# AgenC Inventory

Every file AgenC takes from `/home/tetsuo/git/AgenC/src/`. TypeScript
→ TypeScript direct port; file paths kebab-cased on arrival; content is
1:1 unless noted.

These files are behavior/reference sources, not final runtime owners. Where
AgenC historically owned the live loop or subagent path, AgenC keeps only
the selected behavior while final ownership moves to the AgenC implementationed
`session/*`, `agents/control.ts`, and `agents/mailbox.ts` runtime boundary.

**Totals:** ~30 files directly ported, ~13,000 LOC before trim.

---

## 1. Query kernel (Tranche 4b)

**Source:** `AgenC/src/query.ts` (1,838 LOC — single while-true loop, lines 244–1838)

The loop drives 6 distinct phases with 8 continue sites short-circuiting
back to the top. Do not copy the monolith; explode into one file per
phase. Below is the exact phase map from the inventory agent.

| # | Phase | Lines | Inputs | Mutates | Next |
|---|---|---|---|---|---|
| 1 | Context Prep | 311–652 | state, messages | `messagesForQuery`, trackers | → Streaming |
| 2 | API Streaming | 685–1028 | messagesForQuery, system prompt, tools | `assistantMessages[]`, `toolUseBlocks[]`, tool-result queue | → No-tools check |
| 3 | Error Recovery | 1093–1216 | last message, `assistantMessages[]` | post-compact/post-reactive messages OR yielded error | → No-tools exit |
| 4 | Continuation Nudge | 1400–1463 | `assistantMessages[]`, model text | nudge → messages | → No-tools exit |
| 5 | Tool Execution | 1471–1590 | `toolUseBlocks[]` | `toolResults[]`, updated context | → Attachments |
| 6 | Attachment + Recurse | 1643–1836 | tool results, memory, skills | assembled messages, `turnCount++` | Back to Phase 1 |

**8 continue sites (all re-enter Phase 1):**

| Line | Reason |
|---|---|
| 981 | `model_fallback` |
| 1147 | `collapse_drain_retry` |
| 1198 | `reactive_compact_retry` |
| 1254 | `max_output_tokens_escalate` |
| 1286 | `max_output_tokens_recovery` |
| 1341 | `stop_hook_blocking` |
| 1377 | `token_budget_continuation` |
| 1460 | `continuation_nudge` |

**Loop state (22 variables) — top-level destructured at line 315. See `architecture.md` for the full state shape.**

**AgenC destination:**

```
runtime/src/phases/prepare-context.ts      # phase 1
runtime/src/phases/stream-model.ts         # phase 2
runtime/src/phases/post-sample-recovery.ts # phase 3
runtime/src/phases/continuation-nudge.ts   # phase 4
runtime/src/phases/execute-tools.ts        # phase 5
runtime/src/phases/commit.ts               # phase 6
runtime/src/phases/index.ts                # transition table
runtime/src/session/turn-state.ts          # the 22 loop variables
runtime/src/session/run-turn.ts            # top-level while(true) + continue dispatch
```

Ownership note: `query.ts` does not survive as a runtime owner. Its retained
phase behavior runs under the AgenC runtime-owned `session/run-turn.ts` path.

---

## 2. Recovery paths (Tranche 7)

**Source:** `AgenC/src/query.ts:685-900, 1093-1341` + recovery helpers

**7 strategies with cascading ladder:**

| Strategy | Trigger | Action | Fallback | Lines |
|---|---|---|---|---|
| Tombstone orphans | `streamingFallbackOccured=true` | Yield TombstoneMessage, clear arrays, fresh executor | Continue with fallback model | 747–774 |
| Collapse drain | `isWithheld413 && !collapse_drain_retry` | `contextCollapse.recoverFromOverflow()`, re-enter | Reactive compact | 1116–1149 |
| Reactive compact | `(isWithheld413 \|\| isWithheldMedia) && !attempted` | `reactiveCompact.tryReactiveCompact()`, re-enter | Surface error + stop hooks | 1151–1215 |
| Max-tokens escalate | `isWithheldMaxOutputTokens && cap=default` | Override to 64k, re-enter | Continuation nudge | 1221–1255 |
| Max-tokens continuation | `recoveryCount < limit` | Inject "resume" meta message, re-enter | Surface error | 1257–1291 |
| Stop hook blocking | `blockingErrors.length > 0` | Inject blocking errors, `stopHookActive=true`, preserve `hasAttemptedReactiveCompact` | Fall through | 1313–1341 |
| Model fallback | `FallbackTriggeredError` | Yield missing tool_results, clear arrays, swap model | Re-throw | 928–981 |

**Critical subtleties (port these verbatim — they encode real prod bugs):**

1. **Withheld cascading** (834–857): collapse and reactive compact each withhold errors independently; two gates both must pass before stream yield.
2. **`hasAttemptedReactiveCompact` persistence** (1189, 1332): reset on token-budget continuation but **preserved** on stop hook blocking — "Resetting caused infinite loop."
3. **Stop hooks on API errors** (1297–1299): guarded on `lastMessage?.isApiErrorMessage` or recovery dies spiralling.
4. **Tool executor ring flush** (768, 947): both streaming-fallback AND model-fallback must `.discard()` + recreate or orphan `tool_use_id`s leak.
5. **taskBudgetRemaining carryover** (1170–1177): captured pre-compact, loop-local; easy to drop through state transitions.
6. **Collapse drain one-shot guard** (1123): `state.transition?.reason !== 'collapse_drain_retry'` or spirals.

**Dependencies (must port together):**

- `AgenC/src/services/compact/reactiveCompact.js` — `isWithheldPromptTooLong()`, `isWithheldMediaSizeError()`, `tryReactiveCompact()`
- `AgenC/src/services/contextCollapse/index.js` — `recoverFromOverflow()`
- `AgenC/src/services/api/errors.js` — `isPromptTooLongMessage()`, `PROMPT_TOO_LONG_ERROR_MESSAGE`
- `AgenC/src/services/api/withRetry.js` — `FallbackTriggeredError`
- `AgenC/src/utils/messages.js` — `buildPostCompactMessages()`, `createSystemMessage()`, `createUserMessage({isMeta})`

