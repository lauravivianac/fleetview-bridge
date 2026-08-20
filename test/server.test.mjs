// End-to-end tests against a real listening bridge. These assert the behaviours a reviewer
// would check by hand before signing off a release: that an unnamed origin gets nothing, that
// an unauthenticated caller learns nothing about the machine, that guessing the pairing code
// locks out, and that a token in a URL is not a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/server.js";

const ORIGIN = "https://fleetview.example.test";

// One temp repo shared by the tests that need a real directory on disk.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "fv-bridge-test-"));
fs.mkdirSync(path.join(REPO, "docs"), { recursive: true });
fs.writeFileSync(path.join(REPO, "index.html"), "<h1>hi</h1>");

async function withBridge(fn, opts = {}) {
  const { server, setPairingCode } = createBridgeServer({
    repos: [REPO],
    allowedOrigin: ORIGIN,
    log: () => {},
    ...opts,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, setPairingCode });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const call = (base, pathname, { origin = ORIGIN, method = "GET", body, headers = {} } = {}) =>
  fetch(base + pathname, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function pair(base, setPairingCode) {
  const code = "ABCD2345";
  setPairingCode(code);
  const res = await call(base, "/pair", { method: "POST", body: { code } });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test("the bridge binds loopback only", async () => {
  await withBridge(({ base }) => {
    assert.match(base, /^http:\/\/127\.0\.0\.1:/);
  });
});

test("an origin that was never named is refused outright", async () => {
  await withBridge(async ({ base }) => {
    for (const origin of ["https://attacker-deploy.vercel.app", "http://localhost:3000", "https://evil.test"]) {
      const res = await call(base, "/health", { origin });
      assert.equal(res.status, 403, `${origin} reached the bridge`);
      // And no CORS header, so even the 403 body stays unreadable to the page.
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
  });
});

test("a request with no Origin header at all is refused", async () => {
  await withBridge(async ({ base }) => {
    const res = await call(base, "/health", { origin: null });
    assert.equal(res.status, 403);
  });
});

test("a preflight from a disallowed origin is refused too", async () => {
  await withBridge(async ({ base }) => {
    const res = await call(base, "/dispatch", { method: "OPTIONS", origin: "https://evil.test" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("unauthenticated /health reveals liveness and nothing else", async () => {
  await withBridge(async ({ base }) => {
    const res = await call(base, "/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    // Asserted as an exact key set, not a list of absences: a future field carrying anything
    // about this machine has to come here and be thought about, rather than leaking because
    // the test only knew to check for yesterday's field names.
    assert.deepEqual(Object.keys(body).sort(), ["ok", "paired", "version"]);
    // The specific things this endpoint used to hand out to anyone.
    for (const leak of ["pairedRepos", "providers", "gh", "repos", "env"]) {
      assert.equal(leak in body, false, `unauthenticated /health leaked ${leak}`);
    }
    assert.equal(JSON.stringify(body).includes(REPO), false, "a repo path leaked in /health");
  });
});

test("guessing the pairing code locks pairing out", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    setPairingCode("ABCD2345");
    for (let i = 1; i <= 4; i++) {
      const res = await call(base, "/pair", { method: "POST", body: { code: "WRONG222" } });
      assert.equal(res.status, 401, `attempt ${i} should be a plain rejection`);
    }
    const fifth = await call(base, "/pair", { method: "POST", body: { code: "WRONG222" } });
    assert.equal(fifth.status, 401);
    // Locked out from here on — and crucially, the CORRECT code no longer works either.
    // A lockout that still honours the right code would let an attacker keep guessing.
    const withRightCode = await call(base, "/pair", { method: "POST", body: { code: "ABCD2345" } });
    assert.equal(withRightCode.status, 429, "the real code still paired after lockout");
  });
});

test("a pairing code stops working once it has expired", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    setPairingCode("ABCD2345");
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000 + 1_000; // just past the TTL
    try {
      const res = await call(base, "/pair", { method: "POST", body: { code: "ABCD2345" } });
      assert.equal(res.status, 401, "an expired code still paired");
    } finally {
      Date.now = realNow;
    }
  });
});

test("a redeemed pairing code cannot pair a second session", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    setPairingCode("ABCD2345");
    const first = await call(base, "/pair", { method: "POST", body: { code: "ABCD2345" } });
    assert.equal(first.status, 200);
    const second = await call(base, "/pair", { method: "POST", body: { code: "ABCD2345" } });
    assert.equal(second.status, 401, "the same code paired twice");
  });
});

test("endpoints reject a caller holding no token or the wrong one", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    const token = await pair(base, setPairingCode);
    const preview = `/preview?repoPath=${encodeURIComponent(REPO)}`;
    assert.equal((await call(base, preview)).status, 401, "no token was accepted");
    assert.equal(
      (await call(base, preview, { headers: { "X-FleetView-Token": "not-the-token" } })).status,
      401,
      "a wrong token was accepted"
    );
    assert.equal(
      (await call(base, preview, { headers: { "X-FleetView-Token": token } })).status,
      200,
      "the real token was rejected"
    );
  });
});

test("a token in the query string is not a token", async () => {
  // Tokens in URLs end up in shell history, proxy logs, and Referer headers on the way out of
  // any page holding one. The header is the only accepted channel.
  await withBridge(async ({ base, setPairingCode }) => {
    const token = await pair(base, setPairingCode);
    const res = await call(
      base,
      `/preview?repoPath=${encodeURIComponent(REPO)}&token=${encodeURIComponent(token)}`
    );
    assert.equal(res.status, 401, "/preview accepted a token from the query string");
  });
});

test("/preview refuses a folder that escapes the repo", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    const token = await pair(base, setPairingCode);
    const headers = { "X-FleetView-Token": token };
    for (const folder of ["..", "../", "../../etc", "docs/../../elsewhere"]) {
      const res = await call(
        base,
        `/preview?repoPath=${encodeURIComponent(REPO)}&folder=${encodeURIComponent(folder)}`,
        { headers }
      );
      assert.equal(res.status, 400, `folder=${folder} was not rejected`);
    }
    // A folder that stays inside is still served.
    const ok = await call(base, `/preview?repoPath=${encodeURIComponent(REPO)}&folder=docs`, { headers });
    assert.equal(ok.status, 200);
  });
});

test("/preview refuses a repo outside the --repo allow-list", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    const token = await pair(base, setPairingCode);
    const res = await call(base, `/preview?repoPath=${encodeURIComponent(os.tmpdir())}`, {
      headers: { "X-FleetView-Token": token },
    });
    assert.equal(res.status, 403);
  });
});

test("an unknown provider name cannot reach a prototype property", async () => {
  await withBridge(async ({ base, setPairingCode }) => {
    const token = await pair(base, setPairingCode);
    for (const provider of ["constructor", "__proto__", "toString", "nope"]) {
      const res = await call(base, "/login", {
        method: "POST",
        body: { token, provider },
        headers: { "X-FleetView-Token": token },
      });
      assert.equal(res.status, 400, `provider=${provider} was not rejected cleanly`);
    }
  });
});

test("/health reports the package's real version, not a restated one", async () => {
  // The console reads this field to tell a developer whether their bridge is the fixed one.
  // A hardcoded copy that drifts from package.json turns that check into a lie, which is how
  // someone concludes they are patched when they are running the vulnerable build.
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  await withBridge(async ({ base }) => {
    const body = await (await call(base, "/health")).json();
    assert.equal(body.version, pkg.version);
  });
});
