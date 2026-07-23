# Multi-Agent v2 Parity

This directory owns the model-facing v2 agent tools tracked by the
`task-tool-bridge` row in `parity/agent-surface-contract.json`.

## Tool Map

| Reference source                                          | Local target      | Model-facing tool       |
| --------------------------------------------------------- | ----------------- | ----------------------- |
| `core/src/tools/handlers/multi_agents_v2/spawn.rs`        | `spawn.ts`        | `spawn_agent`           |
| `core/src/tools/handlers/multi_agents_v2/wait.rs`         | `wait.ts`         | `wait_agent`            |
| `core/src/tools/handlers/multi_agents_v2/close_agent.rs`  | `close-agent.ts`  | `close_agent`           |
| `core/src/tools/handlers/multi_agents_v2/assign_task.rs`  | `assign-task.ts`  | `assign_task`           |
| `core/src/tools/handlers/multi_agents_v2/send_message.rs` | `send-message.ts` | `send_message`          |
| `core/src/tools/handlers/multi_agents_v2/list_agents.rs`  | `list-agents.ts`  | `list_agents`           |
| `core/src/tools/handlers/multi_agents_v2/message_tool.rs` | `message-tool.ts` | shared message dispatch |

The previous `followup_task` compatibility alias (`followup-task.ts`) has been
deleted — `assign_task` is the only trigger-turn spelling. Historical
transcripts that recorded `followup_task` calls still render via the
transcript's collab-tool suppression set.

## Guarded Behavior

- `assign_task` and `send_message` share strict `target` plus `message`
  validation and the same event envelope.
- `assign_task` atomically admits one correlated task only when its target is
  an idle reusable worker and its authenticated sender is a strict ancestor;
  busy, self-targeted, peer, and outstanding-assignment requests are rejected.
  `send_message` remains passive and does not trigger a turn.
- `assign_task` rejects assigning work to the root agent and does not enqueue
  root mail on that failure.
- Completed agents are terminal; only `idle` keep-alive workers are reusable.
- Reusable agents durably record one correlated completed, errored, interrupted,
  or NACK receipt per accepted task before projecting it to the parent.
- Omitting `fork_turns` is the documented clean-fork default; `all` is opt-in.
- `wait_agent` drains all delivered receipts and is therefore mutating. It has
  no target filter that could discard unrelated agents' messages.
- All v2 path resolution registers the current root thread before resolving
  relative or canonical targets.
- Nested tool identity is accepted only as a valid HMAC-signed
  `__agencSessionId` / `__agencSessionIdSig` pair for a known live agent.
  Missing halves, forged/mismatched signatures, and unknown signed sessions
  return `invalid-runtime-identity`; root fallback is allowed only when both
  internal fields are absent.
