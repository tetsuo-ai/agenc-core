# AgenC Runtime Replacement Plan

This document supersedes the earlier "hybrid runtime" framing for the
live AgenC execution engine.

The target is now explicit:

- AgenC keeps the product, CLI, TUI, provider, and operator surface
- AgenC's live runtime/session kernel is ported from `../codex`
- selected agent-loop and compaction behaviors are ported from
  `../openclaude`
- no AgenC-era runtime ownership survives in the live turn path

This is a replacement-first migration. We are not polishing the
transitional hybrid runtime. We are deleting it tranche by tranche and
replacing it with an AgenC runtime whose kernel is copied from codex and
whose selected behaviors are copied from openclaude.

---

## Decision

The live runtime must stop being AgenC-era and bridge-owned.

That means:

- no permanent hybrid runtime
- no custom AgenC wrappers around core runtime behavior
- no command-level reconstruction of runtime context
- no legacy `query.ts` / `services/*` modules acting as runtime owners

The acceptable end state is:

- all live turns are owned by an AgenC runtime ported from codex
- openclaude-derived behavior runs inside that AgenC runtime
- AgenC-specific code exists above the runtime, not inside it

This is still AgenC. We are copying codex's runtime architecture into
AgenC, not turning the product into codex.

---

## Runtime Boundary

For this migration, **runtime** means the code that owns a live turn from
input to output.

That includes:

- bootstrap into a live `Session`
- session lifecycle
- turn lifecycle
- config mutation / snapshot rules
- history ownership
- compaction invocation ownership
- recovery ownership
- tool routing / approval / sandbox ownership
- MCP exposure/runtime ownership
- event emission / persistence ownership
- sidecar startup/subscription/shutdown ordering

In `agenc-core/runtime/src`, this primarily means:

- `session/*`
- `phases/*`
- `tools/*`
- `recovery/*`
- runtime-owned logic in `commands/*`
- runtime-owned parts of `bin/agenc.ts`
- helper entry paths that still participate in live execution

Not part of the runtime boundary:

- TUI visuals / watch art
- branding / public CLI identity
- provider-specific adapters such as Grok
- docs / examples / umbrella surfaces

---

## Source Of Truth

### Codex runtime source of truth

The replacement target is the codex runtime under:

- `/home/tetsuo/git/codex/codex-rs/core/src/session/session.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/session/turn.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/session/turn_context.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/compact.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/tools/router.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/tools/orchestrator.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/tools/context.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/tools/registry.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/agent/*`
- `/home/tetsuo/git/codex/codex-rs/codex-mcp/src/mcp_connection_manager.rs`

Important note:

- codex runtime is Rust
- AgenC replacement is therefore a Rust -> TypeScript port
- "1:1" means ownership, architecture, invariants, control flow,
  sequencing, and semantics, not byte-identical code

### Openclaude behavior source of truth

Openclaude remains the behavior source for the parts that are
intentionally retained:

- compaction behavior
- selected query-loop semantics
- selected streaming-tool execution patterns
- selected recovery behaviors

Primary sources:

- `/home/tetsuo/git/openclaude/src/query.ts`
- `/home/tetsuo/git/openclaude/src/services/compact/*`
- `/home/tetsuo/git/openclaude/src/services/tools/StreamingToolExecutor.ts`

Rule:

- openclaude code may provide behavior
- it must not remain the runtime owner

---

## Retained Behavior Inventory

The replacement plan only retains openclaude behavior where the rebuild
documents already call for it. That retained inventory is:

- pre-request compaction stages and shrink discipline
- manual `/compact` behavior once invoked through the runtime
- auto-compaction / reactive-compaction behavior
- continuation / blocking-limit behavior already called for by the
  tranche docs
- streaming-tool-execution behavior where the runtime explicitly keeps it

Not retained as openclaude runtime ownership:

- query-loop bootstrap / top-level runtime ownership
- slash-command runtime dispatch ownership
- state persistence ownership
- MCP connection manager ownership
- generic session mutation ownership

If a behavior is retained, it must be called from the AgenC runtime
ported from codex. If it is not in this list or in the tranche docs, it
is not implicitly carried forward.

---

## Replacement Rules

These rules are mandatory for all runtime work after this decision.

