# Code-Mode Parity

Donor references are local-only parity metadata for C-05.

Primary source anchor:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/core/src/tools/code_mode/mod.rs` // branding-scan: allow local parity citation
- `codex-rs/core/src/tools/code_mode/execute_handler.rs` // branding-scan: allow local parity citation
- `codex-rs/core/src/tools/code_mode/wait_handler.rs` // branding-scan: allow local parity citation
- `codex-rs/core/src/tools/code_mode/response_adapter.rs` // branding-scan: allow local parity citation
- `codex-rs/core/src/tools/code_mode/execute_handler_tests.rs` // branding-scan: allow local parity citation
- `codex-rs/tools/src/code_mode.rs` // branding-scan: allow local parity citation

C-05 scope carried into AgenC:
- `service.ts` owns the QuickJS-backed exec/wait cell lifecycle, stored values, yielding, waiting, termination, nested tool callbacks, and progress notifications.
- `turn-host.ts` owns turn-scoped nested-tool dispatch, self-invocation rejection, object/string nested input routing, fail-closed side-effect gating, code-mode result projection, cancellation propagation, and progress event emission.
- `tools.ts` owns the AgenC tool-registry exec/wait adapters, exec pragma parsing, enabled nested-tool metadata, wait arguments, and max-token handoff.
- `description.ts` owns exec/wait descriptions, exec pragma parsing, nested-tool identifier normalization, and code-mode tool-definition collection.
- `response-adapter.ts` owns runtime-response-to-tool-result rendering, status headers, error surfacing, content items, and output truncation.

Intentional C-05 shape reductions:
- The donor `execute_handler.rs` and `wait_handler.rs` class-style handlers are folded into `tools.ts` because AgenC's runtime tool surface is a plain `Tool` object with an `execute(args)` function, not a Rust `ToolHandler` trait.
- The donor `mod.rs` session wrapper is split across `service.ts` and `turn-host.ts`; session-specific router dispatch lives in `turn-host.ts`, while the JavaScript runtime and cell registry stay in `service.ts`.
- The donor `tools/src/code_mode.rs` freeform `ToolSpec` construction maps to AgenC's `Tool` plus registry string-argument handling. AgenC still accepts raw string exec calls through the registry's `exec -> code` string field.
- The donor execute-handler tests map to AgenC tests in `description.test.ts`, `tools.test.ts`, `service.test.ts`, and `turn-host.test.ts` rather than a stem-matched test filename.
- Until C-05 has a permission-aware nested runtime hook equivalent to the live model tool pipeline, side-effecting or approval-required nested tools fail closed instead of running through raw `Tool.execute()`. Read-only nested tools can use the registry fallback.

Validation note:
- The focused C-05 session test `dispatches code-mode nested tools through the registry code-mode path` passes. A full `run-turn.test.ts` run also contains an unrelated pre-existing LP-07 queued-stream cancellation failure observed before the C-05 edits; that broader failure is outside the code-mode host boundary.