**AgenC destination:** `runtime/src/phases/post-sample-recovery.ts` + `runtime/src/recovery/{tombstone,terminal-tool-result,fallback-ladder,reconnection}.ts`

---

## 3. Compaction chain (Tranche 4)

**Source:** `AgenC/src/services/compact/` — 15 files, 4,171 LOC

Delete AgenC's dead `runtime/src/llm/compact/` (12 files, 1,690 LOC, zero external call sites) and port AgenC wholesale.

| File | LOC | Purpose | Exports |
|---|---|---|---|
| `compact.ts` | 1,712 | Core compaction: prompt-too-long retry, image stripping, post-compact rehydration | `compactConversation`, `partialCompactConversation`, `stripImagesFromMessages`, `truncateHeadForPTLRetry`, `createPostCompactFileAttachments`, `createPlanAttachmentIfNeeded`, `createSkillAttachmentIfNeeded`, `buildPostCompactMessages` |
| `autoCompact.ts` | 361 | Thresholding, session-memory-first, circuit breaker | `autoCompactIfNeeded`, `shouldAutoCompact`, `getAutoCompactThreshold`, `calculateTokenWarningState`, `getEffectiveContextWindowSize` |
| `microCompact.ts` | 536 | Selective tool-result clearing, time-based eviction | `compactMessages`, `microcompactMessages`, `resetMicrocompactState`, `estimateMessageTokens`, `suppressCompactWarning` |
| `sessionMemoryCompact.ts` | 630 | Prunes old messages, preserves context via session store | `trySessionMemoryCompaction`, `adjustIndexToPreserveAPIInvariants`, `calculateMessagesToKeepIndex` |
| `prompt.ts` | 374 | Compaction prompt templates (BASE, PARTIAL from/up_to); NO_TOOLS_PREAMBLE | `getCompactPrompt`, `getPartialCompactPrompt`, `formatCompactSummary`, `getCompactUserSummaryMessage` |
| `grouping.ts` | 63 | Group by API round-trips (via assistant msg id) for PTL retry | `groupMessagesByApiRound` |
| `postCompactCleanup.ts` | 77 | Reset micro state, memory cache, classifier approvals, prompt sections | `runPostCompactCleanup` |
| `apiMicrocompact.ts` | 153 | API-level context management (Anthropic `context_edits`) | `getAPIContextManagement` |
| `timeBasedMCConfig.ts` | 43 | Prompt-cache-TTL–triggered content clear | `getTimeBasedMCConfig` |
| `compactWarningState.ts` | 18 | Warning suppression store | `suppressCompactWarning`, `clearCompactWarningSuppression`, `compactWarningStore` |
| `compactWarningHook.ts` | 16 | React hook wrapper | `useCompactWarningSuppression` |
| `snipCompact.ts` | 4 | Stub | `snipCompact` |
| `cachedMicrocompact.ts` | 12 | Stub | `isCachedMicrocompactEnabled` |
| `autoCompact.test.ts` | 45 | Tests — port | — |
| `microCompact.test.ts` | 127 | Tests — port | — |

**Entry points the query loop calls:**

| Function | File | Called from |
|---|---|---|
| `autoCompactIfNeeded()` | autoCompact.ts | query loop (deps.ts), session resume |
| `compactConversation()` | compact.ts | autoCompactIfNeeded or manual `/compact` |
| `partialCompactConversation()` | compact.ts | message-selector UI |
| `trySessionMemoryCompaction()` | sessionMemoryCompact.ts | autoCompactIfNeeded (first) |
| `compactMessages()` | microCompact.ts | pre-flight before API call |

**Critical logic worth highlighting during port:**

- **Circuit breaker** (autoCompact:72–75, 267–275): `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`. Prevents 250K+ wasted API calls/day on irrecoverably-over-limit sessions.
- **Post-compact rehydration** (compact:519–587): clears `readFileState`, re-injects (a) recently-read files (5 max, 50K budget), (b) invoked skills (25K), (c) plan file, (d) async agent status, (e) deferred tool+MCP schemas.
- **Image stripping** (compact:136–203): replaces image/document blocks with `[image]` markers to prevent compaction itself from 413.
- **Prompt-too-long retry** (compact:230–293): drops oldest API-round groups via `groupMessagesByApiRound()` until gap covered; 3 retries.

**External dependencies to follow:**

```
src/bootstrap/state.ts         — markPostCompaction, getSdkBetas, getInvokedSkillsForAgent
src/utils/forkedAgent.ts       — runForkedAgent (cache-prefix sharing)
src/utils/hooks.ts             — executePreCompactHooks, executePostCompactHooks
src/services/api/claude.ts     — queryModelWithStreaming, getMaxOutputTokensForModel
src/services/api/errors.ts     — getPromptTooLongTokenGap
src/services/SessionMemory/    — memory extraction utilities
src/tools/FileReadTool/        — post-compact file restoration
src/utils/plans.ts             — plan file restoration
src/utils/messages.ts          — normalization + compact boundary markers
```

**AgenC destination:** `runtime/src/llm/compact/` (replace the existing dead chain; kebab-case rename on port).

---

## 4. Tool executor + orchestration (Tranche 6)

**Source:** `AgenC/src/services/tools/`

| File | LOC | Purpose | Exports |
|---|---|---|---|
| `StreamingToolExecutor.ts` | 530 | Callback-driven dispatcher; start tools mid-stream; sibling-abort on Bash errors; order-preserving yield | `class StreamingToolExecutor` |
| `toolOrchestration.ts` | 188 | Batch partitioner + `runToolsConcurrently` (legacy, env-capped at 10) / `runToolsSerially` | `runTools`, `MessageUpdate` |
| `toolExecution.ts` | 1,777 | Input validation (Zod), permission checks, pre/post hooks, error classification | `runToolUse`, `classifyToolError`, `MessageUpdateLazy` |
| `toolHooks.ts` | 716 | Pre/post tool hooks, auto-fix retry, MCP output modification | `runPostToolUseHooks`, `runPreToolUseHooks` |