1. No new runtime logic in legacy owners
- Do not add new live-path logic to:
  - `runtime/src/query.ts`
  - `runtime/src/services/compact/*`
  - `runtime/src/services/tools/*`

2. No command-built or helper-built runtime context
- Slash commands and helper modules must not synthesize fake
  `ToolUseContext`, fake `TurnContext`, fake session state, or fake
  compaction context.
- This applies to `commands/*`, `utils/*`, and any auxiliary live path.

3. Commands are adapters only
- `commands/*` may parse args, call runtime/session APIs, and render
  results.
- They may not own runtime policy or execution semantics.

4. Helpers are not hidden owners
- Utility paths such as `runtime/src/utils/queryHelpers.ts` must not
  preserve legacy runtime ownership behind helper APIs.

5. One execution owner path
- bootstrap creates or resumes a `Session`
- all live turns begin in the session/turn kernel
- all tool calls flow through one runtime tool stack
- all compaction flows are owned by the same runtime boundary

6. Delete after cutover
- Once a replacement path is validated, the legacy owner is deleted. We
  do not keep dual live owners indefinitely.

---

## Live Entrypoint Inventory

The migration cannot treat `bin/agenc.ts` as the only owner. Every live
entrypoint that can create, resume, or drive a session must have an
explicit disposition.

### Local runtime owners

| Entrypoint / owner | Current role | Disposition |
| --- | --- | --- |
| `runtime/src/bin/agenc.ts` | interactive CLI bootstrap, session setup, slash-command short-circuit, sidecar wiring | cut over first; keep only bootstrap + UI surface |
| `runtime/src/bin/slash.ts` | slash-command wrapper and bridge gate | thin adapter only; no runtime ownership |
| `runtime/src/tasks/LocalMainSessionTask.ts::startBackgroundSession` | background/local-main session owner | cut over; must use the same session bootstrap contract as CLI |
| `runtime/src/agents/delegate.ts` -> `system.agent.delegate` / `runAgent` path | subagent/delegate turn owner | cut over; must use the same runtime turn/bootstrap contract as the main session path |
| test-only session owners | integration harnesses that instantiate sessions or wire observer slots | keep as tests only, but force them through the same runtime bootstrap contract |

### Compatibility / non-runtime session surfaces

These are not current local runtime owners, but they must be tracked so
the runtime cutover does not accidentally claim ownership it does not
have today.

| Surface | Current role | Disposition |
| --- | --- | --- |
| `runtime/src/entrypoints/agentSdkTypes.ts::unstable_v2_createSession` | unimplemented SDK stub | out of scope for the runtime-owner cutover; keep as compatibility stub unless separately implemented |
| `runtime/src/entrypoints/agentSdkTypes.ts::unstable_v2_resumeSession` | unimplemented SDK stub | out of scope for the runtime-owner cutover; keep as compatibility stub unless separately implemented |
| `runtime/src/bridge/createSession.ts::createBridgeSession` | remote bridge API client for server-side session creation | compatibility surface only; do not treat as a local runtime owner |
| `runtime/src/bridge/createSession.ts::getBridgeSession` | remote bridge API client for server-side session lookup/resume | compatibility surface only; do not treat as a local runtime owner |

Rule:

- no live entrypoint is allowed to retain its own session/turn semantics
  after the cutover
- there is no separate checked-in `bin/daemon.ts` entrypoint in the
  current tree; bridge/session creation surfaces above are the non-CLI
  compatibility surfaces currently visible in-tree

---

## Legacy Ownership Inventory

Phase 0 must classify every known fabricated-context seam and every
legacy runtime-owner file before implementation starts.

### Known fabricated-context / cloned-context seams

- `runtime/src/commands/compact.ts`
- `runtime/src/utils/forkedAgent.ts`
- `runtime/src/utils/hooks/execAgentHook.ts`
- `runtime/src/bin/agenc.ts`
- `runtime/src/commands/context/context-noninteractive.ts`
- `runtime/src/utils/processUserInput/processSlashCommand.tsx`
- `runtime/src/services/MagicDocs/magicDocs.ts`
- `runtime/src/tools/AgentTool/runAgent.ts`
- `runtime/src/tools/AgentTool/*`

These sites either build runtime context directly today or are close
enough to the boundary that they must be reviewed before the plan can
claim the hybrid is gone.

### File-level legacy services matrix

