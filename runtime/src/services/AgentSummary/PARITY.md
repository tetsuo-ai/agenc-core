# Agent Summary Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source path -->

Primary source anchors:
- `src/services/AgentSummary/agentSummary.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/runAgent.ts#filterIncompleteToolCalls`
- `src/utils/forkedAgent.ts`

This directory owns the AgenC port of periodic subagent progress summarization:
- `agentSummary.ts` schedules non-overlapping summary forks, rebuilds current transcript context per tick, preserves cache-safe request parameters, denies all tool use through `canUseTool`, extracts concise assistant progress text, and aborts/ignores stale work on stop.
- `transcript.ts` converts native AgenC child-run transcript events into upstream-shaped summary messages with paired tool blocks.
- `agentSummary.test.ts` covers scheduling, transcript filtering, cache-safe fork parameters, tool denial, summary extraction, stop behavior, and stale result suppression.

Live integration is owned by AgenC task lifecycle code:
- `runtime/src/tasks/lifecycle.ts` stores `AgentProgress.summary` on live local-agent task snapshots without clobbering token/tool counts.
- `runtime/src/agents/run-agent.ts` captures cache-safe summary params from the real child session once provider, model, registry, cwd, and abort state are known.
- `runtime/src/agents/delegate.ts` records child-run transcript events onto `AgentThread`.
- `runtime/src/tasks/agent-thread.ts` starts and stops the summarizer for registered agent threads when those captured params arrive; it does not synthesize a lookalike cache key from unrelated session state.

S-12 follows the checklist's 1-2 sentence summary wording. This deliberately diverges from the donor's shorter progress-label prompt while preserving its scheduling, cache-safe fork, and tool-denial mechanics.