**Lifecycle (exact line references — port these verbatim):**

1. Arrival (query.ts:876): `addTool(toolBlock, assistantMessage)` as model streams tool_use blocks.
2. Queue (StreamingToolExecutor:114–123): add with status `'queued'`, compute `isConcurrencySafe` via `toolDefinition.isConcurrencySafe(parsedInput.data)` at line 108.
3. Dispatch (processQueue:140–151): scan queue; if `canExecuteTool(isConcurrencySafe)` (line 144), run `executeTool(tool)` (line 145). Non-safe blocks queue (line 148).
4. Execute (executeTool:265–405): status `'executing'` (266), child AbortController (301), `runToolUse()` generator (320), stream into `messages[]` (376). Bash errors set `hasErrored=true` and fire `siblingAbortController.abort('sibling_error')` (362) cascading to siblings.
5. Result (getCompletedResults:412–440): yields pending progress (420), then in-order results (431). Status → `'yielded'` (429), removed from in-progress (435).
6. Back to query (query.ts:885–895): results wrapped in `normalizeMessagesForAPI()`, appended to `toolResults[]`.
7. Final drain (getRemainingResults:453–490): races executing promises + progressPromise (482) until all yielded.

**Concurrency partition (StreamingToolExecutor:129–135):**

```ts
if (executingTools.length === 0) return true
if (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe)) return true
return false
```

Non-safe tool blocks until all executing tools finish.

**Sibling abort is Bash-only** (line 359). Rationale: Bash is sequential (mkdir → cd → cmd), others are idempotent.

**Dependencies outside tools/:**

```
src/Tool.ts                    — findToolByName, Tools, ToolUseContext, ToolProgress
src/hooks/useCanUseTool.ts     — CanUseToolFn
src/tools/BashTool/            — BASH_TOOL_NAME, BashToolInput, startSpeculativeClassifierCheck
src/types/message.ts           — Message, AssistantMessage, ProgressMessage, ToolUseSummaryMessage
src/utils/generators.ts        — all() (concurrency-capped Promise.all)
src/utils/hooks.ts, permissions.ts, telemetry.ts
src/services/mcp/              — MCP client lookup + normalization
src/services/autoFix/          — auto-fix retry logic (in toolHooks.ts)
```

**AgenC destination:** `runtime/src/tools/streaming-executor.ts`, `orchestration.ts`, `execution.ts`, `hooks.ts`.

---

## 5. Transport stack (Tranche 8)

**Source:** `AgenC/src/cli/transports/` — 7 files, 3,242 LOC total

| File | LOC | Role | Take? |
|---|---|---|---|
| `WebSocketTransport.ts` | 800 | Duplex (WS↔WS). Exponential backoff 1s→30s ±25% jitter, 10min budget. 10s pings. | **Yes** (base) |
| `HybridTransport.ts` | 282 | Extends WS; WS reads + HTTP POST writes; 100ms batch window | **Yes** |
| `SerialBatchEventUploader.ts` | 275 | Batch uploader + backpressure; max queue 100K | **Yes** (dep of Hybrid) |
| `SSETransport.ts` | 711 | SSE reads + HTTP POST writes; Last-Event-ID resume; 45s frame liveness | Maybe |
| `WebSocketTransport.ts` ping logic | — | 10s pings, reconnect on missed pong | (embedded) |
| `transportUtils.ts` | 45 | Factory `getTransportForUrl()` — env-driven selection | **Yes** |
| `ccrClient.ts` | 998 | CCR v2 orchestrator (heartbeats, state sync) | **No** — domain-specific |
| `WorkerStateUploader.ts` | 131 | Coalescing RFC 7396 merge uploader | Maybe |

**Selection (transportUtils:16):**

```
if CLAUDE_CODE_USE_CCR_V2=1        → SSETransport
else if POST_FOR_SESSION_INGRESS=1 → HybridTransport
else                               → WebSocketTransport
```

**No runtime capability probe** — env-driven static choice. Matches AgenC TODO rule (do not probe; use env).

**Reconnection pattern (WS 465–555, SSE 470–535):**
- Exponential backoff with ±25% jitter, 10min budget
- 45s SSE liveness or 10s WS ping
- `refreshHeaders()` callback on 4003 (auth) lets parent mint fresh session token mid-recovery
- `>60s` gap between reconnects triggers budget reset (process was likely sleeping)

**Event model:**
- **Upstream:** newline-delimited JSON (NDJSON) → `onData(string)`; SSE wraps in `event: client_event` frames
- **Downstream:** `StdoutMessage` → JSON → NDJSON; Hybrid buffers `stream_event` for 100ms then POSTs batches

**Query-loop integration** (remoteIO.ts:88–189):
- `getTransportForUrl()` → instantiate based on env (88)
- `transport.setOnData()` → `inputStream.write()` (98)
- `transport.setOnClose()` → graceful shutdown (106)
- `transport.connect()` fires background, no await (172)
- Query loop calls `transport.write(message)` for control req/res (189)

**AgenC destination:** `runtime/src/transport/{index,ws-duplex,ws-post,sse-post,fallback-ladder,serial-batch-uploader}.ts`. Port ~1,400 LOC (WebSocket + Hybrid + SerialBatch + transportUtils) as core; SSE as optional second tranche.

---

## 6. Ink TUI core (Tranche 12)

**Source:** `AgenC/src/ink/` — 16 core files + components + layout engine, ~9,000 LOC

**STATUS:** PORTED (T12, locked) — destination `runtime/src/tui/ink/`. See the LOCKED modules subsection at the end of this doc.

### Core files (load-bearing — all must port)

