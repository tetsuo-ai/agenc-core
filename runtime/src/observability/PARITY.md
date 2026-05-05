# Observability Parity

## ZC-41 coverage lock

ZC-41 preserves the runtime observability call surface as a no-op interface.
The implementation lives in `telemetry.ts` and exports spans, span events,
attributes, counters, histograms, duration records, timers, tag sanitization,
and a replaceable global client. Runtime call sites import this surface rather
than binding directly to an exporter.

## Source anchors

- `/home/tetsuo/git/codex/codex-rs/otel/src/metrics/client.rs`
- `/home/tetsuo/git/codex/codex-rs/otel/src/metrics/timer.rs`
- `/home/tetsuo/git/codex/codex-rs/otel/src/metrics/names.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/turn_timing.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/session_startup_prewarm.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/hook_runtime.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/mcp_tool_call.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/exec.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/windows_sandbox.rs`
- `/home/tetsuo/git/codex/codex-rs/core/src/state/turn.rs`

## Carried behavior

- `TelemetryClient` carries the donor metrics-client call surface:
  `counter`, `histogram`, `recordDuration`, `timer`, `startSpan`,
  `withSpan`, `getCurrentSpan`, and `event`.
- `TelemetrySpan` carries span enter/exit, attributes, and events.
- `TelemetryTimer` carries explicit `record` / `end` semantics so callers do
  not rely on destructor behavior.
- Metric names are AgenC-owned (`agenc.*`) while preserving the donor metric
  categories: tool calls, unified exec, MCP calls, hook runs, turn E2E/TTFT/TTFM,
  startup prewarm duration/age, and Windows sandbox setup.
- `sanitizeMetricTagValue` and `toMetricTags` keep tag values bounded and
  telemetry-safe.

## Wired call sites

- `runtime/src/session/session.ts` stores spans and E2E timers on
  `RunningTask` and ends them on finish or abort.
- `runtime/src/session/turn-context.ts` and `runtime/src/session/run-turn.ts`
  preserve turn-start, TTFT, and TTFM timing seams.
- `runtime/src/session/startup-prewarm.ts`,
  `runtime/src/session/bootstrap.ts`, and
  `runtime/src/conversation/thread-manager.ts` record startup prewarm
  duration and first-turn age status.
- `runtime/src/hooks/engine/dispatcher.ts` records hook run count, duration,
  and completion event.
- `runtime/src/mcp-client/tool-bridge.ts` creates `mcp.tools.call` spans,
  records server fields, parses AgenC MCP result span metadata, and emits MCP
  count/duration metrics.
- `runtime/src/session/observer-wiring.ts`,
  `runtime/src/app-server/command-exec.ts`, and
  `runtime/src/unified-exec/process-manager.ts` preserve exec-command,
  app-server command execution, and Windows sandbox setup timing seams.

## Intentional reductions

- The default client is intentionally no-op. ZC-41 preserves call-site shape
  only; a later exporter can replace the client with no runtime call-site edits.
- The MCP result metadata key is AgenC-owned (`agenc/telemetry`) rather than
  donor-owned. The destination span attributes are also AgenC-owned
  (`agenc.mcp.*`).
- The donor row cites `core/src/session.rs`; the current donor checkout stores
  session runtime sources under `core/src/session/`. ZC-41 uses
  `core/src/session/mod.rs` and `core/src/session/session.rs` as the moved
  source counterparts, with live AgenC wiring in `runtime/src/session/`.
