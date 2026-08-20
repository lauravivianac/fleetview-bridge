// Reports what a dispatch actually changed on disk — so a result is visible in FleetView
// instead of requiring a trip to a terminal. Read-only, safe to run regardless of outcome.
//
// It reports the DIFFERENCE between a snapshot taken before the run and one after, because
// `git status` alone answers "what is dirty", not "what did this run do". A repo that was
// already dirty had its pre-existing edits credited to the agent — a run that wrote nothing
// still announced "Finished — 3 files changed".
//
// Three smaller things it now gets right, all of them things a reader would otherwise see and
// not know were wrong:
//   - NUL-separated output, so a path containing a space, a quote or a newline survives intact.
//   - --untracked-files=all, so a new directory lists its files instead of collapsing to one
//     entry and undercounting.
//   - renames, whose porcelain record spans two fields; the destination path is reported rather
//     than a made-up string containing an arrow.
import { spawn } from "node:child_process";

const NUL = "\0";

function runGit(repoPath, args) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("git", ["-C", repoPath, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(null)); // git not on PATH — fail quiet, this is a nice-to-have
    child.on("exit", (code) => resolve(code === 0 ? out : null));
  });
}

// A rename record consumes the FOLLOWING field as its source path, so records cannot simply be
// split and mapped one to one.
function parsePorcelainZ(out) {
  const parts = out.split(NUL);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const dest = record.slice(3);
    files.push({ status: status.trim(), path: dest });
    // Report where the file ended up, and skip the source field this record consumed.
    if (status[0] === "R" || status[0] === "C") i++;
  }
  return files;
}

const STATUS_ARGS = ["status", "--porcelain", "-z", "--untracked-files=all"];

// A snapshot to diff against later. Call before dispatching.
export async function snapshotRepoState(repoPath) {
  const out = await runGit(repoPath, STATUS_ARGS);
  if (out === null) return null; // not a git repo, or no git — no baseline is possible
  return new Set(parsePorcelainZ(out).map((f) => `${f.status} ${f.path}`));
}

// What changed relative to `baseline`. With no baseline (not a git repo, or git missing) this
// reports nothing, rather than reporting everything dirty as though the run had done it.
export async function getChangedFiles(repoPath, baseline = null) {
  const out = await runGit(repoPath, STATUS_ARGS);
  if (out === null || !baseline) return [];
  return parsePorcelainZ(out).filter((f) => !baseline.has(`${f.status} ${f.path}`));
}
