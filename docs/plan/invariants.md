# Design Invariants

These are the architectural rules that resolve design holes the
flowchart (`agentic-loop.html`) exposed. Every tranche references them;
violating one is a bug.

Each invariant has: **the rule**, **why it matters**, **where it's
enforced in code**, and **the test that proves it**.

---

## I-1 · Subagent recursion depth is bounded

**Rule:** Every `AgentThread` carries a `depth: number`. Root session =
0. Spawning a child increments by 1. Spawn is rejected with
`MaxDepthExceeded` when `depth + 1 > MAX_AGENT_DEPTH`.

**Default:** `MAX_AGENT_DEPTH = 4`. Overrideable via
`config.agents.maxDepth` (root) or per-role in `agents/role.ts`.

**Divergence:** codex ships `DEFAULT_AGENT_MAX_DEPTH = 1` (single
level of subagent recursion). AgenC raises the default to 4 so a
coordinator → planner → worker → tool-caller chain fits inside the
default cap. Intentional AgenC divergence; operators who want codex
semantics set `config.agents.maxDepth = 1`.

**Why:** registry caps breadth (`max_threads`) but nothing today caps
depth. A misbehaving child calling `AgentTool` can recurse
indefinitely, burning slots and tokens.

**Enforced in:** `runtime/src/agents/control.ts` — `spawnAgentInternal`
checks depth before allocating slot and before rollout fork.

**Test:** `agents/control.test.ts` — spawn 5 nested agents, assert 5th
rejects with `MaxDepthExceeded`.

---

## I-2 · `previous_response_id` is cleared on any compaction

**Rule:** Every compaction cleanup path — `auto-compact`,
`micro-compact`, `session-memory-compact`, `reactive-compact`,
`collapse-drain`, manual `/compact` — MUST synchronously call
`clearResponseId()` on the active provider adapter as part of its
post-compact cleanup, BEFORE returning control to the phase machine.

**Why:** `previous_response_id` (xAI Responses API; OpenAI Responses
API) tells the provider "continue from this response with these new
inputs as delta." After compaction, the history sent is radically
different from what the provider associates with that id, producing
undefined behavior. Openclaude doesn't have this concern because its
ccrClient doesn't use `previous_response_id`; AgenC does because xAI
and OpenAI do.

**Pattern:** synchronous call inside `runPostCompactCleanup()`,
mirroring the openclaude pattern (`postCompactCleanup.ts:31-77`) that
clears 8+ caches synchronously. Not an event subscription — cleanup
must be deterministic, serial with compaction, and complete before
the next model request is built.

**Enforced in:** `runtime/src/llm/compact/post-compact-cleanup.ts` —
**partial port** of the openclaude pattern, not verbatim. Openclaude's
source imports `bun:bundle` and `../../tools/BashTool/bashPermissions.js`
which don't resolve in AgenC's build graph. AgenC reproduces the
synchronous-cleanup contract (serial with compaction, complete before
the next request is built) and routes the `previous_response_id` clear
through a tracker-registry shim at
`runtime/src/llm/grok/incremental.ts::clearAllResponseIds`. Adapters
without `previous_response_id` (Anthropic, local, Ollama) register a
no-op clear. Openclaude's other cache-clearing helpers (image,
tool-result, etc.) are ported selectively as AgenC grows those caches.

**Test:** `llm/compact/post-compact-cleanup.test.ts` — invoke
compaction with a cached `lastResponseId`, assert the provider's
cache is empty immediately after `runPostCompactCleanup()` returns
and before any next request is built.

---

## I-3 · Mode changes require a mid-dispatch guard on every mutation tool

**Rule:** Every tool with `ConcurrencyClass.Exclusive` (writes, bash,
network) MUST re-check `permissions.mode` immediately before mutating
state, not just at evaluation time. A mid-stream Shift+Tab transition
to `plan` mode while a write is in flight must abort the write.

**Why:** Openclaude only wires this race guard for Bash
(`tools/BashTool/bashPermissions.ts`). Every other mutation tool has a
window where the user cycles modes via Shift+Tab and the tool still
commits, violating plan-mode's read-only contract.

**Enforced in:** `runtime/src/tools/execution.ts` —
`runToolUse()` injects a `checkModeStillAllowed()` callback that
mutation tools call before their final commit (file write, process
spawn, network send). `permissions/mode.ts` exposes
`subscribeToModeChange()` for abortability.

**Status:** WIRED (T11) — `runtime/src/tools/execution.ts`
subscribes via `PermissionModeRegistry.subscribeToModeChange`
inside `runToolUse` (unsubscribe on settle) and the evaluator
`runtime/src/permissions/evaluator.ts::checkModeGate` re-reads
`context.getAppState()` at step 2a to observe Shift+Tab races
mid-evaluation.

**Test:** `tools/execution.test.ts` — start a write tool, flip mode to
plan mid-execution, assert write aborts and emits
`TerminalToolResult{reason:'mode_changed'}`.

---

## I-4 · Event log fsync at turn commit

**Rule:** `session-store` batches JSONL writes at 100ms for
throughput, but **every `TurnComplete`, `TurnAborted`, `Error`, and
`ContextCompacted` event forces an immediate fsync** before the
phase machine proceeds. Turn-scoped durability is guaranteed; within
a turn, up to 100ms of progress events may be lost on crash.

**Why:** The openclaude pattern of 100ms batching is fine for token
deltas and tool progress (both replayable) but unacceptable for turn
boundaries (not replayable — the next turn depends on knowing the
previous one committed).

**Enforced in:** `runtime/src/session/session-store.ts` — every
append first checks `isDurableEvent(event)`; if true, flush batch +
`fs.fsync()` before returning.

**Test:** `session/session-store.test.ts` — simulate crash
(`process.exit`) between an `AgentMessage` emit and a `TurnComplete`
emit, assert replay sees everything up to and including
`TurnComplete`.

---

## I-5 · Mailbox is bidirectional

**Rule:** `Mailbox` supports both child→parent (progress, completion,
result) and parent→child (`Interrupt`, `Resume`, `Cancel`,
`UpdateContext`) messages. `MailboxReceiver` exists on both ends.
Codex semantics — not openclaude's AsyncGenerator-only pattern.

**Why:** Parent can't interrupt a long-running async child without a
send path. Openclaude uses AbortController for hard cancel but lacks
softer signals (pause, update-context, nudge).

**Enforced in:** `runtime/src/agents/mailbox.ts` — `send()` takes a
`direction: 'up' | 'down'` and routes to the correct queue. `Session`
holds both `inbox` (from children) and `childInboxes: Map<threadId,
Mailbox>` (to children).

**AgenC interrupt-cascade divergence:**
`AgentControl.interrupt(threadId)` in `runtime/src/agents/control.ts`
cascades the abort to every live descendant of the interrupted agent
(recursive `this.interrupt(descendant.agentId, ...)` at the tail of
`interrupt()`). Codex's `interrupt_agent` (`control.rs:643-646`)
submits only to a single thread. Rationale: in AgenC a user Ctrl+C
or a parent→child `Interrupt` must reach every in-flight subagent
on the spot; in codex the supervisor loop drives the cascade
externally. Downstream TUI and any caller issuing an interrupt
must not assume single-thread interrupt semantics — sending
`Interrupt` to a non-leaf agent WILL tear down its entire live
subtree.

**Test:** `agents/mailbox.test.ts` — spawn child, send `Interrupt`
from parent, assert child receives and aborts its current turn.

---

## I-6 · MCP startup failure is fail-soft by default

**Rule:** If an MCP server does not respond within its startup
timeout (default 30s), AgenC logs a warning, emits a
`McpStartupFailed` event, and continues without that server's tools.
`config.mcp.<name>.required: true` flips this to hard-fail.

**Why:** One flaky MCP server shouldn't block the CLI from starting.
But some servers (e.g., an auth provider or a required gateway)
genuinely must be up.

**Enforced in:** `runtime/src/mcp-client/manager.ts` —
`waitForServerReady(name, timeoutMs)` returns
`{ready: boolean, error?: Error}`; manager decides based on
`required` flag.

**Test:** `mcp-client/manager.test.ts` — start with a server that
refuses connection, assert CLI boots and emits the warning; set
`required: true`, assert boot fails with clear error message.

---

## I-7 · Stream abort cascades through the tool executor — with two destinations

**Rule:** When a stream abort fires, the model stream's `AbortController`
must be signaled AND every in-flight tool in `StreamingToolExecutor`
must be aborted. **But the destination differs by abort trigger:**

| Trigger | Cascade destination | Reason returned |
|---|---|---|
| User interrupt (Ctrl+C) | `Cleanup → Exit` | `aborted_streaming` (openclaude `query.ts:1082`) |
| Subagent parent `Interrupt` (I-5) | `Cleanup → Exit` | `aborted_streaming` |
| Recovery trigger (PTL, media, max-tokens) | `Phase3 post-sample-recovery` | continues loop |
| Plan-mode transition mid-stream (I-3) | `Cleanup → Exit` with `TerminalToolResult{reason:'mode_changed'}` | `aborted_streaming` |
| Provider hard-fail (401 bearer, OAuth exhausted) | `Cleanup → Exit` | `auth_failed` |

In all five cases the cascade is identical (walk
`streamingToolExecutor.getRemainingResults()` to synthesize
`tool_result` blocks for orphans — openclaude `query.ts:1046-1060`).
What differs is where control flow returns after cleanup.

**Why:** Orphan tools continue running after any of these triggers,
producing results that don't match the (now-modified) history. They
also hold locks preventing either the recovery path or the exit path
from progressing. But recovery is for *transient* provider-side
conditions the loop can heal from; user/parent interrupt and hard
auth failure are *terminal* and exit the turn.

**Enforced in:** `runtime/src/phases/post-sample-recovery.ts`,
`runtime/src/phases/stream-model.ts`, and
`runtime/src/agents/mailbox.ts` — each caller of `abortInFlight()`
passes an `AbortReason` enum (`user_interrupt`, `parent_interrupt`,
`recovery`, `mode_changed`, `auth_failed`) that determines the
destination.

**Test:** `phases/post-sample-recovery.test.ts` — start a stream
with 3 concurrent tools; trigger each of the 5 reasons; assert (a)
all 3 tools receive abort signal, (b) the correct destination is
reached, (c) `tool_result` synthesis produces matching ids for all
orphaned `tool_use` blocks.

---

---

## I-8 · Every error site emits a typed event

**Rule:** Every code path that surfaces an error to the user — phase
abort, provider auth failure, MCP startup failure, subagent
rejection, mode-race abort, stop-failure, recovery exhaustion,
schema validation failure, hook deny — MUST emit either an `error`
or `stream_error` event to the event log before returning. No
silent failures.

**Why:** AgenC adopts codex's typed `EventMsg` discriminated union
(`protocol.rs` `Error`, `StreamError`, `Warning`) precisely so
post-mortem analysis (replay, debugging, telemetry) can distinguish
*what kind of failure happened*. An event log that only records
happy-path events is a liar — replay reconstructs a session that
"completed normally" when it actually died on a 401.

Openclaude doesn't have this issue because it tags errors inline on
messages with `isApiErrorMessage` (openclaude `query.ts:1103, 1297`);
that pattern doesn't survive AgenC's structured event log because
errors aren't always inside an assistant message.

**Enforced in:** `runtime/src/session/event-log.ts` exports an
`emitError(session, error, classification)` helper. Lint rule
(`@typescript-eslint/no-throw-without-emit`) flags any `throw` or
`return {error}` in a phase, recovery, or sidecar module that
isn't preceded by an `emitError()` call.

