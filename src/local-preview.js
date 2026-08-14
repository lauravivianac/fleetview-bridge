// Local-disk equivalent of the web app's lib/live-preview.js — finds an index.html straight
// off the paired repo's filesystem (optionally scoped to a focus folder) and inlines its
// local <link rel="stylesheet">/<script src> so it renders correctly from a single srcDoc
// blob, with no further requests back to the bridge for each asset. Same shape and limits as
// the Cloud version so both feel identical to use — this one just reads real files off disk
// instead of asking GitHub's API for a branch's tree.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ASSET_FILES = 6;
const MAX_TOTAL_BYTES = 400_000;
const MAX_SCAN_ENTRIES = 5000; // bail out on pathological repos rather than hang
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

/** Resolves an href/src relative to the html file that references it, same git-tree-style
 *  walk as lib/live-preview.js's resolveRelative — kept identical on purpose, not "improved",
 *  so a page behaves the same whether FleetView is reading it from GitHub or from disk. */
function resolveRelative(basePathRel, ref) {
  if (!ref || /^(https?:)?\/\//i.test(ref) || ref.startsWith("data:")) return null;
  const parts = basePathRel.split("/").filter(Boolean);
  parts.pop(); // drop the html filename itself, keep its directory
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

async function findIndexFiles(root, scopeDir) {
  const start = scopeDir ? path.join(root, scopeDir) : root;
  const results = [];
  let scanned = 0;

  async function walk(dir) {
    if (scanned > MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, symlink to nowhere) — skip, not fatal
    }
    for (const entry of entries) {
      if (scanned > MAX_SCAN_ENTRIES) return;
      scanned += 1;
      if (entry.isDirectory()) {
        // Dotdirs (.git, .next, .vercel, ...) and the usual build/dependency output — never
        // where a hand-authored index.html worth previewing would live, and often huge.
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase() === "index.html") {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  try {
    const st = await fs.stat(start);
    if (!st.isDirectory()) return [];
  } catch {
    return []; // scopeDir doesn't exist (yet) — not an error, just nothing to preview
  }
  await walk(start);
  return results;
}

/** @returns {Promise<{html, indexPath, updatedAt, assetsInlined}|null>} null = no index.html
 *  found anywhere under repoPath (or repoPath/folder, if scoped). */
export async function buildLocalPreviewHtml({ repoPath, folder }) {
  const files = await findIndexFiles(repoPath, folder);
  if (files.length === 0) return null;
  files.sort((a, b) => a.length - b.length); // shortest absolute path = closest to the folder root
  const indexFile = files[0];
  const indexPath = path.relative(repoPath, indexFile).split(path.sep).join("/");

  let html;
  let stat;
  try {
    [html, stat] = await Promise.all([fs.readFile(indexFile, "utf8"), fs.stat(indexFile)]);
  } catch {
    return null;
  }

  let budget = MAX_TOTAL_BYTES - html.length;
  let assetsInlined = 0;
  const repoRoot = path.resolve(repoPath);

  async function inlineOne(regex, wrap) {
    const matches = [...html.matchAll(regex)];
    for (const m of matches) {
      if (assetsInlined >= MAX_ASSET_FILES || budget <= 0) break;
      const resolvedRel = resolveRelative(indexPath, m[1]);
      if (!resolvedRel) continue;
      const resolvedAbs = path.resolve(repoRoot, resolvedRel);
      // Stay inside repoPath — a crafted "../../../etc/passwd"-style href in the HTML can't
      // walk this read outside the repo the bridge was told it's allowed to touch.
      if (resolvedAbs !== repoRoot && !resolvedAbs.startsWith(repoRoot + path.sep)) continue;
      let content;
      try {
        content = await fs.readFile(resolvedAbs, "utf8");
      } catch {
        continue; // asset referenced but missing/unreadable — leave the original tag as-is
      }
      budget -= content.length;
      assetsInlined += 1;
      html = html.replace(m[0], wrap(content));
    }
  }

  await inlineOne(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, (css) => `<style>\n${css}\n</style>`);
  await inlineOne(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi, (js) => `<script>\n${js}\n</script>`);

  return { html, indexPath, updatedAt: stat.mtime.toISOString(), assetsInlined };
}