| File | LOC | Role | Status |
|---|---|---|---|
| `ink.tsx` | 1,752 | React reconciler root; frame loop; stdin/stdout; alt-screen routing | PORTED (T12, locked) |
| `render-node-to-output.ts` | 1,495 | DOM → Screen buffer; Yoga layout driver; scroll drain | PORTED (T12, locked) |
| `log-update.ts` | 1,062 | Screen diff → ANSI patches; DECSTBM blit+shift; hyperlink escaping | PORTED (T12, locked) |
| `parse-keypress.ts` | 739 | stdin bytes → `ParsedKey` (name, ctrl, shift, meta, super, fn) | PORTED (T12, locked) |
| `output.ts` | 763 | ANSI escape builder; patch serializer | PORTED (T12, locked) |
| `dom.ts` | 538 | Virtual DOM; Yoga node attachment | PORTED (T12, locked) |
| `reconciler.ts` | 675 | React Reconciler (LegacyRoot); commit→layout→render pipeline | PORTED (T12, locked) |
| `selection.ts` | 917 | Text selection state, line-wrap aware, scrolled-off accumulator | PORTED (T12, locked) |
| `terminal.ts` | 275 | Capability detection (Kitty, xterm.js, iTerm2) | PORTED (T12, locked) |
| `frame.ts` | 124 | Frame + Patch + Diff types | PORTED (T12, locked) |
| `screen.ts` | ~700 | Cell grid (packed uint32), CJK width, StylePool, HyperlinkPool | PORTED (T12, locked) |
| `renderer.ts` | ~400 | `createRenderer()` — React → DOM → Yoga → Screen in one pass | PORTED (T12, locked) |
| `colorize.ts` | ~250 | ANSI 256/truecolor + style transition cache | PORTED (T12, locked) |
| `layout/yoga.ts` + `layout/engine.ts` | ~1,200 | Pure-TS Yoga flexbox | PORTED (T12, locked) |
| `events/` (6 files) | ~500 | KeyboardEvent, InputEvent, TerminalFocusEvent, ClickEvent, bubbling | PORTED (T12, locked) |

### Contexts

| File | LOC | Role | Status |
|---|---|---|---|
| `ClockContext.tsx` | 111 | Frame timer (FRAME_INTERVAL_MS); keepAlive idle tracking | PORTED (T12, locked) |
| `TerminalSizeContext.tsx` | 6 | cols/rows | PORTED (T12, locked) |
| `TerminalFocusContext.tsx` | 51 | Focus state + subscription | PORTED (T12, locked) |
| `StdinContext.ts` | 49 | stdin + raw mode + TTY check + event emitter | PORTED (T12, locked) |
| `AppContext.ts` | 21 | Exit callback | PORTED (T12, locked) |
| `CursorDeclarationContext.ts` | 32 | IME cursor position | PORTED (T12, locked) |

### Components

| File | LOC | Role | Take? | Status |
|---|---|---|---|---|
| `App.tsx` | 689 | Root PureComponent; AgenC extends with cockpit + composer tree | **Critical** | PORTED (T12) — AgenC root at `runtime/src/tui/App.tsx` composes 6 Ink contexts + `AgenCAppStateProvider` + `KeybindingProvider` + `OverlayProvider` |
| `Box.tsx` | 209 | Flex primitive with click/focus/key/mouse handlers | **High** | PORTED (T12, locked) |
| `ScrollBox.tsx` | 236 | Overflow scroll; `scrollTo/By/ToBottom`; sticky follow-to-bottom | **High** | PORTED (T12, locked) |
| `Text.tsx` | 253 | Styling: color, bold, italic, wrap/truncate | **High** | PORTED (T12, locked) |
| `Button.tsx` | 191 | Focused/hovered/active state; onAction | Medium | PORTED (T12, locked) |
| `AlternateScreen.tsx` | 79 | DEC 1049 alt-screen + SGR mouse | **High** | PORTED (T12, locked) |
| `RawAnsi.tsx` | 56 | Bypass React tree for pre-wrapped ANSI (syntax highlight, diffs) | Medium | PORTED (T12, locked) |
| `Link.tsx` | 41 | OSC 8 hyperlink | Low | PORTED (T12, locked) |
| `Spacer.tsx` | 19 | Flex spacer | Low | PORTED (T12, locked) |
| `Newline.tsx` | 38 | Inline newline repeater | Low | PORTED (T12, locked) |
| `NoSelect.tsx` | 67 | `user-select:none` blocker | Low | PORTED (T12, locked) |
| `ErrorOverview.tsx` | 27 | Error boundary UI | Low | PORTED (T12, locked) |

**Not in `ink/components/`:** composer, palette, file-mention, autocomplete. Those live in `AgenC/src/components/` (`PromptInput`, `BaseTextInput`, `CustomSelect`). AgenC builds its own in `runtime/src/tui/composer/`.

### NPM dependencies (add to runtime/package.json)

| Package | Why |
|---|---|
| `react` (19.x) | Fiber + hooks |
| `react-reconciler` (0.33.x) | LegacyRoot commit pipeline |
| `@alcalzone/ansi-tokenize` (0.3.x) | ANSI style transition detection |
| `cli-boxes` (3.x) | Border characters |
| `lodash-es` | throttle, noop |
| `auto-bind` | method binding |
| `signal-exit` | terminal restoration on exit |
| `indent-string` | wrap/indent helpers |

**AgenC destination:** `runtime/src/tui/ink/` (copy verbatim) + `runtime/src/tui/components/` (App, cockpit Banner, ArtPanel, Splash, MessageList, StreamingMessage, Composer, Palette).

---

## 7. Slash commands + /plan mode (Tranche 11)

**Source:** `AgenC/src/commands/*` (46+ commands) + `AgenC/src/utils/permissions/`

### Commands to port (first cut)