**Test:** `session/event-log.test.ts` — for each of the 13 known
error sites listed in the invariant matrix, assert the corresponding
event variant is appended to the rollout before the phase machine
returns.

### Known error emission sites

| Site | Event variant | Module |
|---|---|---|
| Provider 401 (bearer) | `error` | `phases/stream-model.ts` |
| Provider 401 (OAuth, after `MAX_CONSECUTIVE_AUTH_FAILURES`) | `error` | `llm/oauth/refresh-loop.ts` |
| Provider network 5xx (after SDK retry) | `stream_error` | `phases/stream-model.ts` |
| Recovery exhausted (`prompt_too_long`, `image_error`) | `error` | `phases/post-sample-recovery.ts` |
| Stop-hook blocking-error injection | `warning` | `phases/stop-hooks.ts` |
| Stop failure | `error` | `phases/stop-hooks.ts` |
| MCP startup failure (soft) | `warning` | `mcp-client/manager.ts` |
| MCP startup failure (hard, `required:true`) | `error` | `mcp-client/manager.ts` |
| Subagent depth exceeded (I-1) | `error` | `agents/control.ts` |
| Subagent slot rejected | `warning` | `agents/registry.ts` |
| Mode race abort (I-3) | `warning` | `tools/execution.ts` |
| Tool schema validation failure | `error` | `tools/execution.ts` |
| Hook deny | `warning` | `tools/hooks.ts` |

---

## I-9 · Per-tool execution timeout

**Rule:** Every tool dispatch carries a `maxRuntimeMs` budget. Default
30,000 (30s); per-tool override via `tool.timeoutMs`; per-call
override via tool args (e.g. `Bash{timeoutMs:120000}`). On timeout:
abort the tool via its `AbortController`, synthesize a
`TerminalToolResult{reason:'timeout', is_error:true}`, emit I-8
`stream_error`, and continue.

**Source:** **PORT** from codex `core/src/tools/registry.rs:561`
(`timeout_ms: params.timeout_ms`) + `tools/mod.rs:107-108`
(`build_content_with_timeout`). Openclaude has Bash-only timeout
(`tools/BashTool/`); codex has it generic. Take codex's pattern.

**Why:** Without this, a hung MCP call, infinite loop in a tool's own
code, or a stalled subprocess (where SIGTERM is ignored) blocks
`StreamingToolExecutor` indefinitely. Sibling-abort (Bash-only) only
fires on Bash *errors*, not Bash *hangs*.

**Enforced in:** `runtime/src/tools/execution.ts` — wrap
`runToolUse()` generator in `Promise.race([toolPromise,
timeoutPromise])`. `runtime/src/tools/registry.ts` extends each
registered tool with default + override timeout.

**Test:** `tools/execution.test.ts` — register a tool that returns a
never-resolving promise; assert dispatch returns
`TerminalToolResult{reason:'timeout'}` after 100ms timeout.

---

## I-10 · Recovery trigger priority is explicit

**Rule:** When the last assistant message satisfies more than one
recovery condition, evaluate in this fixed order: `isWithheld413` →
`isWithheldMedia` → `isWithheldMaxOutputTokens` →
`stopHookBlocking` → `streamingFallbackOccured` → `FallbackTriggeredError`.
First match wins; the rest are ignored for that turn.

**Source:** **DOCUMENT** existing openclaude order at `query.ts:1101,
1115, 854, 1335, 928`. Order is implicit in current source (chained
`if`/`else if`); AgenC makes it explicit + tested.

**Why:** Multiple triggers CAN fire simultaneously (e.g. an oversized
tool result causes both PTL and a media-too-large flag). The
implicit order in openclaude has the right priority (413 first
because compaction also fixes media bloat) but it's never asserted.
Future refactors can silently reorder and break recovery in subtle
ways.

**Enforced in:** `runtime/src/phases/post-sample-recovery.ts` — a
single ordered `RecoveryTrigger[]` array with `match()` + `apply()`
per trigger, evaluated in array order. Test asserts the array matches
the documented order.

**Test:** `phases/post-sample-recovery.test.ts` — synthesize a
message satisfying ALL triggers, assert `WithheldGate413` is taken.

---

## I-11 · Stream idle watchdog (default-on)

**Rule:** While streaming from any provider, a watchdog times the
gap since the last received event. If gap exceeds
`STREAM_IDLE_TIMEOUT_MS` (default 90,000 — matches openclaude `claude.ts:1898`), abort the stream with
`abortReason='stream_idle'`, emit I-8 `stream_error`, route to
`AbortRecovery → Phase3` (transient — SDK retry attempts a
reconnect).

**Source:** **PORT** from openclaude `services/api/claude.ts:1894-2433`
(`streamWatchdogEnabled`, `streamWatchdogFiredAt`,
`streamIdleAborted`) + codex `client.rs:1146`
(`stream_idle_timeout_ms` from provider info). Openclaude gates
behind `CLAUDE_ENABLE_STREAM_WATCHDOG` env var; **AgenC ships
default-on** because silent provider stalls are pure latency burn.

**Why:** Provider connections can hold open while the upstream
generation stalls (network buffer, server-side bug, OpenAI/xAI
incident). Without a watchdog, the CLI hangs until TCP keepalive
eventually trips — minutes to hours.

**Enforced in:** `runtime/src/phases/stream-model.ts` —
`for await` loop wraps each iteration in
`Promise.race([nextEvent, idleTimer])`. Resets timer on each event;
fires `AbortController.abort('stream_idle')` on expiry.

**Test:** `phases/stream-model.test.ts` — mock provider that opens
stream then stalls 100s. Assert abort fires at 90s, recovery routed.

---

## I-12 · Filesystem error handling for durable writes

**Rule:** Every disk write in `session-store.ts`, `file-history.ts`,
and `error-log.ts` MUST handle `ENOSPC` (disk full), `EROFS`
(read-only), `EACCES` (permission), and `EIO` (hardware) explicitly.
On any of these: emit I-8 `error`, switch the affected sidecar into
**degraded mode** (in-memory ring buffer of last 1000 events,
attempts to flush every 30s), and surface a one-shot warning to the
TUI cockpit.

**Source:** **NEW for AgenC**. Neither openclaude `sessionStorage.ts`
nor codex `rollout/` handles these explicitly — both will throw
unhandled rejections on ENOSPC, which silently breaks the I-4 fsync
guarantee.

**Why:** AgenC sessions can run for hours and emit thousands of events
to disk. A full disk during a long session today produces silent data
loss + a future fsync that thinks it succeeded. I-4 says "fsync at
turn commit guarantees durability" — but only if the write itself
didn't fail. Honoring I-4 requires honoring the failure mode.

**Enforced in:** `runtime/src/session/session-store.ts` — wrap every
`fs.writeFile` / `fs.appendFile` / `fs.fsync` in a discriminated
try/catch with branches for each errno. Degraded-mode ring buffer at
`runtime/src/session/degraded-store.ts`.

**Test:** `session/session-store.test.ts` — mock `fs.appendFile` to
throw `ENOSPC`; assert error event emitted, ring buffer engaged,
turn aborts cleanly with `error:'persistence_failed'` rather than
unhandled rejection.

---

## I-13 · Mid-stream provider/model switch is treated as a deliberate abort

**Rule:** When the user invokes `/model <name>` or `/provider <name>`
during an active stream, the command does NOT take effect on the
current turn. It:
1. Sets a pending switch flag on the session.
2. Triggers `AbortTerminal(reason='provider_switched')` to drain
   the current stream cleanly (orphan tool_results synthesized per
   I-7).
3. Applies the new provider/model on the NEXT turn (after
   `WaitInput`).
4. Clears `lastResponseId` (I-2 — provider boundary invalidates
   incremental cache).
5. Emits I-8 `warning` with old/new provider+model in the event log.

**Source:** **NEW for AgenC**. Openclaude's `commands/model/` doesn't
handle live-stream switches; the slash command just updates state
silently and the in-flight stream completes with the old model. With
multi-provider that's worse — the new provider's request shape
won't match the pending response.

**Why:** Multi-provider exposes a class of bugs openclaude doesn't
have. Mid-stream provider switch with mismatched request shape
produces wrong-format tool calls or undefined provider behavior.
Better to abort cleanly + apply on next turn.

**Enforced in:** `runtime/src/commands/model.ts` and
`runtime/src/commands/provider.ts` — both check
`session.activeTurn !== null` and dispatch via
`session.abortTerminal('provider_switched')` if so.
`runtime/src/session/run-turn.ts` reads pending-switch flag at the
top of each turn and applies before Phase 1.

**Status:** WIRED (T11) — staged via the typed mutator in
`runtime/src/commands/model.ts` (sets `session.pendingProviderSwitch`);
consumed at the top of the turn loop in
`runtime/src/session/run-turn.ts` (see `session.pendingProviderSwitch`
check inside the run-turn loop).

**Test:** `commands/model.test.ts` — start a stream, fire `/model
gpt-5` mid-stream, assert (a) current stream aborts with reason, (b)
next turn uses gpt-5, (c) `lastResponseId` cleared, (d) warning
event emitted.

---

## I-14 · `previous_response_id` server-side expiration retry

**Rule:** When a provider returns 404 / `unknown_response_id` /
`response_not_found` (or the equivalent) for a request carrying
`previous_response_id`, the adapter MUST: (a) clear `lastResponseId`
on that adapter, (b) retry the same request once with the full
history (omitting `previous_response_id`), (c) emit I-8 `warning`
with `cause='previous_response_id_expired'`.

**Source:** **NEW for AgenC**. Codex `client.rs:980` always sends
`previous_response_id` when available but has no branch for the
provider returning "I don't know that id." Provider response caches
have TTLs (xAI evicts after ~10 minutes of inactivity per their
docs); a long pause between turns can trigger this.

**Why:** Without retry, the user sees a cryptic 404 error and the
turn fails. With it, the worst case is one turn that sends full
history (slightly more tokens) — invisible to the user.

**Enforced in:** `runtime/src/llm/providers/grok/incremental.ts` and
`providers/openai/incremental.ts` — wrap the first request attempt;
on the specific error code, retry once with `previous_response_id`
omitted, then succeed or fail normally.

**Test:** `llm/providers/grok/incremental.test.ts` — mock provider
returning 404 with `previous_response_id` set; assert clear + retry +
warning event.

---

## I-15 · Tool result size hard cap

**Rule:** Every tool result is capped at `MAX_TOOL_RESULT_BYTES`
(default 400 KB — matches openclaude `MAX_TOOL_RESULT_TOKENS=100_000 × BYTES_PER_TOKEN=4`; per-tool override). Results exceeding the cap are
truncated to `cap - marker.length` and a marker
`\n\n[truncated: original was N bytes, returning first M]\n` is
appended. Emit I-8 `warning` per truncation.

**Source:** **PORT + GENERALIZE** from openclaude
`utils/shell/outputLimits.ts:3-11` (`BASH_MAX_OUTPUT_DEFAULT=30_000`,
`BASH_MAX_OUTPUT_UPPER_LIMIT=150_000`, env override). Openclaude has
this for Bash only; AgenC generalizes to every tool.

**Why:** Without a generic cap, a tool that returns a 50 MB binary
read or a database dump gets injected verbatim into history,
overflowing the next request, forcing compaction, which still has to
truncate it (badly). Better to truncate at the boundary where size
context is local.