| File | Current role | Final disposition |
| --- | --- | --- |
| `runtime/src/services/compact/compact.ts` | legacy compaction owner | move retained behavior into `runtime/src/llm/compact/*`; delete as owner |
| `runtime/src/services/compact/autoCompact.ts` | legacy auto-compact owner | behavior parity reference only; delete as owner |
| `runtime/src/services/compact/reactiveCompact.ts` | legacy reactive compact owner | behavior parity reference only; delete as owner |
| `runtime/src/services/compact/microCompact.ts` | legacy microcompact owner | behavior parity reference only; delete as owner |
| `runtime/src/services/compact/cachedMicrocompact.ts` | legacy cached microcompact owner | behavior parity reference only; delete as owner |
| `runtime/src/services/compact/apiMicrocompact.ts` | legacy API microcompact helper | delete |
| `runtime/src/services/compact/postCompactCleanup.ts` | legacy post-compact cleanup owner | move retained behavior under `runtime/src/llm/compact/*`; delete as owner |
| `runtime/src/services/compact/sessionMemoryCompact.ts` | legacy session-memory compaction path | delete |
| `runtime/src/services/compact/snipCompact.ts` | legacy snip owner | move retained behavior under `runtime/src/llm/compact/*`; delete as owner |
| `runtime/src/services/compact/snipProjection.ts` | legacy snip helper | delete |
| `runtime/src/services/compact/grouping.ts` | grouping helper with non-runtime consumers possible | keep as non-runtime helper only |
| `runtime/src/services/compact/prompt.ts` | prompt-builder helper | delete |
| `runtime/src/services/compact/compactWarningHook.ts` | warning UI/support seam | keep as non-runtime helper only |
| `runtime/src/services/compact/compactWarningState.ts` | warning UI/support seam | keep as non-runtime helper only |
| `runtime/src/services/compact/cachedMCConfig.ts` | legacy config helper | delete |
| `runtime/src/services/compact/timeBasedMCConfig.ts` | legacy config helper | delete |
| `runtime/src/services/tools/StreamingToolExecutor.ts` | legacy streaming executor owner | runtime uses `runtime/src/tools/streaming-executor.ts`; keep old file only as parity reference during cutover |
| `runtime/src/services/tools/toolExecution.ts` | legacy tool execution owner | replace with `runtime/src/tools/execution.ts` ownership; delete old owner |
| `runtime/src/services/tools/toolHooks.ts` | legacy tool-hook owner | replace with runtime hook ownership; delete old owner |
| `runtime/src/services/tools/toolOrchestration.ts` | legacy orchestration owner | replace with `runtime/src/tools/orchestrator.ts`; delete old owner |
| `runtime/src/tools/AgentTool/*` | legacy subagent/delegate executor surface | replace with `runtime/src/agents/*` ownership; delete old owner path |

This is intentionally file-level, not directory-level, so UI/support
consumers do not get pulled into unnecessary runtime churn.

---

## Current Problem Statement

The repo contains a large amount of codex/openclaude-derived code, but
the live runtime is still transitional.

Symptoms:

- codex-style session pieces exist, but are not yet the sole runtime owner
- openclaude-derived behavior exists, but is still often entered through
  AgenC-era bridges
- bootstrap and slash-command entry still own runtime behavior in
  `bin/agenc.ts`
- commands still reconstruct runtime context by hand on some paths
- helper paths still encode old runtime assumptions
- legacy `query.ts` / `services/*` ownership still leaks into live paths

The result is a runtime that:

- looks ported
- passes slice tests
- still violates the intended ownership boundary

That is the thing being replaced.

---

## Target End State

The migration is complete only when all of the following are true:

1. `session/*` is the only runtime state owner
2. `run-turn.ts` is the only live turn owner
3. bootstrap/entrypoint code constructs or resumes a session and then
   hands off; it does not own turn execution
4. `tools/*` runtime routing/orchestration is the only tool runtime path
5. manual, pre-sampling, auto, and reactive compaction are all invoked
   through the same runtime ownership boundary
6. `commands/*` contains no runtime business logic
7. helper paths contain no hidden runtime ownership
8. `query.ts` is no longer on the live path
9. `services/compact/*` and `services/tools/*` are no longer runtime owners
10. no live path fabricates runtime context by hand
11. persisted session state can be replayed or rejected safely across the
    cutover

