// Token generation/verification and the repo allow-list check — the two things standing
// between "a browser tab can dispatch real commands on this machine" and "any web page that
// happens to guess localhost:4700 can." See docs/local-bridge-design.md §3.
import crypto from "node:crypto";
import path from "node:path";

export function generatePairingCode() {
  // Six digits, printed to the bridge's own terminal — never sent anywhere over the network
  // except back to FleetView in the one /pair exchange that redeems it.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// The bridge's default allow-list when --origin isn't passed: localhost dev origins (any
// port — Next.js dev servers wander) and *.vercel.app, since that's where FleetView actually
// runs. Not `*` — a page on an unrelated domain still gets no CORS header and can't read the
// response, even though (like any localhost server) it could still blindly send a request.
export function isOriginAllowed(origin, explicitOrigin) {
  if (!origin) return false;
  if (explicitOrigin) return origin === explicitOrigin;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return true;
  return false;
}

// Every repoPath a dispatch/login request names must resolve (after following .. and symlink
// segments in the string form, not just string-prefix matching) to one of the repos the
// bridge was started with. A malicious page that talks its way past pairing still can't point
// dispatch at an arbitrary path on disk.
export function isRepoAllowed(repoPath, allowedRepos) {
  if (!repoPath || typeof repoPath !== "string") return false;
  const resolved = path.resolve(repoPath);
  return allowedRepos.some((allowed) => resolved === path.resolve(allowed));
}
