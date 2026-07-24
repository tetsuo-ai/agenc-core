# AgenC Core — Bug Audit TODO

Read-only audit, 2026-07-13. No code was changed. Every issue below is actionable; check
it off when fixed. Full narrative report: `docs/bug-audit-2026-07-13.md`.

**Method.** ~20 subsystem reviewers fanned out over `runtime/src` and `packages/agenc-sdk`;
every critical/moderate finding was then put through an independent adversarial refutation
pass (3 findings were refuted — see bottom). The four criticals plus the two cost findings
and the TOML pollution were additionally reproduced by executing the suspect code.

**Legend.** `[x]` reproduced by running the code · `[V]` confirmed by an adversarial verifier ·
`[?]` uncertain / reachability unproven · `[-]` refuted (not a bug). Severity: 🔴 critical ·
🟠 moderate · 🟡 minor.

**Totals:** 4 critical · 33 moderate · 33 minor · 1 uncertain · 3 refuted.

**Suggested first batch:** C1, C2, C3 (secrets/guard/config — all reproduced), then M-COST-1/2
(3× Opus overcharge), then C4.

---

## 🔴 CRITICAL

- [x] `[x]` **C1 — Secret sanitizer leaks keypairs, PEM keys, the vault passphrase, and uppercase seed phrases.**
  `runtime/src/secrets/sanitizer.ts` (patterns ~270–351; BIP39 :196; keys :343–357, :425–457).
  Ran `redactSecrets()` against six payloads: it leaves **unchanged** a Solana JSON-array keypair
  (`~/.config/solana/id.json` 64-int format), a `-----BEGIN PRIVATE KEY-----` PEM block,
  `AGENC_WALLET_VAULT_PASSPHRASE=…` (unlocks the mainnet signing wallet), and an ALL-CAPS BIP39
  phrase (Ledger recovery sheets are uppercase). It does redact `sk-ant-…` and lowercase phrases.
  Root causes: no bracketed-int-array pattern, no PEM pattern; "passphrase" is in no key list;
  `classifyBip39Token` strips `[^a-z]` case-sensitively so `ABANDON`→miss. Any `Read`/`cat` of a
  wallet file, or a logged env/bash line, persists the signing key unredacted into `~/.agenc` logs,
  rollout traces, and hook payloads.
  **Fix:** add a 32/64-comma-separated-0–255-int-array pattern and a `-----BEGIN … PRIVATE KEY----- … END`
  pattern; add `passphrase`/`credential` to the key lists and `isSensitiveKey`; lowercase the token
  core before the BIP39 wordlist lookup.

