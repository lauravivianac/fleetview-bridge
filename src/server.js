// The bridge's HTTP+SSE server. Loopback-only, no framework dependency — see
// docs/local-bridge-design.md for the protocol this implements (§3 security model, §5
// protocol, §4 login flow).
import http from "node:http";
import { generateToken, timingSafeEqual, isRepoAllowed, isOriginAllowed } from "./security.js";
import { getChangedFiles } from "./git-status.js";
import { buildLocalPreviewHtml } from "./local-preview.js";
import { createTraceRecorder } from "./trace-builder.js";
import * as claude from "./providers/claude.js";
import * as codex from "./providers/codex.js";

const PROVIDERS = { claude, codex };
const VERSION = "0.1.0";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(); // refuse to buffer an unreasonably large body
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

export function createBridgeServer({ repos, allowedOrigin, log = () => {} }) {
  // Fresh pairing code + token every process start — see §3: re-pairing on restart is the
  // deliberately simple default, not a missing feature.
  let pairingCode = null;
  let sessionToken = null;
  let providerStatusCache = {}; // refreshed on every /health call, not cached across calls

  function setPairingCode(code) {
    pairingCode = code;
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
      claude: { installed: claudeInstalled, authenticated: claudeAuth },
      codex: { installed: codexInstalled, authenticated: codexAuth },
    };
    return providerStatusCache;
  }

  function requireToken(req, body) {
    const token = body?.token || req.headers["x-fleetview-token"];
    return sessionToken && timingSafeEqual(token, sessionToken);
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowedOrigin)) {
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
        const providers = await refreshProviderStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          version: VERSION,
          paired: Boolean(sessionToken),
          pairedRepos: repos,
          providers,
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/pair") {
        const body = await readJsonBody(req);
        if (!pairingCode || !timingSafeEqual(body?.code, pairingCode)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Wrong or already-used pairing code." }));
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
        const provider = PROVIDERS[body?.provider];
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
          .triggerLogin({ onStatus: (text) => log(`[login:${body.provider}] ${text.trim()}`) })
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
        const provider = PROVIDERS[body?.provider];
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
            task,
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
        // GET has no body to carry a token in — same header /dispatch already accepts as a
        // fallback, plus a query-string fallback for the plain <img>/<iframe src> case (not
        // used today, since the UI fetches this as text and renders via srcDoc, but keeps the
        // route usable without JS too).
        const token = req.headers["x-fleetview-token"] || url.searchParams.get("token");
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
