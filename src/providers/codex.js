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

export function dispatch({ repoPath, task, onChunk }) {
  return new Promise((resolve, reject) => {
    // VERIFIED against a real install (`codex exec --help`, 2026-08-14): `codex exec`
    // defaults to `sandbox: read-only` — confirmed the hard way, by a first real dispatch
    // that ran successfully but silently couldn't write the file it was asked to create.
    // `-s workspace-write` is the documented flag to let it actually write inside the repo,
    // one level short of `danger-full-access` — the argv array (not a shell string) keeps
    // task text from ever being interpolated into anything a shell parses, same discipline
    // as claude.js and the cloud workflow YAML.
    const child = spawn("codex", ["exec", "-s", "workspace-write", task], { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      onChunk?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => onChunk?.(chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`codex exited with code ${code}`));
        return;
      }
      resolve(out);
    });
  });
}
