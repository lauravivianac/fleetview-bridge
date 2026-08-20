// Codex CLI provider.
//
// VERIFIED against a real install (2026-08-14, `codex exec --help` pasted back from a real
// machine — OpenAI Codex v0.145.0):
//   - `codex exec [OPTIONS] [PROMPT]` is the real headless entry point.
//   - `-s, --sandbox <SANDBOX_MODE>` accepts `read-only | workspace-write |
//     danger-full-access`, and **defaults to `read-only`** — found the hard way, by a first
//     real dispatch that ran cleanly but silently couldn't write the file it was asked to
//     create. dispatch() below now passes `-s workspace-write` explicitly.
//   - Auth detection (`checkAuthenticated`, the `~/.codex/auth.json` file check) was
//     confirmed working — a real paired session showed "Codex — logged in" against a
//     machine that already had `codex` authenticated, with no false negative.
//
// STILL ASSUMED, not directly exercised yet: `codex login` and `codex login status` as the
// exact subcommands `triggerLogin`/the status fallback below spawn — developers.openai.com
// was blocked by this sandbox's egress proxy when this was written, so that specific pair
// came from third-party docs. The auth.json file check above is the primary signal and is
// now verified; these two are the fallback path for a machine that isn't logged in yet.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexStreamParser } from "../codex-stream-parser.js";

function authFilePath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

export async function checkInstalled() {
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// true | false | null (couldn't determine either way — treated as "ask the user to confirm").
export async function checkAuthenticated() {
  try {
    const raw = fs.readFileSync(authFilePath(), "utf8");
    if (raw && JSON.parse(raw)) return true;
  } catch {
    // Fall through to the subcommand check below — the file check is the primary signal
    // (cheap, no subprocess), this is a second opinion, not required to agree.
  }
  return new Promise((resolve) => {
    const child = spawn("codex", ["login", "status"], { stdio: "ignore" });
    child.on("error", () => resolve(null)); // codex itself not on PATH — checkInstalled() covers that separately
    child.on("exit", (code) => resolve(code === 0 ? true : code === 1 ? false : null));
  });
}

// See the same function in claude.js for why this exists. Codex has no bridge-held token, so
// the only signals are the auth file and whether an API key is sitting in the environment that
// dispatch() passes straight through.
export function billingSignals() {
  let authFile = false;
  try {
    authFile = Boolean(fs.readFileSync(authFilePath(), "utf8"));
  } catch {
    authFile = false;
  }
  return {
    bridgeToken: false,
    subscriptionAuthFile: authFile,
    // Names only, never values.
    apiKeyEnvVars: ["OPENAI_API_KEY"].filter((name) => Boolean(process.env[name])),
  };
}

// Spawns `codex login`, which (per third-party docs, unverified first-party) defaults to a
// ChatGPT OAuth browser flow and writes ~/.codex/auth.json on completion — no token to
// capture from stdout the way Claude's setup-token has, so this just watches for the auth
// file to appear rather than parsing output for a specific string.
export function triggerLogin({ onStatus } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["login"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("codex login didn't finish within 90s — try running `codex login` manually in a terminal instead."));
    }, 90_000);

    child.stdout.on("data", (chunk) => onStatus?.(chunk.toString()));
    child.stderr.on("data", (chunk) => onStatus?.(chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex login exited with code ${code}`));
        return;
      }
      resolve(true);
    });
  });
}

// `--json` (alias `--experimental-json`): structured JSONL streaming, real per Codex's own
// source (see bridge/src/codex-stream-parser.js's header for exactly what's confirmed vs.
// still assumed) — same upgrade `--output-format stream-json` was for claude.js. Composing it
// with the already-live-verified `-s workspace-write` isn't itself confirmed on a real
// machine yet; flagged here rather than assumed silently, same honesty bar as the rest of
// this file.
export function dispatch({ repoPath, task, onChunk }) {
  return new Promise((resolve, reject) => {
    // VERIFIED against a real install (`codex exec --help`, 2026-08-14): `codex exec`
    // defaults to `sandbox: read-only` — confirmed the hard way, by a first real dispatch
    // that ran successfully but silently couldn't write the file it was asked to create.
    // `-s workspace-write` is the documented flag to let it actually write inside the repo,
    // one level short of `danger-full-access` — the argv array (not a shell string) keeps
    // task text from ever being interpolated into anything a shell parses, same discipline
    // as claude.js and the cloud workflow YAML.
    const child = spawn(
      "codex",
      ["exec", "-s", "workspace-write", "--json", "--", task],
      { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] }
    );
    const parser = new CodexStreamParser();
    let out = "";
    let buffer = "";
    let stderrOut = "";
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
    // stderr used to be forwarded straight into onChunk as a fake spoken turn, same shape as a
    // real agent_message — confirmed on a real dispatch, this is exactly where a codex CLI
    // diagnostic line ("Reading additional input from stdin...") leaked into the chat window
    // looking like a team member had said it, when nobody had. Buffered instead: nothing shown
    // while the run is healthy. If codex actually exits non-zero, the real diagnostic detail
    // goes into the rejection's error message below — where a crash reason is actually useful —
    // instead of narrating every routine run's ordinary stderr chatter as if it were dialogue.
    child.stderr.on("data", (chunk) => {
      stderrOut += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        // Tail, not the whole thing — a crash's real reason is usually the last few lines, not
        // buried under startup noise that accumulated before it.
        const detail = stderrOut.trim().slice(-500);
        reject(new Error(`codex exited with code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(out);
    });
  });
}
