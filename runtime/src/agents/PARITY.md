# Codex Agent Layer Parity

Upstream reference: `/home/tetsuo/git/codex` at commit
`a9f75e5cda2d6ff469a859baf8d2f50b9b04944a`.

This directory owns the TypeScript port of Codex's agent layer:

- `thread-manager.ts` is the lifecycle owner for root and child thread handles.
- `control.ts` coordinates tree metadata, spawn, message, close, resume, and status.
- `registry.ts`, `mailbox.ts`, and `status.ts` mirror the Codex control-plane state.
- `fork-context.ts` builds forked child history from rollout-backed parent state when available.
- The visible `spawn_agent` model-facing tool launches through `delegate()`, so spawned
  agents reserve a live handle, fork context, start the child run loop, and expose a
  joinable `AgentThread`.

Intentional TypeScript/runtime adaptation:

- AgenC child execution still runs through the existing `run-agent.ts` child-session runner.
  The manager owns the live thread handle and all model-facing routing goes through that
  managed handle, but the lower-level provider loop remains the AgenC TypeScript session loop.
- `Agent`, `send_input`, `TaskOutput`, `TaskStop`, `SendMessage`, and `resume_agent` remain
  hidden/deferred compatibility aliases. The visible Codex v2 tools stay strict.

Parity tests should be added for every upstream behavior category from:

- `codex-rs/core/src/thread_manager_tests.rs`
- `codex-rs/core/src/agent/control_tests.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_tests.rs`
