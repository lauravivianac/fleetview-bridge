// Claude Code CLI provider. Facts below are cited against code.claude.com/docs/en/authentication
// (fetched during design) — everything else is marked as an assumption to verify against a
// real installed `claude` on the machine that actually runs this.
//
// VERIFIED:
//   - There is no standalone `claude login` shell subcommand. Login happens by running
//     `claude` interactively (first launch auto-prompts, or use the in-REPL `/login`), or via
//     `claude setup-token` for a scriptable, subscription-bound long-lived token.
//   - `claude setup-token` "opens the same browser authorization flow as /login, and the
//     token prints to the terminal after you approve access in the browser" — no browser
//     redirect page is FleetView's; the terminal-side of this is what we can spawn+capture.
//   - Credentials on Linux live at `~/.claude/.credentials.json` (mode 0600), Windows at
//     `%USERPROFILE%\.claude\.credentials.json`, overridable via `CLAUDE_CONFIG_DIR`. On
//     macOS they're in the encrypted Keychain, not a plain file — no cheap file-existence
//     check exists there, so `authenticated` is reported as `null` (unknown) on macOS rather
//     than guessed.
//   - "Subscription OAuth credentials from /login" are used automatically in headless `-p`
//     mode too when no higher-priority credential (API key, CLAUDE_CODE_OAUTH_TOKEN, etc.) is
//     set — so once you're logged in via the interactive CLI or VS Code extension, headless
//     dispatch here needs nothing extra.
//
// ASSUMED, NOT YET VERIFIED against a real install — confirm with `claude --help` /
// `claude -p --help` before trusting this in a real dispatch:
//   - `-p`/`--print` is the correct one-shot headless flag (very likely — the docs describe
//     "non-interactive mode (-p)" directly — but the exact combination with a task string as
//     a positional/quoted argument hasn't been run here).
//   - Plain stdout streaming (no `--output-format` flag) is what dispatch() below uses,
//     deliberately avoiding a structured/streaming JSON flag whose exact name isn't verified
//     for the *local* CLI (only the CI Action's own wrapper format is verified, and that's a
//     different program).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSavedClaudeToken, saveClaudeToken } from "../config.js";

function credentialsPath() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

export async function checkInstalled() {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false)); // ENOENT — not on PATH
    child.on("exit", (code) => resolve(code === 0));
  });
}

// true | false | null (macOS — genuinely unknown without guessing at Keychain internals).
export async function checkAuthenticated() {
  if (readSavedClaudeToken()) return true; // a token the bridge itself obtained via setup-token
  if (os.platform() === "darwin") return null;
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    return Boolean(raw && JSON.parse(raw));
  } catch {
    return false;
  }
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

// Runs the task headlessly, streaming raw stdout/stderr chunks via onChunk as they arrive.
// Resolves with the full combined output once the process exits; rejects on a non-zero exit.
export function dispatch({ repoPath, task, onChunk }) {
  return new Promise((resolve, reject) => {
    const savedToken = readSavedClaudeToken();
    const env = savedToken ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: savedToken } : process.env;
    // Task text goes through as a single argv entry, never interpolated into a shell string —
    // spawn() with an argv array (no shell: true) makes that the default, not something we
    // have to remember to do right.
    const child = spawn("claude", ["-p", task], { cwd: repoPath, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      onChunk?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => onChunk?.(chunk.toString()));
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
