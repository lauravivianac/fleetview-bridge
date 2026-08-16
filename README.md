# FleetView Bridge

Local companion process for FleetView's "Local agent" step — relays between the FleetView web
UI and an already-authenticated `claude`/`codex` CLI on your machine, so Direct dispatch can
run against your Claude Pro/Max or ChatGPT Plus/Codex subscription instead of a metered API
key and a cloud runner. Full design and security model:
[`docs/local-bridge-design.md`](https://github.com/lauravivianac/fleetview/blob/main/docs/local-bridge-design.md)
in the main FleetView repo.

**Status:** Phase 1 + 2 of that doc — the protocol, security mechanics, and FleetView UI are
built and tested. The provider-specific commands (`claude.js`, `codex.js`) are tested against
fake stand-in scripts, not yet a real `claude`/`codex` install — see the doc's §7 before
trusting this against your real subscription.

## Run it

```bash
node bin/fleetview-bridge.js --repo /path/to/your/repo
```

It prints a 6-digit pairing code — paste it into FleetView → Installation → Local agent
(optional). The bridge binds to `127.0.0.1` only and is never reachable from the network.

```
Usage:
  fleetview-bridge --repo <path> [--repo <path> ...] [--port 4700] [--origin https://your-fleetview.example.com]

  --repo    Path to a git repo the bridge is allowed to dispatch into. Repeatable.
  --port    Local port to listen on (default 4700).
  --origin  FleetView origin to allow via CORS. Defaults to localhost (any port) and
            *.vercel.app — pass this if FleetView runs somewhere else.
```

## Layout

```
bin/fleetview-bridge.js        CLI entry point
src/server.js                  HTTP + SSE server (pairing, health, login, dispatch)
src/security.js                token generation/verification, repo allow-list, CORS origin check
src/config.js                  CLI arg parsing, ~/.fleetview-bridge/ local state
src/providers/claude.js        Claude Code CLI: installed/auth checks, login trigger, dispatch
src/providers/codex.js         Codex CLI: same, for codex
src/local-preview.js           GET /preview: finds+inlines a real index.html straight off disk
src/claude-stream-parser.js    Parses Claude Code's --output-format stream-json events
src/codex-stream-parser.js     Parses Codex's --json event stream
src/trace-builder.js           Turns either parser's events into a compact agent-trace summary
src/git-status.js              Real git status/diff info surfaced to the FleetView UI
```

No dependencies beyond Node's standard library — deliberately, to keep `npm install` out of
the loop between cloning this and running it.
