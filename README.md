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
npx fleetview-bridge --repo /path/to/your/repo --origin https://your-fleetview.example.com
```

`--origin` is the address of *your* FleetView, and it is required — the bridge refuses to start
without it. See [Why --origin is required](#why---origin-is-required) below; the short version is
that anything allowed to talk to this process can run commands as you, so there is no safe
default to fall back on.

No install step, no cloning — `npx` fetches the latest published version and runs it directly
(FleetView's own Installation screen generates this exact command for you, already pointed at
your connected repo and filled in with its own origin, so you can copy it rather than typing the
URL). Prefer a real local install instead? `npm install -g fleetview-bridge` also works — but
note that a global install does not update itself the way `npx` does, so you have to re-run
`npm install -g fleetview-bridge` to pick up a security fix.

Working from a clone of this repo instead (e.g. to make a code change)? Same entry point, run
directly: `node bin/fleetview-bridge.js --repo /path/to/your/repo --allow-localhost-origins`.

It prints an 8-character pairing code — paste it into FleetView → Installation → Local agent
(optional). The code expires 5 minutes after it is printed, and pairing locks out after 5 wrong
attempts, so if you miss the window just restart the bridge. It binds to `127.0.0.1` only and is
never reachable from the network.

```
Usage:
  fleetview-bridge --repo <path> [--repo <path> ...] --origin https://your-fleetview.example.com [--port 4700]

  --repo    Path to a git repo the bridge is allowed to dispatch into. Repeatable.
  --port    Local port to listen on (default 4700).
  --origin  FleetView origin allowed to talk to this bridge. REQUIRED, exact match, no
            wildcards. Comma-separate for more than one.
  --allow-localhost-origins
            Trust http://localhost:<any port> instead, for developing FleetView itself.
```

## Layout

```
bin/fleetview-bridge.js        CLI entry point
src/server.js                  HTTP + SSE server (pairing, health, login, dispatch)
## Why --origin is required

Anyone who can reach this bridge and redeem its pairing code can dispatch, and a dispatch runs
the agent CLI with permission prompts bypassed, in your repo, inheriting your shell's entire
environment — cloud keys, `gh` token, SSH agent. The repo allow-list is not a sandbox; an agent
running with permissions bypassed can run anything.

So the origin allow-list and the pairing code are the whole security model, and both were weaker
than that job:

- The default allow-list accepted any `*.vercel.app` subdomain. Those are free to register, so
  any page an attacker deployed was a trusted origin — as was any `http://localhost:<port>`,
  meaning any dev server or locally served HTML you happened to open. There is now no default:
  you name your origin, or you pass `--allow-localhost-origins` deliberately.
- The pairing code was six digits with no rate limit and no expiry. Measured against this
  server, that is roughly 100 guesses per second over a single connection — the whole keyspace
  in hours, far less from a browser making parallel requests. It is now eight characters from a
  31-character alphabet (~41 bits), expires 5 minutes after it is printed, and locks pairing out
  after 5 wrong attempts until you restart.

A request with no `Origin` header is refused outright. That is what stops DNS rebinding, so
don't relax it.


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

No dependencies beyond Node's standard library — deliberately, so `npx fleetview-bridge` has
nothing to install beyond the package itself, and so a local clone never needs its own
`npm install` step either.
