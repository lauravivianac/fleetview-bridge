// Token generation/verification and the repo allow-list check — the two things standing
// between "a browser tab can dispatch real commands on this machine" and "any web page that
// happens to guess localhost:4700 can." See docs/local-bridge-design.md §3.
import crypto from "node:crypto";
import path from "node:path";

// The pairing code is the ENTIRE security model of this bridge: whoever redeems it can
// dispatch, and dispatch runs the agent CLI with permission prompts bypassed and the
// developer's whole environment inherited. So it has to survive being guessed at speed.
//
// Six digits did not. A real run against this server managed ~104 sequential attempts per
// second over a single curl connection — the whole 10^6 keyspace in hours, and far less from a
// browser issuing parallel fetches over loopback. 10^6 is a keyspace, not a secret, once
// nothing throttles guessing.
//
// Eight characters from an unambiguous base32 alphabet is ~41 bits, which is infeasible to
// brute force even if the throttle and the expiry below are both defeated. Ambiguous glyphs
// (0/O, 1/I/L) are left out because a human reads this off a terminal and types it into a
// browser.
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;

// How long a printed code stays redeemable. A bridge left running all day used to keep its
// code valid for the whole session; the window only needs to cover walking back to the browser.
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

// Wrong guesses tolerated before pairing is shut off until the process restarts. Deliberately
// unforgiving: a human typing a code off their own screen does not need five tries, and an
// attacker needs thousands.
export const PAIRING_MAX_ATTEMPTS = 5;

export function generatePairingCode() {
  // Printed to the bridge's own terminal — never sent anywhere over the network except back to
  // FleetView in the one /pair exchange that redeems it.
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    // randomInt per character rather than a modulo of the byte, which would bias toward the
    // first 8 letters of a 31-character alphabet.
    out += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return out;
}

export function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function timingSafeEqual(a, b) {
  // Empty is never a match. Without this, timingSafeEqual(undefined, undefined) compared two
  // zero-length buffers and returned TRUE — so any call site that forgot to check the secret
  // was set first would authenticate a caller who sent no credential at all. Every current
  // call site does guard (`sessionToken && ...`, `!pairingCode || ...`), which is the only
  // reason that was never live; relying on all future ones to remember is not a security
  // model. Refusing empty here makes the guard belt-and-braces instead of load-bearing.
  const strA = typeof a === "string" ? a : a == null ? "" : String(a);
  const strB = typeof b === "string" ? b : b == null ? "" : String(b);
  if (!strA || !strB) return false;
  const bufA = Buffer.from(strA);
  const bufB = Buffer.from(strB);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Which web origins may talk to this bridge at all. This is the outer boundary: past it sits a
// pairing code, and past that sits arbitrary command execution as the developer.
//
// It used to accept any `*.vercel.app` subdomain. Vercel hands those out to anyone with a free
// account, so `https://whatever-an-attacker-deploys.vercel.app` was a trusted origin by default
// — and the quickstart never passes --origin, so that default is what everyone runs. Any
// `http://localhost:<port>` was trusted too: any dev server, any locally served HTML the
// developer happens to open.
//
// Now: nothing is trusted by default. There is no FleetView production hostname anywhere in
// this repository, so picking one here would be a guess baked into a security boundary — and a
// wrong guess would either lock everyone out or, worse, trust someone else's domain. The
// operator names their own origin with --origin, or opts into localhost explicitly for
// development. An empty list means every request is refused, which is the safe way to be wrong.
const DEFAULT_ALLOWED_ORIGINS = [];

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isOriginAllowed(origin, explicitOrigin, { allowLocalhost = false } = {}) {
  // A request with no Origin header at all is refused. This is what actually defeats DNS
  // rebinding — a rebound host either sends its own Origin (not on the list) or none.
  if (!origin) return false;
  if (explicitOrigin) {
    // --origin may name more than one, comma-separated. Exact match only.
    return String(explicitOrigin)
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
      .includes(origin);
  }
  if (allowLocalhost && LOCALHOST_ORIGIN.test(origin)) return true;
  return DEFAULT_ALLOWED_ORIGINS.includes(origin);
}

// Every repoPath a dispatch/login request names must resolve to one of the repos the bridge was
// started with. A malicious page that talks its way past pairing still can't point dispatch at
// an arbitrary path on disk.
//
// Note what this does and does not do: path.resolve is purely lexical, so it collapses `..`
// but does NOT follow symlinks — an earlier comment here claimed it did. That claim was
// harmless only because the comparison below is strict equality, leaving no prefix for a
// symlink to smuggle anything past. If this is ever relaxed to a prefix match, it needs
// fs.realpathSync on both sides first.
export function isRepoAllowed(repoPath, allowedRepos) {
  if (!repoPath || typeof repoPath !== "string") return false;
  const resolved = path.resolve(repoPath);
  return allowedRepos.some((allowed) => resolved === path.resolve(allowed));
}

// Is `child` the same as, or inside, `parent`? The check every path that leaves the allow-list
// has to make. attachments.js and local-preview.js's asset walk already did this correctly;
// /preview's own folder parameter did not, which let `folder=../secret` read an index.html
// outside the repo entirely.
export function isContainedIn(child, parent) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return (
    resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep)
  );
}
