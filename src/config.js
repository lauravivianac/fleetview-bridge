// CLI arg parsing + the bridge's own small local state directory (~/.fleetview-bridge) — not
// your claude/codex credentials, just this process's own pairing/port/token bookkeeping and,
// for Claude specifically, the long-lived subscription token `claude setup-token` prints
// (see providers/claude.js — that's the one thing worth persisting across restarts so you
// don't re-run setup-token every time you start the bridge).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 4700;

export function parseArgs(argv) {
  const repos = [];
  let port = DEFAULT_PORT;
  let allowedOrigin = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      const value = argv[++i];
      if (!value) throw new Error("--repo needs a path");
      repos.push(path.resolve(value));
    } else if (arg === "--port") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--port needs a positive integer");
      port = value;
    } else if (arg === "--origin") {
      allowedOrigin = argv[++i];
      if (!allowedOrigin) throw new Error("--origin needs a value, e.g. https://fleetview.example.com");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }

  if (repos.length === 0) {
    throw new Error("At least one --repo <path> is required — the bridge refuses to guess which repo you mean.");
  }
  for (const repo of repos) {
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
      throw new Error(`--repo ${repo} doesn't exist or isn't a directory.`);
    }
  }

  return { repos, port, allowedOrigin };
}

export function printUsage() {
  // eslint-disable-next-line no-console
  console.log(`fleetview-bridge — local companion for FleetView's Direct dispatch

Usage:
  fleetview-bridge --repo <path> [--repo <path> ...] [--port 4700] [--origin https://your-fleetview.example.com]

  --repo    Path to a git repo the bridge is allowed to dispatch into. Repeatable.
            Required — the bridge never dispatches outside an explicit allow-list.
  --port    Local port to listen on (default ${DEFAULT_PORT}). Bound to 127.0.0.1 only.
  --origin  FleetView origin to allow via CORS. Defaults to the well-known FleetView
            deployment origins baked into the bridge; pass this if you're running FleetView
            somewhere else (a fork, a preview deploy, localhost).

See docs/local-bridge-design.md at the repo root for the full protocol and security model.`);
}

const BRIDGE_HOME = path.join(os.homedir(), ".fleetview-bridge");
const CLAUDE_TOKEN_PATH = path.join(BRIDGE_HOME, "claude-subscription-token");

function ensureBridgeHome() {
  fs.mkdirSync(BRIDGE_HOME, { recursive: true, mode: 0o700 });
}

export function readSavedClaudeToken() {
  try {
    return fs.readFileSync(CLAUDE_TOKEN_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function saveClaudeToken(token) {
  ensureBridgeHome();
  fs.writeFileSync(CLAUDE_TOKEN_PATH, token, { mode: 0o600 });
}