| Command | Type | File | Status |
|---|---|---|---|
| `/plan` | local-jsx | `commands/plan/plan.tsx` | **Core** |
| `/permissions` | local-jsx | `commands/permissions/index.js` | **Core** |
| `/model` | local-jsx | `commands/model/model.tsx` | **Core** |
| `/config` | local-jsx | `commands/config/index.js` | **Core** |
| `/help` | local-jsx | `commands/help/index.js` | **Core** |
| `/clear` | local | `commands/clear/index.js` | Simplified |
| `/context` | local-jsx | `commands/context/context.tsx` | Simplified |
| `/exit` | local-jsx | `commands/exit/exit.tsx` | **Core** |
| `/status` | local | `commands/status/index.js` | **Core** |
| `/keybindings` | local-jsx | `commands/keybindings/index.js` | Simplified |
| `/skills` | prompt | `commands/skills/index.js` | WIRED status surface + local skills/plugin loader |

### /plan mode architecture

**State** (not persisted — session-scoped):
- Lives in `AppState.toolPermissionContext.mode`
- Values: `default | acceptEdits | plan | bypassPermissions | auto | dontAsk`
- Getter: `context.getAppState().toolPermissionContext.mode`
- Setter: `context.setAppState(prev => ({ ...prev, toolPermissionContext: {...} }))`

**Tools blocked in plan mode:**
- Writes (Bash, PowerShell, file writes)
- External commands
- Only reads + exploration allowed

**EnterPlanModeTool / ExitPlanModeV2Tool:**
- Entry: checks `mode !== 'plan'`, transitions
- Exit (ExitPlanModeV2Tool.ts:243–403):
  1. Read plan from disk or input
  2. Store `prePlanMode = current mode`
  3. Set mode back to `prePlanMode`
  4. Restore dangerous permissions if leaving auto
  5. Set `hasExitedPlanModeInSession = true`
  6. Trigger background plan verification hook

**UX:**
- Shift+Tab: `src/keybindings/defaultBindings.ts:69` → `chat:cycleMode`
- Windows fallback: Meta+M (line 30)
- Status line: `src/components/PromptInput/PromptInputFooterLeftSide.tsx`
- Cycle: `utils/permissions/getNextPermissionMode.ts:34–79` → default → acceptEdits → plan → bypassPermissions → (auto) → default

### Permission modes

| Mode | Behavior | Defined in |
|---|---|---|
| `default` | Prompt on all ops | `types/permissions.ts:17` |
| `acceptEdits` | Auto-accept file edits | `types/permissions.ts:17` |
| `plan` | Read-only exploration | `EnterPlanModeTool.ts:36` |
| `bypassPermissions` | Auto-approve all | `types/permissions.ts:17` |
| `auto` | AI classifier decides | `types/permissions.ts:35` |
| `dontAsk` | Auto-reject (deprecated) | `types/permissions.ts:17` |

### Query-loop integration

- Import `getCanUseTool` at query.ts ~77
- Mode check in `src/hooks/useCanUseTool.tsx` against AppState
- Bash race guard in `src/tools/BashTool/bashPermissions.ts` — re-fetches AppState mid-execution to catch Shift+Tab changes
- Mode transitions flow through `src/state/onChangeAppState.ts` (analytics) and `src/bootstrap/state.ts:handlePlanModeTransition()`

**AgenC destination:** `runtime/src/commands/` + `runtime/src/permissions/` + `runtime/src/tui/keybindings/defaultBindings.ts`.

---

## 8. System prompts + project instructions (Tranche 10)

**Source:** `AgenC/src/constants/prompts.ts` + `src/utils/projectInstructions.ts` + `src/utils/claudemd.ts` + `src/memdir/memdir.ts`

| File | LOC | Purpose |
|---|---|---|
| `constants/prompts.ts` | 914 | Main system prompt assembly via `getSystemPrompt()` returning `string[]`; static + dynamic sections; caching boundary marker; env injection |
| `utils/projectInstructions.ts` | 55 | Ancestor-walk behavior adapted to AgenC instruction files |
| `utils/claudemd.ts` | 1,502 | Memory file loader behavior adapted as `agenc-md`; @include directive; 4-tier precedence (Managed → User → Project → Local) |
| `memdir/memdir.ts` | 507 | Memory typing; truncation; `loadMemoryPrompt()` entrypoint; 200 lines / 25KB cap |
| `constants/systemPromptSections.ts` | 69 | Section registry; `systemPromptSection()` cached vs `DANGEROUS_uncachedSystemPromptSection()` volatile |
| `utils/attachments.ts` (partial) | 1,800+ | Memory attachment rules + relevant memory surfacing per turn |

### System prompt section order (port byte-accurate)

