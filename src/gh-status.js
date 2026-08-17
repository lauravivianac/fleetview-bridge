// GitHub CLI (`gh`) detection — needed for the local agent to actually open real issues/PRs,
// not just edit files on disk. The CLAUDE.md "FleetView Team" / Team Room protocol tells
// whatever's dispatched here to open backlog items as real GitHub issues via `gh issue create`
// (or the equivalent API call) — but unlike Cloud dispatch (GitHub Actions, which gets
// GITHUB_TOKEN injected automatically by the workflow run), this bridge never talks to
// FleetView's own server for credentials at all — see server.js's dispatch(): `env` is just
// `process.env`, inherited straight from whatever shell started the bridge. So whether
// `gh issue create` can succeed depends entirely on whatever's already set up on this machine,
// exactly like `claude`/`codex` themselves — checked the same way, surfaced for the same
// reason: so a missing `gh auth login` shows up here instead of as a silently-incomplete task
// (the agent narrates intent, edits local files, but nothing ever lands on GitHub).
import { spawn } from "node:child_process";

export async function checkGhInstalled() {
  return new Promise((resolve) => {
    const child = spawn("gh", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false)); // ENOENT — not on PATH
    child.on("exit", (code) => resolve(code === 0));
  });
}

// `gh auth status` exits 0 when logged in, non-zero otherwise — same convention as every other
// installed/authenticated check in this file and providers/*.js, so no output parsing needed.
export async function checkGhAuthenticated() {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status"], { stdio: "ignore" });
    child.on("error", () => resolve(false)); // checkGhInstalled() separately covers "not on PATH"
    child.on("exit", (code) => resolve(code === 0));
  });
}
