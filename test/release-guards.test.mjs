// The release workflow's guards, in a test rather than only in the file they guard.
//
// ---- WHY THIS EXISTS ----
//
// The previous release was published by hand from a laptop, and its registry record points at a
// commit that was never pushed — so nobody could verify from the outside that the code users were
// running was the code in this repository. The workflow was written to make that check automatic.
//
// It now has a BUTTON as well as a tag push, because a release should not wait on whoever happens
// to have a terminal with push rights open: it did, once, and a merged version sat unpublished.
// A button is also the normal way a workflow like this quietly loses its guarantees, so each one
// is asserted here — a comment explaining a check is not a check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yaml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
// Comments stripped: this file explains its own rules at length, and a test that cannot tell prose
// from configuration would pass on the explanation of a check somebody deleted.
const config = yaml.replace(/^\s*#.*$/gm, "");

test("both ways in, and the tag push is untouched", () => {
  assert.match(config, /on:\s*\n\s*push:\s*\n\s*tags: \["v\*"\]\s*\n\s*workflow_dispatch:/);
});

test("the button publishes from main only", () => {
  // Reviewed code. Without this the button publishes any branch somebody can select in the UI,
  // which is precisely the hole the tag-on-main check closes on the other path.
  assert.match(config, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(config, /if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then/);
  assert.match(config, /exit 1/);
});

test("the button cannot republish a version", () => {
  assert.match(config, /npm view "fleetview-bridge@\$pkg" version/);
  assert.match(config, /is already on the registry/);
});

test("the annotated tag has a tagger, or it exits 128 before anything happens", () => {
  // Release #2 died here: actions/checkout sets up auth but not identity, and `git tag -a` needs
  // a tagger. Reproduced in a scratch repository — annotated fails, lightweight succeeds. The
  // lightweight tag is the other way out and is the wrong one: the message on the tag is what
  // somebody reads months later to know what that version was.
  assert.match(config, /git config user\.name "github-actions\[bot\]"/);
  assert.match(config, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
  // In the same step as the tag, and before it — a config set in another step does not survive.
  const step = config.slice(config.indexOf("Tag this commit"), config.indexOf("- run: npm test"));
  assert.ok(step.indexOf("git config user.email") < step.indexOf("git tag -a"), "identity is set after the tag is made");
});

test("the button leaves a tag on the exact commit it published", () => {
  // The whole reason this workflow exists: a registry record anybody can check out. A publish
  // with no tag would be the hand-published release again, with a nicer origin.
  assert.match(config, /git tag -a "v\$pkg" -m "\$pkg" "\$GITHUB_SHA"/);
  assert.match(config, /git push origin "refs\/tags\/v\$pkg"/);
  // And it refuses rather than publishing when the tag already names a different commit.
  assert.match(config, /\[ "\$existing" != "\$GITHUB_SHA" \]/);
});

test("the tag path keeps both of its own checks", () => {
  assert.match(config, /tag="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(config, /does not match package\.json/);
  assert.match(config, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  // Each is scoped to the push event now, so neither runs — or silently passes — on a dispatch.
  assert.equal([...config.matchAll(/if: github\.event_name == 'push'/g)].length, 2);
});

test("nothing publishes without the tests and the provenance", () => {
  assert.match(config, /- run: npm test/);
  assert.match(config, /npm publish --provenance --access public/);
  assert.match(config, /id-token: write/);
  // contents: write is what lets the dispatch path create the tag, and it is the one permission
  // this file did not need before — worth failing over if it ever disappears with the step.
  assert.match(config, /contents: write/);
});
