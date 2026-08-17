// Saves files attached to a Local dispatch onto disk inside the paired repo, so the CLI can
// actually see them — a dispatch only ever gets a text task, there's no other channel to hand
// it binary data. Then hands back a short block of text naming where each one landed, meant to
// be appended to the task before dispatch, so the CLI knows to look at them before starting.
//
// Deliberately conservative: small count/size caps (loopback-only or not, an unbounded base64
// body is still a real way to make a Node process choke on memory), filenames sanitized to a
// safe subset before ever touching the filesystem (a crafted "../../../etc/passwd"-style name
// can't walk outside the attachments folder), and every written path re-verified to resolve
// inside repoPath — same containment check local-preview.js already uses for exactly the same
// reason (a crafted href/src in HTML can't read outside the repo the bridge was told it's
// allowed to touch; the same principle applies here to writes, not reads).
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 6_000_000; // ~6MB decoded, per file
export const MAX_TOTAL_BYTES = 18_000_000; // ~18MB decoded, whole request

const ATTACHMENTS_DIR = ".fleetview/attachments";
const GITIGNORE_MARKER = ".fleetview/";

// Strips any directory component outright (path.basename), then keeps only a conservative safe
// character set — nothing here can produce ".." or a path separator, so there's no traversal
// to construct even before the containment re-check below runs.
function sanitizeFileName(name) {
  const base = path.basename(String(name || "file"));
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "file";
}

// Attachments are working scratch space, never meant to be committed — an agent running `git
// add -A` shouldn't accidentally pick up someone's reference screenshot as a tracked file.
async function ensureGitignored(repoRoot) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // No .gitignore yet — fine, one gets created below.
  }
  if (content.split("\n").some((line) => line.trim() === GITIGNORE_MARKER || line.trim() === ".fleetview")) {
    return; // already ignored, don't append a duplicate entry on every dispatch
  }
  const sep = content && !content.endsWith("\n") ? "\n" : "";
  const addition = `${sep}\n# FleetView Local dispatch scratch space — never meant to be committed\n${GITIGNORE_MARKER}\n`;
  await fs.writeFile(gitignorePath, content + addition, "utf8");
}

/** Validates and writes `attachments` (from the /dispatch request body — each
 *  { name, mimeType, dataBase64 }) into <repoPath>/.fleetview/attachments/. Returns
 *  { taskAddendum, savedCount } — taskAddendum is a text block to append to the task, empty
 *  if there was nothing to attach. Throws with a specific, actionable message on anything
 *  invalid or over a limit, rather than silently dropping or truncating a file. */
export async function saveAttachments(repoPath, attachments) {
  if (!attachments || attachments.length === 0) return { taskAddendum: "", savedCount: 0 };
  if (!Array.isArray(attachments)) throw new Error("attachments must be an array.");
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS}).`);
  }

  const repoRoot = path.resolve(repoPath);
  const dir = path.join(repoRoot, ATTACHMENTS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await ensureGitignored(repoRoot);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let totalBytes = 0;
  const lines = ["Attached files — already saved to disk, look at them before you start:"];

  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    if (!a?.dataBase64 || typeof a.dataBase64 !== "string") {
      throw new Error(`Attachment ${i + 1} has no data.`);
    }
    let buf;
    try {
      buf = Buffer.from(a.dataBase64, "base64");
    } catch {
      throw new Error(`Attachment ${i + 1} isn't valid base64.`);
    }
    if (buf.length === 0) throw new Error(`Attachment ${i + 1} is empty.`);
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment ${i + 1} (${a.name || "unnamed"}) is too large — max ${Math.round(MAX_ATTACHMENT_BYTES / 1_000_000)}MB per file.`
      );
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Attachments together are too large — max ${Math.round(MAX_TOTAL_BYTES / 1_000_000)}MB total.`);
    }

    const safeName = sanitizeFileName(a.name);
    const fileName = `${stamp}-${i}-${safeName}`;
    const filePath = path.join(dir, fileName);
    const resolvedFilePath = path.resolve(filePath);
    // Belt-and-suspenders: sanitizeFileName already can't produce a traversal, but re-verify
    // the final resolved path is still inside repoRoot before ever writing anything to disk —
    // the same discipline every other filesystem write in this codebase already holds itself to.
    if (resolvedFilePath !== repoRoot && !resolvedFilePath.startsWith(repoRoot + path.sep)) {
      throw new Error(`Attachment ${i + 1} resolved outside the repo — refused.`);
    }

    await fs.writeFile(filePath, buf);
    const relPath = path.relative(repoRoot, filePath).split(path.sep).join("/");
    lines.push(`- \`${relPath}\` (${a.mimeType || "unknown type"}, ${Math.round(buf.length / 1024)}KB)`);
  }

  return { taskAddendum: lines.join("\n"), savedCount: attachments.length };
}
