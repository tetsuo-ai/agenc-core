# Codex Agent Layer Parity

Upstream reference: `/home/tetsuo/git/codex` at commit
`a9f75e5cda2d6ff469a859baf8d2f50b9b04944a`.

Primary source anchors:

- `codex-rs/core/src/agent/control.rs`
- `codex-rs/core/src/thread_manager.rs`
- `codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_tests.rs`
- `codex-rs/core/src/agent/control_tests.rs`
- `codex-rs/state/src/model/graph.rs`

This directory owns the TypeScript port of Codex's agent and thread-manager
control semantics:

- `thread-manager.ts` is the lifecycle owner for root and child thread handles,
  thread-created notifications, status routing, bounded shutdown, subtree
  lookup, and manager-owned operation dispatch.
- `control.ts` coordinates tree metadata, spawn reservations, send/interrupt,
  close vs session shutdown edge status, rollout-backed resume, and descendant
  reopening.
- `registry.ts`, `mailbox.ts`, and `status.ts` mirror the Codex control-plane
  state visible to model-facing agent tools.
- `fork-context.ts` builds forked child history from rollout-backed parent state
  when available.
- The visible `spawn_agent` model-facing tool launches through `delegate()`, so
  spawned agents reserve a live handle, fork context, start the child run loop,
  and expose a joinable `AgentThread`.

Tool contract:

- `resume_agent` remains a hidden/deferred compatibility tool. It is not exposed
  in the default strict Codex v2 tool list.
- The strict legacy `resume_agent` input shape is `{ id: string }` and returns
  `{ status }`.
- AgenC compatibility aliases `{ target }`, `{ agent_id }`, and `{ agentId }`
  normalize to the same thread id path before dispatch.
- Live agents return current control-plane status. Closed rollout-backed agents
  resume through `AgentControl.resumeAgentFromRollout(...)`, which rehydrates
  the root handle and breadth-first open descendants from persisted
  thread-spawn edges. Closed descendants stay closed.

Intentional TypeScript/runtime adaptations:

- AgenC child execution still runs through the existing `run-agent.ts`
  child-session runner. The manager owns the live thread handle and all
  model-facing routing goes through that managed handle, but the lower-level
  provider loop remains the AgenC TypeScript session loop.
- Persisted thread-spawn edges are stored by AgenC `RolloutStore` as a
  Codex-shaped graph snapshot. This is a backend detail; callers use the
  manager/control APIs rather than reading the snapshot directly.
- The full Rust `SessionSource`, shell snapshot, and exec-policy inheritance
  model is represented by available TypeScript session metadata and rollout
  edge metadata. Any deeper Rust-only config inheritance remains a known
  language/runtime difference, not a model-facing shortcut.
- `Agent`, `send_input`, `TaskOutput`, `TaskStop`, and `SendMessage` remain
  hidden/deferred compatibility aliases. The visible Codex v2 tools stay
  strict.

Parity tests should cover every upstream behavior category from:

- `codex-rs/core/src/thread_manager_tests.rs`
- `codex-rs/core/src/agent/control_tests.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_tests.rs`