---

## File Classification

### Port from codex into the AgenC runtime

These modules are intended to become the live runtime owners:

- `runtime/src/session/session.ts`
- `runtime/src/session/run-turn.ts`
- `runtime/src/session/turn-context.ts`
- `runtime/src/session/turn-state.ts`
- `runtime/src/session/event-log.ts`
- `runtime/src/session/rollout-store.ts`
- `runtime/src/session/session-store.ts`
- `runtime/src/tools/router.ts`
- `runtime/src/tools/orchestrator.ts`
- `runtime/src/tools/context.ts`
- `runtime/src/tools/registry.ts`
- `runtime/src/agents/*`
- `runtime/src/permissions/network-approval.ts`
- codex-aligned ownership pieces under `runtime/src/recovery/*`
- codex-aligned MCP/session-service ownership pieces used by runtime boot

### Keep from openclaude as behavior only

These may survive only as behavior modules under runtime ownership:

- `runtime/src/llm/compact/*`
- selected phase logic under `runtime/src/phases/*`
- selected streaming-tool behavior explicitly retained by tranche docs

### Thin surface only

These should become adapters/surfaces only:

- `runtime/src/bin/agenc.ts`
- `runtime/src/commands/*`
- CLI/TUI display layers

### Delete after cutover

These must stop being live runtime owners:

- `runtime/src/query.ts`
- `runtime/src/services/compact/*`
- `runtime/src/services/tools/*`
- bridge layers that reconstruct runtime state outside `session/*`

---

## Phased Execution Plan

### Phase 0 — Boundary Lock

Goal:

- freeze the architecture target before more transitional work lands

Work:

- document the runtime as an AgenC runtime ported from codex
- document openclaude as behavior source only
- add architecture guard scripts/tests
- add a forbidden-owner manifest covering:
  - exact live entrypoints
  - allowed-import graph for those entrypoints
  - banned runtime call sites
  - allowed non-runtime consumers
  - fabricated `ToolUseContext` / `TurnContext` creation outside the
    runtime boundary
- treat static manifest checks as defense-in-depth and heuristic only,
  not primary proof
- perform exact adjacent-doc actions:
  - `docs/plan/architecture.md` -> rewrite in place to reflect the new
    runtime boundary
  - `docs/plan/feature-matrix.md` -> update runtime-ownership rows to
    stop describing the destination as hybrid
  - `docs/plan/sequence-diagrams.md` -> either rewrite the runtime
    swimlanes or mark the affected diagrams as historical until updated

Deliverables:

- this document
- updated docs index
- minimum blocker guard scripts/tests
- forbidden-owner manifest
- updated live-entrypoint matrix
- updated legacy-ownership matrix
- explicit per-doc action list for adjacent runtime-plan docs

Validation:

- no new direct live imports from `query.ts`, `services/compact/*`, or
  `services/tools/*` in runtime entry paths
- no new fabricated runtime contexts in `commands/*` or `utils/*`
- forbidden-owner manifest covers exact live entrypoints and known
  fabricated-context seams
- every live entrypoint is listed with a disposition
- smoke tests remain the primary proof; static checks are defense-in-depth

Rollback:

- docs/checks only; no runtime behavior changes

---

### Phase 1 — Compatibility Freeze

Goal:

- freeze persistence, observer, attach-order, and sidecar compatibility
  before ownership moves

Current hotspots:

- `runtime/src/bin/agenc.ts:1519`
- `runtime/src/bin/agenc.ts` session boot and slash-command dispatch
- `runtime/src/session/observer-wiring.ts`
- `runtime/src/session/mcp-startup.ts`

Work:

- define runtime persistence versioning for the cutover
- define replay invariants for old and new histories
- explicitly document which old histories can be replayed, upgraded, or
  must be rejected
- define rollback conditions if mixed histories or partial upgrades are
  detected
- add storage/schema checks for session store and rollout store
- include sidecar-coupled persistence and event-order surfaces:
  - `runtime/src/session/sidecar.ts`
  - `runtime/src/session/file-history.ts`
  - `runtime/src/session/error-log.ts`
  - `runtime/src/session/cost.ts`
  - `runtime/src/session/degraded-store.ts`
  - `runtime/src/session/observer-wiring.ts`
  - `runtime/src/session/mcp-startup.ts`