1. Intro ("You are an interactive agent...")
2. System (tool permission flow, tag handling, hook guidance, compression notice)
3. Doing tasks (minimal comments, conservative changes, task patterns)
4. Actions (reversibility matrix, destructive-op confirmation)
5. Using tools (prefer dedicated > Bash; parallel tool calls)
6. Tone & style (no emojis; file:line; owner/repo#123)
7. Output efficiency (be concise, lead with answer)
8. **[SYSTEM_PROMPT_DYNAMIC_BOUNDARY]** — everything above is globally cacheable
9. Session guidance (agent tool, skills, fork/verification, ask-user-question gates)
10. Memory (via `loadMemoryPrompt()`)
11. Environment (CWD, git status, platform, shell, OS, model, cutoff)
12. Language (per-user override)
13. Output style (custom identity)
14. MCP instructions (per-turn, busts cache on connect/disconnect)
15. Scratchpad (session temp dir, if enabled)

### Project instructions — ancestor walk

- Walk CWD → filesystem root, stop at first match per tier
- Precedence:
  1. Managed `/etc/agenc/AGENC.md` (policy)
  2. User `~/.agenc/AGENC.md`
  3. Project (walk CWD→root): `AGENC.md`
  4. Local: `AGENC.local.md` (gitignored)
- **Nested worktree:** skip checked-in files from parent repo, allow `.local` from main repo.

### @include semantics

- Syntax: `@path`, `@./rel`, `@~/home`, `@/abs`
- Resolved via lexer on markdown tokens (skip code, codespan, HTML comments)
- Circular refs prevented via `processedPaths` Set
- Non-existent silently ignored
- Fragment stripped (`@file.md#sec` → `@file.md`)
- Spaces escaped (`@path\ with\ spaces.md`)
- Allowed ext: md, txt, json, yaml, ts, py, rs, go, etc. (no binary)
- Resolved relative to including file's dirname

### Hidden variants

- `AGENC_SIMPLE_PROMPT` env: ultra-minimal one-line prompt
- Feature gates: PROACTIVE, KAIROS, CACHED_MICROCOMPACT, VERIFICATION_AGENT, TOKEN_BUDGET, EXPERIMENTAL_SKILL_SEARCH, TEAMMEM
- Undercover mode (Ant-internal): strips model names

**AgenC destination:** `runtime/src/prompts/system-prompt.ts`, `project-instructions.ts`, `memory/loader.ts`, `memory/attachments.ts`, `agenc-md.ts`.

---

## 9. Memory + session storage (Tranche 5 + 10)

**Source:** `AgenC/src/utils/sessionStorage.ts` (5,361 LOC, partial port) + `src/memdir/` + `src/memoryScan.ts` + `src/memoryTypes.ts`

### sessionStorage.ts breakdown

| Lines | Section | Purpose | AgenC |
|---|---|---|---|
| 1–500 | Imports, types, constants | Module setup | Reference only |
| 500–900 | Project class init, write queues | Singleton; batch queue (100ms flush); per-file queues | **Take** (batching model) |
| 900–1,300 | appendEntry, messageSet dedup | Core append; UUID tracking; sidechain routing | **Take** (dedup strategy) |
| 1,300–1,600 | recordTranscript, snapshot recording | High-level record APIs; compaction boundaries | **Take** |
| 1,600–1,800 | loadTranscriptFile | Session resume from JSONL | Reference |
| 2,000–2,500 | Compaction preserved-segment relinking | Context collapse repair | Skip |
| 2,500+ | saveCustomTitle, saveTag, metadata re-append | Metadata at EOF pattern | **Take** |

Core responsibilities: append-only JSONL with write-queue batching, UUID dedup, metadata tail management. Extract ~1,800 LOC.

### Memory files

| File | LOC | Purpose |
|---|---|---|
| `memoryTypes.ts` | 270 | 4 types + frontmatter schema + UI prompt |
| `memoryScan.ts` | 102 | Directory scanner; read frontmatter; newest-first; cap 200 files |
| `memdir/memdir.ts` | 21KB | Memory prompt builder; auto-save; team sync |
| `paths.ts` | 250+ | `~/.claude/projects/<slug>/memory/` with override |
| `sessionMemory.ts` | 300+ | Auto-extract on token/tool thresholds |

### Schema

```yaml
---
name: <human-readable title>
description: <one-line relevance hint>
type: user | feedback | project | reference
---
```

### Auto-memory trigger (sessionMemory.ts)

Extracts post-turn if:
- Context grew ≥ `minimumTokensBetweenUpdate` (~5K default), AND
- Tool calls ≥ `toolCallsBetweenUpdates` (5 default) OR last assistant turn has no tool calls

Forked subagent runs `extractMemories`.

### On-disk layout (mirror into AgenC at `~/.agenc/`)

```
~/.agenc/
  projects/
    <slug>/
      memory/
        MEMORY.md            (index; 8k char cap; 200 files cap)
        <topic>.md           (frontmatter required)
        logs/YYYY/MM/YYYY-MM-DD.md
        private/             (team mode only)
        team/MEMORY.md       (team mode only)
      sessions/
        <sessionId>.jsonl    (max 50MB per read)
        <sessionId>/
          subagents/
          remote-agents/     (only if transport negotiated)
  memory/MEMORY.md           (global fallback)
```

**AgenC destination:** `runtime/src/session/session-store.ts`, `event-log.ts`, `prompts/memory/{loader,auto-save,scan,types}.ts`.

---

## 10. Permissions + sandbox (Tranche 11)

**Source:** `AgenC/src/utils/permissions/` + `src/hooks/useCanUseTool.tsx` + `src/hooks/toolPermission/` + `src/utils/sandbox/`

| File | LOC | Purpose |
|---|---|---|
| `types/permissions.ts` | 442 | `PermissionMode`, `PermissionRule`, `PermissionBehavior`, `PermissionDecision`, `ClassifierResult`, `YoloClassifierResult` |
| `utils/permissions/permissions.ts` | 1,487 | `hasPermissionsToUseTool()` — core evaluator with 5-step tree |
| `hooks/useCanUseTool.tsx` | 204 | Tool-use entry; orchestration; handler routing |
| `hooks/toolPermission/PermissionContext.ts` | 389 | Permission context builder; queue ops; hook runners |
| `utils/permissions/PermissionMode.ts` | 142 | Mode config + display |
| `hooks/toolPermission/handlers/interactiveHandler.ts` | 550+ | TUI modal; queue push; classifier race |
| `utils/sandbox/sandbox-adapter.ts` | 600+ | Sandbox config: FS allow/deny, network allowlist |
| `utils/permissions/classifierDecision.ts` | 99 | Safe tool allowlist for auto mode fast path |
| `utils/permissions/permissionSetup.ts` | 200+ | Init from settings.json; mode transitions |
| `tools/BashTool/bashPermissions.ts` | 500+ | Bash-specific: subcommand parse, sandbox override rules |

### Evaluator decision tree (`hasPermissionsToUseTool`)

1. **Deny checks (bypass-immune)**
   a. Entire tool denied → `deny`
   b. Tool in ask-rules with sandbox fast-path → continue to 2b
   c. `tool.checkPermissions()` (bash subcommands, file safety)
   d. `deny`
   e. `tool.requiresUserInteraction()` → force ask even in bypass
   f/g. Content-specific rules, `.git/`, `.claude/` — bypass-immune
2. **Mode check**
   a. `bypassPermissions` or `plan+bypassAvailable` → `allow`
   b. Entire tool allowed rule → `allow`
3. Convert passthrough → ask
4. **Post-decision transforms** (on `ask`)
   - `dontAsk` → `deny`
   - `auto` → 2-stage YOLO classifier (fast + thinking)
   - `plan+auto-active` → classifier
   - Denial limits (5 consecutive or 15 total) → fall back to prompt

### Approval UI flow

1. Push `ToolUseConfirm` to React queue
2. Launch TUI modal
3. Background races:
   - `pendingClassifierCheck` (bash) → `executeAsyncClassifierCheck()`, auto-allow if high confidence
   - `awaitAutomatedChecksBeforeDialog` → classifier before modal
   - `PermissionRequest` hooks async
4. 200ms grace, then `userInteracted=true` cancels pending classifier
5. First to fire wins: classifier approve / user allow/reject / Ctrl+C abort
6. Return `PermissionDecision`

### Sandbox

Runtime + filesystem:
- `@anthropic-ai/sandbox-runtime` spawns child with cgroup/seccomp
- FS allowlist from `sandbox.filesystem.{allowWrite, denyWrite, allowRead, denyRead}`
- Network: `sandbox.network.{allowlist, denylist, allowManagedDomainsOnly}`
- Bash: `SandboxManager.isSandboxingEnabled()` → if sandboxed + `autoAllowBashIfSandboxed` → skip ask

**AgenC simplification:** skip the sandbox-runtime dep initially; use worktree + permission evaluator + cwd jail. Add sandbox-runtime later if needed.

### Settings schema

```ts
permissions.rules.allow: PermissionRuleValue[]   // ToolName or ToolName(content:*)
permissions.rules.deny: PermissionRuleValue[]
permissions.rules.ask: PermissionRuleValue[]
sandbox.filesystem.allowWrite: string[]
sandbox.filesystem.denyWrite: string[]
sandbox.network.allowlist: string[]
permissions.defaultMode: ExternalPermissionMode
features.autoMode: boolean
```

Precedence: `$CLAUDE_USER_DIR/settings.json` → `.claude/settings.json` → `.claude/settings.local.json` → CLI args → policy settings.

**AgenC destination:** `runtime/src/permissions/{evaluator,context,mode,sandbox,rules,approval,classifier}.ts` + `runtime/src/tui/permissions/InteractiveHandler.tsx`.

---

## 11. Subagents + git worktrees (Tranche 9)

**Source:** `AgenC/src/utils/worktree.ts` + `src/tools/AgentTool/` + `src/tools/EnterWorktreeTool/` + `src/tools/ExitWorktreeTool/`

| File | LOC | Purpose |
|---|---|---|
| `utils/worktree.ts` | 1,563 | Create/cleanup/stale detection; git mutation lock; symlink; sparse-checkout |
| `tools/AgentTool/runAgent.ts` | 987 | Subagent behavior port; child session hooks, MCP init, abort, cleanup |
| `tools/AgentTool/AgentTool.tsx` | 1,232+ | Legacy spawn dispatcher semantics; adapter surface only in AgenC |
| `tools/AgentTool/forkSubagent.ts` | 210 | Fork directive boilerplate; message building; worktree notice |
| `utils/forkedAgent.ts` | 200 | Cache-safe params (system prompt, context, tools) |
| `tools/EnterWorktreeTool/EnterWorktreeTool.ts` | 127 | User-facing entry; CWD mutation |
| `tools/ExitWorktreeTool/ExitWorktreeTool.ts` | 329 | Exit; change verify; keep/remove choice |

Final ownership note: in the replacement target, legacy `AgentTool` naming is
source provenance only. `agents/delegate.ts` is a caller-facing adapter;
`agents/control.ts`, `agents/mailbox.ts`, and child `session/*` own lifecycle
and turn execution.

### Subagent lifecycle

1. **Spawn** (AgentTool:590–649): if `isolation=worktree` → `createAgentWorktree(slug)` (590–605); build `runAgentParams` (615–649); `isAsync = run_in_background || agent.background || forceAsync` (620)
2. **Run** (runAgent:250–820): init agent context/tools/MCP/hooks (250–334); run start hooks (545–556); query loop (762–820); cleanup (822–846)
3. **Join**: sync → `for await (const msg of runAgent(...))` blocks caller; async → `registerAsyncAgent(...)` + `LocalAgentTask` returns immediately
4. **Teardown** (AgentTool:656–698 / worktree:1003–1064): `hasWorktreeChanges()` checks commits+dirty (680–691); if clean `removeAgentWorktree(path, branch, gitRoot)` (682); runs `git worktree remove --force` then `git branch -D` (1029–1062)

### Worktree management

**Create** (worktree:744–820):
- Validate slug `[a-zA-Z0-9._-]+`, max 64 chars (752)
- Try hook → fall back to git (757–770)
- `findGitRoot()` via `.git` pointer (773–785)
- `getOrCreateWorktree(gitRoot, slug)` — fast resume if exists, read HEAD SHA directly (784)
- New: fetch base, `git worktree add -B worktree-<slug> <path> <base>`, sparse-checkout if enabled (789–810)

**Bind CWD:**
- Sync: `process.chdir(worktreePath)` + `setCwd()` state mutation
- Async: `runWithCwdOverride()` closure — no global chdir, isolated scope

**Teardown** (worktree:1029–1064, ExitWorktree:261–291):
- Check `git status --porcelain -uno` → no commits? safe
- Check `git rev-list --count <baseCommit>..HEAD` → empty? no commits
- Remove `git worktree remove --force <path>` from repo root
- `git branch -D worktree-<slug>`
- Sparse-checkout error path (381–407): force-remove before throw

### Mailbox (there isn't one)

**No explicit mailbox in AgenC.** Communication is message-driven via AsyncGenerator:
- Parent → child: `forkContextMessages` + `promptMessages` + `toolUseContext`
- Child → parent: `for await (const msg of runAgent(...))` yields Assistant/User/Progress messages
- Unidirectional; parent polls via async iterator
- ProgressMessage updates notifications (TaskOutputTool); parent subscribes via `onProgress?()` callback
- **AgenC runtime's typed mailbox is cleaner** — we hand-port that instead (see runtime-inventory.md).

### Concurrency + timeout

- Multiple subagents per parent: each spawn → independent agentId + abortController
- Sync agents share parent's controller; async agents have unlinked controller → parallel in background
- No explicit per-agent timeout (inherits parent)
- 30s MCP server wait (runAgent:378)
- Stale worktree cleanup: 30-day mtime cutoff

**AgenC destination:** port worktree lifecycle + selected `runAgent` behavior
from AgenC into `runtime/src/agents/{thread,worktree,delegate,run-agent,fork-context,resume}.ts`; keep lifecycle ownership in AgenC runtime ports under `runtime/src/agents/{control,mailbox,registry,role,status}.ts` plus child `runtime/src/session/*`.

---

## 12. MCP + CLI + hooks (Tranche 10 + existing)

**Source:** mostly already in AgenC; cross-reference for completeness

| File | LOC | Status |
|---|---|---|
| `runtime/src/mcp-client/connection.ts` | 80 | **AgenC existing** — stdio via `@modelcontextprotocol/sdk` |
| `runtime/src/mcp-client/tool-bridge.ts` | 223 | **AgenC existing** — namespacing `mcp.{server}.{tool}` |
| `runtime/src/mcp-client/manager.ts` | 221 | **AgenC existing** |
| `runtime/src/mcp-client/resilient-bridge.ts` | 175 | **AgenC existing** — auto-reconnect with backoff |
| `runtime/src/llm/hooks/*` | 539 total | **AgenC existing** — 8 hook events, parallel dispatch, deny-first fold |

**Missing from AgenC (port from AgenC patterns):**
- SSE transport for MCP (not just stdio)
- HTTP transport for MCP
- MCP resources (not just tools)
- MCP prompts (not just tools)
- Per-tool approval config in MCP server definitions
- Config file loading (no `~/.agenc/config.json` yet; env-var only)

**AgenC destination:** extend existing `runtime/src/mcp-client/` with `transports/{sse,http}.ts`; add `runtime/src/mcp-client/resource-bridge.ts` + `prompt-bridge.ts`.

---

## 13. Missed-features sweep (priority-sorted)

Features outside the main subsystems that are still worth porting.

### Must-take

| Feature | File(s) | LOC | AgenC destination | Status |
|---|---|---|---|---|
| Input history + shell history completion | `history.ts`, `utils/suggestions/shellHistoryCompletion.ts`, `utils/config.ts` | 600+ | `runtime/src/tui/composer/history.ts` | PORTED (T12) |
| Drag-drop path detection | `utils/dragDropPaths.ts` | 55 | `runtime/src/tui/composer/drag-drop.ts` | PORTED (T12) |
| Image paste + multi-modal | `utils/imagePaste.ts`, `utils/imageResizer.ts`, `utils/imageValidation.ts` | 1,570 | `runtime/src/tui/composer/image-paste.ts` | PORTED (T12) |
| File history checkpointing | `utils/fileHistory.ts` | 1,115 | `runtime/src/session/file-history.ts` | pending (T5/T6 scope, not T12) |
| Spinner + activity indicators | `components/Spinner.tsx`, `utils/activityManager.ts`, `utils/sessionActivity.ts` | 858 | `runtime/src/tui/components/Spinner.tsx` | PORTED (T12) |
| Markdown + table rendering | `utils/markdown.ts` | 300+ | `runtime/src/tui/render/markdown.ts` | PORTED (T12) |
| Diff rendering + structured patch | `components/diff/`, `utils/diff.ts`, `utils/gitDiff.ts` | 450+ | `runtime/src/tui/components/Diff/` | PORTED (T12) |
| Code syntax highlighting | `components/HighlightedCode/`, `utils/cliHighlight.ts` | 300+ | `runtime/src/tui/components/HighlightedCode/` | PORTED (T12) |
| Error logging sink | `utils/errorLogSink.ts` | 150+ | `runtime/src/session/error-log.ts` | pending (T6 scope, not T12) |

### Nice-to-have

| Feature | File(s) | LOC | Status |
|---|---|---|---|
| Auto updater | `utils/autoUpdater.ts` | 568 | deferred until release endpoint/install-channel contract exists |
| Bash tool sandboxing | `utils/sandbox/sandbox-adapter.ts`, `components/sandbox/` | 997 | partial (T11 decision model wired) |
| Shell output truncation | `utils/shell/outputLimits.ts`, `utils/truncate.ts` | 187 | wired in T6/T7 tranches |
| Token + cost tracking | `costHook.ts`, `utils/tokens.ts`, `cost-tracker.ts` | 300+ | wired in T5 tranche |
| Clipboard paste store | `utils/pasteStore.ts` | 104 | PORTED (T12) — `runtime/src/tui/composer/paste-store.ts`; owns I-67 sanitizer |
| Shell config management | `utils/shellConfig.ts` | 167 | deferred (T13+) |
| Suggestion engine | `utils/suggestions/` | 1,235 | partial (history completion ported T12) |
| Global pub/sub store | `state/store.ts`, `state/AppStateStore.ts` | 500+ | skipped (replaced by phase/session state) |
| React hooks library | `hooks/use*.ts[x]`, `ink/hooks/` | 1,500+ | subset PORTED (T12) — `runtime/src/tui/hooks/` |

### Skip

Circular buffer, mailbox util (we use AgenC runtime's), ANSI slicing util, screenshot clipboard, test fixtures.

---

## LOCKED modules (T12)

The following AgenC files are copied verbatim from AgenC and should NOT be modified in-tree without an explicit migration note in the commit message. Upstream bumps re-copy wholesale.

- `runtime/src/tui/ink/` (all files except `vendored/`)

`runtime/src/tui/ink/vendored/` is intentionally un-locked: it holds
small shims (env, semver, intl, etc.) for imports that escape the
ink subtree in upstream. Those shims can be edited in-tree as
needed.