**Enforced in:** `runtime/src/tools/execution.ts` — after
`runToolUse()` returns, before injecting into messages, run
`capToolResult(result, tool.maxResultBytes ?? DEFAULT)`.

**Test:** `tools/execution.test.ts` — register a tool that returns
500 KB; assert result is truncated to 400 KB with marker, warning
emitted.

---

## I-16 · Mailbox is bounded with backpressure policy

**Rule:** `Mailbox` has a per-direction capacity of
`MAX_MAILBOX_DEPTH` (default 1000). When full, `send()` blocks for
up to `MAX_MAILBOX_BLOCK_MS` (default 5000); on timeout, drop the
oldest message, increment `droppedMessageCount`, emit I-8 `warning`
once per drop streak.

**Source:** **NEW for AgenC** (must change codex pattern). Codex
`agent/mailbox.rs:12-24` uses `mpsc::unbounded_channel()` —
explicitly unbounded. Acceptable in Rust where sends are
non-blocking and memory pressure is observed via OS signal; in
Node.js with no equivalent backpressure signal, an unbounded
mailbox is a memory leak waiting to happen.

**Why:** If a parent's main loop blocks (e.g. user sitting on an
approval modal) while a busy async child sends progress, the queue
grows unbounded. Eventually OOM.

**Enforced in:** `runtime/src/agents/mailbox.ts` — `AsyncQueue`
implementation has a `maxDepth` parameter; `send()` returns a
`Promise<SendResult>` that may resolve to `'sent'`, `'dropped'`, or
`'rejected'` per backpressure policy.

**Test:** `agents/mailbox.test.ts` — fill queue to capacity, send
N+1th message, assert oldest dropped, warning emitted, droppedCount
incremented.

---

## I-17 · Stop-hook recursion cap

**Rule:** Per-turn counter `stopHookBlockingCount` increments each
time `phases/stop-hooks.ts` injects blocking errors. Default cap
`MAX_STOP_HOOK_BLOCKS = 3`. Exceeding the cap forces termination of
the turn with `error:'stop_hook_loop'`, emits I-8 `error`.

**Attribution (T8 A4 closure):** `MAX_STOP_HOOK_BLOCKS = 3` is
openclaude-sourced. AgenC reuses the exact value and extends the
pattern from a boolean `stopHookActive` flag into a counted cap so
multi-stop-hook configs can't sidestep the ceiling.

**Source:** **PORT + EXTEND**. Openclaude has `stopHookActive`
boolean flag (`query.ts:211, 1310, 1335`) that prevents one specific
re-fire pattern, but no counter cap. If a hook keeps blocking on each
retry (e.g. a buggy hook that always returns blockingErrors), the
flag flips back and forth without breaking the loop.

**Why:** Without a cap, a misbehaving stop hook turns every session
into an infinite loop that burns tokens on each cycle until the user
notices. Same class of bug as the autocompact circuit breaker
(`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`).

**Enforced in:** `runtime/src/phases/stop-hooks.ts` — counter on
`TurnState`, incremented on each `StopHookInject`, checked at top of
`evaluateTurnEndStopGate()`.

**Test:** `phases/stop-hooks.test.ts` — register a hook that always
blocks, assert turn terminates with `error:'stop_hook_loop'` after 3
blocks.

**Counter-reset semantics (T8 concrete):**

- `state.stopHookBlockingCount` is per-turn (initialized to 0 in
  `buildInitialTurnState`).
- On a non-blocking stop-hook result: the counter isn't incremented;
  legitimate successive stops don't combine with earlier one-shot
  blocks.
- Reaching the cap emits `error:'stop_hook_loop'` + returns
  `allowStop=true` so the turn terminates cleanly (do NOT re-enter
  the hook loop at the cap).
- API-error stop-hook guard fires BEFORE the block-injection
  branch — an API-error turn with a blocking hook takes the
  skip-path (`reason:'api_error_stop_guard'`) so a single buggy
  hook cannot spiral tokens on PTL responses.

---

## I-18 · Compaction must shrink the history

**Rule:** After `compactConversation()` returns, assert
`summary.tokens < original.tokens * 0.7` (configurable via
`config.compaction.minShrinkRatio`). If the assertion fails, treat
as a compaction failure: increment circuit-breaker counter (the
existing `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`), discard the
summary, fall through to alternative recovery (collapse-drain,
reactive-compact). Emit I-8 `warning`.

**Source:** **NEW for AgenC**. Openclaude has the failure-counted
circuit breaker (`autoCompact.ts:75`) but only counts THROWN
failures, not "succeeded but produced verbose summary." A model that
returns a longer summary than the input is a soft failure that goes
undetected today.

**Why:** Some models occasionally restate the entire history as the
"summary" (especially when given vague summarization instructions).
Without the assertion, every subsequent turn re-compacts because
context is still over the threshold — burning tokens on
self-defeating summaries.

**Enforced in:** `runtime/src/llm/compact/compact.ts` — at the end
of `compactConversation()`, before returning the result.

**Test:** `llm/compact/compact.test.ts` — mock provider that returns
a summary 90% the size of the original; assert circuit-breaker
counter incremented, summary discarded, warning emitted.

---

## I-19 · TUI stdin loss is a graceful exit

**Rule:** If the TUI loses stdin (terminal closed, SSH session
dropped, parent process died, EPIPE on write), treat as a graceful
session-end signal. Sequence: (a) abort active turn via
`AbortTerminal('stdin_lost')`, (b) flush all pending writes (I-4
fsync), (c) emit I-8 `warning` with `cause='stdin_lost'`, (d) exit
with code 130 (same as SIGINT — not an error).

**Source:** **NEW for AgenC**. Openclaude has `suspendStdin` for
intentional pause, but no explicit handler for unexpected stdin
closure. Today this surfaces as unhandled exception in Ink's read
loop.

**Why:** In production usage AgenC sessions can run inside detached
tmux/screen, SSH connections, or be parented to a script that
crashes. Unexpected stdin closure should mean "user is gone, save
state and shut down cleanly," not "unhandled exception, lose the
last 100ms of events."

**Enforced in:** `runtime/src/tui/main.tsx::handleStdinLoss`
(~lines 138-200) — `bootTUI` registers
`stdin.once('close'|'end'|'error')` handlers at ~lines 244-246
that call `handleStdinLoss`, which (1) invokes
`session.abortTerminal('stdin_lost')`, (2) awaits `flushEventLog`
with a hard cap (or a 200ms fallback grace), (3) emits
`warning:stdin_lost` via `session.emit`, (4) unmounts the Ink
tree, and (5) calls `process.exit(130)`.

**STATUS:** WIRED (T12). `runtime/src/tui/main.tsx` ships the full
I-19 protocol. The bin-level SIGHUP hook at
`runtime/src/bin/agenc.ts` still routes SIGHUP through
`session.abortTerminal('stdin_lost')` per I-46 for the
headless / one-shot path.

**Test:** `runtime/src/tui/main.stdin-loss.test.tsx` — simulate
stdin `close`/`end`/`error` mid-stream; assert clean shutdown
sequence, exit code 130, no unhandled rejection.

---

## I-20 · MCP startup aggregate failure mode

**Rule:** If ALL configured MCP servers fail startup (regardless of
per-server `required` flag), AND any tool spec marks itself
`requiresMcp: true` (e.g. tools defined inline by an MCP server's
prompt extensions), AgenC hard-fails boot with a clear "no MCP
servers available" message. If no tool requires MCP, soft-fail per
I-6 and continue with built-in tools only.

**Source:** **NEW for AgenC**. Openclaude evaluates per-server. No
aggregate rollup. With AgenC's broader MCP usage (resources, prompts,
multiple servers expected), this matters more.

**Why:** A misconfigured MCP setup (wrong env vars, missing OAuth
tokens) typically fails ALL servers identically. Soft-failing each
one and continuing with zero MCP capability gives the user a CLI
that *looks* functional but can't do MCP work — silent degradation.
The aggregate rollup catches this.

**Enforced in:** `runtime/src/mcp-client/manager.ts` — after the
parallel startup phase, count successes vs total. Aggregate-failure
branch in init.

**Test:** `mcp-client/manager.test.ts` — configure 3 MCP servers,
all fail; assert boot-fail with aggregate error message.

---

## I-21 · Approval modal lifecycle bounded by abort

**Rule:** When the approval modal is open and the user fires
Ctrl+C (or any abort signal), the modal MUST: (a) resolve its
pending decision promise with `{behavior:'abort'}`, (b) propagate
to the in-flight tool's AbortController, (c) NOT swallow the abort
or treat Ctrl+C as "deny." Modal cleanup runs before the abort
cascade (I-7) processes orphans.

**Source:** **NEW for AgenC**. Openclaude's
`hooks/toolPermission/handlers/interactiveHandler.ts` doesn't
explicitly handle Ctrl+C during modal — the abort signal arrives at
the tool dispatcher but the modal promise can resolve later with a
stale decision.

**Why:** Race window: user Ctrl+C while approval modal is rendered.
Without explicit ordering, the modal can resolve with `'allow'`
after the abort, dispatching a tool the user just tried to cancel.

**Enforced in:** `runtime/src/tui/permissions/ApprovalOverlay.tsx`
(~lines 217-245) — the overlay subscribes to
`session.abortController.signal` on mount, switches the keybinding
context to `modal` (I-72), and on abort resolves immediately with
`{behavior:'abort'}`. `runtime/src/tui/permissions/InteractiveHandler.tsx`
(~lines 292-395) is the lifecycle owner that mounts the overlay
and claims `abort` on unmount if the request is still unresolved.

**STATUS:** WIRED (T12). Both the modal's abort-signal listener
and the handler's unmount-claim path are live.

**Test:** `runtime/src/tui/permissions/InteractiveHandler.test.tsx`
— open modal, fire abort, assert modal resolves with abort
decision and tool is NOT dispatched.

---

## I-22 · Token budget checked mid-stream, not just at turn boundaries

**Rule:** While streaming, after every N (default 1000) output
tokens, check `budgetTracker.remaining`. If exceeded: abort stream
with `AbortRecovery(reason='token_budget_exceeded')`, route to
Phase 3 which can decide to inject a budget-continuation nudge
(existing pattern at openclaude `query.ts:1375`).

**Source:** **PORT + EXTEND**. Openclaude has `budgetTracker` +
`token_budget_continuation` transition (`query.ts:1346, 1375`) but
checks only at turn boundaries. AgenC adds the mid-stream check.

**Why:** A turn that asks for "just write the entire codebase as a
single response" can blow the token budget by 10x before hitting any
boundary check. Mid-stream check enforces the budget where the
overshoot actually happens.

**Enforced in:** `runtime/src/phases/stream-model.ts` — emit-token
loop tracks running token count; modulo N triggers budget check.

**Test:** `phases/stream-model.test.ts` — set budget to 500 tokens;
mock stream emitting 5000 tokens; assert abort fires near 1000-token
mark with `token_budget_exceeded`.

---

# Edge-case invariants — second sweep (I-23..I-72)

50 additional invariants surfaced by 8 specialist subagent reviews of
the flowchart. Each carries source provenance: **PORT** (working
solution exists in openclaude/codex; copy it), **EXTEND** (partial
solution exists; broaden), **NEW** (no upstream solution; AgenC must
build), or **ALREADY-COVERED** (verified in upstream; documented here
for completeness). Each invariant is shorter-form than I-1..I-22 to
keep this section navigable.

## Persistence & durability (I-23..I-30)