- [x] `[x]` **C2 — A read-only prefix disables the transaction guard entirely.**
  `runtime/src/transaction-guard/tool-intent.ts:120` (runs before :123). `buildToolTransactionGuardInput`
  checks `isReadOnlySolanaLookup` (returns null = guard skipped) BEFORE `hasTransactionWriteSignal`,
  and the read-only check consults only `SOLANA_WRITE_SIGNAL_RE` — never `DIRECT_TRANSACTION_TOOL_RE`
  or `SOLANA_PROGRAM_WRITE_RE`, where `submitTransaction`/`walletSign`/`write-buffer`/`set-buffer-authority`
  live (`\bsubmit\b`/`\bsign\b` don't match camelCase/hyphenated forms). Reproduced with the verbatim
  regexes: `solana balance && node -e 'conn.submitTransaction(raw)'` and
  `solana program show X && solana program write-buffer ./evil.so --url mainnet-beta` both skip the
  guard; the same commands without the read-only prefix are guarded.
  **Caveat:** the guard is **disabled by default** (`config.enabled` defaults false) — this defeats an
  opt-in defense-in-depth layer, not a default-on control.
  **Fix:** evaluate `hasTransactionWriteSignal` first; take the read-only early-exit only when it is
  false. Add the camelCase/hyphenated terms to `SOLANA_WRITE_SIGNAL_RE`.

- [x] `[x]` **C3 — TOML config parser allows `__proto__` prototype pollution.**
  `runtime/src/config/loader.ts` (`setNested` :386/:435, `ensureTablePath` :427, `parseInlineTable` :340).
  `parseToml` walks table/key paths with plain `cur[seg] = …` and never rejects `__proto__`/`constructor`/
  `prototype`. Reproduced: after `parseToml("[__proto__]\nisAdmin = true\n")`, `({}).isAdmin === true` —
  `Object.prototype` is poisoned for the whole daemon process, so every `obj.field ?? default` config
  lookup across all concurrent sessions sees the injected value. Reachable from `~/.agenc/config.toml`
  (loader.ts:689) AND workspace agent-role configs (agents/role.ts:1033) that may come from a cloned
  untrusted repo.
  **Fix:** reject/skip `__proto__`/`constructor`/`prototype` segments at the `setNested`/`ensureTablePath`/
  `parseInlineTable` choke point, or build tables with `Object.create(null)`.

- [x] `[V]` **C4 — Responses-API transport replays unpaired tool items → session repeatedly 400s after an ESC-interrupt.**
  `runtime/src/services/api/openAiCodeTransform.ts:273–360` (`convertproviderMessagesToResponsesInput`).
  Unlike the chat-completions path (`openaiShim.ts convertMessages` ~681–698/763–772, which drops orphan
  tool blocks with a comment explaining that an ESC-interrupt creates a synthetic `tool_result` with no
  recorded `tool_use`), this converter emits `function_call_output` for every `tool_result` and
  `function_call` for every `tool_use` with NO pairing check. On the gpt-5.x/Responses transport
  (`store:false`, full replay) an orphan persists in session history and is replayed on every subsequent
  request → the session hard-fails repeatedly after an ESC. Feeds `performProviderCodeRequest` (:494–502)
  and `buildResponsesBody`. **NOTE:** unguarded emission + orphan-producing scenario verified; exact
  provider 400 text inferred.
  **Fix:** apply the same pre-scan/pairing filter as `convertMessages` — drop `function_call_output` with
  no matching `function_call`, and non-trailing `function_call` with no output.

---

## 🟠 MODERATE

### Cost & budget

- [x] `[x]` **M-COST-1 — Opus 4.5–4.8 mispriced 3× in the live cost tracker.**
  `runtime/src/session/cost.ts:554` (`canonicalModel`), tier at :150–156/:276–282. `canonicalModel()`
  collapses every `claude-opus-4*` (incl. flagship 4.5/4.6/4.7/4.8) to `claude-opus-4-7` @
  `COST_TIER_OPUS` = $15/$75 per Mtok, but the canonical `utils/modelCost.ts` prices these at
  `COST_TIER_5_25` = $5/$25. Proven by executing `computeUsdCostWithResolution`: opus-4-8 with 1M in /
  100k out / 500k cached returns **$23.25** vs the correct **$7.75**. Surfaces in `/cost`, `/status`,
  the exit "Total cost" summary, and transcript `token_count` lines.
  **Fix:** give Opus 4.5–4.8 their own $5/$25 entries; keep $15/$75 only for opus-4/opus-4-1; reuse the
  single source of truth in `utils/modelCost.ts`.

- [x] `[V]` **M-COST-2 — Background-agent `dollar_cap` trips at ~1/3 the configured budget (same root cause).**
  `runtime/src/app-server/background-agent-runner.ts:2772` (`agentCostUsd` → `computeUsdCost(usage,
  DEFAULT_MODEL_COSTS)`; halt at :2681). Same stale Opus registry entry prices an Opus 4.5–4.8 background
  agent at $15/$75, so `budgetHaltForActiveAgent` halts spawned agents far earlier than configured.
  **Fix:** correct the `DEFAULT_MODEL_COSTS` Opus 4.5–4.8 tier to $5/$25 (same root fix as M-COST-1).

### LLM / providers

- [x] `[V]` **M-LLM-1 — Bare `413` regex misclassifies transient 5xx as context-overflow.**
  `runtime/src/llm/errors.ts:406` (`CONTEXT_WINDOW_EXCEEDED_MESSAGE_RE`), checked at :462–464 before the
  5xx branch. Any error body containing the substring "413" (a request/trace id like `req_84413`) maps a
  500/503 to the non-retryable `LLMContextWindowExceededError` → drops history / fails the turn instead
  of retrying.
  **Fix:** anchor to `\b413\b` or drop the alternative and rely on the numeric `status===413` check at :463.

- [x] `[V]` **M-LLM-2 — Structured-output parse on a truncated Responses reply fails the whole turn.**
  `runtime/src/llm/wire/responses-openai.ts:436` (`parseOpenAIResponsesResponse`). Parses `content` when
  `structuredOutput.enabled !== false` + schema + non-empty, but NOT gated on generation completing. A
  truncated reply (`finishReason 'length'`) holds partial JSON; `parseStructuredOutputText` throws
  "returned invalid JSON instead of a schema object" out of `chat()/chatStream()`. Chat-completions was
  patched for this (`generationCompleted` guard); the Responses path and grok adapter (~1508 stream /
  ~2270 non-stream) were not.
  **Fix:** gate the parse on a completed finishReason (stop/tool_calls); return `structuredOutput`
  undefined for length/error/content_filter.

- [x] `[V]` **M-LLM-3 — Grok incremental-tracker leak (no `dispose()` caller).**
  `runtime/src/llm/providers/grok/incremental.ts:234`. `GrokProvider` ctor registers its tracker in a
  module-global Set removed only by `dispose()`, which no production path calls (optional in types.ts:836).
  `permissions/classifier.ts` builds a fresh grok provider per auto-mode classification (fast+thinking) and
  `session/agenc-delegate.ts` per delegate — each permanently adds a tracker retaining `lastRequestInput`.
  Unbounded growth in a long-lived daemon.
  **Fix:** wire `dispose()` through session/turn teardown, hold via `WeakRef`, or drop the global registry
  (`clearAllResponseIds` has no production caller).

- [~] `[V]` **M-LLM-4 [SKIPPED: correct fix threads providerOverride through isGeminiMode + 5 call sites + providerConfig — a risky shared hot-path change the goal guardrail says needs approval; only fires in the legacy AGENC_USE_GEMINI/BNKR env mode, not with a selected provider] — OpenAI-shim writes `process.env` per query → cross-session contamination.**
  `runtime/src/services/api/openaiShim.ts:2508–2533` (`createOpenAiShimClient`, called per-query from
  `client.ts getproviderClient`). Sets `OPENAI_BASE_URL`, `OPENAI_API_KEY = geminiApiKey`, BNKR/BANKR
  mappings. After any Gemini session runs, `isGeminiMode()` (keyed off `OPENAI_BASE_URL` host) is true
  process-wide, changing tool-schema strictness and routing for concurrent OpenAI-shim sessions and
  sending the Gemini key as the OpenAI key.
  **Fix:** resolve the Gemini/Bankr mapping into a local `providerOverride` threaded down the request path
  instead of writing `process.env`.

- [x] `[V]` **M-LLM-5 — Reasoning delta after the thinking block closes throws `RangeError`.**
  `runtime/src/services/api/openaiShim.ts:1257–1271` (closes at :1277–1281/:1307–1311). `hasEmittedThinkingStart`
  is never reset, so a later `delta.reasoning_content` skips `content_block_start` and emits `thinking_delta`
  at a stale index; the consumer (`services/api/anthropic.ts:2093–2147`) throws
  `RangeError('Content block not found')` / `Error('Content block is not a thinking block')`, killing the
  request. Triggers on providers that interleave reasoning around tool calls (Kimi/Moonshot, MiniMax, Z.AI).
  **Fix:** on a reasoning delta when `hasClosedThinking`, open a NEW thinking block at a fresh index (reset
  the flags).

- [x] `[V]` **M-LLM-6 — Truncated tool call executed (Responses stop-reason precedence).**
  `runtime/src/services/api/openAiCodeTransform.ts:667–691` (`determineStopReason`). Returns `tool_use`
  before checking `incomplete_details.reason === 'max_output_tokens'`, so a response cut off mid-function-call
  yields `stop_reason 'tool_use'` and the runtime executes a tool call with truncated/JSON-repaired args.
  Chat-completions was hardened against exactly this (:1401–1417).
  **Fix:** check `max_output_tokens` first and return `max_tokens` before the tool_use check.

- [x] `[V]` **M-LLM-7 — Streaming tool call dropped when id/name arrive in separate chunks.**
  `runtime/src/services/api/openaiShim.ts:1303–1380`. A call is registered only when one delta has both
  `tc.id` and `tc.function.name` (:1305). Providers that split them (vLLM/LM Studio/OpenRouter passthroughs)
  never register the call; later argument deltas hit `activeToolCalls.get(index)` → undefined and are dropped
  silently; the stream ends `finish_reason 'tool_calls'` with zero tool_use blocks and the agent loop stalls.
  **Fix:** register on `tc.id` alone (name pending), patch name on a later delta, warn on orphan arg deltas.

### Daemon / concurrency

- [~] `[V]` **M-DAEMON-1 [SKIPPED: fix relocates a full thread-store scan out of the shared session AsyncLock and pushes cursor/limit into ListThreads — a change to the daemon hot path (getSession) the goal guardrail says needs approval; recommend scanning outside the lock with an invalidatable cache] — `listSessions`/`countSessions` are O(N²) and hold the hot-path session lock.**
  `runtime/src/app-server/session-lifecycle.ts:218` (`#listPersistedSessions` :266–293). Both run inside the
  shared session `AsyncLock` and scan the ENTIRE thread store (pageSize 500) per page, then slice — so
  paginating K pages is O(N·K) full-store SQLite reads while holding the lock that guards `getSession()`
  (on `streamAgentMessage`/`cancelSessionTurn`). A single `session.list`/`health.stats` stalls in-flight
  turns' session lookups.
  **Fix:** scan the thread store outside the lock (or cache with invalidation) and push cursor/limit into
  `ThreadStore.listThreads` so a page reads one page.

- [~] `[V]` **M-DAEMON-2 [SKIPPED: fix dispatches full-turn message.stream off the per-connection FIFO — an architectural change to connection dispatch (risky shared hot path) needing approval; recommend routing streams off the FIFO given their own cancel correlation] — Head-of-line blocking: control RPCs queue behind a full turn.**
  `runtime/src/app-server/transport/stdio.ts:168` (identical chain in `transport/websocket.ts:469`). The
  per-connection dispatch chain serializes non-preemptive requests FIFO; `message.stream`/`message.send`
  are non-preemptive and await the entire turn. The TUI drives streams AND interactive control RPCs
  (`setModel`, `applyConfig`, `hooks.setDisabled`, `mcp.addServer/reconnect`, `snapshot`, `clear`) over the
  same connection, so any of those issued mid-turn waits for the entire (now intentionally unbounded) turn.
  **Fix:** dispatch full-turn `message.stream`/`message.send` off the per-connection FIFO (they have their
  own cancel correlation).

- [~] `[V]` **M-DAEMON-3 — Empty session routes leak on client disconnect. [SKIPPED: mis-diagnosis — reaping on disconnect breaks intended reconnect-buffer design]**
  SKIPPED after investigation. Reaping the empty route in `disconnectClient` (the proposed fix) is
  WRONG: the existing test `client-multiplexer.dead-session-route-leak.test.ts:205` ("only consults the
  session manager when no route exists yet") proves the route is intentionally KEPT after a transient
  disconnect so a reconnecting client (TUI closed, session still alive) can replay buffered events
  without a `getSession` liveness probe. Applying the fix turns that passing test RED. Buffer-only
  routes for TERMINATED/UNKNOWN sessions are already reaped via the broadcast liveness probe (sibling
  tests in the same file); a live session's route is reaped by `terminateSession`. A session that is
  never terminated is a session-lifecycle concern, not a route leak — dropping its route on disconnect
  would lose events the reconnecting client should receive. Not a bug.
  `runtime/src/app-server/client-multiplexer.ts:480` (`disconnectClient`). Removes the client from each
  route's `clientAttachmentIds` but never calls `deleteRouteIfEmpty()` (every other detach path does). A
  TUI close (removeClient → disconnectClient) leaves an empty `MutableSessionRoute` husk in `state.sessions`
  forever; only `terminateSession` reaps it. Unbounded slow growth over many distinct sessions/agents.
  **Fix:** call `deleteRouteIfEmpty(state, route)` after `clientAttachmentIds.delete(clientId)` in the
  per-session loop. *(Verifier rated minor; listed here with the daemon family.)*

### Tools / exec

- [x] `[V]` **M-EXEC-1 — `Monitor` confused its foreground yield with process lifetime.**
  `runtime/src/tools/system/monitor.ts` now uses the bounded foreground yield only to return a process id.
  The monitored process has no implicit hard timeout and remains available for later
  `write_stdin(session_id, '')` polls until it exits or is explicitly stopped. Explicit caller-supplied
  process deadlines are still honored.

- [x] `[V]` **M-EXEC-2 — Unbounded subprocess buffering in shell mode (OOM risk).**
  `runtime/src/tools/system/bash.ts:347` (`runSpawnedCommand`). Shell / shell-wrapper mode pushes every
  chunk into `Buffer[]` with no cap, truncating only at flush (`maxOutputBytes = 100_000`). A fast large
  emitter (`yes`, `cat huge`) buffers the whole stream in daemon heap → OOM takes down all sessions.
  Asymmetric: direct-mode `execFile` caps via `maxBuffer`; `exec_command`'s `ProcessOutputBuffer` enforces a
  running cap.
  **Fix:** enforce a rolling byte cap while accumulating (head-tail-collapse past a multiple of
  `maxOutputBytes`, matching `ProcessOutputBuffer.enforceCap`).

- [x] `[V]` **M-EXEC-3 — `enforceCap` is O(cap) per append under deferred drain.**
  `runtime/src/unified-exec/process-manager.ts:96` (`ProcessOutputBuffer.enforceCap`). Foreground exec and
  empty-input background polls drain once at end of yield (30s / up to 300s), so `consumedIndex` stays 0 and
  the ~1MB pending region is re-collapsed (slice/filter/join/truncateHeadTail) on every 8KB chunk past the
  1MB cap. Pins a core on the shared daemon for a verbose emitter.
  **Fix:** collapse lazily at `drain()` time, or amortize (dirty threshold, re-truncate at most every N appends).
  **DONE (amortize + collapse-at-drain):** split `enforceCap` into cheap `evictConsumed()` (runs every append) and
  the expensive `collapsePending()`, which now runs on append ONLY when the pending region overshoots by a full
  cap (`totalChars > maxChars*2`), collapsing back to the cap — bounding memory at ~2×maxChars and amortizing the
  O(pending) work to O(1)/char. `drain()` collapses to the cap so a caller never sees more than maxChars. All 6
  pre-existing head/tail/label/fairness invariant tests still pass unchanged. New revert-sensitive test: under
  deferred drain, 500 appends past the cap trigger ~30 collapses (a `collapseCountForTest` counter), vs 484 when
  reverted to per-append collapse; plus a never-drained memory-bound test.

- [x] `[V]` **M-EXEC-4 — Background process evicted before it is polled (lost output + exit code).**
  `runtime/src/unified-exec/process-manager.ts:396` (`pruneExitedProcesses`). Called at the start of every
  `execCommand`; deletes any process whose `exitState !== null`. A background command that exited but hasn't
  been polled is evicted the moment the model issues any next `exec_command` (the normal start→do-work→poll
  flow), so the subsequent poll throws `unknown_process` and the final buffered stdout/stderr + exit code are
  lost. `writeStdin` allows one final drain of an exited entry, but the prune front-runs it.
  **Fix:** track a "drained-after-exit" flag; only release exited entries once completion output has been
  delivered at least once (or prune only to reclaim slots at/over `maxProcesses`, oldest-drained first).

### Tools / file & data

- [!] `[V]` **M-FILE-1 [DEFERRED: session-close hook location + workspace-keyed map eviction policy are design decisions; naive session-close clear is unsafe for the shared workspace map] — Session/workspace read-state maps leak forever.**
  `runtime/src/tools/system/filesystem.ts:614` (state at :184/:206). `sessionReadState` accumulates one Map
  per session (each up to ~25MB content; `boundSessionReadContent` caps bytes within a session, never the
  session count) and `workspaceReadState` one entry per unique path ever read. `clearSessionReadState`/
  `clearSessionReadCache`/`snapshotTopRecentReads` have zero production callers; `workspaceReadState` has no
  cleanup at all. Doc comments falsely claim cleanup happens on session close. Grows until OOM.
  **Fix:** wire `clearSessionReadState(sessionId)` into the session-close path; add/call a
  `clearWorkspaceReadState` (or evict entries) on teardown.

- [x] `[V]` **M-FILE-2 — FileRead emits oversized/high-DPI images the provider rejects.**
  `runtime/src/tools/system/file-read.ts:1146` (`readImageFile`; notebook path `extractNotebookImageOutput`
  ~:705). Base64-encodes up to `maxImageBytes = 10MB` with no downsample/dimension clamp; the wire layer
  (`llm/wire/shared.ts:551`) passes it through. Provider limit is ~3.7MB / 1568px, which is why BashTool
  (`resizeShellImageOutput → maybeResizeAndDownsampleImageBuffer`) and MCP resize. Reading a >3.7MB screenshot
  or a small-but-over-1568px PNG 400s on the advertised "read this screenshot" path.
  **Fix:** route `readImageFile`'s buffer (and notebook outputs) through `maybeResizeAndDownsampleImageBuffer`
  before base64 encoding.

### Services / context

- [~] `[V]` **M-SVC-1 [SKIPPED: LLMMessage has no timestamp field, so the correct fix needs broad timestamp plumbing (>5 files) or a microcompact design decision (protect-all disables it; not-protecting is the current bug); recommend adding a timestamp to the runtime message or widening the positional recent-window] — microcompact time-window protection is a complete no-op on the hot path.**
  `runtime/src/services/compact/microCompact.ts:91` (`isWithinTimeWindow`). The live caller
  `run-turn.ts toAgenCRuntimeMessages` stamps every message `new Date(0).toISOString()` (:684/:699), so `now −
  timestamp` is always ~56 years and the "don't clear results younger than `AGENC_MICROCOMPACT_CLEAR_AFTER_MS`
  (5 min)" guard never fires. Large (≥6000 char) recent tool results get stubbed to `[microcompact:N]` even
  seconds old → context churn / re-reads; the knob is inert. `/context` passes real timestamps, so the epoch-0
  stamp is the anomaly.
  **Fix:** carry each message's real timestamp through `toAgenCRuntimeMessages`, or treat epoch-0/missing
  timestamps as unknown-age and skip time-based clearing.

### TUI

- [~] `[V]` **M-TUI-1 — Transcript re-mints every message UUID on each streaming delta.** [SKIPPED: risky
  hot-path refactor with a subtle correctness invariant. The fix threads a deterministic id (eventKey(raw) + block
  index) through `adaptTranscriptEvents` into the `make*` helpers (which take no id today — 7 helpers, ~53 refs in
  session-transcript.ts, plus external callers in session/transcript-replacement.ts). `adaptTranscriptEvents` runs
  per appended token, so this is the transcript rendering hot path, and the deterministic id MUST be unique per
  synthetic message: one source event fans out to multiple messages (assistant text + thinking + each tool_use
  block; tool_result), so the block-index scheme has to be collision-free across every message type or two rows
  share a key and VirtualMessageList mis-renders/drops them. Recommend: add an optional `uuid` param to each
  make* helper defaulting to `randomUUID()` (keeps external callers unchanged), thread
  `${eventKey(raw)}:${blockIndex}` from adaptTranscriptEvents with a per-event block counter, and add a test that
  the same events derived twice yield identical, unique message uuids before landing it.]
  `runtime/src/tui/session-transcript.ts:430` (`make*` helpers :430/:438/:467/:532/:550). Each mints a fresh
  `randomUUID()`, and `useSessionTranscript`'s `useMemo` (:2839, deps `[state.events]`) re-derives on every
  appended event (one per token during a turn), so every historical message gets a new uuid per delta.
  `messageKey = ${uuid}-${conversationId}` feeds `VirtualMessageList` `itemKey`, and `useVirtualScroll`
  prunes any key not in the live set — so every token invalidates the whole height cache, remounts+remeasures
  all visible rows (Yoga), and breaks uuid-keyed state (`selectedIdx`/cursor → -1, expanded rows, unseen
  divider).
  **Fix:** derive each synthetic message's uuid deterministically from its source event key (`eventKey(raw)` +
  block index) so identity is stable across re-derivations.

- [x] `[V]` **M-TUI-2 — `ESC[3J` wipes terminal scrollback on resize / offscreen repaint.**
  `runtime/src/tui/ink/clearTerminal.ts:68` (emitted from `log-update.ts` full-reset sites
  :147/:226/:251/:275/:393 → `terminal.ts:246` → `ESC[2J ESC[3J ESC[H`). In the default main-screen (non-
  fullscreen) mode, a resize or an offscreen-row change triggers a full reset whose `ESC[3J` erases the user's
  scrollback above the app. The deliberate ctrl+L/`forceRedraw` path uses only `ESC[2J` and documents
  "scrollback preserved."
  **Fix:** use `ESC[2J` + CURSOR_HOME for engine-internal resets; reserve `ESC[3J` for the explicit
  `forceRedraw`/ctrl+L path (or thread `FlickerReason` so resize/offscreen skip the 3J).
  **DONE:** `getClearTerminalSequence(wipeScrollback = true)` gates the `ERASE_SCROLLBACK` (ESC[3J); the
  `clearTerminal` patch already carries `reason: FlickerReason`, so `terminal.ts` now emits
  `getClearTerminalSequence(patch.reason === 'clear')` — 'resize'/'offscreen' skip the 3J, only an explicit
  'clear' wipes. Revert-sensitive test (clearTerminal-scrollback.test.ts) via `writeDiffToTerminal` with a
  capturing terminal.

- [x] `[x]` **M-TUI-3 — `/context` fabricates a per-file token breakdown.**
  `runtime/src/tui/components/v2/ContextUsageModal.tsx:178–186,220–227`. `parseContextUsage` extracts only one
  aggregate `files: N tokens` number, but whenever it's present the modal always renders three hardcoded
  filenames — `lib.rs`, `pool.rs`, `math.rs` — plus a hardcoded `files (3)` / `3 files`, splitting the real
  total by magic ratios `3841/8402` and `2118/8402`. Leftover design-browser fixture data shipped live;
  reachable from `/context` (`commands/session-compact.ts:214`). Also `system` row uses `?? toolsTokens` and
  the 92%/`compactionThreshold/hardLimit` fallback → `auto-compact at Infinity%` when hardLimit parses to 0.
  **Fix:** remove the fabricated per-file rows (and the hardcoded label/fallbacks), or plumb real per-file data
  into `parseContextUsage`.

- [~] `[V]` **M-TUI-4 — `Tabs` crashes on empty children. [SKIPPED: unreachable — sole caller HelpV2 always seeds tabs=[general]; file is react-compiler-compiled output]**
  `runtime/src/tui/components/design-system/Tabs.tsx:235`. The context provider indexes `tabs[selectedTabIndex][0]`
  unconditionally; with `children = []`, `tabs[0][0]` throws `TypeError` on mount, and `handleTabChange` does
  `% tabs.length` → NaN → crash next render. Any caller building tab children dynamically (all filtered out)
  crashes. *(Reachability from a dynamic caller unproven; static callers are non-empty.)*
  **Fix:** guard the empty-tabs case (render nothing / fallback) and skip the modulo when length is 0.

- [x] `[V]` **M-TUI-5 — Uncaught Neovim RPC rejection on buffer close/quit.**
  `runtime/src/tui/workbench/buffer/neovim/NeovimLifecycle.ts:89–113`. `isDirty()` and the quit path call
  `#rpc.request(...)` with no catch, and `NeovimRpc.request()` rejects once the transport is closed. The
  transport closes independently of the session (stdin EPIPE before the child's `exit`), so during that window
  `:q`/`:wq` (void-invoked at `BufferSurface.tsx:323–333`) and the `buffer:close` handlers let the rejection
  escape → unhandled rejection can take down the daemon. The sibling `#readCurrentDirtyState` wraps the same
  call in `.then(ok, fallback)`. *(Timing race partially unverified.)*
  **Fix:** catch the RPC rejection on the quit/close path (treat a dead transport as not-dirty/already-closed).
  **DONE:** `isDirty()` now `.catch(() => false)` on the RPC (the uncaught path the quit/close flow awaits;
  `#quitOnce`/`#cleanupOnce` already had `.catch`). Revert-sensitive test (NeovimLifecycle-dirty-catch.test.ts):
  a rejecting transport makes `isDirty()` resolve false and `quit()` return `{ closed: true }`, vs both rejecting
  without the catch.

- [x] `[V]` **M-TUI-6 — MCP import dialog floats an uncaught async write.**
  `runtime/src/tui/components/MCPServerDesktopImportDialog.tsx:114–132`. `onSubmit` is async and awaits
  `addMcpConfig` (a config-file write) with no try/catch, but `SelectMulti` types `onSubmit` as `void`-returning
  and invokes it fire-and-forget. An EACCES/EROFS/disk error rejects as an unhandled rejection and `done()`
  never runs → dialog stuck. (Siblings TeamsDialog/WorktreeExitDialog wrap their awaits.)
  **Fix:** wrap the loop in try/catch and surface the failure in the dialog.
  **DONE:** extracted `importSelectedMcpServers(...)` (a top-level export, no memo-cache change since the file is
  committed react-compiler output; it rejects on write failure), and wrapped `onSubmit` in try/catch. On error it
  catches (SelectMulti calls onSubmit fire-and-forget, so an uncaught rejection would be unhandled), logs, and does
  NOT complete/shut down — the dialog stays open so the user can retry/cancel (matching the pre-existing
  MCPServerDesktopImportDialog.test.tsx guard that an import error must not complete or shut down). `done()` only on
  full success. Revert-sensitive: the pre-existing test asserts onSubmit resolves + logError called + onDone/
  gracefulShutdown NOT called; MCPServerDesktopImport-catch.test.ts covers the helper (rejects on failure, success,
  collision, skip). NOTE: an earlier attempt wrongly completed with a partial count on error — the full-suite run
  caught it via this pre-existing test; corrected here. In-dialog error banner UI is still a follow-up (needs new
  component state in the compiled output).

- [~] `[V]` **M-TUI-7 — PromptInput submit path floats async work with no catch.** [SKIPPED: risky shared hot path
  + no feasible isolated reproduction. `onSubmit` is THE main prompt-input handler (a huge useCallback deeply wired
  to the store, teamContext, speculation, suggestions, and parent callbacks). The fix needs surgical try/catch
  around each awaited parent callback (onAgentSubmit :1425, sendDirectMemberMessage :1375, onSubmitProp) PLUS a
  `.catch(logError)` on the floated `void onSubmitProp(...)` at :1340 — a broad try/catch around the whole handler
  would swallow errors that specific sites handle by return value (e.g. sendDirectMemberMessage's { success,
  error } checked at :1376), changing control flow. A revert-sensitive unhandled-rejection test would have to mock
  the entire submit environment (store, teamContext, speculation state, suggestions, onAgentSubmit,
  sendDirectMemberMessage, writeToMailbox). Recommend: `.catch(logError)` on the floated call, and wrap ONLY the
  awaited callback expressions (not the surrounding control flow) so return-value handling is preserved; verify
  under the component's render harness. The audit itself notes the process-level unhandledRejection impact is
  unverified.] —
  `runtime/src/tui/components/PromptInput/PromptInput.tsx:1340` (also :691, :2163 invocation; :1375/:1425/:1519
  awaited callbacks). `onSubmit` is `void`-invoked from the history-search callback and the `chat:submit`
  keybinding; inside it `onSubmitProp` is itself floated on the speculation-accept path while `onAgentSubmit`/
  `sendDirectMemberMessage`/`onSubmitProp` are awaited with no try/catch (only the bash branch is wrapped). An
  IPC/network/disk rejection becomes an unhandled rejection. *(Whether a process-level `unhandledRejection`
  handler exists is unverified.)*
  **Fix:** wrap the awaited parent callbacks in try/catch and attach `.catch` to the floated calls.

- [x] `[V]` **M-TUI-8 — SDK subprocess transport can crash the embedder on EPIPE.**
  `packages/agenc-sdk/src/subprocess.ts:259–264`. `promptViaSubprocess` writes to `child.stdin` and `end()`s it
  with no `error` listener on the stdin stream. If the spawned `agenc` child exits before draining stdin
  (startup crash, bad flag), the buffered write hits a closed pipe → EPIPE on the stream → no listener →
  uncaught exception in the embedder's process. `child.once("error")` (:210) covers ChildProcess spawn errors
  only, not stream errors.
  **Fix:** attach `child.stdin.on("error", …)` (routing into `finishError`) before writing. *(Related minors in
  the same file: abort listener at :253–257 never removed on completion; `buffered` array at :136 has no cap
  while `client.ts` caps at 1000.)*

- [x] `[V]` **M-TUI-9 — AgentsRail arrow-nav follows a different order than it renders.**
  `runtime/src/tui/workbench/agents/AgentsRail.tsx:24–31`. `selectByDelta`/`selectedIndex` navigate the flat
  `taskList`, but the rail renders two partitioned sections (active, then background). For `[A running,
  B completed, C running]` the UI shows active `[A,C]` then background `[B]`, yet ↓ from A highlights B —
  skipping C and jumping between sections. Also `taskList[next].id` can be `undefined` (unkeyed task) →
  dispatches `selectAgent` with `taskId: undefined`.
  **Fix:** navigate the rendered (partitioned) order — concat `activeTasks` then `backgroundTasks` — and guard
  the undefined id.
  **DONE:** extracted exported `nextAgentSelectionId(taskList, selectedId, delta)` that partitions then walks
  `[...activeTasks, ...backgroundTasks]` and returns `null` for an empty list or an unkeyed target (no
  `taskId: undefined` dispatch); `selectByDelta` uses it (dropped the now-unused `selectedIndex`). Revert-sensitive
  test (AgentsRail-nav.test.ts) proves rendered-order navigation vs the flat-order bug.

- [x] `[V]` **M-TUI-10 — Workbench file activity recomputes per candidate path (O(paths×tasks) with JSON.stringify).**
  `runtime/src/tui/workbench/agents/activity.ts:27–38` (`inFlightPathsFromTasks`). Invokes
  `taskMayReferencePath` inside `candidatePaths.filter(activeTasks.some(...))`, so `taskSearchStrings(task)` (which
  `JSON.stringify`s `lastActivity.input` and every `recentActivities[].input`) runs `paths × tasks` times,
  re-serializing the same inputs per path. Driven by `ProjectExplorer.tsx:52–57` over the full expanded tree on
  every streamed agent-progress event.
  **Fix:** compute `taskSearchStrings` once per task, not per path.
  **DONE:** `inFlightPathsFromTasks` now precomputes `normalizedTaskSearchStrings(task)` once per active task
  (shared helper also used by `taskMayReferencePath`), then the per-path filter reuses them — so `taskSearchStrings`
  (and its JSON.stringify of every input) runs O(tasks) not O(paths×tasks). Behavior-preserving (existing
  activity tests unchanged). Revert-sensitive test: with 1 task + 21 candidate paths, `JSON.stringify` is called
  once (fixed) vs 21× (reverted, per-path).

- [x] `[V]` **M-TUI-11 — Project tree rebuilt and re-sorted on every cursor move (doubled on cursor normalization).**
  `runtime/src/tui/workbench/project-tree/ProjectTreeStore.ts:366–409` (`#emit`). Calls `buildProjectTreeRows`
  (→ `createProjectTree` full Map build + `sortTree` O(N log N)) on every `move`/`page`/`toggle`/`expand`/
  `reveal`/`setActivePath`/`setInFlightPaths`/`refresh`, and twice when `visibleCursorPath` differs from the
  current cursor. On a large repo this is per-keystroke O(N log N).
  **Fix:** memoize the row build against `#paths`/`#expandedPaths` rather than recomputing on pure selection
  changes.
  **DONE:** the expensive structure build (createProjectTree Map build + sortTree) depends only on (cwd, paths);
  cursor/expand/flags are applied cheaply in appendRows. Memoized the sorted tree in a `WeakMap<paths, {cwd,root}>`
  keyed by the paths-array identity (the store reassigns `#paths` wholesale and never mutates it, so a stable
  reference == unchanged file list; WeakMap auto-GCs replaced arrays and keeps sessions isolated). Now
  move/page/toggle/cursor-normalization reuse the sorted structure. Behavior-preserving (all 38 existing tree tests
  pass). Revert-sensitive test: 3 cursor moves over the same paths trigger 1 structure build (a
  `structureBuildCountForTest` counter) vs 3 when the cache is bypassed; a new paths array rebuilds.

- [x] `[V]` **M-TUI-12 — MarkdownTable does ~4–5 full O(rows×cols) layout passes per render, unmemoized.**
  `runtime/src/tui/components/markdown/MarkdownTable.tsx:142–217`. `getMinWidth`/`getIdealWidth`/
  `calculateMaxRowLines`/`renderRowLines` each call `formatCell → formatToken + stripAnsi` per cell with no
  `useMemo`; re-runs on resize, theme change, and every streaming delta while a table is the growing block
  (StreamingMarkdown re-parses the tail per token). A wide table streamed row-by-row re-lays-out the whole table
  per token.
  **Fix:** memoize the width/line computations against the table token; contrast `Markdown.tsx`'s token cache.
  **DONE (render-scoped formatCell cache):** `formatCell` is memoized per render by the cell's `tokens` reference
  (theme/highlight are constant within a render). The ~4-5 layout passes each formatted every cell; now each cell
  runs through `formatToken` once. Revert-sensitive test (markdown-table-format-cache.test.tsx): a 6-cell table
  calls `formatToken` 6 times (cached) vs 24 (4× per cell, reverted). Also fixed a missed `Math.max(...spread)` at
  :323 (`renderPreformattedLines`) — the crash-class site the Math.max item noted as ":322" — now `maxOf`. NOTE:
  chose the render-scoped cache (the dominant redundant work, and the only reuse available for a STREAMING table
  whose token changes every delta) over an across-render token-keyed layout cache, which only helps
  stable-token re-renders (resize/theme) and would be a larger, riskier restructure of this hot-path component.

### Onboarding (new code — commits 699768615 / 6c219902c, today)

- [~] `[V]` **M-ONB-1 — Grok OAuth sign-in never shows the URL and swallows browser-open failure.** [SKIPPED: the
  URL-display fix is an API-shape change (STOP-and-ask). The wizard's submit handler blocks on a single
  `await runLogin()` (Onboarding.tsx:1031) and `runGrokOauthLogin` takes NO args, so there is no channel to show
  the URL while the login is in flight — unlike `/grok-login`, which has a `SlashCommandContext` (`showLoginNotice`).
  A real fix threads an `onNotice`/React-setState callback into the `runGrokOauthLogin` injection signature so the
  submit handler can `setState(url)` before/while awaiting (React re-renders independently of the handler's return)
  and `defaultRunGrokOauthLogin(onNotice)` mirrors /grok-login: notice(url) → openUrlInBrowser → on failure
  notice(manual-open URL). Also catch the `void openUrlInBrowser(url)` rejection (route to logError) — the child
  `error` event is currently an unhandled promise; this half is safe to do independently. Recommend confirming the
  injection-signature change before wiring.]
  `runtime/src/onboarding/Onboarding.tsx:168`. The first-run wizard's grok flow uses
  `onAuthorizeUrl: (url) => { void openUrlInBrowser(url); }` — never displays the URL, and the `void` makes an
  `openUrlInBrowser` rejection (child `error` event) an unhandled promise. On a headless/SSH/no-xdg-open box the
  browser never opens, nothing is shown, and `runXaiBrowserLogin` blocks on the loopback callback for the full
  300s with no feedback. The `/grok-login` command (`commands/xai-auth.tsx:140`) does it right (prints URL first,
  copy-URL fallback).
  **Fix:** surface the authorize URL in `onAuthorizeUrl` before opening the browser, and catch the open failure
  with a manual-open fallback.

- [x] `[V]` **M-ONB-2 — Theme "terminal background awareness" tip defaults to dark and can invert its advice.**
  `runtime/src/onboarding/Onboarding.tsx:1344`. Calls `getSystemThemeName()`, which resolves the background from
  a `$COLORFGBG`-seeded cache defaulting to `dark`, corrected only by the OSC 11 watcher — which runs only when
  the theme is `auto` (ThemeProvider.tsx:74–94). The wizard default is `dark`, so no OSC 11 query fires; on
  terminals that don't export COLORFGBG (gnome-terminal, Terminal.app, iTerm2, Windows Terminal, VS Code,
  Ghostty, kitty, Alacritty) it always returns `dark`. A light-terminal user is told "your terminal background
  looks dark — dark/system will read best," the exact mismatch the feature was added to prevent.
  **Fix:** actively issue the OSC 11 query during onboarding before rendering the tip, or omit the directional
  recommendation when the value is a defaulted (not detected) `dark`.
  **DONE (option 2):** `systemTheme.ts` now tracks whether the value was measured ($COLORFGBG parse or an OSC 11
  `setCachedSystemTheme`) via `isSystemThemeDetected()`; the onboarding theme tip gives a directional
  recommendation only when detected, otherwise "couldn't detect your terminal background — if light … if dark …".
  Revert-sensitive tests: systemTheme-detected.test.ts (detected vs defaulted) + theme-tip-detection.test.ts (the
  undetected case no longer asserts the guessed direction).

### Permissions / agents

- [x] `[V]` **M-PERM-1 — `bypassPermissions` (--yolo) silently waives user content-ASK rules.**
  `runtime/src/permissions/bash.ts:471`. Under bypass mode, `bashToolHasPermission` short-circuits to `allow`
  for any subcommand set with no explicit deny, so a configured `Bash(git push:*)` / `Bash(rm:*)` ASK guardrail
  is skipped (verified by running the function: `default` mode → `ask`, `bypassPermissions` → `allow`). The
  evaluator's step 1f (content-ask-survives-bypass) never fires.
  **Fix:** before the `if (!hadDeny) return allow` early-return (:473), also bail when any subcommand produced a
  rule-based ask (reuse `aggregateAskCameFromRule` from the sandbox-override block :507–511), returning the
  aggregate ask.

- [~] `[V]` **M-AGENT-1 [SKIPPED: fix is mechanical (thread session.sessionConfiguration.cwd into requireAgentRole/getAgentRole/listAgentRoles at spawn.ts:511/329/348 and control.ts:357/1437/79 — the role.ts functions ALREADY accept cwd and resolve the right namespace). A revert-sensitive test must exercise the spawn call site, not role.ts (already correct), needing a spawn harness + vi.mock. Security-relevant (wrong disallowlist); recommend doing with a spawn-path test] — Markdown agent roles resolve against the wrong workspace in a multi-session daemon.**
  `runtime/src/agents/v2/spawn.ts:511` (also `listAgentRoles` :329/:348, `control.ts:357/1437/79`).
  `requireAgentRole(role)` is called with no cwd; markdown roles are stored process-globally in
  `markdownRolesByCwd` keyed by cwd (role.ts:357), and the cwd-less lookup falls back to "most recently loaded
  namespace wins." When sessions A and B each define a same-named role (`.agenc/agents/reviewer.md`) and B loaded
  after A, a spawn in still-running session A resolves `reviewer` to project B's role — wrong systemPrompt, model,
  and (security-relevant) disallowlist. `resolveResumedAgentRole`'s fail-closed-to-readonly also breaks.
  **Fix:** thread the requesting session's cwd (`session.sessionConfiguration.cwd`) into `requireAgentRole`/
  `getAgentRole`/`listAgentRoles` at every live spawn and resume site.

### Sandbox (intended safety mechanisms defined but never wired)

- [~] `[V]` **M-SBX-1 [SKIPPED: wiring isSandboxRequired into the Bash gate changes security-gate behavior (refuse when unavailable) across tools + orchestrator; the main engine/exec path ALREADY fails closed (enforceRuntimeSandboxAttempt), so this is the legacy settings.sandbox path. Needs care + confirmation it wont block legitimate no-sandbox users] — `failIfUnavailable` fail-closed switch is dead; legacy sandbox fails OPEN.**
  `runtime/src/utils/sandbox/sandbox-runtime.ts:488` (`isSandboxRequired`). Reads `sandbox.enabled &&
  failIfUnavailable` but has zero callers. When bwrap/socat is missing, `isSandboxingEnabled()` → false →
  `shouldUseSandbox()` → false → Bash runs fully unsandboxed. A user who set `failIfUnavailable: true` expecting a
  hard fail gets silent unsandboxed execution.
  **Fix:** call `isSandboxRequired()` at startup/print and in the Bash gate; refuse to run when true and
  sandboxing is unavailable.

- [~] `[V]` **M-SBX-2 [SKIPPED: additive but needs wiring getSandboxUnavailableReason into the doctor/REPL startup path + a doctor-output test; recommend surfacing it as a startup warning banner] — `getSandboxUnavailableReason()` (the missing-confinement warning) is never called.**
  `runtime/src/utils/sandbox/sandbox-runtime.ts:571`. Its own doc: "Call once at startup … This is a security
  footgun — users configure allowedDomains expecting enforcement, get none." Zero callers, so a user who enabled
  the sandbox but can't run it gets no feedback.
  **Fix:** invoke it during REPL/print startup and surface the reason as a visible warning banner.

- [~] `[V]` **M-SBX-3 [SKIPPED: populating environmentLacksSandboxProtections enables an approval branch = security-gate behavior change in tools/orchestrator; recommend setting it from runtimePlatformSandboxStatus().available===false with tests] — `environmentLacksSandboxProtections` escalation branch is unreachable.**
  `runtime/src/tools/orchestrator.ts:1052` (dead read at `sandbox/escalation/unix-escalation.ts:277`).
  `renderDecisionForUnmatchedCommand` treats `environmentLacksSandboxProtections === true` as dangerous
  (force prompt / forbid), but the only builder of `UnmatchedCommandContext` never sets the field, so the
  "no confinement → require approval" policy is not in effect on the local_shell path. *(The newer engine/exec
  path does fail closed via `enforceRuntimeSandboxAttempt`; this gap is the legacy path + UX.)*
  **Fix:** populate `environmentLacksSandboxProtections` from `runtimePlatformSandboxStatus().available === false`
  when constructing the unmatched-command context.

### Bash classification & shell parsing

- [x] `[V]` **M-BASH-1 — `date --iso-8601 <MMDDhhmm>` misclassified as read-only (can set the system clock).**
  `runtime/src/tools/BashTool/readOnlyValidation.ts:740–741` (callback :761–767). `-I` is type `none` but its
  long alias `--iso-8601` is type `string` and is in the callback's `flagsWithArgs`; GNU `date` treats
  `--iso-8601` as optional-argument, so `date --iso-8601 12312359` leaves `12312359` as a positional operand
  (sets the clock, `MMDDhhmm`), but `validateFlags` consumes it as the flag arg and the callback skips it, so the
  "positional not starting with `+`" danger check never sees it. Reproduced: `date --iso-8601 12312359` →
  READONLY; `date -I 12312359` and `date 12312359` correctly blocked. (The regex path is authoritative — the
  tree-sitter path is shadow-gated.)
  **Fix:** treat `-I`/`--iso-8601` as optional-argument (accept only the `=`-attached value) and drop
  `--iso-8601` from the callback's `flagsWithArgs`.

### Transaction-guard config (beyond C2)

- [~] `[V]` **M-TXG-1 [SKIPPED: the fix (make truthy values enable) alters the DOCUMENTED env-var kill-switch semantics (config.ts:52-53), which the goal guardrail says needs approval; recommend either (a) accept truthy-enables, or (b) case-normalize slm + warn on truthy values] — `AGENC_TRANSACTION_GUARD` set to a truthy value silently DISABLES the guard.**
  `runtime/src/transaction-guard/config.ts:70–72`. `enabled = envEnabledRaw === "slm"`, so any other non-empty
  value (`1`, `true`, `on`, or even `SLM` — not case-normalized, unlike `fail_mode`) is a kill switch that beats a
  config `enabled: true`, with no warning. An operator setting `=1`/`=true` intending to enable the guard silently
  disables it.
  **Fix:** case-normalize; treat recognized truthy values as enable and falsy as disable; warn (or fall back to
  config) on unrecognized values instead of silently disabling.

- [x] `[V]` **M-TXG-2 — Attacker text containing "devnet" makes the framework vouch "targeting DevNet" for a mainnet tx.**
  `runtime/src/transaction-guard/tool-intent.ts:16,127,136–138`. `isDevnet = DEVNET_RE.test(combined)` runs over
  fully attacker-influenced text. A command like `# devnet test only\nsolana transfer ATTACKER 100 --url
  https://api.mainnet-beta.solana.com` makes the framework author `transactionSummary: "… targeting DevNet."` and
  set `detector.devnetRpcExplicit: true`; the judge prompt treats devnet transfers as benign-leaning, so untrusted
  content biases the classifier through a trusted-looking field.
  **Fix:** assert DevNet only when a devnet RPC URL appears in a URL-shaped position AND no mainnet RPC marker is
  present; otherwise phrase it as "text mentions devnet (unverified)."

---

## 🟡 MINOR

### TUI

- [x] `[V]` `runtime/src/tui/session-transcript.ts:2771` — `append` reducer mutates the previous state's `keys`
  Set in place and returns it (impure reducer). Under StrictMode dev double-invoke, invoke #2 sees the key already
  present and drops the event from the committed render. Prod unaffected. **Fix:** clone before `add`/`evict`.
  **DONE:** `const keys = new Set(state.keys)` before `add`/`evictOldestEvents` (bounded by ring eviction).
  Revert-sensitive test (session-transcript-reducer-purity.test.ts) proves the prev state is untouched and a
  double-invoke keeps the event.
- [x] `[V]` `runtime/src/tui/ink/ink.tsx:1642` — `StylePool` is created once and never reset (unlike CharPool/
  HyperlinkPool rotated every 5 min); `styles`/`ids`/`transitionCache` (worst case O(usedStyles²)) grow unbounded
  over a long truecolor session. **Fix:** rotate StylePool in `resetPools()` or cap `transitionCache`.
  **DONE (cap transitionCache):** FIFO-capped the `(fromId,toId)` transitionCache at 16_384 — it is the
  O(usedStyles²) dominant growth, and eviction is behavior-preserving (an evicted pair recomputes on next use).
  Revert-sensitive test: 200 distinct styles → ~39,800 transition pairs stay capped at 16,384 (vs 39,800 uncapped).
  NOTE: chose the cap over rotating the pool — `stylePool` is `readonly` and rotating it would require migrating
  style IDs held by the frames (like `migrateScreenPools` does for CharPool), a riskier change. The linear
  `ids`/`styles` growth (one entry per DISTINCT interned style) is bounded by the truecolor palette actually used
  and would need that ID-migrating rotation; left as a follow-up.
- [x] `[V]` `runtime/src/tui/ink/parse-keypress.ts:199` — `inputToString()` mutates the caller-owned Buffer in
  place (`input[0] -= 128`); an aliasing hazard for non-utf8 callers of the exported `parseMultipleKeypresses`
  (production input path is utf8-string, so effectively dead there). **Fix:** build the string without mutating.
- [x] `[V]` `runtime/src/tui/components/CustomSelect/use-select-navigation.ts:549–567` — when a parent passes a
  fresh-but-equal `options` array each render, `setLastOptions` never runs, so the O(n) `optionsNavigateEqual`
  scan runs every render (incl. every keystroke). **Fix:** update `lastOptions` even on structural equality.
  **DONE:** extracted exported `optionsUpdatePlan(options, lastOptions)` returning `{ reset, updateLast }`;
  `updateLast` is true whenever the reference differs (even when structurally equal), so `setLastOptions` refreshes
  the reference and the next same-reference render short-circuits (no re-scan). `reset` still fires only on a real
  content change. Behavior-preserving (16 CustomSelect suites pass). Revert-sensitive test (options-update-plan.
  test.ts): a fresh-but-equal array yields `updateLast: true` vs `false` when reverted to refresh-only-on-reset.
- [~] `[V]` `runtime/src/tui/components/PromptInput/PromptInputQueuedCommands.tsx:150` [SKIPPED: no
  front-drain-stable key is available without a non-trivial threading change. The mapped `messages` are derived in
  a `useMemo(..., [queuedCommands])` where `createUserMessage` mints a FRESH uuid per call, so on any queue change
  (incl. the front-drain) every message gets a new uuid — keying by `message.uuid` would remount just as much as
  the index. The only id that survives a front-drain is the source `QueuedCommand.uuid`, which is OPTIONAL and
  would have to be threaded through `processQueuedCommands`/`normalizeMessages` (which don't preserve a 1:1 mapping
  to queued commands). The churn is also per-drain (when a queued item executes), not per-frame. Recommend:
  guarantee a stable id on each QueuedCommand at enqueue and carry it onto the derived message, then key by it.] —
  index-keyed queue preview over a front-draining queue causes remount churn when the head is removed. **Fix:** key
  by stable id.
- [x] `[V]` `runtime/src/tui/components/PromptInput/PromptInputFooterSuggestions.tsx:351–355` — folding `isSelected`
  into the React `key` unmounts/remounts the selected+previous rows on every arrow keypress, defeating the `memo`.
  **Fix:** keep `key` = `item.id`; pass `isSelected` as a prop.
  **DONE:** extracted exported `suggestionRowKey(item, isSelected)` that keys by `item.id` only (isSelected already
  flows to `SuggestionItemRow` as a prop). Revert-sensitive test (suggestion-row-key.test.ts): the key is invariant
  to `isSelected` vs the folded key that changes with selection.
- [~] `[?]` `runtime/src/tui/components/design-system/Ratchet.tsx:53` [SKIPPED: verified INTENTIONAL, not a bug.
  The Ratchet establishes a min-height that only grows; it must `measureElement` on every commit to catch content
  growth that happens while `rows` is unchanged — a dep array (e.g. `[rows]`) would MISS that growth and break the
  ratchet. The work is guarded (`setMinHeight` fires only on `height > maxHeight`, which ratchets up to `rows` then
  stops), so there is no re-render loop and no behavior-preserving optimization. Leaving as-is.] —
  `useLayoutEffect` with no dep array runs `measureElement` every commit; likely intentional (min-height ratchet),
  flagged as a perf observation.
- [x] `[V]` `runtime/src/tui/components/v2/ContextUsageModal.tsx:187–189` — `compactionThreshold / hardLimit` →
  `auto-compact at Infinity%` when `hardLimit` parses to 0 (regex accepts `0`); plus a hardcoded `92` fallback.
  **Fix:** guard `hardLimit > 0`. *(Same file as M-TUI-3.)*
- [x] `[V]` `runtime/src/tui/components/markdown/MarkdownTable.tsx:347` & `.../diff/StructuredDiff/Fallback.tsx:362`
  — `Math.max(...arr)` spreads each element as a call arg; a ~100k-line table/diff overflows the arg-count limit
  → `RangeError`, crashing the render. **Fix:** use a reduce-based max. *(MarkdownTable also :132/:236/:322.)*
  **DONE:** added `utils/maxOf.ts` (reduce-based, seed-aware) and replaced all four spread sites (MarkdownTable
  :132/:236/:347, Fallback :362 — the two-arg `Math.max(x, 0)` at Fallback :363 is not a spread, left as-is).
  Revert-sensitive test (maxOf.test.ts): `Math.max(...200_000)` throws `RangeError`; `maxOf` returns the max.
  Confirmed empirically that 200k-element spread throws.
- [x] `[V]` `runtime/src/tui/components/teams/TeamsDialog.tsx:116–125` — an unconditional 1s `useInterval` bumps a
  key that forces `getTeammateStatuses` (filesystem discovery) once per second while the dialog is open.
  **Fix:** poll less often or watch the dir.
  **DONE (poll less often):** extracted `TEAMMATE_STATUS_POLL_INTERVAL_MS = 3000` and use it for the refresh
  interval — 3× less fs discovery, and teammate mode changes are human-driven so a few seconds of latency is fine.
  Regression-guard test (teams-dialog-poll-interval.test.ts) asserts the interval stays ≥ 3000 (revert to 1000 →
  RED). Did NOT switch to fs.watch (more responsive but platform-dependent); noted as an option.
- [~] `[V]` `runtime/src/tui/components/CoordinatorAgentStatus.tsx:84 [SKIPPED: NOT safe to remove — has TEST callers (CoordinatorAgentStatus.render.test.tsx, .runtime-coverage, swarm-117 render the component). Production-dead but test-covered; removing it requires also removing/updating those coverage tests. Recommend a dedicated dead-code+test pass]–158` — `CoordinatorTaskPanel` (a ~75-line
  component with a 1s `setInterval` eviction effect) has zero renderers; dead code (the workbench uses
  `AgentsRail`). **Fix:** delete the component (keep the still-used sibling helpers).
- [~] `[V]` `runtime/src/tui/components/memory/MemoryUpdateNotification.tsx:16` [SKIPPED: NOT safe to remove — has TEST callers (MemoryUpdateNotification.test.tsx, .runtime-coverage render it). Recommend removing component + its coverage tests together] — dead component, zero importers
  (only the sibling `getRelativeMemoryPath` is imported). **Fix:** delete.
- [x] `[V]` `runtime/src/tui/workbench/buffer/render.tsx:168–208` — `renderTerminalCellsToAnsi` rebuilds the
  highlight `Map` per row (O(rows×highlights) per Neovim redraw). **Fix:** build the map once in
  `terminalAnsiLines` and pass it down.
  **DONE:** `terminalAnsiLines` builds the `Map<id, highlight>` once and passes it to `renderTerminalCellsToAnsi`
  (signature changed from the `highlights` array to a `ReadonlyMap`; sole caller). Behavior-preserving. Revert-
  sensitive test (render-highlight-map.test.tsx): a 6-row snapshot builds the map once (`highlights.map` spy = 1)
  vs 6× when reverted to per-row.
- [x] `[V]` `runtime/src/tui/workbench/surfaces/ShellSurface.tsx:39–43` — unconditionally blanks the tail on any
  `status` change (running→completed flickers output blank for one cycle); the sibling `AgentSurface` guards this.
  **DONE:** extracted exported `nextShellTailState(current, taskId)` = `current.taskId === taskId ? current :
  { taskId, content: "" }` (the same guard AgentSurface already uses), and the effect calls it via a functional
  setState. A status-only change (same taskId) now preserves the tail instead of blanking it. Revert-sensitive
  test (shell-surface-tail-guard.test.ts): same-task returns the current state unchanged vs blanked.
  **Fix:** match the guarded pattern.
- [x] `[V]` `runtime/src/tui/workbench/project-tree/ProjectTreeStore.ts:5` (unused `visibleTreePaths`),
  `agents/AgentsRail.tsx:147–149` (unused `isActiveTaskStatus`), `surfaces/SearchSurface.tsx:98` (a `rows`
  `useMemo` computed and discarded). Dead declarations. **Fix:** remove.
  **DONE:** removed the unused `visibleTreePaths` import from ProjectTreeStore.ts AND its now-orphaned export in
  buildTree.ts (grep of src/tests/packages/scripts confirmed zero other callers); removed the dead
  `isActiveTaskStatus` function; removed the discarded `rows` useMemo in SearchSurface (kept `groups`, still used
  by groupStep). Behavior-preserving; typecheck confirms zero dangling references; project-tree/search-model/
  AgentsRail suites green.

### Ink engine

- [x] `[V]` `packages/agenc-sdk/src/subprocess.ts:253–257` — abort listener added `{once:true}` but never removed
  on normal completion; a reused long-lived `AbortSignal` accumulates listeners. **Fix:** removeEventListener in
  `finishOk`/`finishError`. *(Same file also: unbounded `buffered` array at :136 — cap at 1000 like `client.ts`.)*
  **DONE:** `removeAbortListener` recorded on registration and invoked from `runCleanup()` in both finish paths;
  `buffered` capped at `MAX_BUFFERED_PROMPT_EVENTS = 1_000` (mirrors client.ts). Fixed together with M-TUI-8.

### utils

- [~] `[V]` `runtime/src/utils/toolResultStorage.ts:836` [SKIPPED: the "~450 LOC dead engine" claim is largely
  REFUTED by a whole-repo grep, and the safe subset needs surgical helper-tracing that risks the live tool-result
  path. Evidence: `utils/toolResultStorage.ts` has ~10 live importers; the audit's own named-as-dead symbols
  `reconstructForSubagentResume` (imported by tools/AgentTool/resumeAgent.ts) and the `ContentReplacementState`
  type (tools/Tool.ts, tools/AgentTool/runAgent.ts) are LIVE, and many helpers (createContentReplacementState,
  cloneContentReplacementState, applyToolResultReplacementsToMessages, reconstructContentReplacementState) are used
  by that live path. Only the four budget functions (enforceToolResultBudget, applyToolResultBudget,
  getPerMessageBudgetLimit, provisionContentReplacementState) are genuinely superseded — production run-turn.ts
  imports `applyToolResultBudget` from `session/_deps/tool-result-storage.js`, and NONE of the four are imported
  from `utils/toolResultStorage` anywhere. Recommend a dedicated pass that removes ONLY those four + their
  exclusive helpers after tracing that they share no helper with the live exports; NOT the blanket ~450 LOC delete
  described here. Matches the "verify a file is actually obsolete before deleting" rule.] — the entire aggregate
  per-message tool-result budget
  engine (`enforceToolResultBudget`, `applyToolResultBudget`, `provisionContentReplacementState` (hard-disabled
  `const enabled=false`), `getPerMessageBudgetLimit` (dead GrowthBook branch) + ~15 helpers, ~450 LOC) is dead —
  superseded by `session/_deps/tool-result-storage.ts`. This is the flagged dead "shed budget" follow-up (stale
  `shed ~…` string at :952). **Fix:** delete the dead engine; keep the still-live exports.
- [x] `[V]` `runtime/src/utils/toolResultStorage.ts:53` — `getPersistenceThreshold` (live) has a permanently-dead
  per-tool override lookup (`const overrides = {}` → `overrides?.[toolName]` always undefined). **Fix:** remove
  the dead branch.
- [x] `[V]` `runtime/src/utils/debug.ts:409` — `updateLatestDebugLogSymlink` is `memoize`d with no args so it runs
  once per process; after `/resume` switches the session id, writes go to the new `<id>.txt` but the `debug/latest`
  symlink still points at the pre-resume file, so `tail -f ~/.agenc/debug/latest` follows the wrong log.
  **Fix:** re-link on target mismatch / session switch; don't memoize.
- [x] `[V]` `runtime/src/utils/ripgrep.ts:567` — `countFilesRoundedRg` + private `ripGrepFileCount` (:326) have
  zero callers; if ever wired, `memoize` would cache a transient-timeout `undefined` permanently. **Fix:** remove,
  or don't memoize failure/undefined.
- [~] `[V]` `runtime/src/utils/memoize.ts:40` [SKIPPED: keep — the recommended fix for sandbox-runtime.ts:451 (checkDependencies TTL) gives memoizeWithTTL a live caller, so it is not dead once that is wired] — `memoizeWithTTL` (sync) has no callers (only the async/LRU variants
  are used). **Fix:** delete or document as external API.
- [x] `[V]` `runtime/src/utils/model/model.ts:500` — `firstPartyNameToCanonical` canonicalizes by ordered
  `.includes()`, so a future `claude-opus-4-10`/`-4-11` collapses to `claude-opus-4-1` (wrong tier/caps);
  `getModelPricingTier` (:939) has the same collision. **Fix:** match on a delimited boundary.
- [x] `[V]` `runtime/src/utils/swarm/teamHelpers.ts:208` — `readTeamFile*` returns `jsonParse(content) as TeamFile`
  with no shape validation; a config.json lacking a `members` array (version skew / non-atomic partial write)
  makes `teamFile.members.filter(...)` throw — during SIGINT/SIGTERM cleanup this skips worktree/dir cleanup.
  **Fix:** validate `Array.isArray(teamFile.members)` after read.
- [x] `[V]` `runtime/src/utils/thinking.ts:216` — `modelSupportsAdaptiveThinking` allowlist omits
  `claude-opus-4-8`, so pinning opus-4-8 silently disables adaptive thinking vs 4.7. (Known WS-F1 family.)
  **Fix:** add opus-4-8, or make the gate version-threshold-based like `modelSupports1M`.
- [~] `[V]` `runtime/src/utils/model/model.ts:250` — MiniMax drift [SKIPPED: which MiniMax id is the true flagship (M2.5 vs M2.7) is a factual model-string decision; recommend aligning getDefaultOpusModel default to configs.ts]: `getDefaultOpusModel()` resolves the flagship
  to `MiniMax-M2.7` but `configs.ts` sets `minimax: 'MiniMax-M2.5'`; the two paths disagree on which model is
  requested. **Fix:** one flagship id, used consistently.
- [x] `[V]` `runtime/src/utils/model/model.ts:808` — `parseUserSpecifiedModel` `case 'best'` returns
  `getBestModel()` without re-appending `[1m]`, so `best[1m]` silently drops the 1M window. **Fix:** append the
  `[1m]` suffix like the sibling cases.

### Tools / exec

- [~] `[V]` `runtime/src/tools/system/bash.ts:1308` [SKIPPED: not reproducible in local Node 25 — a maxBuffer-exceeded execFile error does NOT set error.killed here, so isTimeout already returns false; the audit's premise is Node-version-specific. Defensive guard (exclude ERR_CHILD_PROCESS_STDIO_MAXBUFFER from isTimeout) recommended for older Node] — direct-mode `isTimeout = error.killed || code==='ETIMEDOUT'`
  also fires when the child is killed for exceeding `maxBuffer` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), so an
  output-overflow is misreported to the model as a timeout. **Fix:** distinguish the maxBuffer case.
- [x] `[V]` `runtime/src/tasks/LocalShellTask/LocalShellTask.tsx:224` (also :333, :431) — background completion
  handlers attach `void shellCommand.result.then(async …)` with no `.catch`; a throwing completion callback
  (updateTaskState/enqueueShellNotification in a torn-down state) becomes an unhandled rejection that can crash all
  sessions. **Fix:** add `.catch(logError)` to each.
  **DONE:** appended `.catch(logError)` to all three floated completion promises. Revert-sensitive test
  (LocalShellTask-completion-catch.test.ts): mocks `updateTaskState` to throw in the completion callback; with the
  catch the error goes to `logError`, without it vitest catches an unhandled rejection.
- [x] `[V]` `runtime/src/tools/BashTool/shouldUseSandbox.ts:22–53` — `containsExcludedCommand` has a hardcoded
  empty `raw = { commands: [], substrings: [] }` so the `substrings`/`commands` loops can never match (comment
  claims it reads dynamic config); refactoring leftover on the non-security excluded-commands path. **Fix:** wire
  the intended source or delete the dead block.
  **DONE:** deleted the dead scaffold (the hardcoded-empty object + both loops over its always-empty lists). Chose
  DELETE over WIRE deliberately: `containsExcludedCommand === true` takes a command OUT of the sandbox, so wiring a
  new exclusion source would EXCLUDE MORE commands from the sandbox = weaker (guardrail: security never weaker).
  Behavior-preserving (the loops never matched); the live `settings.sandbox.excludedCommands` path is unchanged.
  Not a revert-sensitive bug (no behavior change); characterization test (shouldUseSandbox-excluded.test.ts) pins
  the surviving live path.

### Services

- [~] `[V]` `runtime/src/services/lsp/LSPDiagnosticRegistry.ts:179` [SKIPPED: needs a design decision — whether the drain-and-delete should be keyed by session or by file/workspace, plus sessionId threaded through registerPendingLSPDiagnostic (passiveFeedback) + 2 checkForLSPDiagnostics sites where availability is unconfirmed; recommend per-session delivered-tracking] — `pendingDiagnostics`/`deliveredDiagnostics`
  are module-level singletons; `checkForLSPDiagnostics()` takes no session arg and drains ALL pending diagnostics
  globally, so with two active sessions the first to assemble attachments consumes the other's diagnostics.
  **Fix:** key pending/delivered by session (or scope the drain to the requesting session's workspace).
- [x] `[V]` `runtime/src/services/MagicDocs/magicDocs.ts:430` — `updateQueue` is one module-level promise chain
  shared across all sessions, so session B's magic-docs update can't start until session A's (a full background
  subagent) finishes. **Fix:** per-session queue keyed like `trackedMagicDocsByScope`.
  **DONE:** replaced the global `updateQueue` with `updateQueueByScope: Map<scopeId, Promise>` keyed by
  `scopeIdForContext(context)`; the tail entry is deleted once it settles (bounded to in-flight scopes).
  Revert-sensitive test (magicDocs-queue-isolation.test.ts): a blocked session A no longer stalls session B.
- [x] `[V]` `runtime/src/services/api/cacheStatsTracker.ts:76` — process-global tracker keyed by nothing; a
  session's `resetCurrentTurn()`/`/clear` wipes another session's in-flight aggregate, and the provider is derived
  from `process.env.OPENAI_BASE_URL` (which M-LLM-4 shows can belong to another session). Observability only.
  **Fix:** key by sessionId; pass the resolved base URL from request context.
  **DONE (primary):** state is now a bounded LRU `Map<sessionId, TrackerState>` via `currentState()` keyed on
  `getSessionId()`; public API unchanged, cap 128 sessions with LRU-on-access eviction. Revert-sensitive
  two-session test in cacheStatsTracker.test.ts. The base-URL/provider sub-part stays with M-LLM-4 (skipped:
  threading `process.env.OPENAI_BASE_URL` off the request context is the same risky hot-path env change).
- [x] `[V]` `runtime/src/services/api/openaiShim.ts:2242–2254` — GitHub/Copilot 429 retry sleeps a fixed
  exponential ignoring the server's `Retry-After` (only used to decorate the final error). **Fix:** parse
  `retry-after` and use `max(header, backoff)`.
  **DONE:** extracted exported `computeGithub429WaitMs(attempt, retryAfterHeader, nowMs?)` = `max(Retry-After,
  backoff)` capped at `GITHUB_429_RETRY_AFTER_CAP_MS = 60_000`; `parseRetryAfterMs` handles delta-seconds and
  HTTP-date. Revert-sensitive test (openaiShim-github429-retry-after.test.ts).
- [x] `[V]` `runtime/src/services/api/openaiShim.ts:2433–2450` — `_convertNonStreamingResponse` dereferences
  `tc.function.name`/`.arguments` without a shape check; a malformed provider response (`tool_calls:[{id:"x"}]`)
  throws a bare `TypeError` bypassing `classifyOpenAiHttpFailure`. **Fix:** skip entries where `tc.function?.name`
  isn't a string.
- [x] `[V]` `runtime/src/services/api/promptCacheBreakDetection.ts:287–292` — FIFO eviction at capacity (10)
  deletes the oldest-inserted key, typically `repl_main_thread`; ten subagent spawns destroy the main thread's
  cache-break baseline. **Fix:** LRU eviction or pin non-agent keys.
- [~] `[V]` `runtime/src/services/api/sessionIngress.ts:20 [SKIPPED: an LRU cap is unsafe — sequentialAppendBySession holds a per-session append-ordering closure whose eviction mid-flight would break ordering. Correct fix is wiring clearSession into the session-teardown path (same design dependency as M-FILE-1). Recommend a shared session-close cleanup hook]–28,249–257` — `lastUuidMap`/`sequentialAppendBySession`
  accumulate one entry per remotely-persisted session; `clearSession`/`clearAllSessions` here have zero callers.
  Slow unbounded growth. **Fix:** call `clearSession` from session teardown or make the maps LRU.

### Daemon

- [~] `[V]` `runtime/src/app-server/client-multiplexer.ts:480` — see **M-DAEMON-3** [SKIPPED: mis-diagnosis] (empty routes leak on
  disconnect); verifier rated it minor.

### MCP / gateway / agents

- [~] `[V]` `runtime/src/mcp-client/resilient-client.ts:174` [SKIPPED: no contained fix reaches the model, and the
  complete fix crosses the guardrail (risky shared MCP catalog surface, >5 files). Evidence: `manager.getTools()`
  (manager.ts:391) SNAPSHOTS `bridge.tools` (`push(...bridge.tools)`) and the model's tool registry consumes that
  snapshot, so mutating `this.tools` in place on reconnect does NOT surface added/removed/changed tools to the
  model — the registry must re-poll. Execution already re-resolves the inner tool by name at call time (:212), so
  only the ADVERTISED schema is stale. A real fix = add a tool-list-changed event to ResilientMCPBridge, wire the
  manager to re-run catalog assembly (re-applying catalog policy / SHA pin / approval modes — security-sensitive),
  and refresh the model tool registry. Recommend: bridge emits `onToolsChanged`; manager re-registers on it.] —
  the model-facing `tools` proxy array is built once
  in the ctor and never rebuilt on reconnect (`this.inner` swapped at :314 but not `this.tools`). A server that
  restarts with a changed catalog hides added tools, 404s removed ones, and presents stale schemas for changed
  ones (silent argument mismatch). **Fix:** reconcile the proxy array with `newBridge.tools` on reconnect (mutate
  in place / surface a tool-list-changed hook).
- [x] `[V]` `runtime/src/skills/mcpSkills.ts:223` — `fetchMcpSkillsForClient` is `memoizeWithLRU` keyed only on
  server name, so two sessions each configuring a same-named MCP server (e.g. both "github") pointing at different
  servers collide while both live. **Fix:** key by name + config hash / connection identity, or scope per session.
- [x] `[V]` `runtime/src/gateway/slack-channel.ts:381` — `#editTargets` (Map) grows without bound: every non-edit
  `send()` inserts a `<id>-out-<n>` handle and nothing deletes; identical in discord-channel.ts:465 and
  telegram-channel.ts:779. Unbounded leak on a busy channel. **Fix:** LRU/ring cap or evict on turn completion.
- [x] `[V]` `runtime/src/memory/agencmd.ts:808` — `getMemoryFiles` is `memoize`d with the default resolver so its
  key is only the `forceIncludeExternal` boolean, never the workspace cwd; combined with module-global hook flags
  the first session's memory files are returned to every other session. Part of the known daemon workspace-pinning
  family. **Fix:** key the memoize on the effective workspace cwd (when the memory subsystem is session-scoped).
  **DONE:** added a memoize resolver keying on `JSON.stringify([getProjectRoot(), getOriginalCwd(), forceIncludeExternal])`.
  `.cache.clear()` still works (lodash keeps `.cache` a Map). Revert-sensitive two-session test in memdir.test.ts.

### Secrets

- [x] `[V]` `runtime/src/secrets/sanitizer.ts:284–287` — the generic `sk-(?:proj-)?[A-Za-z0-9_-]{20,}` pattern
  runs first and always consumes `sk-ant-…` keys, so the dedicated sk-ant entry never matches (dead). Also
  `runtime/src/transaction-guard/errors.ts:4–14` `TransactionGuardError` is exported but never constructed/thrown
  in production. **Fix:** delete the sk-ant entry (or reorder first); drop `TransactionGuardError` or wire a throw.
- [~] `[V]` `runtime/src/secrets/sanitizer.ts:343 [SKIPPED: risky security-regex surgery (over-redaction risk) for a minor multi-word-value edge; single-token secrets already redact fully; recommend extending the quoted-value capture to the closing quote and unquoted to end-of-line, with careful over-redaction test coverage]–357` — the assignment-pattern value class `[^\s"',}]{8,}` leaves
  tails of whitespace-containing secrets and whole short/punctuated secrets unredacted (`password: abcdefgh
  ijklmnopq` redacts only the first token). **Fix:** for quoted values consume to the closing quote; for unquoted,
  consider to end-of-line after a sensitive key.

### Sandbox

- [~] `[V]` `runtime/src/sandbox/engine/bwrap.ts:32` [SKIPPED: wiring needs a semantic decision I shouldn't guess.
  `systemBwrapWarning(permissionProfile, platform)` gates on `shouldWarnAboutSystemBwrap(profile)` (whether the
  profile requires a platform sandbox), but the doctor (`doctorDiagnostic.ts`) resolves NO PermissionProfile and
  there is no `getPermissionProfile()` accessor; `systemBwrapWarningForPath` (the profile-free variant) is not
  exported. Substituting `SandboxManager.isSandboxingEnabled()` (already imported in the doctor) as the gate is
  coarser than the profile check and unverified as equivalent. Recommend: export `systemBwrapWarningForPath`, add a
  pure `buildSystemBwrapWarning({ sandboxingEnabled, systemBwrapPath, platform })` mirroring `buildRipgrepWarning`,
  push it into `getDoctorDiagnostic().warnings`, after confirming the correct gate.] — `systemBwrapWarning()`
  (missing-bwrap / no-userns / WSL1
  warnings) has zero callers, so those conditions are computed nowhere the user sees. **Fix:** surface from the
  doctor/diagnostic path.
- [~] `[V]` `runtime/src/utils/sandbox/sandbox-runtime.ts:451` [SKIPPED: fix is memoize -> a TTL cache so a transient probe failure self-heals; the ideal is to reuse the (otherwise-dead) memoizeWithTTL here, resolving both items. TTL-heal not cheaply revert-sensitive-testable (wraps a static BaseSandboxManager.checkDependencies, needs fake timers + static mock). Recommend memoizeWithTTL(check, 30s)] — `checkDependencies = memoize(...)` caches on the
  single `undefined` key for the process lifetime, so one transient probe failure at startup latches
  "sandbox disabled" for all subsequent sessions until `reset()`. **Fix:** add a short TTL / re-evaluate on
  settings refresh.

### Bash / shell parsing

- [x] `[V]` `runtime/src/utils/bash/shellPrefix.ts:20–24` — `formatShellPrefixCommand` splits at
  `lastIndexOf(' -')`, so a multi-flag `AGENC_SHELL_PREFIX="wsl -e bash -c"` mis-splits into a non-executable
  quoted word. Trusted config, so correctness not security. **Fix:** tokenize the prefix into exec + args.
- [x] `[V]` `runtime/src/utils/bash/commands.ts:798–817` — an empty redirect target (`>` with `""`) is neither
  captured/validated nor flagged dangerous, violating the module's stated "captured-or-flagged" invariant
  (currently not exploitable). **Fix:** make `hasDangerousExpansion('')` return true.
- [~] `[-]` `runtime/src/utils/bash/ParsedCommand.ts:297–317` [REFUTED by verifier — NOT a bug; left per the
  "refuted [-] items are not bugs" guardrail] — `lastCmd`/`lastResult` is a process-global
  single-entry cache shared across sessions, but verified SAFE (pure function of the command string; only cache
  thrash). No fix required; noted for awareness.

### Uncertain

- [x] `[x]` `runtime/src/utils/execFileNoThrow.ts:289` — on timeout it calls `child.kill()` (SIGTERM only) with no
  SIGKILL escalation, so a SIGTERM-ignoring or IO-stuck git/gh/npm child never emits `close` and the promise hangs
  forever past the timeout (ripgrep.ts escalates to SIGKILL; this shared wrapper doesn't). **Fix:** arm a secondary
  timer to `child.kill('SIGKILL')`, mirroring ripgrep.ts.

---

## Dead code / dependencies (knip `--production`; `npm run check:unused` currently EXITS 1 — not enforced in CI)

- [x] Unused dependency: `vscode-languageserver-types` (`runtime/package.json:146`) — zero references in
  `runtime/src` and `runtime/tests`. **Fix:** remove.
- [x] Production-dead files: `runtime/src/gateway/index.ts`, `runtime/src/gateway/test-channel.ts`,
  `runtime/src/heartbeat/index.ts` (barrels + a test channel referenced only from tests). **Fix:** move under
  `tests/` or delete.
  **DONE:** deleted the two barrels (`gateway/index.ts`, `heartbeat/index.ts`) — grep confirmed ZERO importers of
  either (nothing does `from ".../gateway"` or `.../heartbeat`; the only matches were `join(agencHome,"gateway")`
  path literals), and neither is a package entrypoint; typecheck + gateway/heartbeat suites (252 tests) green.
  `test-channel.ts` (`InMemoryChannelAdapter`) is NOT deleted — it is imported directly by 7 test files; moving it
  under `tests/` would rewrite those 7 imports (a >5-file refactor, STOP-and-ask), so it stays in place as a
  test-only helper. Deleting the barrel that re-exported it did not affect those direct imports.
- [x] Duplicate export `remoteCommand | default` in `runtime/src/commands/remote.tsx` (harmless).
- [x] Unlisted binary `tar` spawned by `runtime/src/bin/update-cli.ts:410` (system `tar` assumed; ENOENT throws
  with an unclear "status null" message).
  **DONE:** extracted `assertTarExtractionSucceeded(res)` — checks `res.error` first and reports "tar not found on
  PATH — install tar …" for ENOENT (and "failed to run tar: …" for other spawn errors) before the status check.
  Revert-sensitive test (update-cli-tar.test.ts) proves the clear message vs the old "status null" text.
- [~] 154 total unused exports reported by knip [SKIPPED: this is a triage/process meta-task, not a single fix,
  and the item itself says "triage before deleting; many are test-only or public-API surface." Blanket-deleting
  154 exports risks breaking the SDK/public surface and test-only helpers, and the referenced `scratchpad/knip.txt`
  is from a prior session (not present now, and would be stale). The obvious dead exports flagged by their own
  audit items were already removed this branch (visibleTreePaths, isActiveTaskStatus, gateway/heartbeat barrels).
  Recommend a dedicated pass: re-run knip, categorize each export (truly-dead → delete with a per-symbol
  whole-repo grep; test-only → keep or move under tests/; SDK/public-API → keep and annotate why), then wire
  `check:unused` into CI with an allowlist for the intentional exports.] — full list was `scratchpad/knip.txt`;
  many are test-only or public-API surface. Consider wiring `check:unused` into CI once triaged.

---

## Known-open items (tracked elsewhere) — status this pass

- **opus-4-8 half-onboarded (TODO.md WS-F1):** still true — see the utils/model minors and `utils/thinking.ts:216`.
- **`/compact` + rewind flat 30s RPC timeout, daemon.log rotation cap, client-env override forwarding:** in the
  daemon reviewer's scope but did not surface as new confirmed findings this pass — re-check with a targeted probe
  if still suspected.

## Refuted by the verification pass (NOT bugs — recorded so they aren't re-investigated)

- `[-]` `runtime/src/utils/forkedAgent.ts:419` — conflates two distinct `ContentReplacementState` types sharing a
  name; no actual bug.
- `[-]` `runtime/src/tools/system/filesystem.ts:484` — the `workspaceReadState` process-global scope reproduces
  mechanically but is intended and causes no cross-session harm at that site (distinct from the real leak in
  M-FILE-1).
- `[-]` `runtime/src/budget/ledger.ts:175` — each `BudgetLedger` is per-consumer by design; the claimed
  multi-instance cap-overshoot does not occur.

---

## Coverage

Read deeply across: `tui` (top-level + hooks/state/context/realtime/input/history/startup/slash, components,
workbench, and the vendored `ink` engine), `utils` (top-level + permissions/plugins/model/swarm/settings/hooks/
secureStorage/suggestions/bash/shell), `tools` (exec + file/data halves), `llm` (adapters, streaming parsers,
retry), `services` (incl. the `api` OpenAI shim), `app-server`/session/transport/lifecycle, `bin`/bootstrap/cli/
commands/config/onboarding, browser/pty/unified-exec/file-watcher/shell-command/elicitation/gateway,
`mcp`/mcp-client/mcp-server/plugins/hooks/skills/schemas, agents/coordinator/tasks/phases/conversation/memory,
permissions/auth/budget/cost, secrets/sandbox/transaction-guard, and `packages/agenc-sdk`. Verified by executing
code: secrets sanitizer, transaction-guard bypass, TOML prototype pollution, Opus cost, and several others noted
`[x]` above.