- freeze `session_configured` emission semantics and first-subscriber /
  session-slot attach timing before later phases move their ownership

Deliverables:

- explicit persistence compatibility contract
- explicit observer/sidecar compatibility contract
- version gates that later phases must honor

Validation:

- replay old history into the new runtime contract
- reject unsupported mixed-history cases cleanly
- session-store/rollout-store schema tests
- observer attach-order tests
- first-subscriber / dropped-event tests

Rollback:

- reject unsupported histories instead of silently mutating them
- do not begin ownership transfer until this contract is frozen

---

### Phase 2 — Bootstrap And Entrypoint Cutover

Goal:

- move runtime ownership out of `bin/agenc.ts` and into the session
  kernel as early as possible

Work:

- reduce `bin/agenc.ts` to bootstrap, session creation/resume, and UI
  wiring
- move turn-context construction ownership behind the session/runtime
  boundary
- remove slash-command short-circuit ownership from bootstrap
- keep all compatibility constraints defined in Phase 1 unchanged while
  ownership moves

Deliverables:

- one bootstrap handoff into the runtime
- no top-level turn ownership in `bin/agenc.ts`

Validation:

- bootstrap tests
- slash-command integration tests
- sidecar startup/subscription tests
- shutdown ordering tests
- subagent/delegate integration tests
- all local runtime owners listed in the inventory route through the same
  bootstrap contract

Rollback:

- temporary adapter allowed only at the bootstrap handoff point

---

### Phase 3 — Session Kernel Cutover

Goal:

- make the ported codex session code the single owner of runtime state
  and turn execution

Work:

- finish strict codex parity for:
  - `session.ts`
  - `run-turn.ts`
  - `turn-context.ts`
  - `turn-state.ts`
  - event log / rollout / reconstruction ownership
- eliminate direct state mutation outside `session/*`
- move any remaining session mutation helpers behind the session kernel

Deliverables:

- one `Session` owner
- one `TurnContext` builder
- one `runTurn` entrypoint

Validation:

- turn lifecycle tests
- resume/replay tests
- config mutation tests
- interruption / active-turn tests

Rollback:

- keep old call sites temporarily dispatchable behind a guarded adapter
  only until the new path is green

---

### Phase 4 — Tool And Approval Runtime Cutover

Goal:

- replace tool ownership with codex router/orchestrator semantics

Work:

- port/adapt codex:
  - router
  - orchestrator
  - tool context
  - approval flow
  - sandbox selection semantics
  - network approval flow
- route all tool execution through that runtime
- remove duplicate execution logic from commands/phases/helpers

Deliverables:

- one tool execution path
- one approval path
- one sandbox/network decision path

Ownership table:

| Concern | Final owner |
| --- | --- |
| tool classification / model-visible spec shaping | `runtime/src/tools/router.ts` |
| approval requirement + retry decision | `runtime/src/tools/orchestrator.ts` |
| sandbox/network policy application | `runtime/src/tools/orchestrator.ts` |
| low-level execution path | `runtime/src/tools/execution.ts` |
| hook dispatch / hook-owned tool wrapping | runtime hook layer plus `runtime/src/tools/tool-hooks.ts` |
| MCP attach/wiring seam | runtime session bootstrap + `runtime/src/session/mcp-startup.ts` |
| context mutation / turn-scoped tool execution contract | runtime session + `runtime/src/phases/execute-tools.ts` calling the orchestrator |
| progress buffering / concurrent submission / sibling-abort behavior | `runtime/src/tools/streaming-executor.ts`, invoked only from the runtime tool phase |
| executor lifecycle / discard-on-recovery | runtime turn state + recovery modules |

Boundary rule:

- `phases/execute-tools.ts` remains the runtime phase entry that feeds the
  tool stack
- `tools/router.ts` owns classification/spec shaping
- `tools/orchestrator.ts` owns approval/sandbox/retry semantics
- `tools/execution.ts` owns low-level tool invocation mechanics
- `tools/streaming-executor.ts` owns buffered streaming execution only
- no concern may be implemented in two layers at once

Validation:

- direct tool tests
- approval/sandbox tests
- MCP tool routing tests
- parallel/non-parallel tool execution tests
- stale approval reuse rejection
- missing approval resolver handling
- turn-abort during approval
- approval state on resume

