# Codex Agent Layer Parity

Upstream reference: `/home/tetsuo/git/codex` at commit
`a9f75e5cda2d6ff469a859baf8d2f50b9b04944a`.

Primary source anchors:

- `codex-rs/core/src/agent/control.rs`
- `codex-rs/core/src/thread_manager.rs`
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

- AgenC exposes only the current strict agent tool names:
  `spawn_agent`, `wait_agent`, `close_agent`, `followup_task`, `send_message`,
  and `list_agents`.
- Legacy Codex aliases are intentionally not registered as model-facing tools.
  Removed names include `Agent`, `send_input`, `TaskOutput`, `TaskStop`,
  `SendMessage`, `resume_agent`, `TeamCreate`, and `TeamDelete`.
- Live agents return current control-plane status. Closed rollout-backed agents
  may be rehydrated internally through `AgentControl.resumeAgentFromRollout(...)`,
  which rehydrates
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
- Historical legacy aliases are not preserved in the model-facing registry.

Parity tests should cover every upstream behavior category from:

- `codex-rs/core/src/thread_manager_tests.rs`
- `codex-rs/core/src/agent/control_tests.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_tests.rs`

## Shared Parity Checklist

Status values:

- `covered`: the TypeScript target has focused tests for the parity category.
- `adapted`: the behavior is intentionally routed through AgenC runtime
  seams, with tests covering the model-facing contract.
- `deferred`: the plan keeps the surface hidden or structurally stubbed until
  the owning tranche wires it.
- `blocked`: the required validation currently fails and needs an owning
  runtime fix before closure.
- `watch`: validation passed locally, but the row is a known regression-prone
  boundary for later workers.