### I-23 · Concurrent-session file lock on rollout
**NEW.** Two AgenC processes opening the same `~/.agenc/projects/<slug>/sessions/<sessionId>/` corrupt the rollout. Acquire `flock(LOCK_EX|LOCK_NB)` on `rollout-*.jsonl` before first append; on `EWOULDBLOCK`, hard-fail boot with `error:'session_locked'` and the holder's PID. Release on graceful exit. **Where:** `runtime/src/session/session-store.ts`. **Test:** spawn two processes against same session, second fails fast.

### I-24 · Atomic rollout append (write-then-rename for batch flushes)
**NEW.** A crash mid-`fs.appendFile` leaves a half-written JSONL line. Replay's reverse-scan truncates at the corrupt line, losing the turn. Pattern: write the batch to `rollout-*.jsonl.tmp`, fsync, then `fs.rename` over the live file. On startup, scan tail for trailing partial line; truncate + emit `warning:'rollout_truncated_corrupt_tail'`. **Where:** `runtime/src/session/session-store.ts`. **Test:** kill mid-write, reopen, verify reconstruction succeeds.

### I-25 · Snapshot is best-effort, rollout is source of truth
**NEW.** Periodic `state.snapshot.json` writes can succeed while the rollout fsync fails (or vice versa) — a divergence both files claim authoritative. Rule: rollout JSONL is the only source of truth for replay; snapshot is a 30-min cached projection used only as a reconstruction speedup. Each carries `snapshotSequenceNumber`; if snapshot.seq < rollout.seq, ignore snapshot + emit `warning:'snapshot_behind_rollout'`. **Where:** `runtime/src/session/rollout-reconstruction.ts`.

### I-26 · Forward-compat: unknown event variant skipped, not panicked
**EXTEND** codex (`#[serde(default, skip_serializing_if)]` partial). Reconstruction from a rollout written by a newer AgenC version must not panic on unknown event types. Rule: every `RolloutItem` carries `eventVersion: number`; reducer wraps unknown variants in a `{type:'unknown', raw:string, version:N}` shim and continues. Emit `warning:'unknown_event_variant'` per skipped event. **Where:** `runtime/src/session/event-log-reducer.ts`. **Test:** v1 reads a v2 rollout and reconstructs without throwing.

### I-27 · Event-log emission is FIFO with monotonic sequence numbers
**NEW.** When two phases or sidecars emit concurrently (Node.js single event loop but interleaved promise microtasks), the reducer can see events out-of-causal-order. Rule: every `EventLog.emit()` is synchronous; events get a monotonic `seq: number` at emit time; reducer asserts `prevSeq + 1 === currSeq` and emits `error:'event_reordering_detected'` on violation. **Where:** `runtime/src/session/event-log.ts`. **Test:** synthetic concurrent emit from two phases; reducer order matches emit order.

### I-28 · File-history snapshot LRU eviction
**NEW.** openclaude `fileHistory.ts` caps at 100 snapshots silently. Long sessions overflow + lose oldest. Rule: explicit LRU eviction with `maxFileHistorySnapshots` config; on cap, evict oldest + emit `warning:'file_history_cap_reached'` once per session; expose `isFileHistoryComplete: false` on snapshot metadata so consumers know history is partial. **Where:** `runtime/src/session/file-history.ts`.

### I-29 · Memory file write lock (auto-extract vs manual edit)
**NEW.** `MEMORY.md` is written by both the auto-extract subagent and (potentially) hand-edits. Race loses one write silently. Rule: acquire `fs.open(path, 'wx')` exclusive lock with 2s timeout; on contention, emit `warning:'memory_write_contention'` + skip the write, retrying on the next auto-save tick. Journal append replay (`MEMORY.md.extract`) is deferred to T11; current impl emits `warning:'memory_write_contention'` + skips the write, retrying on the next auto-save tick. **Where:** `runtime/src/prompts/memory/auto-save.ts`. **Scheduled for:** T10 (memory / auto-save tranche); journal-replay variant lands in T11.

### I-30 · Config snapshot is per-turn-immutable
**NEW.** User edits `~/.agenc/config.toml` mid-session. Without policy, half a turn uses old values, half new. Rule: `LoadConfig` reads once at session init; `TurnState` carries a `configSnapshot: Readonly<Config>` constructed at turn start; phases ALWAYS read from `turnState.configSnapshot`, never from a live config object. File-watch on `config.toml` triggers `warning:'config_reloaded_takes_effect_next_turn'` only — never mid-turn. **Where:** `runtime/src/session/turn-state.ts` + `runtime/src/config/loader.ts`. **Status:** WIRED (T11) — `runtime/src/session/turn-context.ts::buildTurnContext` clones the Config and `deepFreeze`s it into `configSnapshot: Readonly<Config>` before the TurnContext is handed to phases.

## Subagent lifecycle (I-31..I-37)

### I-31 · Empty mailbox returns sentinel on receiver-closed
**NEW.** Parent's `mailbox.drain()` returns `[]` whether the child is alive (idle) or already shut down. Parent loops on stale reference. Rule: `MailboxReceiver` carries `closed: boolean`; on receiver close, future `drain()` returns `[{type:'agent_exited', threadId, finalStatus}]` then permanently empty. Sender side rejects sends after close with `MailboxClosed` error. **Where:** `runtime/src/agents/mailbox.ts`. Codex's `mpsc::Receiver` has equivalent semantics naturally; AgenC must implement explicitly.

### I-32 · Child-spawn race with parent Interrupt (cancellation token in slot reservation)
**NEW.** Parent sends `Interrupt` to child A while child A is mid-spawn of child B. B is born, A dies, B is orphaned. Rule: `registry.reserve_spawn_slot(parentId)` returns a `CancellationToken` scoped to the parent. Before `spawn_agent_internal()` returns, validate `parent.token.is_cancelled()`; if true, undo spawn + synthesize a `parent_interrupt` mailbox message to the child. **Where:** `runtime/src/agents/control.ts` + `runtime/src/agents/registry.ts`.

### I-33 · Async-child unread result drained on session exit
**NEW.** Async child completes, parent's main loop exits before reading the child's mailbox. Result lost. Rule: `Session.shutdown()` walks `childInboxes`, force-drains each into the event log as `agent_async_result_unread`, emits `warning:'async_child_result_unread'` with count. **Where:** `runtime/src/session/lifecycle.ts`.

### I-34 · Worktree force-remove must `git worktree prune`
**NEW.** `git worktree remove --force` can leave a stale `.git/worktrees/<slug>/` gitdir entry if the directory itself is gone but git's internal index isn't cleaned. Next `getOrCreateWorktree(slug)` reads stale HEAD. Rule: after `remove --force`, run `git worktree prune --force`. Failures from `prune` are logged + ignored, not propagated. **Where:** `runtime/src/agents/worktree.ts`.

### I-35 · Sparse-checkout teardown verifies state
**NEW.** Sparse-checkout failure mid-create leaves a partial `.git/info/sparse-checkout` file. Next create reads it as authoritative. Rule: `tearDown()` reads `.git/info/sparse-checkout`; if it differs from requested, run `git sparse-checkout disable` + emit `warning:'sparse_checkout_orphaned'`. **Where:** `runtime/src/agents/worktree.ts`.

### I-36 · Fork-from-parent flushes parent rollout before child reads
**NEW.** Parent is mid-`compactConversation` writing to rollout (100ms batch); child fork reads partial state. Rule: `forkSubagent()` calls `parent.rollout.flushAndSync()` synchronously before reading parent messages for fork context. Distinct from I-4's turn-boundary fsync. **Where:** `runtime/src/agents/fork-context.ts`.

### I-37 · Sibling `agentPath` collision returns error (already covered, document)
**ALREADY-COVERED** by codex `registry.rs:240-260` — `reserve_agent_path` returns `UnsupportedOperation("agent path already exists")` on collision. AgenC port preserves this verbatim. **Where:** port to `runtime/src/agents/registry.ts`. No new behavior; documented to prevent re-introducing the bug during port.

## Failure cascades (I-38..I-44)

### I-38 · `fsync()` itself can fail; degraded path applies (extends I-12)
**EXTEND** I-12. I-12 covers write errors; `fs.fsync()` itself throws ENOSPC/EIO/ENODEV. If fsync at a turn boundary fails, I-4's durability promise is broken. Rule: wrap fsync in try/catch; on failure, retry once after 100ms; if second fails, switch event-log to degraded ring buffer (I-12 path) + emit `error:'fsync_failed'`. **Where:** `runtime/src/session/session-store.ts`.

### I-39 · Stop-hook throw during recovery is caught
**NEW.** A stop-hook can throw an unhandled error inside Phase 3's `executeStopFailureHooks`. The throw bubbles past Phase 3 and aborts the turn without logging the cause. Rule: wrap every hook invocation in `try/catch`; on throw, emit `error:'stop_hook_threw'` with hook name + stack, continue ladder. **Where:** `runtime/src/phases/stop-hooks.ts`.

### I-40 · Reactive-compact throw is caught (parallels I-39)
**NEW.** `tryReactiveCompact()` can throw, not just return false. Today the bool branch is checked but a thrown error bubbles. Rule: wrap in `try/catch`; on throw, treat as `failed` outcome, increment circuit-breaker (I-18), emit `warning:'reactive_compact_threw'`. **Where:** `runtime/src/recovery/reactive-compact.ts`.

### I-41 · Abort re-entrance guard
**NEW.** During orphan-`tool_result` synthesis, a tool's cleanup handler can emit another abort-like error → recursive `abortInFlight()` → infinite synthesis. Rule: `StreamingToolExecutor` carries `isAborting: boolean`; second `discard()` call while `isAborting` returns immediately. **Where:** `runtime/src/tools/streaming-executor.ts`.

### I-42 · Per-turn recovery re-entry cap (separate from I-17 stop-hook cap)
**NEW.** I-17 caps direct stop-hook block re-fires. But `recovery → Phase 1 → recovery → Phase 1` (any trigger) can loop indefinitely if each cycle finds a fresh trigger. Rule: per-turn `recoveryReentryCount` field on `TurnState`, initialized to 0 at turn start, incremented every time `phases/post-sample-recovery.ts` enters a recovery branch (any of the 7 strategies), capped at `MAX_RECOVERY_REENTRIES = 5`. On exceed: terminate turn with `error:'recovery_loop'` + I-8 emission, route to `Cleanup → Exit`. Counter is per-turn (resets when `WaitInput` receives a new user message). **Where:** `runtime/src/phases/post-sample-recovery.ts` + `runtime/src/session/turn-state.ts`. **Test:** synthesize 6 consecutive PTL responses; assert turn aborts at the 6th attempt with `error:'recovery_loop'`.

**Counter-reset semantics (T8 concrete):**

- `state.recoveryReentryCount` is reset to 0 by
  `resetRecoveryReentries(state)` (recovery/fallback-ladder.ts), which
  run-turn invokes when it receives a fresh user message.
- The ladder increments the counter INSIDE the recovery lock (I-62)
  before dispatching the matched trigger, so concurrent triggers
  never observe a stale `count = N-1` and both increment.
- Reaching the cap emits `error:'recovery_loop'` once + returns the
  `reentry_cap_exhausted` outcome. The phase-3 wrapper observes the
  outcome, clears `state.transition` so run-turn's top-of-loop does
  not re-enter, and the commit phase routes the turn to terminal.
- The token-budget-continuation path (I-22) also bumps the counter
  so mid-stream budget overshoot plus subsequent trigger cycles
  share the same cap.

