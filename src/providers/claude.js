// Claude Code CLI provider.
//
// VERIFIED against code.claude.com/docs/en/authentication (fetched during design):
//   - There is no standalone `claude login` shell subcommand at the bare top level. Login
//     happens by running `claude` interactively (first launch auto-prompts, or the in-REPL
//     `/login`), or via `claude setup-token` for a scriptable, subscription-bound long-lived
//     token (still used by triggerLogin() below — see its own comment).
//   - "Subscription OAuth credentials from /login" are used automatically in headless `-p`
//     mode too when no higher-priority credential (API key, CLAUDE_CODE_OAUTH_TOKEN, etc.) is
//     set — so once you're logged in via the interactive CLI or VS Code extension, headless
//     dispatch here needs nothing extra.
//
// VERIFIED against a real install (2026-08-14, real `--help`/output pasted back from Laura's
// machine, Claude Code CLI):
//   - `-p`/`--print` works as assumed for headless dispatch.
//   - `--permission-mode <mode>` (`acceptEdits | bypassPermissions | default | dontAsk | plan
//     | auto`) exists. Found the hard way: a first real dispatch ran cleanly and reported
//     "Finished" — but its own final message said it needed approval to write and had no one
//     to ask, since headless dispatch has no interactive prompt to answer. dispatch() now
//     passes `--permission-mode bypassPermissions` explicitly, deliberately over the blunter
//     top-level `--dangerously-skip-permissions`, which is documented as "recommended only for
//     sandboxes with no internet access" — a caveat this doesn't fit.
//   - There IS a real `claude auth` subcommand group — `claude auth status --json` prints
//     `{ loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType }`,
//     confirmed against real output. This replaces the file-existence guessing this file used
//     to do (a Linux/Windows credentials-file path, `null`/"unknown" on macOS because Keychain
//     has no cheap file check) with one real, cross-platform, documented signal — checked live
//     on macOS, presumed to work the same on Linux/Windows since it's the CLI's own command,
//     not an OS-specific file path.
//   - `claude auth login` also exists (`--claudeai` subscription flow is the default,
//     `--console` for API-key billing — never use that one here, it defeats the entire point
//     of this bridge). Its exact scriptability (does it print anything capturable? block for
//     TTY input?) isn't tested yet, so triggerLogin() below still uses the already-verified
//     `claude setup-token` rather than switching to it on assumption.
//   - `--output-format stream-json` + `--include-partial-messages` exist for structured
//     streaming — a real upgrade over the raw-text streaming dispatch() uses today, left for
//     later since parsing its exact event shape needs its own real test, not bundled here.
import { spawn } from "node:child_process";
import { readSavedClaudeToken, saveClaudeToken } from "../config.js";
import { ClaudeStreamParser } from "../claude-stream-parser.js";

export async function checkInstalled() {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false)); // ENOENT — not on PATH
    child.on("exit", (code) => resolve(code === 0));
  });
}

// true | false | null (couldn't parse a clean answer — treated as "ask the user to confirm",
// same convention as codex.js).
export async function checkAuthenticated() {
  if (readSavedClaudeToken()) return true; // a token the bridge itself obtained via setup-token
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("claude", ["auth", "status", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(null)); // checkInstalled() separately covers "not on PATH"
    child.on("exit", () => {
      try {
        resolve(Boolean(JSON.parse(out).loggedIn));
      } catch {
        resolve(null); // unexpected output shape from a CLI version this wasn't checked against
      }
    });
  });
}

// Spawns `claude setup-token`, which — per the docs above — opens a browser for you to
// approve, then prints a long-lived subscription-bound token to stdout once you do. We
// capture that token and save it (bridge/src/config.js) rather than relying on the ambient
// credentials file, so this keeps working even for a bridge started under a different user
// context than your interactive terminal. 90s timeout: the common desktop-browser case
// completes without any terminal input, but the docs note a fallback where the browser shows
// a code to paste back into the terminal (WSL2/SSH/containers) — that case will time out here
// rather than hang forever, and the caller should tell the user to run it manually instead.
export function triggerLogin({ onStatus } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["setup-token"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude setup-token didn't finish within 90s — if your browser showed a code to paste back into a terminal, run `claude setup-token` manually there instead."));
    }, 90_000);

    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      onStatus?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => onStatus?.(chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude setup-token exited with code ${code}`));
        return;
      }
      // The command's only documented output is the token itself; take the last non-empty
      // line as a defensive best guess in case it prints any surrounding text too.
      const token = out.trim().split("\n").filter(Boolean).pop();
      if (!token) {
        reject(new Error("claude setup-token exited 0 but printed nothing recognizable as a token."));
        return;
      }
      saveClaudeToken(token);
      resolve(token);
    });
  });
}

// Runs the task headlessly. Streams structured turn events via onChunk — orchestrator turns
// and, when the CLAUDE.md Team Room protocol leads it to delegate, live subagent lanes
// (start/progress/message/done) parsed from the CLI's own `--output-format stream-json`
// output by ClaudeStreamParser (see that file for exactly what's verified vs. inferred).
// `--verbose` is required alongside `--output-format stream-json` in `--print` mode — the CLI
// itself errors without it, found by trying.
export function dispatch({ repoPath, task, onChunk }) {
  return new Promise((resolve, reject) => {
    const savedToken = readSavedClaudeToken();
    const env = savedToken ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: savedToken } : process.env;
    // Task text goes through as a single argv entry, never interpolated into a shell string —
    // spawn() with an argv array (no shell: true) makes that the default, not something we
    // have to remember to do right. `--permission-mode bypassPermissions`: see the file-level
    // comment above — without it, a headless run just stalls asking for approval it can never
    // receive.
    const child = spawn(
      "claude",
      ["-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--include-partial-messages", "--verbose", task],
      { cwd: repoPath, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    const parser = new ClaudeStreamParser();
    let out = "";
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      out += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // last line may be incomplete — keep it for the next chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const event of parser.feed(line)) onChunk?.(event);
      }
    });
    child.stderr.on("data", (chunk) => onChunk?.({ role: "raw", text: chunk.toString() }));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      resolve(out);
    });
  });
}
