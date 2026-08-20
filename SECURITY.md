# Security policy

## What this package is, in threat-model terms

`fleetview-bridge` runs on a developer's own machine, listens on `127.0.0.1`, and `spawn()`s the
`claude` / `codex` CLI on behalf of a web page — with permission prompts bypassed and the
shell's entire environment inherited. Anything that gets past its origin allow-list and its
pairing code can run arbitrary commands as that developer, with their credentials.

That is the whole reason the defaults here are unforgiving:

- **No origin is trusted by default.** `--origin` is required and matched exactly. There are no
  wildcards, and the process refuses to start rather than guess.
- **A request with no `Origin` header is refused**, which is what actually defeats DNS rebinding.
- **The pairing code** is 8 characters from a 31-symbol alphabet (~41 bits), expires 5 minutes
  after it is printed, and locks pairing out for the life of the process after 5 wrong guesses.
- **The session token** is only ever accepted in the `X-FleetView-Token` header, never a query
  string.
- **Unauthenticated `/health`** returns `{ok, version, paired}` and nothing else — no repo paths,
  no provider or credential status.
- **Every path** that leaves the `--repo` allow-list is containment-checked.

Each of those has a regression test in `test/`. They are defaults, and a default that regresses
regresses silently, so please do not relax one without the test that pins it.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅ |
| 0.1.x   | ❌ — contains a remote-code-execution chain. Upgrade. |

`0.1.0` and `0.1.1` trusted any `*.vercel.app` origin by default (a free-tier subdomain anyone
can register), served repo paths and credential status from an unauthenticated `/health`, used a
6-digit pairing code with no expiry and no rate limit, and accepted the session token from the
URL. Chained, a web page the developer merely visited could execute code as them.

`npx fleetview-bridge` re-resolves `latest` on every run, so an `npx` user picks up the fix
automatically. **A global install (`npm install -g`) does not** — re-run the install.

## Reporting a vulnerability

Open a [security advisory](https://github.com/lauravivianac/fleetview-bridge/security/advisories/new)
rather than a public issue. Please include what an attacker starts with (an origin? a code? a
token?) and what they end with, since that is what decides severity here.