### I-43 · Sidecar degraded mode is per-sidecar (extend I-12 + I-38)
**EXTEND** I-12. ENOSPC in `Sidecar1` (session-store) does not break `Sidecar5` (error-log-sink) — they're independent files. Rule: each sidecar implements its own degraded ring buffer; one sidecar's failure doesn't propagate. Critically: `error-log-sink` writing about another sidecar's ENOSPC must not itself ENOSPC indefinitely (recursion). Reserve a 64KB in-memory error buffer that always succeeds. **Where:** `runtime/src/session/sidecar.ts`.

### I-44 · Modal decision is turn-id-stamped to reject stale resolutions
**NEW.** Modal opened in turn N. Phase 3 recovery loops back to Phase 1, starting turn N+1's prepare. Modal promise from turn N resolves with `'allow'` after Phase 1 of N+1 begins. Tool dispatched against the wrong turn's intent. Rule: every modal decision carries `decisionAtTurnId`; `tools/execution.ts` rejects decisions where `currentTurn.id !== decision.turnId` with `warning:'stale_modal_decision'`. **Where:** `runtime/src/tools/execution.ts` + `runtime/src/tui/permissions/InteractiveHandler.tsx`. **Status:** WIRED (T11) — `runtime/src/permissions/context.ts::PendingPermissionRequest` carries the `turnId` stamp set by the orchestrator; dispatcher + evaluator consumers reject resolutions whose stamp does not match the active turn.

## Boot, signals, init (I-45..I-52)

### I-45 · SIGTERM ≠ SIGINT (port openclaude pattern)
**PORT** openclaude `main.tsx:4021` (`process.once('SIGTERM', shutdown)`). Different exit code (0 for SIGTERM = orderly orchestrator stop, 130 for SIGINT = user interrupt). Both call `session.abortTerminal('signal_received')` then fsync barrier. **Where:** `runtime/src/bin/agenc.ts`.

### I-46 · SIGHUP routes through stdin-loss path (I-19)
**NEW.** SIGHUP fires when controlling terminal closes. In TUI mode I-19's stdin-close handler covers this. In one-shot mode without TUI, SIGHUP arrives as a bare signal; treat identically: abort + fsync + exit 130. **Where:** `runtime/src/bin/agenc.ts`.

### I-47 · SIGUSR1 = config reload, SIGUSR2 = state dump
**NEW.** Long-running sessions (containerized, daemonized) need operator hooks. `SIGUSR1` = re-run `LoadConfig` after current turn completes (per I-30 boundary), emit `warning:'config_reload_requested'`. `SIGUSR2` = dump current `SessionState` + `TurnState` to `~/.agenc/diag-<pid>-<timestamp>.json` for debugging. **Where:** `runtime/src/bin/agenc.ts`.

### I-48 · Init scans for orphaned `TurnStarted` events (OOM recovery)
**NEW.** OOM-killer (SIGKILL, uncatchable) leaves a `TurnStarted` with no matching `TurnComplete`/`TurnAborted`. Reconstruction sees a half-turn and produces inconsistent state. Rule: `rollout-reconstruction.ts` scans for unmatched `TurnStarted`; synthesizes `TurnAborted{reason:'process_killed'}` immediately after the orphan, emits `warning:'orphaned_turn_recovered'`. **Where:** `runtime/src/session/rollout-reconstruction.ts`.

### I-49 · Session schema version stamped in rollout
**NEW.** User runs `npm install -g @tetsuo-ai/agenc@latest` while a session is live. Old binary continues; restart loads new. Schema mismatch = undefined. Rule: every rollout's `SessionMeta` carries `agencVersion` + `rolloutSchemaVersion`. On open, if `code.schemaVersion < rollout.schemaVersion`, hard-fail with "session created by newer AgenC; please use `/fork` to migrate." On forward-compat (`code > rollout`), upgrade in place per a migration map. **Where:** `runtime/src/session/session-store.ts`.

### I-50 · MCP startup wait is cancellable
**NEW.** Init's 30s MCP server wait is blocking. Ctrl+C during this window leaves servers half-initialized. Rule: wrap each per-server wait in `Promise.race([wait, abortSignal])`; on abort, send shutdown signals to half-started servers + propagate to I-19 stdin-loss path. **Where:** `runtime/src/mcp-client/manager.ts`.

### I-51 · Init step abort propagates cleanly
**NEW.** Generalization of I-50 across all init steps (`LoadConfig` → `LoadProvider` → ... → `LoadMCP`). Each step accepts `AbortSignal`; on abort during init, emit `error:'init_aborted'`, run reverse-cleanup (close opened MCP connections, release file locks), exit cleanly. **Where:** `runtime/src/bin/agenc.ts` init pipeline.

### I-52 · `HOME` unset / `~/.agenc` uncreatable hard-fails with clear message
**NEW.** Containerized environments may run AgenC with `HOME` unset or `~/.agenc` uncreatable (read-only fs). Today this surfaces as cryptic `ENOENT` deep in session-store. Rule: init's first action validates `HOME` set + `~/.agenc` writable; if not, hard-fail boot with explicit "set `AGENC_HOME=<dir>` to a writable path" message. **Where:** `runtime/src/bin/agenc.ts` (very first line of init).

## Provider abstraction (I-53..I-60)

