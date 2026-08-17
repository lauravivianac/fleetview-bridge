// Parses `codex exec --json`'s JSONL stdout into the same normalized turn-event shape
// claude-stream-parser.js produces ({ role, text, toolNames, timestamp }), so
// trace-builder.js and the browser UI (components/LocalAgentChat.js) can treat a Codex
// dispatch the same way as a Claude one — a real tool-call histogram and turn count, instead
// of the raw-text-chunk fallback Codex has used until now.
//
// VERIFIED against openai/codex's own Rust source (raw.githubusercontent.com — no codex
// binary and no real machine in this sandbox to capture an actual --json transcript, same
// caveat every other unverified piece of codex.js already carries):
//   - `--json` (alias `--experimental-json`) is real — codex-rs/exec/src/cli.rs's own doc
//     comment: "Print events to stdout as JSONL."
//   - Event shape from codex-rs/exec/src/exec_events.rs's `ThreadEvent` enum, emitted one
//     per line via `serde_json::to_string(&event)` (event_processor_with_jsonl_output.rs).
//     No timestamp field on any event — same gap Claude's stream-json has, handled the same
//     way: feed() stamps receipt time as each line arrives live, not a guess.
//   - Real top-level `type` tags, confirmed against actual quoted CLI output (not just the
//     Rust struct names, which don't show serde's own tag-rename): "thread.started",
//     "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated",
//     "item.completed", "error".
//   - Item types (the item.type discriminant) from ThreadItemDetails' variants:
//     "agent_message" {text}, "reasoning" {text}, "command_execution" {command,
//     aggregated_output, exit_code, status}, "file_change" {changes, status}, "mcp_tool_call"
//     {server, tool, arguments, result, error, status}, "web_search" {id, query, action},
//     "todo_list" {items}. A "collab_tool_call" type also exists — thread-to-thread
//     delegation, confirmed to actually fire in practice (real dispatches show the
//     orchestrator narrating "convocando a X como subagente independiente" right before one),
//     but its exact field shape still isn't confirmed to the same bar as the others.
//     summarizeCollabToolCall() below handles it defensively rather than assuming a shape —
//     see that function for why. Used to get the same generic `→ ` tool-call treatment as
//     mcp_tool_call, which the browser silently hides from the chat — that was the actual
//     reason a real delegated role's work looked like it never happened. Revisit and tighten
//     once a real transcript confirms the actual field, same as claude-stream-parser.js's own
//     inferred-not-witnessed "subagent done" event was flagged for confirmation.
//
// STRUCTURALLY CONFIRMED, NOT LIVE-VERIFIED (Elena's terms). The first real Codex Local
// dispatch run with --json should be checked against these assumptions before trusting them
// the way claude-stream-parser.js's are now trusted.

function toolNameForItem(item) {
  if (item.type === "command_execution") return "Bash";
  if (item.type === "file_change") return "Edit";
  if (item.type === "mcp_tool_call") return item.tool || "MCP";
  if (item.type === "web_search") return "WebSearch";
  if (item.type === "collab_tool_call") return item.tool || "Collab";
  return null;
}

