// Parses `claude -p --output-format stream-json --include-partial-messages --verbose`'s
// JSONL stdout into normalized turn events FleetView can render as subagent "lanes" — the
// same structural signal VS Code's own Claude Code extension reads to show subagent activity
// live, not a FleetView invention. Verified against real output pasted back from a live
// machine (2026-08-14, Claude Code CLI v2.1.79) — not guessed. Key facts that shape this:
//
//   - Every event carries `parent_tool_use_id`: `null` for the top-level orchestrator, or the
//     `tool_use_id` of the `Agent` tool call that spawned a subagent, for everything that
//     happened inside it. That's the grouping key for "which lane does this belong to."
//   - `{"type":"system","subtype":"task_started","task_id","tool_use_id","description",...}`
//     marks a subagent lane starting — `description` is what to label it.
//   - `{"type":"system","subtype":"task_progress","task_id","tool_use_id","last_tool_name",...}`
//     is a live "what it's doing right now" update for that lane.
//   - `{"type":"assistant","message":{...},"parent_tool_use_id":...}` carries a fully-assembled
//     turn (text and/or tool_use content blocks) — this is what gets rendered, not the raw
//     `stream_event` character-by-character deltas, which are too granular for a UI and are
//     ignored here.
//   - No dedicated "subagent finished" event was captured in the one real transcript this was
//     built against (it was still mid-task when the paste ended) — inferred instead from the
//     matching `tool_result` arriving in a top-level (`parent_tool_use_id: null`) `user`
//     message, keyed by the same `tool_use_id`. Flagged here as the one inferred-not-witnessed
//     part of this parser; worth confirming on the next real run that reaches completion.

function summarizeToolUse(name, input) {
  if (name === "Agent") return null; // surfaced separately via task_started, not as a turn line
  const val = (x, max = 100) => (typeof x === "string" ? x.slice(0, max) : "");
  if (name === "Bash") return `→ Bash: ${val(input?.command)}`;
  if (name === "Read") return `→ Read: ${val(input?.file_path)}`;
  if (name === "Write") return `→ Write: ${val(input?.file_path)}`;
  if (name === "Edit") return `→ Edit: ${val(input?.file_path)}`;
  if (name === "Grep") return `→ Grep: ${val(input?.pattern)}`;
  if (name === "Glob") return `→ Glob: ${val(input?.pattern)}`;
  return `→ ${name}`;
}

function extractText(content) {
  const parts = [];
  for (const block of content || []) {
    if (block.type === "text" && block.text?.trim()) parts.push(block.text.trim());
    if (block.type === "tool_use") {
      const label = summarizeToolUse(block.name, block.input);
      if (label) parts.push(label);
    }
  }
  return parts.join("\n").trim();
}

export class ClaudeStreamParser {
  constructor() {
    this.activeSubagents = new Map(); // toolUseId -> { taskId, description }
  }

  // Parses one JSONL line, returns an array of normalized turn events (usually 0 or 1).
  feed(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return []; // a non-JSON or partial line — nothing to emit
    }

    if (obj.type === "system" && obj.subtype === "task_started") {
      this.activeSubagents.set(obj.tool_use_id, { taskId: obj.task_id, description: obj.description });
      return [{ role: "subagent", toolUseId: obj.tool_use_id, subagentEvent: "start", description: obj.description }];
    }

    if (obj.type === "system" && obj.subtype === "task_progress") {
      return [{
        role: "subagent",
        toolUseId: obj.tool_use_id,
        subagentEvent: "progress",
        description: this.activeSubagents.get(obj.tool_use_id)?.description,
        lastTool: obj.last_tool_name,
      }];
    }

    if (obj.type === "assistant" && obj.message) {
      const text = extractText(obj.message.content);
      if (!text) return [];
      if (!obj.parent_tool_use_id) {
        return [{ role: "orchestrator", text }];
      }
      return [{ role: "subagent", toolUseId: obj.parent_tool_use_id, subagentEvent: "message", text }];
    }

    // Inferred (see file header): a top-level tool_result whose id matches an active subagent
    // means that subagent's Task call has returned.
    if (obj.type === "user" && !obj.parent_tool_use_id && Array.isArray(obj.message?.content)) {
      const done = [];
      for (const block of obj.message.content) {
        if (block.type === "tool_result" && this.activeSubagents.has(block.tool_use_id)) {
          this.activeSubagents.delete(block.tool_use_id);
          done.push({ role: "subagent", toolUseId: block.tool_use_id, subagentEvent: "done" });
        }
      }
      return done;
    }

    return []; // stream_event deltas, init, rate_limit_event, etc. — not renderable turns
  }
}
