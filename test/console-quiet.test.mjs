// The bridge's terminal says what the BRIDGE did, never what the person typed.
//
// ---- WHAT WAS REPORTED ----
//
// A developer's terminal, scrolled back over a night's work:
//
//   [03:42:45] [dispatch:claude] /Users/…/calculator: quiero que mejoremos la calculadora
//   [03:48:14] [dispatch:claude] /Users/…/calculator: Athena, you are leading this one. Someone…
//   [12:09:37] [dispatch:claude] /Users/…/calculator: Quiero mejorar la gui de esta calculadora
//
// Every prompt anybody sent, echoed into a log that scrolls up the screen and sits in whatever
// captured that terminal. Asked for in as many words: the console carries the bridge's own
// execution and nothing else — the conversation belongs in FleetView's screens, and writing it
// down a second time here is the same objection as writing it into the repository.
//
// ---- AND THE HALF THAT WAS MISSING ----
//
// This window printed a dispatch ARRIVING and then nothing at all: no outcome, no duration, no
// failure. A run that had finished half an hour ago looked exactly like one still going, which
// is the state somebody was staring at when they reported the console "no longer working".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const code = server
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

test("no prompt text reaches the log, in any shape", () => {
  // The exact line that did it, and every near relative of it. `task` and `finalTask` are the
  // person's words; neither may appear inside a log() call.
  const logCalls = [...code.matchAll(/log\(([^;]*?)\);/gs)].map((m) => m[1]);
  assert.ok(logCalls.length >= 5, "the log calls could not be found — check this extraction");
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\btask\b/, `a log call carries the task: ${call.trim().slice(0, 80)}`);
    assert.doesNotMatch(call, /\bfinalTask\b(?!\.length)/, `a log call carries the task text: ${call.trim().slice(0, 80)}`);
    assert.doesNotMatch(call, /\bdescription\b/, `a log call carries a description: ${call.trim().slice(0, 80)}`);
  }
});

test("what it does print is the run, not the conversation", () => {
  // Which CLI, which repository, an id to match start to end, and a SIZE standing in for the
  // text — a 40-character task and a 9,000-character one are different situations, and one
  // number says so without quoting a word.
  assert.match(code, /run \$\{runId\}, \$\{finalTask\.length\} chars/);
  assert.match(code, /const runId = Math\.random\(\)/);
});

test("the outcome is reported, which it never was", () => {
  assert.match(code, /run \$\{runId\} finished in \$\{Math\.round\(\(Date\.now\(\) - startedAt\)/);
  assert.match(code, /file\$\{changedFiles\.length === 1 \? "" : "s"\} changed/);
  assert.match(code, /run \$\{runId\} failed after/);
  // Start and end carry the same id, or a terminal with two runs in flight cannot be read.
  assert.ok([...code.matchAll(/run \$\{runId\}/g)].length >= 3);
});

test("a failure's own words are redacted before they are printed", () => {
  // The same rule the login path already applies: long opaque strings in provider output are
  // almost always credentials.
  assert.match(code, /failed after[\s\S]{0,120}redactSecrets\(String\(err\.message \|\| err\)\)/);
});

test("the stream's own status still carries the words a person reads", () => {
  // Nothing here reduces what the CONSOLE shows. The status event is how FleetView's screen says
  // "Starting claude…" the moment a run begins; the terminal is a different audience.
  assert.match(code, /send\(\{ type: "status", text: `Starting \$\{body\.provider\}…` \}\)/);
});
