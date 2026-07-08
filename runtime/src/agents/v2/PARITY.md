# Multi-Agent v2 Parity

This directory owns the model-facing v2 agent tools tracked by the
`task-tool-bridge` row in `parity/agent-surface-contract.json`.

## Tool Map

| Reference source | Local target | Model-facing tool |
| --- | --- | --- |
| `core/src/tools/handlers/multi_agents_v2/spawn.rs` | `spawn.ts` | `spawn_agent` |
| `core/src/tools/handlers/multi_agents_v2/wait.rs` | `wait.ts` | `wait_agent` |
| `core/src/tools/handlers/multi_agents_v2/close_agent.rs` | `close-agent.ts` | `close_agent` |
| `core/src/tools/handlers/multi_agents_v2/assign_task.rs` | `assign-task.ts` | `assign_task` |
| `core/src/tools/handlers/multi_agents_v2/send_message.rs` | `send-message.ts` | `send_message` |
| `core/src/tools/handlers/multi_agents_v2/list_agents.rs` | `list-agents.ts` | `list_agents` |
| `core/src/tools/handlers/multi_agents_v2/message_tool.rs` | `message-tool.ts` | shared message dispatch |

The previous `followup_task` compatibility alias (`followup-task.ts`) has been
deleted — `assign_task` is the only trigger-turn spelling. Historical
transcripts that recorded `followup_task` calls still render via the
transcript's collab-tool suppression set.

## Guarded Behavior

- `assign_task` and `send_message` share strict `target` plus `message`
  validation and the same event envelope.
- `assign_task` sets `triggerTurn: true`; `send_message` sets
  `triggerTurn: false`.
- `assign_task` rejects assigning work to the root agent and does not enqueue
  root mail on that failure.
- Completed live agents remain reusable for later trigger-turn work.
- All v2 path resolution registers the current root thread before resolving
  relative or canonical targets.