Rollback:

- temporary adapter shim permitted only at the tool-runtime boundary

---

### Phase 5 — Compaction Ownership Cutover

Goal:

- keep openclaude compaction behavior, but move invocation ownership
  fully under the runtime boundary established in Phases 1-3

Ownership rule:

- compaction is not a separate owner from tool/runtime ownership
- manual `/compact`, pre-sampling compact, auto-compact, and reactive
  compact must all enter through the same session/runtime contract

Work:

- manual `/compact` becomes a thin runtime call
- pre-sampling compaction becomes runtime-owned
- reactive compaction becomes runtime-owned
- auto-compact ownership moves under the same runtime path
- remove command-level, helper-level, or service-level compaction bridges

Deliverables:

- one compaction invocation path
- no fake compaction context reconstruction

Validation:

- manual `/compact`
- auto-compact
- reactive compact
- resume after compact
- compaction index / shrink assertion / cleanup invariants

Rollback:

- retain old compaction owner only until the runtime-owned path is proven
  equivalent on the same test surface

---

### Phase 6 — Command And Helper Collapse

Goal:

- make commands thin adapters only and remove helper-owned runtime seams

Work:

- refactor `commands/*` to:
  - parse input
  - call runtime/session API
  - render result
- remove runtime business logic from commands
- remove all hand-built runtime contexts
- audit helper paths such as `runtime/src/utils/queryHelpers.ts`
  and remove hidden legacy ownership

Deliverables:

- commands no longer own runtime behavior
- helpers no longer preserve old runtime boundaries

Validation:

- slash-command tests
- command/runtime integration tests
- helper-path execution tests

Rollback:

- command-local wrappers may stay only until the runtime API exists;
  they must not remain after cutover

---

### Phase 7 — Legacy Runtime Deletion

Goal:

- remove old owners and make split ownership impossible

Work:

- remove `runtime/src/query.ts` from live runtime entry
- remove runtime ownership from `runtime/src/services/compact/*`
- remove runtime ownership from `runtime/src/services/tools/*`
- delete adapters that only existed to bridge old -> new

Deliverables:

- one live runtime
- no dual ownership

Validation:

- structural checks
- targeted full runtime suite

Rollback:

- none after deletion checkpoint; delete only once the new owner is green

---

### Phase 8 — Hardening

Goal:

- make the replacement durable and non-regressing

Work:

- expand the minimum blocker guards into long-term hardening checks
- add source-of-truth docs linking each owner module to codex/openclaude
- perform parity audit against codex runtime ownership and openclaude
  behavior retention
- verify sidecar/subscriber and shutdown invariants still hold after
  deletion

Deliverables:

- architecture guardrails
- final parity audit

Validation:

- runtime integration suite
- targeted diff audits
- structural checks

Rollback:

- hardening only

---

## Immediate Priorities

These are the first places to stop treating as permanent:

1. bootstrap-owned runtime logic
- `runtime/src/bin/bootstrap.ts` remains the declared `session_bootstrap`
  owner in `runtime-owner-manifest.md`; keep thinning it only when an
  equivalent session-owned API exists. The current ownership guard allows
  its single `buildTurnContext` handoff and should fail any new fabricated
  context seams.

2. `/compact` bridge ownership
- `commands/compact.ts` now calls the runtime manual-compaction path.
  Keep the command thin and do not reintroduce a UI/service compaction
  owner.

3. helper-owned runtime seams
- helper modules that still preserve old query/runtime assumptions are a
  migration target, not a compatibility layer.

4. legacy tool/compaction service ownership
- any live path that still enters runtime behavior through
  `services/compact/*` or `services/tools/*` as owners is temporary debt.
- current source has no `runtime/src/services/*` tree; keep the structural
  guard so this ownership shape cannot return unnoticed.

---

## Validation Plan

Each replacement phase must ship with both behavioral and structural
validation.

### Behavioral validation

- standard user turn
- tool-heavy turn
- interrupted turn
- resumed session
- plan-mode turn
- MCP-present turn
- manual `/compact`
- auto-compact
- reactive compact
- sidecar startup/subscription
- shutdown ordering
- bridge-gated slash command flows
- non-interactive vs TTY routing
- degraded-mode recovery flows
- subagent/delegate turns

