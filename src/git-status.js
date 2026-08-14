// Reports what actually changed on disk after a dispatch — so a result is visible right in
// FleetView's log instead of requiring a trip to a terminal to `cat`/`git status` by hand.
// Read-only (`git status --porcelain`), safe to run after any dispatch regardless of outcome.
import { spawn } from "node:child_process";

// Resolves to an array of { status, path } (git's two-letter porcelain status code and the
// file path, relative to repoPath) — [] if nothing changed or this isn't a git repo.
export function getChangedFiles(repoPath) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("git", ["-C", repoPath, "status", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve([])); // git not on PATH — fail quiet, this is a nice-to-have
    child.on("exit", (code) => {
      if (code !== 0) return resolve([]); // e.g. not a git repo — same treatment
      const files = out
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
      resolve(files);
    });
  });
}
