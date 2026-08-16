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
//     delegation, possibly Codex's own subagent-equivalent — but its field shape wasn't
//     confirmed to the same bar as the others; it's treated as a generic tool call here, not
//     given its own lane the way Claude's Agent/task_started gets one. Revisit once a real
//     transcript confirms the shape, same as claude-stream-parser.js's own inferred-not-witnessed
//     "subagent done" event was flagged for confirmation.
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

function summarizeItem(item) {
  if (item.type === "agent_message" || item.type === "reasoning") return (item.text || "").trim();
  if (item.type === "command_execution") return `→ Bash: ${String(item.command || "").slice(0, 100)}`;
  if (item.type === "file_change") {
    const files = (item.changes || []).map((c) => c.path).filter(Boolean);
    return `→ Edit: ${files.join(", ")}`;
  }
  if (item.type === "mcp_tool_call") return `→ ${item.tool || "MCP"}`;
  if (item.type === "web_search") return `→ WebSearch: ${String(item.query || "").slice(0, 100)}`;
  if (item.type === "collab_tool_call") return `→ ${item.tool || "Collab"}`;
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
