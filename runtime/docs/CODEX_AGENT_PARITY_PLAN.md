# Codex Agent Parity Plan

Date: 2026-04-28

## Scope

Bring `agenc-core/runtime/src/agents` and the model-facing agent tools into
behavioral parity with the current local Codex checkout:

- Codex repo: `/home/tetsuo/git/codex`
- Codex commit: `a9f75e5cda2d6ff469a859baf8d2f50b9b04944a`
- AgenC worktree: `/home/tetsuo/git/AgenC-worktrees/agenc-core-codex-agent-parity`

This is a TypeScript runtime port. The target is behavioral parity at the
runtime boundary, not byte-for-byte Rust source equivalence.

## Assumptions

- AgenC keeps its TypeScript session and provider loop.
- Codex Rust remains the reference for agent control-plane semantics.
- Compatibility aliases may stay registered, but Codex v2 tools must stay
  strict and visible.
- Local-only workflow: commit in the worktree, merge into local `agenc-core`
  `main`, then remove the worktree and branch.
- No stored ADR exists for this project in codebase-memory, so this plan is
  aligned against the live source and AgenC umbrella routing notes.

## Impact Map

Primary files:

- `runtime/src/agents/status.ts`
- `runtime/src/agents/control.ts`
- `runtime/src/agents/registry.ts`
- `runtime/src/agents/role.ts`
- `runtime/src/agents/thread-manager.ts`
- `runtime/src/agents/thread-rollout-truncation.ts`
- `runtime/src/agents/thread.ts`
- `runtime/src/bin/model-facing-tools.ts`
- `runtime/src/bin/delegate-tool.ts`

Tests:

- `runtime/src/agents/status.test.ts`
- `runtime/src/agents/control.test.ts`
- `runtime/src/agents/registry.test.ts`
- `runtime/src/agents/role.test.ts`
- `runtime/src/agents/thread-manager.test.ts`
- `runtime/src/agents/thread-rollout-truncation.test.ts`
- `runtime/src/bin/model-facing-tools.test.ts`

Docs:

- `runtime/src/agents/PARITY.md`
- this plan file

## Gaps To Close

1. Agent launch semantics
   - Current model-facing `spawn_agent` creates a live handle and queues a
     message, but it does not start the child runner.
   - Codex `spawn_agent` creates a managed thread and submits the initial
     operation immediately.
   - Fix: route strict `spawn_agent` through the live `delegate()` runner in
     background mode so spawned agents actually execute.

2. Agent status semantics
   - Codex has `PendingInit` and `NotFound`.
   - AgenC currently uses `idle` for new and missing agents.
   - Fix: add `pending_init` and `not_found`, make new live agents start
     pending, return not_found for missing managed threads, and keep final-state
     handling aligned with Codex.

3. Depth limit semantics
   - Codex default `agent_max_depth` is 1.
   - AgenC hardcoded a default of 4.
   - Fix: resolve max depth from session config first, then environment
     override, then Codex default 1. Keep explicit test overrides.

4. Role parity
   - Codex currently exposes `default`, `explorer`, and `worker`; `awaiter` is
     temporarily removed.
   - AgenC keeps `awaiter` active and uses shortened role descriptions.
   - Fix: match Codex built-in role set and descriptions. Keep `awaiter`
     available only if a user config explicitly registers it.

5. Nickname parity
   - Codex uses the shared `agent_names.txt` pool when a role does not provide
     nickname candidates.
   - AgenC uses short per-role candidate arrays.
   - Fix: port the Codex default name pool and use it for built-ins without
     explicit nickname candidates.

6. Fork rollout parity
   - AgenC has fork truncation logic but no dedicated parity test file.
   - Fix: add TS parity tests for user-turn positions, rollback handling,
     trigger-turn boundaries, last-N fork truncation, and fork filtering.

7. Tool result parity
   - Codex v2 `send_message` and `followup_task` return empty successful tool
     output.
   - Existing AgenC shape is close, but spawn records and wait/close/list need
     to observe real running agent threads after launch.
   - Fix: bind spawned records to the returned `AgentThread` and its `join()`.

8. Thread manager adapter parity
   - AgenC's thread manager is still an adapter over `Session`/`LiveAgent`, not
     the full Codex Rust manager.
   - Fix within TS constraints: make status, submit, shutdown, fork snapshot,
     subtree listing, and thread-created notification match Codex behavior as
     observed by agent tools and tests.

## Phases

### Phase 1: Status and config semantics

- Add `pending_init` and `not_found`.
- Make `AgentStatusTracker` default to `pending_init`.
- Return `not_found` for unknown thread IDs.
- Resolve max depth from session config and default to 1.
- Update tests that intentionally asserted the old AgenC defaults.

Rollback point: revert status/control changes if broad session tests fail due
to status shape assumptions.

### Phase 2: Role and nickname parity

- Port `agent_names.txt` content into a TS constant.
- Remove built-in `awaiter` from the default role registry.
- Replace shortened role descriptions with Codex descriptions.
- Use the Codex default nickname pool when a role has no custom candidates.
- Update delegate schema and tests.

Rollback point: restore `awaiter` only as a user-registered role if a hidden
test proves the compatibility surface still needs it.

### Phase 3: Spawn execution parity

- Change model-facing `spawn_agent` to call `delegate()` in background mode.
- Preserve strict argument validation and Codex v2 tool outputs.
- Preserve local compatibility aliases as deferred tools.
- Track spawned agents by id, path, and nickname using `AgentThread.join()`.
- Keep collab begin/end events around the launch.

Rollback point: if `delegate()` introduces recursion or session lifecycle
issues, isolate the launch runner into a smaller `launchAgentThread()` helper.

### Phase 4: Fork and thread-manager parity tests

- Add `thread-rollout-truncation.test.ts` with direct ports of Codex rollback
  and last-N fork tests.
- Extend model-facing tests to prove strict spawn launches an async thread.
- Extend control/status tests for missing-thread and pending-init behavior.

Rollback point: if rollout shapes differ from Codex enough to block direct
ports, keep the tests focused on the equivalent AgenC rollout item schema.

### Phase 5: Validation and local integration

- Run focused tests:
  - `npm run test --workspace=@tetsuo-ai/runtime -- src/agents src/bin/model-facing-tools.test.ts`
- Run full required validation:
  - `npm run validate:required --workspace=@tetsuo-ai/runtime`
- Commit locally on `refactor/codex-agent-parity`.
- Merge into local `agenc-core/main`.
- Remove worktree and delete the local branch after merge.

## Risk Notes

- Removing built-in `awaiter` can affect local workflows that depended on the
  AgenC-specific role. The Codex parity target requires this change.
- Starting model-facing `spawn_agent` through `delegate()` makes background
  execution real. Tests must avoid live provider calls by using a stub session
  or mocked delegate path.
- Status shape changes may require TUI rendering code to tolerate `pending_init`
  and `not_found`.
- Full Rust `ThreadManagerState` parity is impossible byte-for-byte without
  porting the whole Rust runtime. The implementation target is the observable
  agent behavior at AgenC's TypeScript runtime boundary.

## Validation Plan

- Typecheck catches status union and role schema drift.
- Focused agent tests cover control-plane, role, registry, mailbox, thread,
  fork, run-agent, and model-facing tool behavior.
- Full runtime validation catches integration drift across TUI/session/tooling.

## Rollback Plan

- The feature branch is isolated in a worktree.
- Before merge, rollback is `git worktree remove --force` plus branch delete.
- After local merge, rollback is a local revert commit on `main` or resetting
  local `main` to the pre-merge commit if no dependent local work has started.