### I-53 · Capability registry has TTL + drift detection
**NEW.** `llm/capabilities.ts` is a static registry per `(provider, model)`. Models update; capabilities change silently. Rule: each registry entry carries `lastVerifiedAt: number`. Entries older than 30 days get a background probe on session start (best-effort, doesn't block boot). On any provider error that maps to a capability mismatch (e.g. 400 with "feature not supported"), emit `warning:'capability_drift_detected'` + flag the registry entry as stale. **Where:** `runtime/src/llm/capabilities.ts`. **Scheduled for:** T13 (provider adapters tranche) — `capabilities.ts` does not exist yet.

### I-54 · Tool-call schema validation before injection
**NEW.** Provider returns 200 OK with a malformed tool_use block (missing id/name/arguments, or non-string `arguments`). Today the bad block goes straight into history → next request 400s. Rule: every parsed `tool_use` is validated against `LLMToolCall` shape (`{id:string, name:string, arguments:string}`) before calling `StreamingToolExecutor.addTool()`. On validation failure, emit `stream_error{cause:'malformed_tool_call', provider, raw}` and route to `AbortRecovery` (transient — provider may be in a buggy state). **Where:** `runtime/src/llm/stream-parser.ts`.

### I-55 · Per-provider tool-call normalizer
**NEW.** OpenAI uses `function.name`/`function.arguments`, Anthropic uses `name`/`input` (object), xAI may differ. Rule: every provider adapter exports `normalizeToolCalls(rawBlocks): LLMToolCall[]`; failures route through I-54. Adapters NEVER return raw provider format upstream. **Where:** `runtime/src/llm/providers/*/normalize-tool-calls.ts`.

### I-56 · Streaming chunk reorder normalization
**NEW.** Some providers emit chunks in unexpected order (text after tool_use, etc). Rule: `stream-parser.ts` buffers incoming chunks; on stream end, reorders to canonical order (thinking → tool_use → text) before forming the assistant message. Emit `warning:'stream_chunk_reordered'` with provider + count for telemetry. **Where:** `runtime/src/llm/stream-parser.ts`.

### I-57 · History compatibility check on provider switch (extends I-13)
**NEW.** I-13 covers the abort flow on `/model` mid-stream. But a session whose history has 3 image messages can't continue under a provider that doesn't support images. Rule: on `/model` or `/provider` switch, run `validateHistoryCompatibility(newCaps, history)`. If history contains content the new provider rejects (images, audio, thinking blocks), strip + nudge user: "your history has image messages; new provider doesn't support them — stripped." Emit `warning:'content_stripped_on_switch'`. **Where:** `runtime/src/commands/model.ts` + `runtime/src/commands/provider.ts` (T11 scope — neither file exists yet). **Status:** WIRED (T11) AS STUB — `runtime/src/commands/model.ts::checkModelHistoryCompat` is the staging site and always returns compatible today; the real capability-registry comparison is deferred to T13 (see I-53) and will replace the stub without changing the call-site contract.

### I-58 · Honor `Retry-After` header on 429 (port openclaude)
**PORT** openclaude `services/api/withRetry.ts:303-475`. Rule: 429 response with `Retry-After: N` MUST sleep for max(N, exponentialBackoff). Cap at user-configurable `MAX_RETRY_AFTER_MS = 300_000` (5 min); above cap, emit `warning:'rate_limit_exceeds_max_wait'` and abort to recovery. **Where:** `runtime/src/llm/oauth/refresh-loop.ts` + `runtime/src/llm/wire/*.ts`.

### I-59 · Local-provider health-check sidecar (port openclaude detection)
**PORT** openclaude `services/api/openaiErrorClassification.ts:224` (ECONNREFUSED detection). For local providers (Ollama, LMStudio), add a 10s health-check ping during streaming. On `connection_refused` mid-stream, emit `stream_error{cause:'local_provider_down'}` immediately rather than waiting for I-11 watchdog (60s). User-facing message: "local provider lost connection — restart Ollama/LMStudio and retry." **Where:** `runtime/src/llm/providers/ollama/health.ts` + `runtime/src/llm/providers/lmstudio/health.ts`.

### I-60 · Ambiguous model name disambiguation at init
**NEW.** Two providers both have a `llama-3.3` (Groq full name `llama-3.3-70b-versatile`, OpenRouter routes through). User passes `--model llama-3.3` without `--provider`. Rule: provider factory builds an inverted index `model → provider[]`. Multiple matches → hard-fail boot with disambiguation message listing all matches. Single match → proceed. **Where:** `runtime/src/config/schema.ts::resolveModelDisambiguated` + `runtime/src/bin/agenc.ts::resolveModelOrExit`. **Scheduled for:** T10 (config / provider resolver tranche).

## Concurrency & ordering (I-61..I-65)

### I-61 · `SharedServer(id)` uses per-id semaphore (not global)
**NEW.** Diagram says "semaphore per server" but doesn't enforce. Two MCP server tools (`mcp.dbA.query` + `mcp.dbB.query`) must run in parallel; two from same server (`mcp.dbA.query` + `mcp.dbA.write`) serialize. Rule: `Map<serverId, Semaphore(1)>` keyed on `serverId`; never a global semaphore. **Where:** `runtime/src/tools/concurrency.ts`.

### I-62 · Recovery-trigger evaluation is exclusive
**NEW.** Two triggers can fire simultaneously (tool error + 413). Without a lock, two recovery branches can interleave. Rule: enter Phase 3 with an exclusive lock on `session.recoveryInFlight: AsyncLock<void>`. Second trigger queues; on dequeue, re-evaluate priority (per I-10) — second trigger may now be moot. **Where:** `runtime/src/phases/post-sample-recovery.ts`.

### I-63 · Subagent slot acquisition is atomic (port codex pattern)
**PORT** codex `agent/registry.rs:80` (`reserve_spawn_slot` under mutex). Rule: slot counter increment/decrement happens under `AsyncLock`; concurrent spawns can never both observe `count = N-1` and both increment to `N`. **Where:** `runtime/src/agents/registry.ts`.

### I-64 · Mailbox `send()` is non-blocking microtask
**NEW.** I-16 says `send()` blocks 5s on backpressure. But if the parent is awaiting an approval modal, that block freezes the modal. Rule: `send()` returns synchronously; backpressure handling (timeout, drop) runs as a `queueMicrotask(...)` so the caller's event loop stays responsive. **Where:** `runtime/src/agents/mailbox.ts`.

### I-65 · Tool result completion ordering (already covered, document)
**ALREADY-COVERED** by openclaude `StreamingToolExecutor.ts:38` ("Results are buffered and emitted in the order tools were received"). AgenC port preserves this. Documented here so the port doesn't drop the buffering by accident. **Where:** `runtime/src/tools/streaming-executor.ts`.

**AgenC concrete pattern (T7):** `StreamingToolExecutor.getCompletedResults()` iterates `this.tools[]` (the submission-order queue) and skips entries with `status === "yielded"`. A completed tool is yielded once; its `status` flips to `"yielded"` so the next iterator call observes it as already-handled. Parallel-safe tools can finish in arbitrary order internally — the yield sequence stays in submission order because the iterator walks the queue front-to-back, skipping anything not yet `"completed"`. Test: `streaming-executor.test.ts` "completes in submission order (I-65)" queues ids [a,b,c] with randomized completion delays and asserts yield order is [a,b,c].

## TUI & input (I-66..I-72)

> **STATUS: WIRED (T12).** The Ink/TUI surface landed in T12. All
> `runtime/src/tui/...` paths cited below are live. I-68 is the
> dispatcher-side parse rule that shipped in T11; the remaining
> I-66, I-67, I-69, I-70, I-71, I-72 rows are all wired in the T12
> TUI tranche.

### I-66 · Frame-diff snapshots terminal size at start of pass
**NEW.** SIGWINCH mid-frame-diff produces blit at stale dimensions. Rule: capture `(cols, rows)` at start of `onRender()`; reject the patch + restart frame if dims change before completion. **Where:** `runtime/src/tui/ink/ink.tsx` (~lines 499, 805-833) — `onRender()` snapshots terminal dims at pass start and restarts the frame if they change mid-render. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/ink/render-node-to-output.i66.test.ts`.

### I-67 · Pasted text is C0/C1-control-character sanitized
**NEW.** Pasted text containing `\x1b[...` ANSI sequences renders without injection but becomes a semantic Trojan if forwarded to a tool. Rule: paste handler strips bytes in `0x00-0x1F` (except `\n`, `\t`) and `0x80-0x9F` before storing. Emit `warning:'paste_sanitized'` with byte count. **Where:** `runtime/src/tui/composer/paste-store.ts` (~lines 55-92) — per-chunk scrubber strips C0 (0x00-0x1F except `\n`/`\t`) and C1 (0x80-0x9F) bytes; the store emits `paste-sanitized` with stripped byte counts. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/composer/paste-store.test.ts`.

### I-68 · Slash command recognized only on first line
**NEW.** Pasted text starting with `/model gpt-5\nsome prompt\n...` should NOT trigger `/model`; today it would. Rule: `parseSlashCommand()` matches `^/[a-z]+(?:\s|$)` against ONLY the first line; multi-line input never dispatches a slash command. **Where:** `runtime/src/commands/dispatcher.ts`. **Status:** WIRED (T11) — enforced in `runtime/src/commands/dispatcher.ts::parseSlashCommand`, which splits on `\n` and requires every subsequent line to be whitespace-only before dispatching (documented inline with the I-68 fence).

### I-69 · Multi-line paste is atomic w.r.t. Enter
**NEW.** User pastes 3 lines, reflexively hits Enter after line 1 — submission strips lines 2-3. Rule: `Composer` tracks `paste-in-flight` state; while true, Enter is buffered, not dispatched. Cleared on paste-complete event (whichever terminal-specific hook fires last). **Where:** `runtime/src/tui/composer/Composer.tsx` (~lines 9-15, 282) — the paste-in-flight reducer buffers Enter and replays it once the paste-complete event lands. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/composer/Composer.test.tsx`.

### I-70 · Render throttles on terminal-input idle (background tab)
**NEW.** Streams in a tmux pane the user has switched away from accumulate frame backlog → stutter on return. Rule: if no stdin event in 5s + not in alt-screen mode, drop render rate from `FRAME_INTERVAL_MS` to 1 FPS until next keystroke. **Where:** `runtime/src/tui/ink/ink.tsx` (~lines 188-266, 1356-1360) — two pre-built throttles (`fastSchedule` at `FRAME_INTERVAL_MS`, `idleSchedule` at `I70_IDLE_INTERVAL_MS`) swap on stdin-idle-without-alt-screen. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/ink/ink.i70.test.ts`.

### I-71 · `@mention` path boundary validator (privacy hardening)
**NEW.** `@/etc/passwd` or `@../../../secret.key` silently attaches and ships to the model. Rule: before attachment, resolve the path; if outside `session.cwd` AND outside an explicit `config.attachments.allowedRoots[]` list, reject + emit `error:'mention_outside_workspace'` + show user a clear "blocked: path outside workspace" message. Configurable for users who deliberately want broader scope. **Where:** `runtime/src/tui/composer/Composer.tsx` (~lines 15-17, 97-165, 328-351) — `validateMentionPath` / `scanMentions` resolve each `@path` against `session.cwd` and `config.attachments.allowedRoots`, and the composer emits `warning:mention_outside_workspace` on reject. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/composer/Composer.test.tsx`.

### I-72 · Modal input focus is exclusive
**NEW.** Approval modal open + user types into composer → keystrokes delivered to both. Modal might dismiss on a key meant for the input. Rule: while a modal is rendered, the underlying `Composer` listens but does not consume keystrokes; queues them and replays after modal resolves. Implemented via Ink's `FocusManager` `isModalOverlayActive` flag. **Where:** `runtime/src/tui/permissions/ApprovalOverlay.tsx` (~lines 217-266) — on mount the overlay calls `setActiveContext('modal')` and registers `modal:*` keybindings; unmount restores the `chat` context. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/permissions/ApprovalOverlay.test.tsx`.

---

## Status (updated)

All **72 invariants** are decisions, not speculation. I-1..I-8
closed the first-review design holes; I-9..I-22 closed the
edge-case sweep; I-23..I-72 closed the multi-agent
flowchart-stress-test review.

**Source provenance summary for I-23..I-72:**

- **PORT** (5): I-37, I-45, I-58, I-59, I-63, I-65 — working solutions exist in openclaude or codex; copy them.
- **EXTEND** (3): I-26, I-38, I-43 — partial solutions exist; broaden.
- **NEW** (42): everything else — AgenC must implement.

Anything labeled NEW must be implemented in AgenC code; nothing to
copy from upstream. Tranche assignments are in the matrix below.

---

# Edge-case invariants — third sweep (I-73..I-88)

16 additional invariants surfaced by 7 specialist verification agents
(adversarial, resource exhaustion, time/clock, network, data integrity,
scale, pure observation). Each carries source provenance.

## Security & adversarial (I-73..I-77)

### I-73 · MCP tool name shadowing rejected
**NEW.** A compromised or malicious MCP server can register tool names that shadow built-ins (`mcp.builtin.bash`, `mcp.system.writeFile`). Today registry uses Map-overwrite semantics. Rule: at MCP `listTools` registration, namespace-validate every returned tool. Names matching `^(mcp\.)?(builtin|system)\.` reserved-prefix patterns are rejected with `error:'tool_namespace_conflict'`. Per-server tools are always re-prefixed with the configured server name; servers cannot self-namespace. **Where:** `runtime/src/mcp-client/tool-bridge.ts`. **Test:** register MCP server returning `{name:'system.bash'}`; assert rejection + I-8 error.

### I-74 · MCP tool catalog SHA-256 supply-chain validation
**NEW (LANDED).** Rule: deterministic JSON serialization (sorted keys, no whitespace) of the tool catalog, SHA-256 hash, compared against `config.mcp.<name>.supplyChain.catalogSha256` (or legacy `pinnedCatalogSha256`) if set. Mismatch hard-fails the server with `error:'mcp_catalog_integrity_mismatch'`. Optional config `failOpen: true` to disable for development. **Where:** `runtime/src/mcp-client/tool-bridge.ts:199` — `computeMCPToolCatalogSha256()` returns the real canonical-JSON digest and `catalogDigestMatches()` enforces the pin; the earlier empty-string stub has been replaced.

### I-75 · `@include` paths validated against workspace boundary (extends I-71)
**EXTEND** I-71. I-71 validates `@mention` from the TUI composer. But `@include` directives parsed at init from `AGENTS.md` / `MEMORY.md` are NOT validated. A hostile or careless project can `@include /etc/shadow` or `@include ~/.ssh/id_rsa` at init. Rule: same path-boundary validator from I-71 applies to all `@include` resolution in `runtime/src/prompts/claude-md.ts`. The resolver emits the specific failure mode as the `error` label; the 8 currently-defined labels are: `path_escape`, `not_found`, `invalid_path`, `not_regular_file`, `circular`, `max_depth`, `max_bytes`, `read_error`. **Where:** `runtime/src/prompts/claude-md.ts` (port of openclaude `utils/claudemd.ts` `@include` resolver). **Scheduled for:** T10 (prompts / AGENTS.md + MEMORY.md loader tranche).

### I-76 · MCP catalog response size hard cap
**NEW.** `listTools` response is parsed without size limit; a hostile MCP server returning 1GB JSON OOMs the runtime. Rule: cap the entire `listTools` response payload at `MAX_MCP_CATALOG_BYTES = 5_000_000` (5 MB). Exceed → soft-fail server (per I-6) with `stream_error:'mcp_catalog_too_large'`. **Where:** `runtime/src/mcp-client/tool-bridge.ts` — wrap `client.listTools()` with size check on raw response body.

### I-77 · Model output sanitization for UI-spoofing patterns
**NEW.** Model can emit text matching real approval modal labels (`[Approval Required] Run bash? [y/n]`), tricking reflexive user input. Rule: before yielding assistant text to the TUI, scan for known UI-control patterns (`[Approval`, `[Allow/Deny]`, `[Yes/No]:`, ANSI escape sequences). On match, prefix with visible `[MODEL OUTPUT]` marker in a distinct color and emit `warning:'model_ui_spoof_pattern'`. Strict mode (config opt-in) replaces the pattern entirely. **Where:** `runtime/src/tui/transcript/StreamingMessage.tsx` (~lines 39-182, 278-323) — `scanForUISpoof` is a pure/stateless sanitizer; `StreamingMessage` wraps matched spans with `{bad:…}` markers rendered as highlighted `<Text>` spans and fires a one-shot `session.emitEvent('warning:model_ui_spoof_pattern', …)` per frame. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/transcript/StreamingMessage.test.tsx`.

## Data integrity & encoding (I-78..I-81)

### I-78 · Buffer chunks accumulated, not stringified at boundary
**NEW.** Today's openclaude (and likely AgenC port) does `stdoutBuf += chunk.toString()` per stdio chunk. UTF-8 sequences split across packets corrupt to `\uFFFD` and lose continuation bytes. Rule: accumulate raw `Buffer[]`, decode once at flush boundary via `Buffer.concat(chunks).toString('utf8')`. Applies to: bash tool output, MCP stdio transport, file reads from streaming sources. **Where:** `runtime/src/tools/system/bash.ts`, `runtime/src/mcp-client/transports/stdio.ts`. **Test:** spawn process emitting a multi-byte emoji split across two writes; assert assembled output is intact.

### I-79 · Large-integer JSON tool args use string-pre-parse reviver
**NEW.** Tool args sent as `{lamports: 9007199254740993}` (>2^53) are silently corrupted by `JSON.parse` to nearest float. Crypto nonces, blockchain amounts, NFT IDs all bite this. Rule: every tool-arg JSON parser uses a pre-parse string scan (regex `"key":\s*-?\d{16,}`) wrapping numeric literals as strings, then a custom reviver converts them to `BigInt`. Tools whose schema declares `bigint` get `BigInt` values; everything else stays `number`. **Where:** `runtime/src/tools/execution.ts` arg deserialization.

### I-80 · Line-ending normalization at every external boundary
**PORT** openclaude `utils/markdown.ts:14-17` (`EOL = '\n'` unconditional). Rule: every text crossing into AgenC from outside (file reads, tool stdout, network responses, MCP results) is normalized via `text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')` before injection into history or YAML parsing. CRLF in YAML frontmatter breaks key matching; mixed endings in tool output confuses the model. **Where:** `runtime/src/utils/text.ts` (helper) + every boundary callsite.

### I-81 · UTF-8 BOM stripped on every file read (port openclaude)
**PORT** openclaude `utils/jsonRead.ts:14` `stripBOM()`. Rule: every `fs.readFile(path, 'utf8')` call wraps result in `stripBOM()`. Windows-edited files often save with BOM (`\uFEFF`); leaving it in breaks YAML parsing, JSON parsing, first-key matching, dedup hashing. **Where:** central `runtime/src/utils/file-read.ts` helper used by config loader, AGENTS.md ancestor walk, memory loader, claude-md @include.

## Time & clock (I-82..I-84)

### I-82 · Monotonic clock for all deadline arithmetic (port openclaude)
**PORT** openclaude `services/api/claude.ts:1933` (`performance.now()` for watchdog). Rule: every deadline / elapsed-time calculation uses `performance.now()` (or `process.hrtime.bigint()`), not `Date.now()`. Wall clock is for display + event-log timestamps only. NTP corrections, `date` set, suspend/resume, container clock skew all break wall-clock arithmetic; monotonic clock is immune. **Where:** I-9 timeouts, I-11 watchdog, I-22 budget check, OAuth refresh, all SDK retries. **Test:** mock `Date.now()` to jump backward 5s mid-stream; assert watchdog timing unaffected.

### I-83 · Event-log batches detect long delays (suspend/resume)
**NEW.** A laptop closes mid-batch; system resumes 8 hours later; the deferred 100ms flush callback fires, attributing all events in the batch to "8 hours ago" by `Date.now()`. Rule: every batch carries `batchOpenedAt: monotonicMs` (per I-82). On flush, if `performance.now() - batchOpenedAt > 10_000` (10s), abandon the batch + emit `warning:'event_log_batch_delayed'` + emit a sentinel `system_resumed_from(durationMs)` event so reconstruction can reason about the gap. **Where:** `runtime/src/session/session-store.ts` batch flush.

### I-84 · `Retry-After` header parses both seconds and HTTP-date (extends I-58)
**EXTEND** I-58. RFC 7231 §7.1.3 allows `Retry-After: 120` (seconds) OR `Retry-After: Wed, 19 Apr 2026 12:00:00 GMT` (HTTP date). Misinterpretation produces 120ms sleep on a 5-min server overload (instant retry storm). Rule: parse robustly — numeric → seconds; non-numeric → `Date.parse(value) - Date.now()`; ambiguous → emit `warning:'retry_after_ambiguous'` + use `max(parsed, exponentialBackoff)`. Floor at 100ms to avoid CPU burn on malformed headers. **Where:** `runtime/src/llm/oauth/refresh-loop.ts` + `runtime/src/llm/wire/*.ts` (T13 scope — wire shims not yet scaffolded). **Scheduled for:** T13 (provider wire shims tranche).

## Network classification (I-85..I-86)

### I-85 · Captive portal / HTML response classified as connectivity
**NEW.** A captive portal returns 200 + `Content-Type: text/html; charset=utf-8` + an HTML login page. Stream parser tries to decode JSON, fails, classifies as I-54 `malformed_tool_call` — wrong category, surfaces a confusing message. Rule: before stream-parsing a provider response, check `Content-Type` header. If `text/html` AND request expected JSON/SSE → emit `stream_error:'captive_portal_or_proxy_intercept'` with explicit user-facing message ("network requires authentication or proxy is misconfigured"). Treat as non-retryable. **Where:** `runtime/src/llm/wire/*.ts` response handler (T13 scope). **Scheduled for:** T13 (provider wire shims tranche).

### I-86 · TLS certificate validation errors are a distinct error class
**NEW.** Provider rotates TLS cert mid-session. New connections fail with `ERR_TLS_CERT_ALTNAME_INVALID` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `CERT_HAS_EXPIRED`. Today these surface as generic `auth_failed`, sending users down the bearer-key debug path when the issue is cert rotation. Rule: classify these specific Node.js error codes into `LLMCertificateError` with `cause:'tls_validation_failed'` + cert details (issuer, subject, validity dates) in the error message. Retry once with a fresh connection (TLS handshake renegotiation). **Where:** `runtime/src/llm/oauth/refresh-loop.ts` + per-adapter HTTP error mapping (T13 scope). **Scheduled for:** T13 (provider adapter HTTP error mapping tranche).

## Production operational (I-87..I-88)

### I-87 · Async-child mailbox drain has bounded timeout (extends I-33)
**EXTEND** I-33. I-33 mandates draining async-child mailboxes during cleanup. But a hung child whose `send()` blocks on backpressure (per I-16) freezes shutdown indefinitely. Rule: drain operation runs under `Promise.race([drain, timeout(MAX_DRAIN_MS=2000)])`. On timeout, log remaining-orphan count + emit `warning:'async_child_drain_timeout(N)'` and proceed to exit. Don't let one stuck child block session termination. **Where:** `runtime/src/session/lifecycle.ts` shutdown sequence.

### I-88 · Compaction prompt build uses per-turn `toolResultBytes` index
**NEW.** Long sessions (10k+ turns, 350KB tool results per turn) accumulate 35MB+ of cumulative tool output. Compaction prompt builder re-streams the full event log to compute token counts — O(n²) in tool-result count. 10–60s blocking compaction at scale. Rule: `session-store` maintains a per-turn `toolResultBytes` and `tokenEstimate` index updated on each event-log append. Compaction filters by index first (skip turns with `<50KB` results), only re-streams candidates. Add telemetry `compactionPromptBuildMs`; warning if any single compaction exceeds 5s. **Where:** `runtime/src/llm/compact/compact.ts` + `runtime/src/session/session-store.ts` (index).

**Index schema (T6 concrete):**

```ts
// runtime/src/session/session-store.ts
class SessionStore {
  // keyed by turnId; value = cumulative bytes of tool-result payloads
  // observed in that turn's event-log appends.
  private readonly toolResultBytesByTurn = new Map<string, number>();

  append(event, { turnId, toolResultBytes }) {
    if (turnId && toolResultBytes > 0) {
      const prev = this.toolResultBytesByTurn.get(turnId) ?? 0;
      this.toolResultBytesByTurn.set(turnId, prev + toolResultBytes);
    }
    // ...persist the event...
  }

  getToolResultBytes(turnId): number { /* lookup */ }
  getToolResultBytesIndexSnapshot(): ReadonlyMap<string, number> { /* snapshot */ }
}
```

The phase-5 `execute-tools` caller passes `{turnId, toolResultBytes}` with each `tool_call_completed` append. The index snapshot is exposed via `RolloutStore.getToolResultBytesIndexSnapshot()` for compaction (T5b/T6 lifts the compact/ exclude and wires the <50KB filter in `compact.ts::compactConversation`).

---

## TUI turn-boundary hygiene (I-90)

### I-90 · Stale pending permission requests dropped on turn boundary
**NEW.** When the active turn changes (provider switch via I-13, new prompt, recovery re-entry), a pending permission request authored under the old turn must not be resolved as if it were still live. Rule: any `PendingPermissionRequest` whose `turnId` !== current active turn's `turnId` is dropped silently via `warning:stale_pending_dropped` + `resolveOnce.claim({behavior: 'deny', source: 'stale_pending_dropped'})`. Enforced at modal mount time in `InteractiveHandler` BEFORE the 200ms classifier grace race. **Where:** `runtime/src/tui/permissions/InteractiveHandler.tsx` (~lines 240-260) — `resolveWithGrace` reads `session.activeTurn.unsafePeek().turnId` and short-circuits on mismatch. **STATUS:** WIRED (T12). **Test:** `runtime/src/tui/permissions/InteractiveHandler.test.tsx` exercises the stale-turn drop without mounting the modal.

---

## Status (updated)

All **89 invariants** are decisions. I-1..I-8 first review, I-9..I-22 second sweep, I-23..I-72 third multi-agent sweep, I-73..I-88 fourth verification sweep, and **I-90** added during the T12 TUI tranche for turn-boundary permission hygiene.

**Source provenance for I-73..I-88:**

- **PORT** (3): I-80, I-81, I-82 — copy openclaude pattern
- **EXTEND** (3): I-75, I-84, I-87 — broaden existing invariant
- **NEW** (10): everything else

**I-90** is NEW (T12) — no upstream precedent for the turn-id stamp + mount-time drop.

---

## Invariant matrix — where each tranche picks them up

| Invariant | Primary tranche | Cross-cutting tranches |
|---|---|---|
| I-1 Subagent depth cap | T9 (subagents) | T5 (Session passes `depth` into TurnContext) |
| I-2 Clear `previous_response_id` on compact | T5 (grok/incremental.ts) | T4 (compaction emits event), T7 (recovery calls clear) |
| I-3 Mode race guard | T11 (permissions) | T7 (executor wires `checkModeStillAllowed`) |
| I-4 fsync at turn commit | T6 (event log + sidecars) | T5 (phase-commit calls durableFlush) |
| I-5 Bidirectional mailbox | T9 (subagents) | T5 (Session holds inbox + childInboxes) |
| I-6 MCP fail-soft | T9 (MCP extensions) | T5 (session init wires waitForServerReady) |
| I-7 Stream abort cascade (two destinations) | T7 (recovery) + T8 (recovery) | T6 (streaming-executor exposes discard), T5 (phases wire abortInFlight) |
| I-8 Every error site emits | T6 (event-log) | every tranche that introduces an error site (T7, T8, T9, T11, T13) |
| I-9 Per-tool execution timeout | T7 (tool executor) | T5 (registry holds default), every tool definition |
| I-10 Recovery trigger priority explicit | T8 (recovery) | T6 (recovery uses explicit trigger array) |
| I-11 Stream idle watchdog (default-on) | T5 (stream-model phase) | T8 (recovery handles `stream_idle` reason) |
| I-12 Filesystem error handling | T6 (session-store + sidecars) | every sidecar that writes to disk |
| I-13 Mid-stream provider/model switch | T11 (commands) | T5 (session holds pending-switch flag), T13 (provider boundary) |
| I-14 `previous_response_id` server-side expiration retry | T13 (provider adapters) | T5 (incremental.ts scaffold) |
| I-15 Tool result size hard cap | T7 (tool executor) | T5 (registry holds default), per-tool override |
| I-16 Bounded mailbox + backpressure | T9 (mailbox) | T5 (Session holds inboxes) |
| I-17 Stop-hook recursion cap | T8 (stop-hooks phase) | T5 (TurnState carries counter) |
| I-18 Compaction shrink assertion | T4 (compaction port) | T5 (Phase 1 wires assertion + circuit-breaker) |
| I-19 TUI stdin loss = graceful exit | T12 (TUI) | T5 (session abortTerminal handles `stdin_lost`) |
| I-20 MCP startup aggregate failure | T9 (MCP extensions) | T5 (init aggregate check) |
| I-21 Approval modal ⊥ abort | T11 + T12 (permissions + TUI) | T7 (executor await on modal promise) |
| I-22 Token budget mid-stream check | T5 (stream-model phase) | T8 (recovery handles `token_budget_exceeded`) |
| **I-23..I-30 Persistence** | T6 (event-log + sidecars + rollout) | T5 (TurnState carries config snapshot) |
| I-23 Concurrent-session file lock | T6 (session-store) | — |
| I-24 Atomic rollout append | T6 (session-store) | — |
| I-25 Snapshot best-effort, rollout truth | T6 (rollout-reconstruction) | — |
| I-26 Forward-compat unknown event | T6 (event-log-reducer) | — |
| I-27 Event-log FIFO + monotonic seq | T6 (event-log) | — |
| I-28 File-history snapshot LRU eviction | T6 (file-history sidecar) | — |
| I-29 Memory file write lock | T10 (memory auto-save) | T6 (sidecar emits warning) |
| I-30 Config snapshot per-turn-immutable | T5 (turn-state) + T10 (config) | — |
| **I-31..I-37 Subagent lifecycle** | T9 (subagents + mailbox) | T5 (Session holds childInboxes) |
| I-31 Empty mailbox sentinel | T9 (mailbox) | — |
| I-32 Spawn race with Interrupt | T9 (control + registry) | — |
| I-33 Async-child unread result drain | T9 (lifecycle) + T6 (event-log) | — |
| I-34 Worktree force-remove + prune | T9 (worktree) | — |
| I-35 Sparse-checkout teardown verify | T9 (worktree) | — |
| I-36 Fork flushes parent rollout | T9 (fork-context) + T6 (rollout-store) | — |
| I-37 agentPath collision (already covered) | T9 (registry — port codex) | — |
| **I-38..I-44 Failure cascades** | T6 + T7 + T8 | every error site |
| I-38 fsync failure degraded path | T6 (session-store) | extends I-12 |
| I-39 Stop-hook throw guard | T8 (stop-hooks) | — |
| I-40 Reactive-compact throw guard | T8 (recovery) | extends I-18 |
| I-41 Abort re-entrance guard | T7 (streaming-executor) | extends I-7 |
| I-42 Recovery re-entry cap | T8 (recovery) | distinct from I-17 |
| I-43 Sidecar degraded mode per-sidecar | T6 (sidecars) | extends I-12 |
| I-44 Stale modal turn-id stamp | T7 (executor) + T12 (modal) | extends I-21 |
| **I-45..I-52 Boot, signals, init** | T5 (bin/agenc.ts init) | — |
| I-45 SIGTERM ≠ SIGINT | T5 (bin/agenc.ts) | extends I-19 |
| I-46 SIGHUP routes through I-19 | T5 (bin/agenc.ts) | extends I-19 |
| I-47 SIGUSR1/2 hooks | T5 (bin/agenc.ts) + T10 (config reload) | — |
| I-48 OOM orphan TurnStarted recovery | T6 (rollout-reconstruction) | — |
| I-49 Session schema version | T6 (session-store) | — |
| I-50 MCP startup cancellable | T9 (mcp-client/manager) | — |
| I-51 Init step abort propagates | T5 (bin/agenc.ts) | — |
| I-52 HOME / `~/.agenc` validated first | T5 (bin/agenc.ts) | — |
| **I-53..I-60 Provider abstraction** | T5 (provider scaffold) + T13 (adapters) | — |
| I-53 Capability registry TTL + drift | T13 (capabilities) | — |
| I-54 Tool-call schema validation | T7 (stream-parser) | — |
| I-55 Per-provider tool-call normalizer | T13 (per adapter) | — |
| I-56 Stream chunk reorder normalize | T7 (stream-parser) | — |
| I-57 History compatibility on switch | T11 (commands/model + provider) | extends I-13 |
| I-58 Honor Retry-After (port openclaude) | T13 (wire shims) | — |
| I-59 Local-provider health-check | T13 (Ollama + LMStudio adapters) | extends I-11 |
| I-60 Ambiguous model name disambiguation | T10 (resolve-provider) | — |
| **I-61..I-65 Concurrency & ordering** | T7 (tools) + T9 (mailbox) | — |
| I-61 SharedServer per-id semaphore | T7 (concurrency) | — |
| I-62 Recovery-trigger evaluation exclusive | T8 (recovery) | extends I-10 |
| I-63 Subagent slot acquisition atomic (port codex) | T9 (registry) | — |
| I-64 Mailbox send non-blocking microtask | T9 (mailbox) | extends I-16 |
| I-65 Tool result ordering (already covered) | T7 (streaming-executor) | — |
| **I-66..I-72 TUI & input** | T12 (TUI) | — |
| I-66 Frame-diff snapshots dimensions | T12 (ink renderer) | — |
| I-67 Paste C0/C1 sanitization | T12 (composer) | — |
| I-68 Slash command first-line-only | T11 (dispatcher) | — |
| I-69 Multi-line paste atomic w.r.t. Enter | T12 (composer) | — |
| I-70 Render throttle on input idle | T12 (ink renderer) | — |
| I-71 `@mention` path boundary | T12 (composer) | — |
| I-72 Modal input focus exclusive | T12 (composer + modal) | — |
| **I-73..I-77 Security & adversarial** | T9 (MCP) + T10 (prompts) + T12 (TUI) | — |
| I-73 MCP tool name shadowing | T9 (mcp-client/tool-bridge) | — |
| I-74 MCP catalog SHA validation | T9 (mcp-client/tool-bridge) | — |
| I-75 `@include` boundary (extends I-71) | T10 (prompts/claude-md) | extends I-71 |
| I-76 MCP catalog size cap | T9 (mcp-client) | — |
| I-77 Model output UI-spoof sanitization | T7 (stream-parser) + T12 (TUI) | — |
| **I-78..I-81 Data integrity** | T7 (tools) + T5 (utils) | — |
| I-78 Buffer chunk accumulation | T7 (tools/system/bash) + T9 (mcp stdio) | — |
| I-79 Large-int JSON reviver | T7 (tools/execution) | — |
| I-80 Line-ending normalization (port openclaude) | T5 (utils/text) | — |
| I-81 UTF-8 BOM strip (port openclaude) | T5 (utils/file-read) | — |
| **I-82..I-84 Time & clock** | T5 (utils) + T8 (recovery) | — |
| I-82 Monotonic clock for deadlines (port openclaude) | T5 (utils/clock) | — |
| I-83 Event-log batch suspend detection | T6 (session-store) | extends I-4 |
| I-84 Retry-After parses date (extends I-58) | T13 (wire shims) | extends I-58 |
| **I-85..I-86 Network classification** | T13 (wire shims) | — |
| I-85 Captive portal detection | T13 (wire/*.ts) | — |
| I-86 TLS cert error class | T13 (HTTP error mapping) | — |
| **I-87..I-88 Production operational** | T6 + T9 + T4 | — |
| I-87 Drain timeout (extends I-33) | T9 (lifecycle) | extends I-33 |
| I-88 Compaction `toolResultBytes` index | T4 (compact) + T6 (session-store index) | — |
| **I-90 Stale pending permission dropped** | T12 (permissions UI) | extends I-44 (turn-id stamp) |

---

## Status

All 89 invariants are **decisions, not speculation**. They close
design holes from four review passes — I-1..I-8 (first), I-9..I-22
(edge-case sweep), I-23..I-72 (multi-agent flowchart sweep), and
I-73..I-88 (verification sweep) — plus **I-90**, added during the
T12 TUI tranche for turn-boundary permission hygiene. Any tranche
PR that touches a listed primary/cross-cutting area must cite the
invariant number in its description.

**Source provenance per invariant:**

| # | Source | Notes |
|---|---|---|
| I-1 | NEW | AgenC bound; codex registry caps breadth, not depth |
| I-2 | NEW | xAI/OpenAI Responses API specific; openclaude doesn't use this id |
| I-3 | EXTEND openclaude | Bash-only race guard in `bashPermissions.ts` extended to all mutation tools |
| I-4 | NEW | AgenC turn-level durability promise; openclaude batches without per-turn fsync |
| I-5 | EXTEND codex | Codex mailbox is single-direction in practice; AgenC adds parent→child |
| I-6 | NEW | Aggregate fail-soft policy; openclaude handles per-server only |
| I-7 | EXTEND openclaude | Two destinations (terminal vs recovery) made explicit |
| I-8 | NEW | Event log error emission as invariant; openclaude tags errors inline |
| I-9 | PORT codex | `tools/registry.rs:561` `timeout_ms` |
| I-10 | DOCUMENT openclaude | `query.ts:1101-1209` implicit order made explicit |
| I-11 | PORT openclaude | `services/api/claude.ts:1894-2433` watchdog, default-on in AgenC |
| I-12 | NEW | Neither openclaude nor codex handles ENOSPC explicitly |
| I-13 | NEW | Mid-stream provider switch is multi-provider specific |
| I-14 | NEW | `previous_response_id` server-side expiration retry |
| I-15 | PORT + GENERALIZE openclaude | `BASH_MAX_OUTPUT` extended to every tool |
| I-16 | CHANGE codex | `mpsc::unbounded_channel` → bounded with backpressure |
| I-17 | EXTEND openclaude | `stopHookActive` flag + counter cap |
| I-18 | NEW | Compaction shrink assertion |
| I-19 | NEW | TUI stdin loss handler |
| I-20 | NEW | MCP startup aggregate rollup |
| I-21 | NEW | Approval modal abort race |
| I-22 | EXTEND openclaude | `budgetTracker` + mid-stream check |

Anything marked **NEW** must be implemented in AgenC code; nothing to
copy from upstream. **PORT** items copy a working pattern from the
named source. **EXTEND** items take a partial pattern and broaden it.
**CHANGE** items deliberately diverge from upstream.

---

## Proposed Invariants (T11 architecture, not yet numbered)

These are genuine invariants observed in the shipped T11 architecture
but not yet assigned I-numbers. They are called out here so a later
verification sweep can either promote them into the numbered series
(appended at the end to avoid renumbering) or consciously reject them.

### Proposed · Slash commands with side effects require `session` in context

Informational commands (`/help`, `/keybindings`) may run with a nil
session, but any command that mutates session state (`/clear`,
`/compact`, `/model`, `/provider`, `/permissions`, `/plan`, `/fork`,
`/resume`, `/enter-worktree`, `/exit-worktree`) must receive a live
`session` inside the command context. The dispatcher refuses to
execute a side-effectful command without a session; callers that
bridge remotely (daemon, IPC) must first rehydrate a session before
dispatching. **Where to enforce:** `runtime/src/commands/dispatcher.ts`
+ each command's own handler. **Test:** dispatch `/clear` with no
session; assert refusal.

### Proposed · `/permissions` mutations must propagate atomically

A `/permissions` write that stages a new rule (or flips a mode) must
apply to the live session state for the next tool-evaluation, and —
when invoked with `--persist` — must also write through to the
settings file in a single atomic pass. If either the in-memory update
or the settings-file write fails, the whole mutation must fail with a
single error and leave both stores untouched so session-state and
on-disk settings never diverge silently. **Where to enforce:**
`runtime/src/commands/permissions.ts` + `runtime/src/permissions/settings.ts`.
**Test:** stub the settings-file write to throw; assert the in-memory
permission state is rolled back and the command reports a single
structured error.
