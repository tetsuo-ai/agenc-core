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

## ZC-35 Coverage Lock

Source anchors: `/home/tetsuo/git/openclaude` at commit
`0ca43335375beec6e58711b797d5b0c4bb5019b8`, `src/utils/swarm/**`.

Decision: the TypeScript swarm/teammate subsystem is a documented scope
reduction for AgenC's live runtime. AgenC carries the equivalent user-facing
coordination contract through Multi-Agent V2 tools, the thread manager, and the
agent mailbox rather than a separate visible pane/team runtime.

Carried behavior:
- model-facing spawn, wait, close, send-message, follow-up, and list tools
- root/child thread registration and parent-child routing
- mailbox delivery between agent threads without terminal pane coupling
- background task lifecycle output for spawned agents

Intentional reductions:
- tmux and iTerm pane orchestration, hidden-pane state, and pane layout
  management are not carried until AgenC has a user-visible team/pane surface.
- in-process teammate runner state is not duplicated because AgenC agent
  execution already flows through `delegate()`, `ThreadManager`, and
  `run-agent`.
- team files and teammate permission-sync mailboxes are not carried because
  AgenC's permission and background-agent policy are owned by the daemon,
  permissions, and agent-control subsystems.