// collab_tool_call is Codex's own delegation mechanism — thread-to-thread, i.e. what the
// CLAUDE.md protocol asks it to use as its `spawn_agent` tool for looping in another role.
// Real evidence (two separate real dispatches) shows the orchestrator narrating "convocando a
// Alex/Daniel como subagente independiente" and then... nothing — no separate turn for that
// role ever appeared, because this item type used to get the same `→ ` prefix as an ordinary
// tool call, which the browser (LocalAgentChat.js's stripToolCallLines) hides from the chat
// entirely. Whatever the delegated role actually said or found was being thrown away, not just
// summarized — the single biggest reason delegation looked like it wasn't happening.
//
// The field shape here is still NOT confirmed against a real transcript (same honesty bar as
// the rest of this file) — codex-rs's source didn't give a confident answer, and there's no
// codex binary in this sandbox to capture one. So this reads defensively: try every field name
// a result might plausibly live under (guessing from mcp_tool_call's own confirmed shape,
// since collab_tool_call is presumably siblings with it in the same Rust enum), and degrade to
// a visible "still working" line rather than nothing or a raw `undefined` if none of them hit.
// Revisit and tighten once a real transcript confirms the actual field.
function summarizeCollabToolCall(item) {
  const who = item.tool || "another role";
  const resultText = [item.result, item.output, item.response, item.summary, item.text]
    .find((v) => typeof v === "string" && v.trim());
  // Real content from the delegated role: format it as `**Name:** message` — the exact same
  // convention a role uses when it writes for itself (see lib/team-room.js in the main repo).
  // That's deliberate, not decoration: it's what lets this flow through the browser's existing
  // splitIntoRoleTurns() and land as a real, separately-avatared turn under Alex's own name —
  // the actual fix for "Alex never shows as active" — instead of a one-off custom format only
  // this code path understands. If `who` doesn't happen to match a real roster name, that
  // existing parser already degrades safely (falls back to the Coordinator or an unattributed
  // turn) — never worse than before, and correct whenever it does match.
  if (resultText) return `**${who}:** ${resultText.trim()}`;
  // No real content yet — nothing to attribute as speech, so this stays a plain status line
  // (not the `**Name:**` format) rather than putting words in Alex's mouth he hasn't said.
  if (item.status && item.status !== "completed") return `🤝 Delegating to ${who}… (${item.status})`;
  return `🤝 Delegated to ${who} — no result text in this event (unconfirmed field shape; see codex-stream-parser.js).`;
}

function summarizeItem(item) {
  // "reasoning" items used to be treated exactly like "agent_message" — the model's real,
  // finished response — and shown as a spoken chat turn. They aren't the same thing: reasoning
  // is Codex's internal chain-of-thought before it acts, the same category as Claude's own
  // `thinking` content blocks or OpenAI's reasoning summaries — narration to itself, not a
  // message to the user. In practice that narration frequently walks through raw shell/code it's
  // about to run ("if [ -f config/project.yml ]; then printf...") — confirmed against a real
  // screenshot from a real dispatch where exactly that kind of fragment leaked into the chat
  // window as if it were something a team member said. Dropped entirely (same treatment as
  // todo_list below) rather than shown or reworded — there's no reliable way to tell "reasoning
  // that happens to restate something worth saying" from "reasoning that's just raw exploration"
  // without guessing, and the actual spoken response still comes through via agent_message
  // regardless of whether reasoning is shown.
  if (item.type === "agent_message") return (item.text || "").trim();
  if (item.type === "command_execution") return `→ Bash: ${String(item.command || "").slice(0, 100)}`;
  if (item.type === "file_change") {
    const files = (item.changes || []).map((c) => c.path).filter(Boolean);
    return `→ Edit: ${files.join(", ")}`;
  }
  if (item.type === "mcp_tool_call") return `→ ${item.tool || "MCP"}`;
  if (item.type === "web_search") return `→ WebSearch: ${String(item.query || "").slice(0, 100)}`;
  if (item.type === "collab_tool_call") return summarizeCollabToolCall(item);
  if (item.type === "error") return `Error: ${item.message || ""}`;
  return null; // todo_list and anything else unrecognized — bookkeeping, not a renderable turn
}

export class CodexStreamParser {
  // Parses one JSONL line, returns an array of normalized turn events (usually 0 or 1).
  feed(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return []; // a non-JSON or partial line — nothing to emit
    }
    const timestamp = new Date().toISOString();

    if (obj.type === "item.completed" && obj.item) {
      const text = summarizeItem(obj.item);
      if (!text) return [];
      const toolName = toolNameForItem(obj.item);
      return [{ role: "orchestrator", text, toolNames: toolName ? [toolName] : [], timestamp }];
    }

    if (obj.type === "error") {
      return [{ role: "orchestrator", text: `Error: ${obj.message || "unknown error"}`, toolNames: [], timestamp }];
    }

    // thread.started/turn.started/turn.completed/turn.failed/item.started/item.updated —
    // lifecycle bookkeeping; item.completed already carries each item's final state.
    return [];
  }
}
