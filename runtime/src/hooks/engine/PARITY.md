# Hook Engine Parity

Upstream reference: `/home/tetsuo/git/codex/codex-rs` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`. <!-- branding-scan: allow upstream source root path -->

Primary source anchors:
- `core/src/hook_runtime.rs` <!-- branding-scan: allow upstream source file path -->
- `hooks/src/engine/dispatcher.rs` <!-- branding-scan: allow upstream source file path -->
- `hooks/src/engine/command_runner.rs` <!-- branding-scan: allow upstream source file path -->
- `hooks/src/engine/output_parser.rs` <!-- branding-scan: allow upstream source file path -->
- `hooks/src/engine/discovery.rs` <!-- branding-scan: allow upstream source file path -->
- `hooks/src/events/permission_request.rs`
- `hooks/src/events/session_start.rs`
- `hooks/src/events/stop.rs`
- `hooks/src/events/pre_tool_use.rs`
- `hooks/src/events/post_tool_use.rs`
- `hooks/src/events/user_prompt_submit.rs`

This directory owns AgenC's configured hook runtime dispatcher:
- `discovery.ts` flattens validated config into ordered configured handlers.
- `dispatcher.ts` selects matching handlers, dispatches command hooks, and records diagnostics.
- `command-runner.ts` owns subprocess execution, timeout, abort, and stdin behavior.
- `output-parser.ts` normalizes structured command output for permission, stop, and context decisions.

The event adapters live at AgenC call sites:
- `runtime/src/hooks/configured-hooks.ts` maps configured commands onto the six event surfaces.
- `runtime/src/permissions/hook-event-schedule.ts` owns matcher policy for those permission-facing lifecycle events.
- `runtime/src/hooks/user-prompt-submit.ts`, `runtime/src/phases/stop-hooks.ts`, and `runtime/src/llm/hooks/types.ts` carry the local input/result contracts those adapters feed.
