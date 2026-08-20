// The bridge's HTTP+SSE server. Loopback-only, no framework dependency — see
// docs/local-bridge-design.md for the protocol this implements (§3 security model, §5
// protocol, §4 login flow).
import http from "node:http";
import path from "node:path";
import {
  generateToken,
  timingSafeEqual,
  isRepoAllowed,
  isOriginAllowed,
  isContainedIn,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
} from "./security.js";
import { getChangedFiles } from "./git-status.js";
import { buildLocalPreviewHtml } from "./local-preview.js";
import { createTraceRecorder } from "./trace-builder.js";
import { checkGhInstalled, checkGhAuthenticated } from "./gh-status.js";
import { saveAttachments } from "./attachments.js";
import * as claude from "./providers/claude.js";
import * as codex from "./providers/codex.js";

const PROVIDERS = { claude, codex };
const VERSION = "0.1.0";

// 28MB covers /dispatch's attachments (base64 inflates ~4/3, so attachments.js's own
// MAX_TOTAL_BYTES of 18MB decoded needs ~24MB of encoded JSON, plus headroom for the rest of
// the body) — every other endpoint's payload is tiny by comparison, so raising this doesn't
// meaningfully change their risk profile.
const MAX_BODY_BYTES = 28_000_000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        // Destroying the socket without settling the promise left the awaiting handler frame
        // alive for the life of the process — a slow leak under repeated abuse.
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function createBridgeServer({ repos, allowedOrigin, allowLocalhost = false, log = () => {} }) {
  // Fresh pairing code + token every process start — see §3: re-pairing on restart is the
  // deliberately simple default, not a missing feature.
  let pairingCode = null;
  let pairingCodeSetAt = 0;
  let pairingAttempts = 0;
  let pairingLockedOut = false;
  let sessionToken = null;
  let providerStatusCache = {}; // refreshed on every /health call, not cached across calls
  let ghStatusCache = { installed: false, authenticated: false }; // same, refreshed every call

  function setPairingCode(code) {
    pairingCode = code;
    pairingCodeSetAt = Date.now();
    pairingAttempts = 0;
    pairingLockedOut = false;
  }

  async function refreshProviderStatus() {
    const [claudeInstalled, codexInstalled] = await Promise.all([
      claude.checkInstalled(),
      codex.checkInstalled(),
    ]);
    const [claudeAuth, codexAuth] = await Promise.all([
      claudeInstalled ? claude.checkAuthenticated() : Promise.resolve(false),
      codexInstalled ? codex.checkAuthenticated() : Promise.resolve(false),
    ]);
    providerStatusCache = {
      // `billing` travels with each provider so the console can tell the developer the truth
      // about what a local run costs them. Being logged in says nothing about HOW — a CLI that
      // picks up an API key from the environment bills per token, and FleetView cannot see that
      // spend at all, so claiming "$0 marginal cost" without checking is a guess presented as a
      // fact. Names of env vars only; never their values.
      claude: {
        installed: claudeInstalled,
        authenticated: claudeAuth,
        billing: claudeInstalled ? claude.billingSignals() : null,
      },
      codex: {
        installed: codexInstalled,
        authenticated: codexAuth,
        billing: codexInstalled ? codex.billingSignals() : null,
      },
    };
    return providerStatusCache;
  }

  async function refreshGhStatus() {
    const installed = await checkGhInstalled();
    const authenticated = installed ? await checkGhAuthenticated() : false;
    ghStatusCache = { installed, authenticated };
    return ghStatusCache;
  }

  // Long opaque strings in provider output are almost always credentials. Redacting on shape
  // rather than on a known prefix means a token format this was never tested against is still
  // caught.
  function redactSecrets(text) {
    return String(text).replace(/[A-Za-z0-9_\-]{24,}/g, "<redacted>");
  }

  function requireToken(req, body) {
    const token = body?.token || req.headers["x-fleetview-token"];
    return sessionToken && timingSafeEqual(token, sessionToken);
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowedOrigin, { allowLocalhost })) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FleetView-Token");
      return true;
    }
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const corsOk = applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(corsOk ? 204 : 403);
      res.end();
      return;
    }
    if (!corsOk) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Origin not allowed." }));
      return;
    }

    const url = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        // Unauthenticated callers get liveness and nothing else. This used to hand anyone on an
        // allowed origin the absolute paths of the developer's repos (which is exactly what a
        // path attack needs), which CLIs and credentials exist on the machine, which API-key
        // environment variables are set, and whether pairing had already happened — i.e.
        // whether guessing the code was worth starting.
        const paired = Boolean(sessionToken);
        if (!requireToken(req, null)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, version: VERSION, paired }));
          return;
        }
        const [providers, gh] = await Promise.all([refreshProviderStatus(), refreshGhStatus()]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: VERSION, paired, pairedRepos: repos, providers, gh }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/pair") {
        const body = await readJsonBody(req);

        // Pairing is the whole security model: whoever redeems this code can dispatch, and
        // dispatch runs the agent CLI with permission prompts bypassed and this shell's entire
        // environment inherited. A measured run against this server managed ~104 guesses per
        // second over one connection, so an unthrottled code is guessed, not protected.
        if (pairingLockedOut) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "Too many wrong pairing codes — restart the bridge to pair.",
          }));
          return;
        }
        if (pairingCode && Date.now() - pairingCodeSetAt > PAIRING_CODE_TTL_MS) {
          pairingCode = null;
          log("Pairing code expired unredeemed — restart the bridge to get a new one.");
        }
        if (!pairingCode || !timingSafeEqual(body?.code, pairingCode)) {
          pairingAttempts++;
          if (pairingAttempts >= PAIRING_MAX_ATTEMPTS) {
            pairingLockedOut = true;
            pairingCode = null;
            // Loud on purpose: repeated wrong codes against a loopback service are not a typo
            // pattern, they are someone guessing.
            log(
              `PAIRING LOCKED OUT after ${pairingAttempts} wrong codes. If that was not you, a web ` +
                "page you visited is trying to pair with this bridge. Restart to pair again."
            );
          }
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Wrong, expired, or already-used pairing code." }));
          return;
        }
        sessionToken = generateToken();
        pairingCode = null; // one-time — a redeemed code can't pair a second session
        log("Paired with FleetView.");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: sessionToken }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/login") {
        const body = await readJsonBody(req);
        if (!requireToken(req, body)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not paired." }));
          return;
        }
        // hasOwn, not a bare lookup: "constructor" and "__proto__" are truthy on a plain
        // object and slipped past the guard into a TypeError further down.
        const provider = Object.hasOwn(PROVIDERS, body?.provider) ? PROVIDERS[body.provider] : null;
        if (!provider) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Unknown provider." }));
          return;
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, started: true }));
        // Fire-and-forget from here — the browser side polls /health for authenticated to
        // flip, per docs/local-bridge-design.md §4. Errors are logged locally rather than
        // returned, since the response already went out.
        provider
          .triggerLogin({
            // `claude setup-token` prints the long-lived subscription token to stdout — that is
            // how claude.js captures it. Logging every chunk verbatim wrote that token into the
            // terminal, into scrollback, and into any file the bridge's output was redirected
            // to. Anything token-shaped is redacted before it reaches the log.
            onStatus: (text) => log(`[login:${body.provider}] ${redactSecrets(text).trim()}`),
          })
          .then(() => log(`[login:${body.provider}] done.`))
          .catch((err) => log(`[login:${body.provider}] failed: ${err.message}`));
        return;
      }

      if (req.method === "POST" && url.pathname === "/dispatch") {
        const body = await readJsonBody(req);
        if (!requireToken(req, body)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not paired." }));
          return;
        }
        // hasOwn, not a bare lookup: "constructor" and "__proto__" are truthy on a plain
        // object and slipped past the guard into a TypeError further down.
        const provider = Object.hasOwn(PROVIDERS, body?.provider) ? PROVIDERS[body.provider] : null;
        if (!provider) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Unknown provider." }));
          return;
        }
        if (!isRepoAllowed(body?.repoPath, repos)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "That repo path isn't in this bridge's --repo allow-list." }));
          return;
        }
        const task = (body?.task || "").trim();
        if (!task) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Task can't be empty." }));
          return;
        }

        // Attachments get saved to disk (and appended to the task as a text note pointing at
        // them) before dispatch even starts — a rejection here (too large, too many, bad data)
        // fails the whole request rather than silently dispatching without what the user
        // actually attached.
        let finalTask = task;
        if (body?.attachments?.length) {
          try {
            const { taskAddendum } = await saveAttachments(body.repoPath, body.attachments);
            if (taskAddendum) finalTask = `${task}\n\n---\n\n${taskAddendum}`;
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
          }
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const trace = createTraceRecorder();
        send({ type: "status", text: `Starting ${body.provider}…` });
        log(`[dispatch:${body.provider}] ${body.repoPath}: ${task.slice(0, 80)}`);
        try {
          await provider.dispatch({
            repoPath: body.repoPath,
            task: finalTask,
            // codex.js still passes plain text chunks; claude.js now passes structured
            // { role, ... } turn events from ClaudeStreamParser (orchestrator text, or a
            // subagent lane's start/progress/message/done) — normalize both into the same
            // "turn" SSE event shape rather than forcing codex.js to match claude.js's shape
            // for no functional reason. Every normalized event is also fed to the trace
            // recorder, which turns it into the compact summary attached to `done`/`error`
            // below — the same events, just not thrown away once rendered.
            onChunk: (chunk) => {
              const normalized = typeof chunk === "string" ? { role: "raw", text: chunk } : chunk;
              trace.record(normalized);
              send({ type: "turn", ...normalized });
            },
          });
          // Real changed-file list, not just the CLI's own self-report — so what shows up in
          // FleetView is what git actually sees, including cases (like a repo-relative-path
          // mismatch) where the CLI claims success but the file landed somewhere unexpected.
          const changedFiles = await getChangedFiles(body.repoPath);
          send({
            type: "done",
            changedFiles,
            summary: changedFiles.length
              ? `Finished — ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed (see below). This run doesn't open a pull request for you the way the cloud dispatch does; ask for one in the task if you want one.`
              : "Finished — no files changed. This run doesn't open a pull request for you the way the cloud dispatch does; ask for one in the task if you want one.",
            trace: trace.summarize(),
          });
        } catch (err) {
          send({ type: "error", message: err.message, trace: trace.summarize() });
        }
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/preview") {
        // Header only. A query-string fallback for a plain <img>/<iframe src> used to be
        // accepted here; nothing in the UI used it, and a token in a URL ends up in shell
        // history, proxy logs and Referer headers on the way out of any page holding it.
        const token = req.headers["x-fleetview-token"];
        if (!sessionToken || !timingSafeEqual(token, sessionToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not paired." }));
          return;
        }
        const repoPath = url.searchParams.get("repoPath");
        const folder = url.searchParams.get("folder") || null;
        if (!isRepoAllowed(repoPath, repos)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "That repo path isn't in this bridge's --repo allow-list." }));
          return;
        }
        // repoPath was checked; `folder` never was, and it is joined straight onto it. A
        // `folder=../secret` therefore read an index.html outside the repo entirely, defeating
        // the allow-list the line above just enforced. Rejected rather than quietly clamped, so
        // an attempt is visible instead of looking like an empty preview.
        if (folder && !isContainedIn(path.join(repoPath, folder), repoPath)) {
          log(`Rejected /preview folder escaping the repo: ${folder}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "folder must stay inside the repo." }));
          return;
        }
        const built = await buildLocalPreviewHtml({ repoPath, folder });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(built ? { ok: true, available: true, ...built } : { ok: true, available: false }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found." }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      } else {
        res.end();
      }
    }
  });

  return { server, setPairingCode };
}