| Plan gap / behavior | Codex source | TypeScript target | Required validation test | Status |
|---|---|---|---|---|
| Thread lifecycle manager: root registration, live child handles, operation dispatch, removal, bounded shutdown | `codex-rs/core/src/thread_manager.rs`; `codex-rs/core/src/thread_manager_tests.rs` | `runtime/src/agents/thread-manager.ts` | `runtime/src/agents/thread-manager.test.ts` | covered |
| Agent control plane: spawn, send, append, interrupt, shutdown, status subscription, metadata, subtree listing | `codex-rs/core/src/agent/control.rs`; `codex-rs/core/src/agent/control_tests.rs` | `runtime/src/agents/control.ts` | `runtime/src/agents/control.test.ts` | covered |
| Registry and spawn slots: max thread accounting, atomic reservation, path/nickname indexes, collision errors | `codex-rs/core/src/agent/registry.rs`; `codex-rs/core/src/agent/registry_tests.rs` | `runtime/src/agents/registry.ts` | `runtime/src/agents/registry.test.ts` | covered |
| Role layer: built-in `default` / `explorer` / `awaiter`, user overlays, nickname allocation, config-layer precedence | `codex-rs/core/src/agent/role.rs`; `codex-rs/core/src/agent/role_tests.rs`; `codex-rs/core/src/agent/builtins/*.toml` | `runtime/src/agents/role.ts` | `runtime/src/agents/role.test.ts` | covered |
| Status FSM: pending, running, completed, errored, interrupted, shutdown, sticky final states | `codex-rs/core/src/agent/status.rs`; status assertions in `agent/control_tests.rs` | `runtime/src/agents/status.ts` | `runtime/src/agents/status.test.ts`; `runtime/src/agents/control.test.ts` | covered |
| Mailbox directionality, sequencing, backpressure, close sentinel, closed-send errors | `codex-rs/core/src/agent/mailbox.rs`; agent mailbox usage in `agent/control.rs` | `runtime/src/agents/mailbox.ts` | `runtime/src/agents/mailbox.test.ts` | covered |
| `spawn_agent` model-facing dispatcher, strict v2 shape, task-name/path handling, sync vs async launch | `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`; `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` | `runtime/src/agents/delegate.ts`; `runtime/src/agents/thread.ts` | `runtime/src/agents/delegate.test.ts`; `runtime/src/agents/thread.test.ts` | adapted |
| Child run loop: parent history handoff, child session metadata, worktree root, rollout store mount, down-inbox follow-up turns, completion/error/interruption status | Codex visible contract in `multi_agents_v2/spawn.rs` / `wait.rs`; execution adapted through AgenC session loop | `runtime/src/agents/run-agent.ts` | `runtime/src/agents/run-agent.test.ts` | adapted |
| Fork context: `new`, `full_history`, `last_n_turns`, `explicit`, cache-safe tool filtering, rollout-backed history filtering | `codex-rs/core/src/agent/control.rs` fork tests; upstream plan source `forkSubagent.ts` / `utils/forkedAgent.ts` | `runtime/src/agents/fork-context.ts`; `runtime/src/agents/thread-rollout-truncation.ts` | `runtime/src/agents/fork-context.test.ts`; `runtime/src/agents/thread-rollout-truncation.test.ts` | covered |
| Rollout-backed internal restore: active no-op, missing/invalid errors, restore open descendants | `codex-rs/core/src/agent/control.rs`; `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` | `runtime/src/agents/resume.ts`; `runtime/src/agents/control.ts` | `runtime/src/agents/resume.test.ts`; `runtime/src/agents/control.test.ts` | covered |
| Close/resume subtree semantics: close descendants, resume open descendants, keep explicitly closed descendants closed | `codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs`; `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` | `runtime/src/agents/control.ts`; `runtime/src/agents/thread-manager.ts` | `runtime/src/agents/control.test.ts` (`resumeAgentFromRollout` cases) | covered |
| Worktree create/bind/remove/stale cleanup and sparse-checkout hygiene | Codex model-facing worktree expectations; plan source `utils/worktree.ts` | `runtime/src/agents/worktree.ts` | `runtime/src/agents/worktree.test.ts` | covered |
| I-1 recursion depth cap | `codex-rs/core/src/tools/handlers/multi_agents_common.rs`; depth checks in `multi_agents_tests.rs` | `runtime/src/agents/control.ts`; `runtime/src/agents/registry.ts` | `runtime/src/agents/control.test.ts` (`I-1` cases) | covered |
| I-5 parent interrupt cascades to descendants | `codex-rs/core/src/agent/control.rs` interrupt path; AgenC divergence documented in `docs/plan/invariants.md` | `runtime/src/agents/control.ts`; `runtime/src/agents/mailbox.ts` | `runtime/src/agents/control.test.ts` (`interrupt() cascades`) | covered |
| I-31 closed mailbox emits `agent_exited` sentinel exactly once | `codex-rs/core/src/agent/mailbox.rs`; invariant from `docs/plan/invariants.md` | `runtime/src/agents/mailbox.ts` | `runtime/src/agents/mailbox.test.ts` (`I-31`) | covered |
| I-32 parent interrupt during child spawn does not orphan the new child | `codex-rs/core/src/agent/registry.rs`; `codex-rs/core/src/agent/control.rs` reservation model | `runtime/src/agents/control.ts`; `runtime/src/agents/registry.ts` | `runtime/src/agents/registry.test.ts` (`slot acquisition is atomic`); `runtime/src/agents/control.test.ts` (`interrupt() cascades`) | covered |
| I-33 unread async child result is surfaced on parent/session shutdown | Codex wait/close result contract in `multi_agents_v2/wait.rs`; invariant from `docs/plan/invariants.md` | `runtime/src/agents/control.ts`; session lifecycle boundary | `runtime/src/agents/control.test.ts` (`maybeStartCompletionWatcher`) | watch |
| I-34 worktree force-remove prunes stale gitdir entries | Plan source `utils/worktree.ts`; invariant from `docs/plan/invariants.md` | `runtime/src/agents/worktree.ts` | `runtime/src/agents/worktree.test.ts` (`removeAgentWorktree`) | covered |
| I-35 sparse-checkout teardown verifies stale state before failing remove | Plan source `utils/worktree.ts`; invariant from `docs/plan/invariants.md` | `runtime/src/agents/worktree.ts` | `runtime/src/agents/worktree.test.ts` (`checks linked-worktree sparse state`) | covered |
| I-36 parent rollout is flushed before forked child reads history | `codex-rs/core/src/agent/control_tests.rs` (`spawn_agent_fork_flushes_parent_rollout_before_loading_history`) | `runtime/src/agents/fork-context.ts` | `runtime/src/agents/fork-context.test.ts` (`I-36`) | covered |
| I-37 sibling `agentPath` collision returns a typed error | `codex-rs/core/src/agent/registry.rs`; `codex-rs/core/src/agent/registry_tests.rs` | `runtime/src/agents/registry.ts` | `runtime/src/agents/registry.test.ts` (`I-37`) | covered |
| Legacy Codex aliases are absent from AgenC's model-facing registry | `codex-rs/core/src/tools/handlers/multi_agents_v2.rs` | `runtime/src/bin/model-facing-tools.ts` | `runtime/src/bin/model-facing-tools.test.ts` | covered |
| Deferred MCP and built-in tool activation after `system.searchTools` selection | Codex deferred-tool contract represented by `multi_agents_v2` strict provider calls; plan T10 deferred schema row | `runtime/src/tool-registry.ts`; `runtime/src/tools/router.ts`; `runtime/src/phases/execute-tools.ts`; `runtime/src/permissions/evaluator.ts` | `runtime/src/bin/bootstrap-mcp.e2e.test.ts`; `runtime/src/tool-registry.test.ts`; `runtime/src/permissions/evaluator.test.ts` | covered |

## Validation Blocker Audit

| Blocker from plan | Evidence checked | Validation status | Follow-up |
|---|---|---|---|
| Provider env leakage during parity validation | `runtime/src/llm/provider.ts` keeps provider-specific base URL variables from inheriting unrelated OpenAI globals, while preserving the documented LMStudio OpenAI-compatible fallback only when no LMStudio-specific auth is set. | Fixed by `runtime/src/llm/provider.test.ts`. | Covered by `createProvider` env-leakage matrix. |
| Deferred MCP / built-in tool activation | `system.searchTools` selection now records discovered names in the live router/executor path, and the permission evaluator allows registry-tagged read-only/non-approval tools to run in headless bootstrap turns. | Fixed by `runtime/src/bin/bootstrap-mcp.e2e.test.ts` and `runtime/src/permissions/evaluator.test.ts`. | Watch for future changes that bypass `recordCompletedToolCall` or `ToolRouter.dispatchModelToolCall`. |
| Root umbrella validation hygiene | Root untracked `runtime/` and `containers/` were quarantined outside `/home/tetsuo/git/AgenC`; umbrella validation belongs in the root repo, not the `agenc-core` worktree. | `npm run validate:umbrella` passes from `/home/tetsuo/git/AgenC`. | Keep root changes limited to public-safe umbrella files and operational quarantine records. |
