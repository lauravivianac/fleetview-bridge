// Builds a compact trace summary from the timestamped turn events a dispatch produced — the
// same events claude-stream-parser.js already emits to drive the live chat UI, just also kept
// and summarized once the run finishes. This is the "$0 AI stack" observability gap FleetView's
// architecture review found: the raw material (which tool ran, how many subagents, how long
// each took) was already flowing through the bridge and getting thrown away after rendering a
// chat bubble. No new dependency, no new service — just not discarding what we already have.
//
// Codex's provider (providers/codex.js) doesn't emit structured events yet — record() still
// counts its raw text chunks so a Codex trace isn't empty, just coarser: elapsed time and an
// event count, no tool/subagent breakdown. Real per-tool tracing for Codex needs its own
// investigation into whatever structured-output mode `codex exec` has, if any — not guessed here.
export function createTraceRecorder() {
  const startedAt = Date.now();
  const toolCalls = {};
  const subagents = new Map(); // toolUseId -> { description, startedAt, endedAt }
  let orchestratorTurns = 0;
  let rawChunks = 0;
  let eventCount = 0;

  function countTools(names) {
    for (const name of names || []) toolCalls[name] = (toolCalls[name] || 0) + 1;
  }

  function record(event) {
    eventCount++;
    if (event.role === "raw") {
      rawChunks++;
      return;
    }
    if (event.role === "orchestrator") {
      orchestratorTurns++;
      countTools(event.toolNames);
      return;
    }
    if (event.role === "subagent") {
      const lane = subagents.get(event.toolUseId) || { description: null, startedAt: null, endedAt: null };
      if (event.description) lane.description = event.description;
      if (event.subagentEvent === "start") lane.startedAt = event.timestamp;
      if (event.subagentEvent === "done") lane.endedAt = event.timestamp;
      if (event.subagentEvent === "message") countTools(event.toolNames);
      subagents.set(event.toolUseId, lane);
    }
  }

  function summarize() {
    return {
      durationMs: Date.now() - startedAt,
      eventCount,
      orchestratorTurns,
      toolCalls: { ...toolCalls },
      subagents: [...subagents.values()].map((s) => ({
        description: s.description,
        durationMs: s.startedAt && s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : null,
      })),
      rawChunks,
    };
  }

  return { record, summarize };
}
