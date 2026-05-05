# Multi-Agent V2 Surface Parity

Upstream reference: `/home/tetsuo/git/codex` at commit <!-- branding-scan: allow local donor parity citation -->
`c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:

- `codex-rs/core/src/tools/handlers/multi_agents_v2.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs` <!-- branding-scan: allow local donor parity citation -->
- `codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs` <!-- branding-scan: allow local donor parity citation -->

This directory owns the TypeScript model-facing Multi-Agent V2 handler surface:

- `index.ts` builds the registered `spawn_agent`, `wait_agent`,
  `close_agent`, `followup_task`, `send_message`, and `list_agents` tools.
- `spawn.ts` validates strict spawn arguments, resolves fork mode, emits spawn
  lifecycle events, launches through `delegate()`, and registers background
  task lifecycle output.
- `wait.ts` owns mailbox-change wait semantics and timeout clamping.
- `close-agent.ts` resolves and closes spawned agents while returning the
  previous status.
- `message-tool.ts`, `send-message.ts`, and `followup-task.ts` own the shared
  text-only message delivery path, including queue-only versus turn-triggering
  delivery.
- `list-agents.ts` returns snake_case agent list entries with optional
  task-path-prefix filtering.
- `common.ts` contains handler-local validation, result, event, telemetry, and
  agent-resolution helpers shared by the tool handlers.

The lower-level runtime ownership remains in `runtime/src/agents/control.ts`,
`runtime/src/agents/delegate.ts`, `runtime/src/agents/thread.ts`, and
`runtime/src/agents/run-agent.ts`; this directory is the model-facing handler
layer over those primitives.
