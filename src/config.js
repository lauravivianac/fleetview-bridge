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
  let allowLocalhost = false;

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
    } else if (arg === "--allow-localhost-origins") {
      allowLocalhost = true;
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

  // Which web origins may reach this process is a security boundary, and it now has to be
  // stated rather than defaulted. The previous default trusted any *.vercel.app subdomain —
  // free to register, so effectively "any attacker who deploys a page" — and any localhost
  // port. Refusing to start beats starting with a boundary the operator never chose.
  if (!allowedOrigin && !allowLocalhost) {
    throw new Error(
      "--origin <url> is required — it names the FleetView origin allowed to talk to this bridge.\n" +
        "  Anyone who can reach this bridge and pair with it can run commands on this machine,\n" +
        "  so there is no safe default. For local FleetView development, pass\n" +
        "  --allow-localhost-origins instead."
    );
  }

  return { repos, port, allowedOrigin, allowLocalhost };
}

export function printUsage() {
  // eslint-disable-next-line no-console
  console.log(`fleetview-bridge — local companion for FleetView's Direct dispatch

Usage:
  fleetview-bridge --repo <path> [--repo <path> ...] --origin https://your-fleetview.example.com [--port 4700]

  --repo    Path to a git repo the bridge is allowed to dispatch into. Repeatable.
            Required — the bridge never dispatches outside an explicit allow-list.
  --port    Local port to listen on (default ${DEFAULT_PORT}). Bound to 127.0.0.1 only.
  --origin  FleetView origin allowed to talk to this bridge, e.g.
            https://fleetview.example.com. Comma-separate for more than one. REQUIRED:
            anyone who can reach and pair with this bridge can run commands as you, so
            there is no safe default. Exact match — no wildcards.
  --allow-localhost-origins
            Trust http://localhost:<any port> instead. For developing FleetView itself.
            Do not use on a machine where you browse: any local dev server, and any
            locally served page you open, becomes a trusted origin.

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
  // `mode` only applies when the file is CREATED. An existing file — from an older version, a
  // restored backup, or planted by a local attacker — keeps whatever permissions it had, so the
  // token could sit world-readable without this.
  fs.chmodSync(CLAUDE_TOKEN_PATH, 0o600);
}