### Security and approval validation

- stale approval reuse is rejected
- missing approval resolver fails safely
- turn abort during approval unwinds cleanly
- resumed sessions do not inherit invalid approval state
- sandbox/network policy matches runtime snapshot rules

### Persistence validation

- replay supported old histories
- reject unsupported mixed histories
- verify rollout/session store version gates

### Structural validation

Add automated checks for:

- no live imports from `runtime/src/query.ts`
- no live imports from `runtime/src/services/compact/*` as runtime owners
- no live imports from `runtime/src/services/tools/*` as runtime owners
- no fabricated `ToolUseContext` or `TurnContext` in commands/helpers
- no direct session state mutation outside `session/*`
- one tool runtime path
- one compaction invocation path
- one bootstrap handoff path into the runtime
- forbidden-owner manifest rules pass for the exact live-entrypoint
  graph; dynamic/transitive checks are heuristic only and do not replace
  smoke tests

---

## Compatibility Shim Policy

Temporary adapters are allowed only when all of the following are true:

- they sit exactly on a documented cutover boundary
- they have one named owner module
- they have one explicit kill-switch or deletion condition
- they do not invent new runtime semantics
- they are deleted in the same phase that replaces their last caller

If a shim cannot satisfy those rules, it is a bug, not a migration tool.

---

## Rollback Strategy

This migration should not be done as one giant irreversible cut.

Checkpoint after:

- persistence compatibility gate
- bootstrap cutover
- session-kernel cutover
- tool/approval cutover
- compaction cutover
- legacy deletion checkpoint

At each checkpoint:

- old path may remain only behind a deliberate guarded adapter
- incompatible persistence state must be rejected cleanly
- no new hybrid seams may be introduced to "buy time"

After the deletion checkpoint:

- rollback means reverting the checkpoint, not reviving deleted owners

---

## Performance And Backpressure Acceptance

The cutover is not acceptable if it is architecturally clean but
materially slower or less stable.

Each runtime milestone must include at least one high-volume scenario:

- many tool events in a single turn
- concurrent approval requests
- replay of a large saved session
- compaction over a large history

Acceptance threshold:

- no unbounded event-buffer growth
- no duplicate sidecar emission under retry/resume
- replay of the standard large-session fixture must not exceed 1.5x the
  current targeted baseline
- large-history compaction must not exceed 1.5x the current targeted
  baseline
- processing 1,000 tool-event emissions in the milestone fixture must
  not add more than 500 ms over the current targeted baseline
- approval-queue handling in the concurrency fixture must not add more
  than 100 ms median latency over the current targeted baseline

Named benchmark fixtures:

- `runtime-large-session-replay`
- `runtime-large-history-compact`
- `runtime-tool-event-burst-1000`
- `runtime-approval-concurrency`

Baseline rule:

- the first green run on the local `gut` branch in `agenc-core` before
  Phase 1 begins is the locked baseline for these fixtures

Fixture note:

- these are named target fixtures/suites that may be added during the
  migration; the plan uses the names now so later work cannot move the
  goalposts

---

## Backward Compatibility Acceptance

Even though the runtime owner changes, the following surfaces must stay
compatible unless a later plan explicitly changes them:

- CLI flags and slash-command behavior
- session event schema consumed by TUI/watch/operator feeds
- bridge-gated slash-command behavior
- SDK-facing create/resume entrypoints
- MCP-visible behavior expected by current session owners

Named compatibility gates:

- `cli-compat-suite`
- `bridge-session-suite`
- `sdk-session-suite`
- `mcp-attach-suite`
- `sidecar-consumer-suite`
- `tty-vs-headless-suite`
- `event-schema-consumer-suite`

Every ownership-moving milestone must keep these suites green unless a
separate plan explicitly changes that public/runtime surface.

---

## Success Condition

The runtime replacement is done only when:

- the live runtime is AgenC's runtime, ported from codex
- selected openclaude behaviors run inside that runtime
- bootstrap, session, tools, compaction, recovery, and persistence all
  have one ownership path
- commands/helpers are thin surfaces only
- legacy runtime owners are gone
- persistence compatibility is explicit and tested
- CLI/TUI/SDK/MCP compatibility acceptance is explicit and tested
- architecture guards prevent the hybrid runtime from returning
