# TL-21 Tool Runtimes Parity

Source root: `/home/tetsuo/git/codex/codex-rs/core/src/tools` <!-- branding-scan: allow local donor citation for TL-21 parity -->

Source commit: `c8c30d9d75556ecbe94991af22380d2a4e9d6589`

## Implemented In This Item

- `runtime/src/tools/runtimes/context.ts` owns the per-call runtime context. It records the routed payload kind, call id, tool name, concurrency class, selected sandbox mode, approval policy, and approval state for each execution attempt.
- `runtime/src/tools/runtimes/parallel.ts` owns the per-call runtime scheduler. It wraps the existing AgenC concurrency guard so runtime dispatch is keyed by full call context instead of only a bare concurrency class.
- `runtime/src/tools/runtimes/unified-exec.ts` owns unified-exec runtime command extraction.
- `runtime/src/tools/runtimes/shell.ts` owns shell-runtime read/write analysis for unified-exec backed tools.
- `runtime/src/tools/runtimes/apply-patch.ts` owns apply-patch target extraction from parsed patch payloads.
- `runtime/src/tools/runtimes/sandboxing.ts` maps AgenC sandbox modes onto the C-01 sandbox engine permission-profile model and enforces the selected attempt before tool execution. Read-only attempts reject shell reads outside the active turn cwd and reject writes; workspace-write attempts reject detected path, shell, and apply-patch write targets outside the active turn cwd and configured writable temp roots; sandbox denials flow back through the orchestrator escalation path.
- `runtime/src/tools/runtimes/parallel.ts` exposes the construction surface used by the live execute-tools phase.
- `runtime/src/tools/router.ts` now builds a runtime attempt context after the orchestrator selects the sandbox attempt and injects it into `executeToolDispatch`.
- `runtime/src/tools/execution.ts` attaches the context as a non-enumerable injected argument before schema validation, enforces the runtime sandbox attempt, and still lets strict tool schemas validate.
- `runtime/src/phases/execute-tools.ts` constructs the live scheduler from `runtime/src/tools/runtimes/parallel.ts`.
- `runtime/src/tools/system/exec-command.ts` passes the selected runtime sandbox profile into unified exec for restricted attempts.
- `runtime/src/unified-exec/process-manager.ts` transforms restricted exec commands through the C-01 sandbox manager before spawning a child process or PTY.

## Donor Mapping

- `parallel.rs` -> `parallel.ts` plus the existing `runtime/src/tools/concurrency.ts` guard implementation.
- `sandboxing.rs` -> `sandboxing.ts`, `shell.ts`, `apply-patch.ts`, and the existing `runtime/src/tools/orchestrator.ts` approval/escalation flow.
- `runtimes/mod.rs` -> `context.ts`, `parallel.ts`, and `sandboxing.ts`; TL-21 intentionally has no re-export-only `index.ts`.
- `runtimes/shell.rs` -> `shell.ts`, backed by existing AgenC system shell handlers.
- `runtimes/unified_exec.rs` -> `unified-exec.ts`, backed by existing AgenC unified-exec process manager handlers.
- `runtimes/apply_patch.rs` -> `apply-patch.ts`, backed by existing AgenC apply-patch parser/runtime handlers.
- `handlers/shell.rs` -> existing `runtime/src/tools/system/exec-command.ts` plus `shell.ts` static runtime analysis; TL-21 does not relocate the whole shell handler lifecycle.
- `handlers/unified_exec.rs` -> existing `runtime/src/tools/system/{exec-command,write-stdin}.ts`, `runtime/src/unified-exec/*`, and `unified-exec.ts`; TL-21 adds selected sandbox profile threading into process launch and keeps result formatting/session polling in their existing owners.
- `handlers/apply_patch.rs` -> existing `runtime/src/tools/apply-patch/*` plus `apply-patch.ts` target extraction; TL-21 does not replace patch parsing/application.
- `orchestrator.rs`, `router.rs`, `registry.rs`, `events.rs`, and `context.rs` were already represented in AgenC-owned tool modules before TL-21. This item stitches the runtime split into those live modules rather than copying duplicate versions into this directory.
- Handler families outside shell/unified-exec/apply-patch remain explicit omissions for TL-21:
  - Agent/delegation handlers (`agent_jobs`, `multi_agents`, `multi_agents_common`, `multi_agents_v2`) stay with AgenC agent/task tool owners.
  - Goal, plan, permission-request, plugin-install, and user-input handlers stay with their control-surface owners.
  - List-dir, MCP, MCP resource, image, and test-sync handlers are non-shell families; TL-21 only inserts shared runtime scheduling/context/sandbox enforcement before they execute.
  - Dynamic discovery, tool-search, and unavailable-tool handlers remain registry/tool-selection concerns.
  - Donor handler test files are references only; executable TL-21 coverage is in the AgenC tests below.

## Behavioral Checks

- `runtime/src/tools/runtimes/runtime.test.ts` verifies parallel scheduling, sandbox-profile mapping, sandbox enforcement, approval-gated sandbox escalation, live router injection of selected sandbox attempt context through `executeToolDispatch`, actual `exec_command` / `Write` / `apply_patch` handler preflight under runtime-selected sandbox modes, and restricted-mode `write_stdin` denial for non-empty input.
- `runtime/src/phases/execute-tools.test.ts` verifies batched model tool calls flow through `executeTools`, the runtime scheduler, and per-call runtime context.
- `runtime/src/unified-exec/process-manager.test.ts` verifies restricted exec calls are transformed through the configured sandbox manager before spawn.
