# TL-21 Tool Runtimes Parity

Source root: `/home/tetsuo/git/codex/codex-rs/core/src/tools` <!-- branding-scan: allow local donor citation for TL-21 parity -->

Source commit: `c8c30d9d75556ecbe94991af22380d2a4e9d6589`

## Implemented In This Item

- `runtime/src/tools/runtimes/context.ts` owns the per-call runtime context. It records the routed payload kind, call id, tool name, concurrency class, selected sandbox mode, approval policy, and approval state for each execution attempt.
- `runtime/src/tools/runtimes/parallel.ts` owns the per-call runtime scheduler. It wraps the existing AgenC concurrency guard so runtime dispatch is keyed by full call context instead of only a bare concurrency class.
- `runtime/src/tools/runtimes/sandboxing.ts` maps AgenC sandbox modes onto the C-01 sandbox engine permission-profile model and enforces the selected attempt before tool execution. Read-only attempts allow targetless shell/read operations and reject detected writes; workspace-write attempts reject detected path and shell write targets outside the active turn cwd/tmp roots; sandbox denials flow back through the orchestrator escalation path.
- `runtime/src/tools/runtimes/parallel.ts` exposes the construction surface used by the live execute-tools phase.
- `runtime/src/tools/router.ts` now builds a runtime attempt context after the orchestrator selects the sandbox attempt and injects it into `executeToolDispatch`.
- `runtime/src/tools/execution.ts` attaches the context as a non-enumerable injected argument before schema validation, enforces the runtime sandbox attempt, and still lets strict tool schemas validate.
- `runtime/src/phases/execute-tools.ts` constructs the live scheduler from `runtime/src/tools/runtimes/parallel.ts`.

## Donor Mapping

- `parallel.rs` -> `parallel.ts` plus the existing `runtime/src/tools/concurrency.ts` guard implementation.
- `sandboxing.rs` -> `sandboxing.ts`, `context.ts`, and the existing `runtime/src/tools/orchestrator.ts` approval/escalation flow.
- `runtimes/mod.rs` -> `context.ts`, `parallel.ts`, and `sandboxing.ts`; TL-21 intentionally has no re-export-only `index.ts`.
- `runtimes/{shell,unified_exec,apply_patch}.rs` -> existing AgenC tool handlers under `runtime/src/tools/system/` and `runtime/src/tools/apply-patch/`, now receiving per-attempt runtime context from this item instead of being duplicated under `tools/runtimes`.
- `orchestrator.rs`, `router.rs`, `registry.rs`, `events.rs`, and `context.rs` were already represented in AgenC-owned tool modules before TL-21. This item stitches the runtime split into those live modules rather than copying duplicate versions into this directory.
- `handlers/*` remains mapped to the existing AgenC tool handler families (`system`, `apply-patch`, `tasks`, `ask-user-question`, model-facing registry tools). TL-21 does not relocate every handler because the item scope is the orchestrator/runtimes split, not a handler directory move.

## Behavioral Checks

- `runtime/src/tools/runtimes/runtime.test.ts` verifies parallel scheduling, sandbox-profile mapping, sandbox enforcement, approval-gated sandbox escalation, and live router injection of selected sandbox attempt context through `executeToolDispatch`.
- `runtime/src/phases/execute-tools.test.ts` verifies batched model tool calls flow through `executeTools`, the runtime scheduler, and per-call runtime context.
