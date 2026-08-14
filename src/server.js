// The bridge's HTTP+SSE server. Loopback-only, no framework dependency — see
// docs/local-bridge-design.md for the protocol this implements (§3 security model, §5
// protocol, §4 login flow).
import http from "node:http";
import { generateToken, timingSafeEqual, isRepoAllowed, isOriginAllowed } from "./security.js";
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
        send({ type: "status", text: `Starting ${body.provider}…` });
        log(`[dispatch:${body.provider}] ${body.repoPath}: ${task.slice(0, 80)}`);
        try {
          await provider.dispatch({
            repoPath: body.repoPath,
            task,
            onChunk: (text) => send({ type: "turn", text }),
          });
          send({ type: "done", summary: "Finished. Check the repo for what changed — this run doesn't open a pull request for you the way the cloud dispatch does; the prompt should ask the CLI to do that itself if you want one." });
        } catch (err) {
          send({ type: "error", message: err.message });
        }
        res.end();
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
