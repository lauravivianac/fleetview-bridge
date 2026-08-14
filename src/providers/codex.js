// Codex CLI provider. `codex exec` as the headless entry point is verified against
// openai/codex-action's README this session. The auth-subcommand details below (`codex
// login`, `codex login status`, the exact auth.json path) come from third-party docs
// (developers.openai.com and docs.onlinetool.cc were both blocked by this sandbox's egress
// proxy, so they couldn't be fetched first-party) — treat this whole module as ASSUMED,
// not verified, until run against a real installed `codex`. If `codex --help` on the real
// machine shows different subcommand names, this file is the one place to fix it.
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
    // argv array, not a shell string — task text is never interpolated into anything a shell
    // parses, same discipline as claude.js and the cloud workflow YAML.
    const child = spawn("codex", ["exec", task], { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
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
