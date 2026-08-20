// Regression tests for the security boundary itself.
//
// Every assertion here corresponds to a specific way this bridge was exploitable before
// PR #1. They exist because these are all *defaults* — a permissive origin list, a short
// code, an ungated status endpoint — and a default that regresses does so silently. The
// bridge spawns the agent CLI with permission prompts bypassed and the developer's whole
// environment inherited, so "silently" here means "arbitrary code execution, unnoticed."
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOriginAllowed,
  isRepoAllowed,
  isContainedIn,
  generatePairingCode,
  generateToken,
  timingSafeEqual,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
} from "../src/security.js";

test("no origin is trusted by default", () => {
  // The whole original RCE chain started here: `*.vercel.app` was allowed by default, and
  // Vercel hands those subdomains to anyone with a free account. If this ever goes back to
  // returning true for an origin nobody named, the outer boundary is gone.
  for (const origin of [
    "https://fleetview.example.com",
    "https://anything.vercel.app",
    "https://attacker-deploy.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:8080",
  ]) {
    assert.equal(isOriginAllowed(origin, null, {}), false, `${origin} must not be trusted by default`);
  }
});

test("a request with no Origin header is refused", () => {
  // This is what actually defeats DNS rebinding: a rebound host sends its own Origin or none.
  assert.equal(isOriginAllowed(undefined, "https://fleetview.example.com", {}), false);
  assert.equal(isOriginAllowed("", "https://fleetview.example.com", {}), false);
  assert.equal(isOriginAllowed(null, null, { allowLocalhost: true }), false);
});

test("--origin matches exactly, never as a suffix or prefix", () => {
  const allowed = "https://fleetview.example.com";
  assert.equal(isOriginAllowed(allowed, allowed, {}), true);
  for (const impostor of [
    "https://fleetview.example.com.evil.test",
    "https://evil.test/https://fleetview.example.com",
    "https://notfleetview.example.com",
    "http://fleetview.example.com", // scheme is part of an origin
    "https://sub.fleetview.example.com",
    "https://fleetview.example.com:8443",
  ]) {
    assert.equal(isOriginAllowed(impostor, allowed, {}), false, `${impostor} must not match ${allowed}`);
  }
});

test("--origin accepts a comma-separated list, each still exact", () => {
  const list = "https://a.example.com, https://b.example.com";
  assert.equal(isOriginAllowed("https://a.example.com", list, {}), true);
  assert.equal(isOriginAllowed("https://b.example.com", list, {}), true);
  assert.equal(isOriginAllowed("https://c.example.com", list, {}), false);
});

test("localhost is trusted only when explicitly opted into", () => {
  assert.equal(isOriginAllowed("http://localhost:3000", null, { allowLocalhost: false }), false);
  assert.equal(isOriginAllowed("http://localhost:3000", null, { allowLocalhost: true }), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:3000", null, { allowLocalhost: true }), true);
  // Not every host that merely contains "localhost".
  assert.equal(isOriginAllowed("http://localhost.evil.test", null, { allowLocalhost: true }), false);
  assert.equal(isOriginAllowed("http://notlocalhost", null, { allowLocalhost: true }), false);
});

test("the pairing code is long enough to be a secret, not a keyspace", () => {
  // 6 digits (10^6) fell to ~104 sequential guesses/sec measured against this server. The
  // throttle and TTL are the primary defence now, but the code has to survive both being
  // defeated, so its own entropy is asserted independently of them.
  assert.equal(PAIRING_CODE_LENGTH, 8);
  const alphabetSize = 31;
  const bits = Math.log2(alphabetSize ** PAIRING_CODE_LENGTH);
  assert.ok(bits >= 39, `pairing code entropy fell to ${bits.toFixed(1)} bits`);

  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = generatePairingCode();
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    // Unambiguous alphabet: a human reads this off a terminal and types it into a browser.
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/, `bad glyph in ${code}`);
    seen.add(code);
  }
  // Not a randomness test — a smoke alarm for a constant or an off-by-one collapsing the space.
  assert.ok(seen.size > 480, `only ${seen.size}/500 distinct codes`);
});

test("the pairing throttle and expiry constants stay within their threat model", () => {
  assert.equal(PAIRING_MAX_ATTEMPTS, 5);
  assert.ok(PAIRING_MAX_ATTEMPTS <= 10, "too many guesses tolerated for a code read off a screen");
  assert.equal(PAIRING_CODE_TTL_MS, 5 * 60_000);
  assert.ok(PAIRING_CODE_TTL_MS <= 15 * 60_000, "a code redeemable this long outlives the walk to the browser");
});

test("session tokens are long and unpredictable", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, `token is only ${a.length} chars`);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("timingSafeEqual never throws and never accepts empty", () => {
  // It compares attacker-controlled input against a secret; a throw on a length mismatch
  // would turn a wrong guess into a 500 and an oracle.
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual(undefined, undefined), false);
  assert.equal(timingSafeEqual(null, "x"), false);
  assert.equal(timingSafeEqual("", ""), false, "an unset token must not match an empty guess");
});

test("repo paths must resolve to an entry in the allow-list, not merely start with one", () => {
  const allowed = ["/home/dev/project"];
  assert.equal(isRepoAllowed("/home/dev/project", allowed), true);
  assert.equal(isRepoAllowed("/home/dev/project/", allowed), true);
  assert.equal(isRepoAllowed("/home/dev/project/../project", allowed), true);
  for (const bad of [
    "/home/dev/project/../secrets",
    "/home/dev/project-other",
    "/home/dev",
    "/etc",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isRepoAllowed(bad, allowed), false, `${bad} must not be allowed`);
  }
});

test("isContainedIn rejects traversal and sibling-prefix escapes", () => {
  assert.equal(isContainedIn("/repo/docs", "/repo"), true);
  assert.equal(isContainedIn("/repo", "/repo"), true);
  assert.equal(isContainedIn("/repo/a/b/c", "/repo"), true);
  assert.equal(isContainedIn("/repo/../secret", "/repo"), false);
  assert.equal(isContainedIn("/repo/docs/../../secret", "/repo"), false);
  // The classic prefix bug: /repo-secret starts with /repo as a string but is not inside it.
  assert.equal(isContainedIn("/repo-secret", "/repo"), false);
});
