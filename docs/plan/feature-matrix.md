# Feature Matrix

Every feature, grouped by subsystem. Source = `oc` (openclaude),
`codex`, `agenc` (existing), `combined` (codex-owned runtime boundary
with retained openclaude behavior), `new`. Status = `take`,
`skip`, `defer`, `locked`. Destination = AgenC TS path.

Tranche mapping: T4 = compaction port, T4b = phase machine + session,
T5 = event log, T6 = concurrency + tool executor, T7 = recovery,
T8 = transport, T9 = subagents, T10 = prompts + memory,
T11 = permissions, T12 = TUI.

---

## Query kernel + phase machine

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| Main loop skeleton | agenc | `runtime/src/query.ts` | ~170 | delete → replaced | T4b | — |
| 6-phase state machine | combined (codex session ownership + oc phase behavior) | oc `query.ts` exploded | 1,838 → 6 files | take | T4b | `phases/*.ts` |
| TurnState (22 loop vars) | oc | `query.ts:203+` destructure at 315 | — | take | T4b | `session/turn-state.ts` |
| TurnContext (immutable per-turn) | codex | `core/src/session/turn_context.rs` | 626 | port | T4b | `session/turn-context.ts` |
| Session struct | codex | `core/src/session/session.rs` | 852 | port | T4b | `session/session.ts` |
| run_turn orchestration | codex | `core/src/session/turn.rs` | 2,230 | port | T4b | `session/run-turn.ts` |
| 8 continue sites (model_fallback, collapse_drain_retry, reactive_compact_retry, max_output_tokens_escalate, max_output_tokens_recovery, stop_hook_blocking, token_budget_continuation, continuation_nudge) | oc | `query.ts` (specific lines) | — | take | T4b | `phases/index.ts` transition table |
| Agent task lifecycle | codex | `session/agent_task_lifecycle.rs` | 182 | port | T9 | `agents/task-lifecycle.ts` |
| Rollout reconstruction | codex | `session/rollout_reconstruction.rs` | 304 | port | T5 | `session/rollout-reconstruction.ts` |

## Event log + persistence

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| EventMsg discriminated union (~18 variants) | codex | `protocol/src/protocol.rs` | ~500 effective | port (subset) | T5 | `session/event-log.ts` |
| RolloutItem wrapper (6 variants) | codex | `protocol/src/protocol.rs:2855` | — | port | T5 | `session/rollout-item.ts` |
| JSONL format | codex | rollout/src/ | — | port | T5 | `session/rollout-store.ts` |
| SessionStore (~/.agenc/projects/<slug>/) | oc (partial) | `utils/sessionStorage.ts` | 5,361 → ~1,800 | port (subset) | T5 | `session/session-store.ts` |
| Write-queue batching (100ms flush, per-file queue) | oc | `sessionStorage.ts:500-900` | — | take | T5 | `session/session-store.ts` |
| UUID dedup | oc | `sessionStorage.ts:900-1300` | — | take | T5 | `session/session-store.ts` |
| Metadata at EOF + re-append | oc | `sessionStorage.ts:2500+` | — | take | T5 | `session/session-store.ts` |
| Sidecar manager (async subscribers) | combined (codex event ownership + oc sidecars) | codex mailbox pattern + oc sidecars | — | design | T5 | `session/sidecar.ts` |
| Per-message file history snapshots | oc | `utils/fileHistory.ts` | 1,115 | take | T5 | `session/file-history.ts` |
| Error log sink (JSONL) | oc | `utils/errorLogSink.ts` | 150+ | take | T5 | `session/error-log.ts` |

## Compaction

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| Dead AgenC chain | agenc | `runtime/src/llm/compact/` | 1,690 | **delete** | T4 | — |
| Core compaction (PTL retry, image stripping, rehydration) | oc | `services/compact/compact.ts` | 1,712 | take 1:1 | T4 | `llm/compact/compact.ts` |
| autoCompactIfNeeded + circuit breaker | oc | `autoCompact.ts` | 361 | take 1:1 | T4 | `llm/compact/auto-compact.ts` |
| microCompact (selective clear, time-based eviction) | oc | `microCompact.ts` | 536 | take 1:1 | T4 | `llm/compact/micro-compact.ts` |
| sessionMemoryCompact | oc | `sessionMemoryCompact.ts` | 630 | take 1:1 | T4 | `llm/compact/session-memory-compact.ts` |
| Compaction prompt templates (BASE, PARTIAL from/up_to) | oc | `prompt.ts` | 374 | take 1:1 | T4 | `llm/compact/prompt.ts` |
| API-level micro-compact (Anthropic `context_edits`) | oc | `apiMicrocompact.ts` | 153 | take 1:1 | T4 | `llm/compact/api-micro-compact.ts` |
| Time-based MC config (prompt-cache TTL trigger) | oc | `timeBasedMCConfig.ts` | 43 | take 1:1 | T4 | `llm/compact/time-based-mc-config.ts` |
| postCompactCleanup | oc | `postCompactCleanup.ts` | 77 | take 1:1 | T4 | `llm/compact/post-compact-cleanup.ts` |
| grouping (for PTL retry) | oc | `grouping.ts` | 63 | take 1:1 | T4 | `llm/compact/grouping.ts` |
| compactWarningState + hook | oc | `compactWarningState.ts` + `compactWarningHook.ts` | 34 | take 1:1 | T4 | `llm/compact/compact-warning-{state,hook}.ts` |
| stripImagesFromMessages | oc | `compact.ts:136-203` | — | take | T4 | (in compact.ts) |
| truncateHeadForPTLRetry (3 retries) | oc | `compact.ts:230-293` | — | take | T4 | (in compact.ts) |
| Post-compact rehydration (files 5/50K, skills 25K, plan, async agents, deferred schemas) | oc | `compact.ts:519-587` | — | take | T4 | (in compact.ts) |
| Tests | oc | `autoCompact.test.ts` + `microCompact.test.ts` | 172 | take 1:1 | T4 | `llm/compact/*.test.ts` |
| Codex compact (local + remote) | codex | `core/src/compact.rs` + `compact_remote.rs` | 933 | defer (we use oc) | — | — |

## Tool executor + concurrency

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| StreamingToolExecutor (mid-stream dispatch) | oc | `services/tools/StreamingToolExecutor.ts` | 530 | take 1:1 | T6 | `tools/streaming-executor.ts` |
| toolOrchestration (batch partition + run concurrently/serially) | oc | `toolOrchestration.ts` | 188 | take 1:1 | T6 | `tools/orchestration.ts` |
| toolExecution (Zod validation, hooks, classifyToolError) | oc | `toolExecution.ts` | 1,777 | take 1:1 | T6 | `tools/execution.ts` |
| toolHooks (pre/post, auto-fix retry) | oc | `toolHooks.ts` | 716 | take 1:1 | T6 | `tools/hooks.ts` |
| ConcurrencyClass enum (Exclusive, SharedRead, SharedServer, BackgroundTerminal) | agenc | — (AgenC-original atop codex RwLock primitive) | 194 | new | T6 | `tools/concurrency.ts` |
| Router (dispatch + parallel flag check) | codex | `tools/router.rs` | 306 | port | T6 | `tools/router.ts` |
| Orchestrator (approval → sandbox → retry) | codex | `tools/orchestrator.rs` | 447 | port | T6 | `tools/orchestrator.ts` |
| ToolPayload + ToolOutput trait | codex | `tools/context.rs` | 584 | port | T6 | `tools/context.ts` |
| Existing ToolRegistry | agenc | `runtime/src/tool-registry.ts` | 141 | extend | T6 | keep + add concurrency tag |
| Sibling-abort on Bash errors | oc | `StreamingToolExecutor.ts:359-362` | — | take | T6 | (in streaming-executor) |
| Progress message buffering | oc | `StreamingToolExecutor.ts:30, 420` | — | take | T6 | (in streaming-executor) |
| Env-capped concurrency (default 10) | oc | `toolOrchestration.ts:10` (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`) | — | take (rename to `AGENC_*`) | T6 | `tools/orchestration.ts` |

## Recovery paths

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| Tombstone orphan assistant text | oc | `query.ts:747-774` | — | take | T7 | `recovery/tombstone.ts` |
| Terminal tool_result synthesis | oc | `query.ts` (fallback content per tool) | — | take | T7 | `recovery/terminal-tool-result.ts` |
| Collapse drain recovery | oc | `services/contextCollapse/index.js` + `query.ts:1116-1149` | — | take | T7 | `recovery/collapse-drain.ts` + phase |
| Reactive compact | oc | `services/compact/reactiveCompact.js` + `query.ts:1151-1215` | — | take | T7 | `recovery/reactive-compact.ts` |
| Max-output-tokens escalate (8k → 64k) | oc | `query.ts:1221-1255` | — | take | T7 | (in post-sample-recovery phase) |
| Max-output-tokens continuation nudge | oc | `query.ts:1257-1291` | — | take | T7 | (in post-sample-recovery phase) |
| Stop-hook blocking | oc | `query.ts:1313-1341` | — | take | T7 | `phases/stop-hooks.ts` |
| FallbackTriggeredError handling (swap model) | oc | `services/api/withRetry.js` + `query.ts:928-981` | — | take | T7 | `recovery/fallback-ladder.ts` |
| Withheld cascading (2-gate check) | oc | `query.ts:834-857` | — | take | T7 | `recovery/withhold-cascading.ts` |
| `hasAttemptedReactiveCompact` persistence asymmetry | oc | `query.ts:1189, 1332, 1369` | — | take | T7 | (in recovery) |
| Stop-hook API-error guard | oc | `query.ts:1297-1299` | — | take | T7 | `phases/stop-hooks.ts` |
| Reconnection backoff (1s → 30s ±25%, 10min budget) | oc | `WebSocketTransport.ts:465-555`, `SSETransport.ts:470-535` | — | take | T7+T8 | `recovery/reconnection.ts` |

## Transport

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| WebSocketTransport (duplex, 10s pings) | oc | `cli/transports/WebSocketTransport.ts` | 800 | take | T8 | `transport/ws-duplex.ts` |
| HybridTransport (WS read + POST write, 100ms batch) | oc | `HybridTransport.ts` | 282 | take | T8 | `transport/ws-post.ts` |
| SSETransport (SSE read + POST write, Last-Event-ID resume) | oc | `SSETransport.ts` | 711 | take (optional) | T8 | `transport/sse-post.ts` |
| SerialBatchEventUploader (backpressure, queue 100K) | oc | `SerialBatchEventUploader.ts` | 275 | take | T8 | `transport/serial-batch-uploader.ts` |
| Env-driven transport selection | oc | `transportUtils.ts:16` | 45 | take | T8 | `transport/fallback-ladder.ts` |
| Process-sleep detection (>60s gap resets budget) | oc | (in WS + SSE transports) | — | take | T8 | (in transports) |
| 4003 auth refresh callback | oc | WS + SSE | — | take | T8 | `transport/refresh-headers.ts` |
| WorkerStateUploader (RFC 7396 coalesce) | oc | `WorkerStateUploader.ts` | 131 | defer | — | — |
| ccrClient (CCR v2 orchestrator) | oc | `ccrClient.ts` | 998 | **skip** (domain-specific) | — | — |
| Capability probe (planned) | new | — | — | defer | T8+ | `transport/capability-probe.ts` |

## Subagents

Final owner note: subagent lifecycle is owned by `agents/control.ts` plus the
child `session/*` runtime. Openclaude-derived `delegate.ts` and
`run-agent.ts` are adapters and behavior ports, not independent runtime
owners.

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| Worktree create/bind/cleanup | oc | `utils/worktree.ts` | 1,563 | take | T9 | `agents/worktree.ts` |
| runAgent execution engine | oc | `tools/AgentTool/runAgent.ts` | 987 | take (behavior only; child turns owned by `session/*`) | T9 | `agents/run-agent.ts` |
| Legacy AgentTool spawn dispatcher (sync/async) | oc | `tools/AgentTool/AgentTool.tsx` | 1,232+ | take as adapter only | T9 | `agents/delegate.ts` |
| EnterWorktreeTool (user entry) | oc | `tools/EnterWorktreeTool/EnterWorktreeTool.ts` | 127 | take | T9 | `commands/enter-worktree.ts` |
| ExitWorktreeTool (change verify + keep/remove) | oc | `tools/ExitWorktreeTool/ExitWorktreeTool.ts` | 329 | take | T9 | `commands/exit-worktree.ts` |
| forkSubagent (fork directive, cache-safe params) | oc | `forkSubagent.ts` + `utils/forkedAgent.ts` | 410 | take | T9 | `agents/fork-context.ts` |
| Mailbox (typed inter-agent queue, mpsc + watch) | codex | `agent/mailbox.rs` | 161 | port | T9 | `agents/mailbox.ts` |
| Control plane (spawn/resume/interrupt) | codex | `agent/control.rs` | 1,214 | port | T9 | `agents/control.ts` |
| Registry (in-memory agent registry + spawn slots) | codex | `agent/registry.rs` | 344 | port | T9 | `agents/registry.ts` |
| Role layer (built-in default/explorer/awaiter) | codex | `agent/role.rs` | 434 | port | T9 | `agents/role.ts` |
| AgentStatus FSM | codex | `agent/status.rs` | 27 | port | T9 | `agents/status.ts` |
| Resume vs restart pragmatism | combined (codex lifecycle + oc worktree behavior) | — | — | design | T9 | `agents/resume.ts` |
| Stale worktree cleanup (30-day mtime cutoff) | oc | `worktree.ts:1102-1179` | — | take | T9 | (in worktree.ts) |

## System prompt + project instructions + memory

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| getSystemPrompt() section assembly | oc | `constants/prompts.ts` | 914 | take | T10 | `prompts/system-prompt.ts` |
| Dynamic boundary marker (cache cutoff) | oc | `constants/prompts.ts` + `systemPromptSections.ts` | 69 | take | T10 | `prompts/sections.ts` |
| Project instructions ancestor walk (AGENC.md) | combined | upstream instruction walkers adapted to AgenC naming | 55 | take | T10 | `prompts/project-instructions.ts` |
| @include directive (4-tier precedence) | agenc | tiered AgenC instruction loader | 1,502 | take | T10 | `prompts/agenc-md.ts` |
| `AGENTS.override.md` | codex | `core/src/agents_md.rs` | — | take | T10 | (in project-instructions) |
| Memory loader (loadMemoryPrompt, 200 lines/25KB cap) | oc | `memdir/memdir.ts` | 507 | take | T10 | `prompts/memory/loader.ts` |
| Memory schema (name/description/type frontmatter) | oc | `memoryTypes.ts` | 270 | take | T10 | `prompts/memory/types.ts` |
| 4 memory types (user, feedback, project, reference) | oc | (in memoryTypes) | — | take | T10 | (in types.ts) |
| Memory scanner (frontmatter parse, newest-first, 200 cap) | oc | `memoryScan.ts` | 102 | take | T10 | `prompts/memory/scan.ts` |
| Auto-memory extraction (thresholds, forked subagent) | oc | `sessionMemory.ts` | 300+ | take | T10 | `prompts/memory/auto-save.ts` |
| Team memory + private | oc | `memdir/memdir.ts` | — | defer | T10+ | — |
| Per-turn relevant memory attachment (5 files/turn, 4KB ea, 60KB/session cap) | oc | `utils/attachments.ts` (partial) | — | take | T10 | `prompts/memory/attachments.ts` |
| Environment context injection (cwd, git, platform, model, cutoff) | oc | `constants/prompts.ts` | — | take | T10 | (in system-prompt) |
| MCP instruction injection (per-turn, bust cache) | oc | `constants/prompts.ts` | — | take | T10 | (in system-prompt) |
| `CLAUDE_CODE_SIMPLE` ultra-minimal prompt | oc | `constants/prompts.ts` | — | take (rename `AGENC_SIMPLE`) | T10 | (env-gated) |

## Permissions

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| Permission mode enum (default/acceptEdits/plan/bypassPermissions/auto/dontAsk + internal `bubble`) | oc | `types/permissions.ts` | 442 | take (WIRED T11) | T11 | `permissions/mode.ts` |
| hasPermissionsToUseTool 5-step decision tree | oc | `utils/permissions/permissions.ts` | 1,487 | take (WIRED T11) | T11 | `permissions/evaluator.ts` |
| PermissionContext builder | oc | `hooks/toolPermission/PermissionContext.ts` | 389 | take (WIRED T11) | T11 | `permissions/context.ts` |
| Interactive TUI handler (modal, classifier race, 200ms grace, I-44 + I-90 turn-id drop) | oc | `hooks/toolPermission/handlers/interactiveHandler.ts` | 550+ | SHIPPED (T12) | T11+T12 | `tui/permissions/InteractiveHandler.tsx` |
| 2-stage YOLO classifier (auto mode) | oc | `utils/permissions/classifierDecision.ts` + handler | 99 + ~400 | take (WIRED T11, real xAI call deferred to T13) | T11 | `permissions/classifier.ts` |
| Safe tool allowlist (classifier fast path) | oc | `classifierDecision.ts` | — | take (WIRED T11) | T11 | (in classifier.ts) |
| Permission rules (allow/deny/ask) with content globs | oc | `permissions.ts` + `rules.ts` | — | take (WIRED T11) | T11 | `permissions/rules.ts` |
| Denial limits (3 consecutive, 20 total → fallback to prompt) | oc | `permissions.ts` | — | take (WIRED T11) | T11 | (in evaluator) |
| Sandbox adapter (FS allow/deny, network allowlist) | oc | `utils/sandbox/sandbox-adapter.ts` | 600+ | **partial skip** (no sandbox-runtime dep) — decision model WIRED T11 | T11 | `permissions/sandbox.ts` |
| Bash subcommand parser + sandbox override | oc | `tools/BashTool/bashPermissions.ts` | ~2598 upstream; AgenC ships ~1005 LOC lean port | take (WIRED T11) | T11 | `permissions/bash.ts` |
| Approval cache (per-session decisions) | codex | `tools/sandboxing.rs` | — | port (WIRED T11) | T11 | `permissions/approval-cache.ts` |
| Approval policy enum (never/on_failure/on_request/granular/untrusted) | codex | `sandboxing.rs` | — | port (WIRED T11) | T11 | `permissions/approval-policy.ts` |
| Sandbox policy enum (danger_full_access/read_only/workspace_write/external_sandbox) | codex | `sandboxing.rs` | — | port (WIRED T11) | T11 | `permissions/sandbox.ts` |
| Network approval flow | codex | `network_approval.rs` | 688 | port (subset, WIRED T11) | T11 | `permissions/network-approval.ts` |
| execpolicy DSL | codex | `execpolicy/` | — | **skip** (defer) | — | — |
| Rust OS sandbox primitives (Seatbelt/Landlock/seccomp) | codex | `sandboxing.rs` | — | **skip** | — | — |
| Settings schema (permissions.rules.{allow,deny,ask}, sandbox.*, permissions.defaultMode, features.autoMode) | oc | settings.json | — | take (WIRED T11 — permissions block promoted in `config/schema.ts`) | T10+T11 | `config/schema.ts` |
| Settings precedence (user → project → local → CLI → policy) | oc | `permissionSetup.ts` | ~1533 upstream; AgenC ships lean settings loader | take (WIRED T11) | T11 | `permissions/settings.ts` |

## Slash commands + modes

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| `/plan` | oc | `commands/plan/plan.tsx` | — | take (WIRED T11) | T11 | `commands/plan.ts` |
| `/permissions` | oc | `commands/permissions/` | — | take (WIRED T11) | T11 | `commands/permissions.ts` |
| `/model` | oc | `commands/model/` | — | take (WIRED T11) | T11 | `commands/model.ts` |
| `/provider` | oc | `commands/model/` (mirror) | — | take (WIRED T11) | T11 | `commands/provider.ts` |
| `/config` | oc | `commands/config/` | — | take (WIRED T11) | T10 | `commands/config.ts` |
| `/help` | oc | `commands/help/` | — | take (WIRED T11, TUI render T12) | T12 | `commands/help.ts` |
| `/clear` | oc | `commands/clear/` | — | simplified (WIRED T11) | T12 | `commands/clear.ts` |
| `/context` | oc | `commands/context/` | — | simplified (WIRED T11) | T12 | `commands/context.ts` |
| `/exit` | oc | `commands/exit/` | — | take (WIRED T11) | T12 | `commands/exit.ts` |
| `/status` | oc | `commands/status/` | — | take (WIRED T11) | T12 | `commands/status.ts` |
| `/keybindings` | oc | `commands/keybindings/` | — | simplified (WIRED T11) | T12 | `commands/keybindings.ts` |
| `/skills` | oc | `commands/skills/` | — | take (WIRED post-T13 status surface + local skills/plugin loader) | T12+ | `commands/skills.ts` + `skills/local-loader.ts` |
| `/compact` | oc | manual compaction trigger | — | take (WIRED T11) | T4 | `commands/compact.ts` |
| `/resume` | codex | picker + `--last` | — | take (WIRED T11) | T5 | `commands/resume.ts` |
| `/fork` | codex | fork current session | — | take (WIRED T11) | T9 | `commands/fork.ts` |
| `/init` | codex | create AGENTS.md | — | take (WIRED T11) | T10 | `commands/init.ts` |
| `/diff` | codex | `slash_dispatch.rs` | — | take (WIRED T11) | T12 | `commands/diff.ts` |
| `/copy` | codex | `slash_dispatch.rs` | — | take (WIRED post-T13 transcript export) | T13+ | `commands/copy.ts` |
| `/mcp` | codex/oc | both | — | take (WIRED post-T13 status surface over `SessionServices.mcpManager`) | T9+ | `commands/mcp.ts` |
| `/enter-worktree` | agenc | pre-existing adapter | — | take (WIRED T11 via registry) | T9/T11 | `commands/enter-worktree.ts` |
| `/exit-worktree` | agenc | pre-existing adapter | — | take (WIRED T11 via registry) | T9/T11 | `commands/exit-worktree.ts` |
| `/side` (ephemeral fork) | codex | `slash_dispatch.rs` | — | defer | T9+ | — |
| `/rename` | codex | rename thread | — | defer | T5+ | — |
| `/review` | codex | code review | — | defer | — | — |
| `/fast` | codex | 2x plan usage toggle | — | **skip** (codex-specific) | — | — |
| Inline slash args (`/review <path>`) | codex | `slash_dispatch.rs` | — | take (pattern, WIRED T11 in `dispatcher.ts`) | T12 | `commands/dispatcher.ts` |
| Shift+Tab mode cycle | oc | `keybindings/defaultBindings.ts:69` | — | SHIPPED (T11 runtime + T12 UI) | T11+T12 | `tui/keybindings/defaultBindings.ts` |
| Meta+M Windows fallback | oc | same, line 30 | — | SHIPPED (T12) | T12 | (in defaultBindings.ts) |
| `/plan` mode runtime state (AppState.toolPermissionContext.mode) | oc | various | — | take (WIRED T11) | T11 | `permissions/mode.ts` |
| EnterPlanModeTool / ExitPlanModeV2Tool | oc | `tools/ExitPlanModeV2Tool.ts:243-403` | — | take (WIRED T11) | T11 | `session/plan-mode.ts` |
| Mode cycle (default → acceptEdits → plan → bypassPermissions → auto → default) | oc | `utils/permissions/getNextPermissionMode.ts:34-79` | — | take (WIRED T11) | T11 | (in mode.ts) |
| Mode footer indicator | oc | `PromptInputFooterLeftSide.tsx` | — | SHIPPED (T12) | T12 | (in cockpit Banner) |
| `hasExitedPlanModeInSession` flag | oc | (in state) | — | take (WIRED T11) | T11 | (in session state) |
| Plan verification hook (background) | oc | ExitPlanModeV2Tool | — | take (WIRED T11) | T11 | `session/plan-mode.ts` |
| I-68 slash command first-line-only parse fence | new | — | — | WIRED T11 — `dispatcher.ts::parseSlashCommand` | T11 | `commands/dispatcher.ts` |
| Bridge-safe slash command allowlist (`isBridgeSafeCommand`) | new | — | — | WIRED T11 | T11 | `commands/dispatcher.ts` |

## TUI (Ink/React)

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| Ink core (reconciler + renderer + layout + events) | oc | `ink/` (16 core files) | ~9,000 | SHIPPED (T12) — LOCKED verbatim port | T12 | `tui/ink/` |
| Ink components (Box, Text, ScrollBox, Button, AlternateScreen, RawAnsi, Link, Spacer, Newline, NoSelect, ErrorOverview) | oc | `ink/components/` | ~2,300 | SHIPPED (T12) — LOCKED | T12 | `tui/ink/components/` |
| Contexts (Clock, TerminalSize, TerminalFocus, Stdin, App, CursorDeclaration) | oc | `ink/components/*Context.{ts,tsx}` | ~270 | SHIPPED (T12) — LOCKED | T12 | `tui/ink/contexts/` |
| App.tsx root (6 Ink contexts + AgenCAppStateProvider + KeybindingProvider + OverlayProvider) | oc | `ink/components/App.tsx` | 689 | SHIPPED (T12) | T12 | `tui/App.tsx` |
| Cockpit banner (run/status/phase/tool) | new | — | — | SHIPPED (T12) | T12 | `tui/cockpit/Banner.tsx` |
| ASCII girl panel (wraps agenc-watch-art.mjs) | agenc | `watch/agenc-watch-art.mjs` | 168 | SHIPPED (T12) | T12 | `tui/cockpit/ArtPanel.tsx` |
| Splash (wraps agenc-watch-splash.mjs) | agenc | `watch/agenc-watch-splash.mjs` | 169 | SHIPPED (T12) | T12 | `tui/cockpit/Splash.tsx` |
| Color palette | agenc | `watch/agenc-watch-ui-primitives.mjs` | 307 | SHIPPED (T12) | T12 | `tui/theme.ts` (re-export) |
| ANSI sequences | agenc | `watch/agenc-watch-terminal-sequences.mjs` | 89 | SHIPPED (T12) | — | consumed by tui |
| Markdown streaming (state machine + parser + diff renderer + cache + text utils) | agenc | `watch/agenc-watch-markdown-*.mjs` + `agenc-watch-diff-render.mjs` + `agenc-watch-render-cache.mjs` + `agenc-watch-text-utils.mjs` | ~2,229 | SHIPPED (T12) — logic modules consumed by StreamingMessage | T12 | kept in `watch/` |
| MessageList (ScrollBox-wrapped transcript) | new (wraps oc ScrollBox) | — | — | SHIPPED (T12) | T12 | `tui/transcript/MessageList.tsx` |
| StreamingMessage (incremental markdown → display lines, I-77 UI-spoof sanitizer) | new (uses agenc markdown modules) | — | — | SHIPPED (T12) | T12 | `tui/transcript/StreamingMessage.tsx` |
| ExecCell (codex-inspired exit codes + live output) | codex | `exec_cell/model.rs` | — | SHIPPED (T12) | T12 | `tui/transcript/ExecCell.tsx` |
| SlashResultRenderer (transcript rendering for 18 shipped slash commands) | new | — | — | SHIPPED (T12) — renders T11 slash results | T12 | `tui/transcript/SlashResultRenderer.tsx` |
| PlanProgress (plan EventMsg variants: plan_started / plan_delta / plan_item_completed / plan_exited) | new | — | — | SHIPPED (T12) | T12 | `tui/transcript/PlanProgress.tsx` |
| Composer (multiline input, history, IME, I-69 paste-in-flight, I-71 mention validator) | new (uses oc BaseTextInput pattern) | oc `src/components/BaseTextInput.tsx` | — | SHIPPED (T12) | T12 | `tui/composer/Composer.tsx` |
| Palette (slash + file-mention autocomplete) | new | — | — | SHIPPED (T12) | T12 | `tui/composer/Palette.tsx` |
| Input history | oc | `history.ts` + `utils/suggestions/shellHistoryCompletion.ts` | 600+ | SHIPPED (T12) | T12 | `tui/composer/history.ts` |
| Drag-drop path detection | oc | `utils/dragDropPaths.ts` | 55 | SHIPPED (T12) | T12 | `tui/composer/drag-drop.ts` |
| Image paste (clipboard capture Darwin/Linux/Win32) | oc | `utils/imagePaste.ts` + `imageResizer.ts` + `imageValidation.ts` | 1,570 | SHIPPED (T12) | T12 | `tui/composer/image-paste.ts` |
| Spinner + activity manager | oc | `components/Spinner.tsx` + `utils/activityManager.ts` + `sessionActivity.ts` | 858 | SHIPPED (T12) | T12 | `tui/components/Spinner.tsx` |
| Markdown + table renderer | oc | `utils/markdown.ts` | 300+ | SHIPPED (T12) | T12 | `tui/render/markdown.ts` |
| Diff renderer (structured patch, hunks) | oc | `components/diff/` + `utils/diff.ts` + `gitDiff.ts` | 450+ | SHIPPED (T12) | T12 | `tui/components/Diff/` |
| Code syntax highlighting | oc | `components/HighlightedCode/` + `utils/cliHighlight.ts` | 300+ | SHIPPED (T12) | T12 | `tui/components/HighlightedCode/` |
| ApprovalOverlay (multi-choice with inline context, I-21 abort + I-72 modal keybindings) | codex | `bottom_pane/approval_overlay.rs` | 56KB | SHIPPED (T12) | T12 | `tui/permissions/ApprovalOverlay.tsx` |
| Configurable status line (12 items: model, git, tokens, context %, limits, session ID) | codex | `bottom_pane/status_line_setup.rs` | 64KB | SHIPPED (T12) | T12 | `tui/cockpit/StatusLineConfig.tsx` |
| ASCII animation scheduler | codex | `chatwidget/ascii_animation.rs` | — | SHIPPED (T12) | T12 | `tui/hooks/useAnimationTick.ts` |
| RawAnsi (bypass React for pre-wrapped ANSI) | oc | `ink/components/RawAnsi.tsx` | 56 | SHIPPED (T12) — LOCKED | T12 | (in tui/ink) |
| Selection (text selection, IME, cursor declaration) | oc | `ink/selection.ts` | 917 | SHIPPED (T12) — LOCKED | T12 | (in tui/ink) |
| Terminal capability detection (Kitty, xterm.js, iTerm2) | oc | `ink/terminal.ts` | 275 | SHIPPED (T12) — LOCKED | T12 | (in tui/ink) |
| I-19 TUI stdin loss graceful exit (main.tsx::handleStdinLoss) | new | — | — | WIRED (T12) | T12 | `tui/main.tsx` |
| I-21 Approval modal lifecycle bounded by abort | new | — | — | WIRED (T12) | T12 | `tui/permissions/ApprovalOverlay.tsx` |
| I-66 Frame-diff snapshots terminal size at start of pass | new | — | — | WIRED (T12) | T12 | `tui/ink/ink.tsx` |
| I-67 Paste C0/C1 control-character sanitizer | new | — | — | WIRED (T12) | T12 | `tui/composer/paste-store.ts` |
| I-69 Multi-line paste atomic w.r.t. Enter | new | — | — | WIRED (T12) | T12 | `tui/composer/Composer.tsx` |
| I-70 Render throttle on terminal-input idle | new | — | — | WIRED (T12) | T12 | `tui/ink/ink.tsx` |
| I-71 `@mention` path-boundary validator | new | — | — | WIRED (T12) | T12 | `tui/composer/Composer.tsx` |
| I-72 Modal input focus exclusive | new | — | — | WIRED (T12) | T12 | `tui/permissions/ApprovalOverlay.tsx` + `tui/keybindings/KeybindingContext.tsx` |
| I-77 Model output UI-spoof sanitization | new | — | — | WIRED (T12) | T12 | `tui/transcript/StreamingMessage.tsx` |
| I-90 Stale pending permission dropped on turn boundary | new | — | — | WIRED (T12) | T12 | `tui/permissions/InteractiveHandler.tsx` |
| CLI branching (routeCLI → oneShotCLI / bootTUIEntry / resumeTUIEntry) | new | — | — | SHIPPED (T12) | T12 | `src/bin/route.ts` + `src/bin/agenc.ts` |

## MCP + CLI + config

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| MCP stdio transport | agenc | `runtime/src/mcp-client/connection.ts` | 80 | keep | — | existing |
| MCP SSE transport | codex/oc | various | — | add | T9+ | `mcp-client/transports/sse.ts` |
| MCP HTTP transport | codex | `codex-mcp/` | — | add | T9+ | `mcp-client/transports/http.ts` |
| MCP tool bridge (namespacing `mcp.{server}.{tool}`) | agenc | `tool-bridge.ts` | 223 | keep | — | existing |
| MCP resource bridge | codex | `codex-mcp/` | — | add | T9+ | `mcp-client/resource-bridge.ts` |
| MCP prompt bridge | codex | `codex-mcp/` | — | add | T9+ | `mcp-client/prompt-bridge.ts` |
| MCP resilient bridge (auto-reconnect with backoff) | agenc | `resilient-bridge.ts` | 175 | keep | — | existing |
| MCP connection manager | codex (reference) | `codex-mcp/src/mcp_connection_manager.rs` | 1,870 | inspire + extend existing | T9+ | `mcp-client/manager.ts` |
| MCP 30s server wait | oc | `runAgent.ts:378` | — | take | T9 | (in manager) |
| Tool namespacing `mcp.{server}.{tool}` | agenc | existing | — | keep | — | — |
| Hook system (8 events, parallel dispatch, deny-first fold) | agenc | `runtime/src/llm/hooks/*` | 539 | keep + wire into phases | T4b+T10 | existing |
| Hook matcher (exact, wildcard, alternation, regex) | agenc | `matcher.ts` | 35 | keep | — | existing |
| Hook executors (command, http, callback, function) | agenc | `executors.ts` | 220 | keep | — | existing |
| Stop hooks (mid-turn continuation detector) | codex | `hooks/src/events/stop.rs` | 547 | port | T7 | `phases/stop-hooks.ts` |
| Stream parsing (thinking/plan block extraction, citations) | codex | `utils/stream-parser/src/` | 500+ | port | T4b | `llm/stream-parser.ts` |
| CLI one-shot mode (argv + stdin) | agenc | `bin/agenc.ts` | 168 | keep + extend | — | existing |
| CLI flags (--help, --version, --config, --profile, --resume, --fork, --model, --sandbox, --approval-policy, --image) | codex+oc | — | — | build | T10+ | `bin/agenc.ts` |
| CLI subcommands (`exec`, `review`, `mcp`, `resume`, `fork`) | codex | `cli/` | — | subset | T5+T9 | `bin/agenc.ts` |
| Config file loader (TOML) | codex (inspire) | `config_toml.rs` | — | build | T10 | `config/loader.ts` |
| Named profiles (override top-level) | codex | `config/profile_toml.rs` | — | port | T10 | `config/profiles.ts` |
| Env var resolution (XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, …, AGENC_MODEL, AGENC_PROVIDER, AGENC_WORKSPACE, AGENC_HOME) | agenc+new | `bin/agenc.ts` + per-provider | — | extend | T10 | `config/env.ts` |

## Provider abstraction (multi-provider — see [`provider-matrix.md`](provider-matrix.md))

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| `LLMProvider` interface | agenc | `runtime/src/llm/types.ts:578` | — | keep | — | existing |
| `createProvider()` factory | new | — | — | built (WIRED) | T5+T13 | `llm/provider.ts` |
| Multi-provider dispatch (two-level Session + Turn client) | codex | `core/src/client.rs` | 1,978 | port (WIRED) | T5+T13 | `llm/client.ts` + `llm/client-session.ts` |
| Capability registry (per-provider × per-model) | new | — | — | built (WIRED) | T5+T13 | `llm/capabilities.ts` |
| Capability-driven request composer | new | — | — | built (WIRED) | T5+T13 | `llm/shape-request.ts` |
| Wire shim: xAI Responses API | agenc | existing Grok adapter internals | — | refactored (WIRED) | T5+T13 | `llm/wire/responses-xai.ts` |
| Wire shim: OpenAI Responses API | new | — | — | built (WIRED) | T13 | `llm/wire/responses-openai.ts` |
| Wire shim: Anthropic Messages API | new | — | — | built (WIRED) | T13 | `llm/wire/messages-anthropic.ts` |
| Wire shim: OpenAI Chat Completions | new | — | — | built (WIRED) | T13 | `llm/wire/chat-completions.ts` (used by OpenAI legacy + Ollama + LMStudio + OpenRouter + Groq + DeepSeek + Gemini-beta) |
| OAuth refresh loop (shared) | codex | `client.rs:1154-1211, 1699-1961` | ~500 | ported (WIRED) | T13 | `llm/oauth/refresh-loop.ts` |
| Grok adapter (default provider) | agenc | `runtime/src/llm/grok/` → `llm/providers/grok/` | 8,144 | relocate, no changes | T5 | `llm/providers/grok/` |
| OpenAI adapter | new | — | — | built (WIRED) | T13 | `llm/providers/openai/` |
| Anthropic adapter | new | — | — | built (WIRED) | T13 | `llm/providers/anthropic/` |
| Ollama adapter | agenc existing | `runtime/src/llm/ollama/` | — | relocate, no changes | T5 | `llm/providers/ollama/` |
| LMStudio adapter | new | — | — | built (WIRED) | T13 | `llm/providers/lmstudio/` |
| OpenRouter adapter | new | — | — | built (WIRED) | T13 | `llm/providers/openrouter/` |
| Groq adapter | new | — | — | built (WIRED) | T13 | `llm/providers/groq/` |
| DeepSeek adapter | new | — | — | built (WIRED) | T13 | `llm/providers/deepseek/` |
| Gemini adapter | new | — | — | built (WIRED) | T13 | `llm/providers/gemini/` |
| `previous_response_id` incremental reuse (per provider) | codex | `client.rs:909-946` | — | ported (WIRED) | T5+T13 | `llm/providers/{grok,openai}/incremental.ts` — **invariant I-2: clear on compact** |
| xAI mid-sentence truncation retry (`tool_choice=none`) | agenc | existing in Grok adapter | — | stays scoped | — | `llm/providers/grok/` internal |
| xAI encrypted_reasoning handling | agenc | existing in Grok adapter | — | stays scoped | — | `llm/providers/grok/` internal |
| Anthropic `cache_control` blocks | new | — | — | built (WIRED) | T13 | `llm/providers/anthropic/cache-control.ts` |
| Anthropic extended thinking blocks | new | — | — | built (WIRED) | T13 | `llm/providers/anthropic/thinking.ts` |
| OpenAI o-series `reasoning.effort` + reasoning summary | new | — | — | built (WIRED) | T13 | `llm/providers/openai/reasoning.ts` |
| Gemini 2.5 thinking mode | new | — | — | built (WIRED) | T13 | `llm/providers/gemini/thinking.ts` |
| Auth: bearer API key (Grok, Anthropic, Groq, DeepSeek, OpenRouter, LMStudio) | new | — | — | built (WIRED) | T5+T13 | `llm/auth/bearer.ts` — 401 = hard-fail |
| Auth: OAuth (OpenAI ChatGPT, future) | codex | `client.rs:1154-1211` | — | ported (WIRED) | T13 | `llm/oauth/refresh-loop.ts` |
| Auth: Google API key (Gemini) | new | — | — | built (WIRED) | T13 | `llm/providers/gemini/auth.ts` |
| Auth: local no-auth (Ollama default, LMStudio default) | agenc | existing Ollama | — | keep | — | adapter internal |
| Model resolution layering (CLI → env → profile → config → provider default → Grok) | new | — | — | build | T10 | `config/resolve-model.ts` |
| Provider resolution layering (CLI → env → profile → config → default=grok) | new | — | — | build | T10 | `config/resolve-provider.ts` |

## Design invariants (see [`invariants.md`](invariants.md))

| Invariant | Title | Primary tranche | Cross-cutting |
|---|---|---|---|
| I-1 | Subagent recursion depth bounded (`MAX_AGENT_DEPTH=4`) | T9 | T5 |
| I-2 | `previous_response_id` cleared on any compaction | T5 | T4, T7 |
| I-3 | Mode change requires mid-dispatch guard on every mutation tool (WIRED T11) | T11 | T7 |
| I-4 | Event log fsync at turn commit (durable boundary) | T6 | T5 |
| I-5 | Mailbox is bidirectional (parent↔child) | T9 | T5 |
| I-6 | MCP startup failure is fail-soft by default | T9 | T5 |
| I-7 | Stream abort cascades through tool executor | T7 | T6, T5 |

## Cross-cutting utilities

| Feature | Source | File | LOC | Status | Tranche | Destination |
|---|---|---|---|---|---|---|
| `all()` concurrency-capped Promise.all | oc | `utils/generators.ts` | — | take | T6 | `utils/generators.ts` |
| Text wrapping / ANSI-aware truncation (grapheme-safe) | oc | `utils/truncate.ts` + `utils/sliceAnsi.ts` | 187+91 | take | T12 | `utils/text.ts` |
| Shell output limits | oc | `utils/shell/outputLimits.ts` | 187 | take | T6 | `tools/shell-output.ts` |
| Token + cost tracking | oc | `costHook.ts` + `utils/tokens.ts` + `cost-tracker.ts` | 300+ | take | T5 | `session/cost.ts` |
| Clipboard paste store (SHA256 content-address) | oc | `utils/pasteStore.ts` | 104 | SHIPPED (T12) | T12 | `tui/composer/paste-store.ts` |
| Shell config management (.bashrc/.zshrc/.fish detect) | oc | `utils/shellConfig.ts` | 167 | utility WIRED (post-T13 alias detect/filter; install mutation still explicit) | T13+ | `utils/shell-config.ts` |
| Auto updater (SemVer + GCS) | oc | `utils/autoUpdater.ts` | 568 | deferred until release endpoint/install-channel contract exists | T13+ | — |
| Global pub/sub store | oc | `state/store.ts` + `AppStateStore.ts` | 500+ | defer — may not need with phases | — | — |
| React hooks library (144+ hooks) | oc | `hooks/use*.ts[x]` | 1,500+ | take subset | T12 | `tui/hooks/` |
| AsyncLock (translation helper) | new | — | — | build | T4b | `utils/async-lock.ts` |
| AsyncRwLock (translation helper) | new | — | — | build | T6 | `utils/async-rwlock.ts` |
| BehaviorSubject-like (translation helper) | new (or rxjs dep) | — | — | build | T4b | `utils/behavior-subject.ts` |
| AsyncQueue (translation helper) | new | — | — | build | T4b | `utils/async-queue.ts` |

## Live `SessionServices` deferrals (T5 wiring)

The bootstrap-side `buildDeferredServices` /
`buildDeferredConfig` / `buildDeferredModelInfo` helpers in
`runtime/src/bin/bootstrap.ts` (formerly `buildPlaceholderServices` /
`buildMinimalConfig` / `buildMinimalModelInfo`) carry the structural
shape of codex `SessionServices` for the live local-runtime path. Each
slot is either wired live today or is a structural stub waiting for the
owning tranche to land. This table records the live-vs-deferred split so
T5 reviewers do not have to re-derive it from the source.

| `SessionServices` slot | Status | Owner |
|---|---|---|
| `provider` / `registry` / `permissionModeRegistry` / `configStore` | live | T5/T11 |
| `toolApprovals` / `networkApproval` | live | T11 |
| `mcpManager` (live facade over `MCPManager`) | live | T9 |
| `agentControl` (rebound by `bindSessionAgentControl`) | live | T9 |
| `mcpConnectionManager` | deferred | T9 |
| `mcpStartupCancellationToken` | live (`AbortController`-backed token passed into MCP startup) | T9+ |
| `unifiedExecManager` | deferred | T7 |
| `userShell` | deferred | T7 |
| `execPolicy` | deferred | T11 |
| `hooks` (pre/post compact + stop + lifecycle) | deferred | T4 / T7 / T10 |
| `rollout` (codex `RolloutRecorder`) | deferred (separate `RolloutStore` is mounted live) | T5 |
| `agentIdentityManager` / `shellSnapshotTx` | deferred | T9 |
| `analyticsEventsClient` / `codeModeService` | deferred | T-future |
| `modelsManager` | live | T13 |
| `authManager` / `modelClient` | deferred structural facades; provider auth/client dispatch is live through `services.provider`, `llm/client.ts`, and adapter auth modules | T13+ |
| `sessionTelemetry` / `threadStore` | deferred | T6 |
| `skillsManager` / `pluginsManager` / `skillsWatcher` | live local filesystem loader; watcher currently cache invalidation only | T10 |

Live-session `Config` / `ModelInfo` deferrals (built by
`buildDeferredConfig` / `buildDeferredModelInfo`):

| Field | Status | Owner |
|---|---|---|
| `Config.features` (`appsEnabledForAuth`, `useLegacyLandlock`) | deferred (hard-false defaults) | T10 |
| `Config.multiAgentV2` (subagent usage hints) | deferred | T9 |
| `Config.permissions.allowLoginShell` / `shellEnvironmentPolicy` / `windowsSandboxPrivateDesktop` | deferred (conservative defaults) | T10 / T11 |
| `Config.ghostSnapshot` | deferred | T-future |
| `Config.agentRoles` | deferred | T9 |
| `ModelInfo.effectiveContextWindowPercent` | deferred fallback = `100` (codex backend default is `95`; was `1` and silently truncated context) | T13 |
| `ModelInfo.supportedReasoningLevels` | deferred fallback = `[]` (silently disables reasoning-level routing) | T13 |
| `ModelInfo.truncationPolicy` | deferred fallback = `"off"` | T13 |

`Session` constructor's own `deriveMinimalSessionConfig` /
`deriveMinimalModelInfo` helpers in `runtime/src/session/session.ts`
mirror the same fallback shape and the same per-field deferrals — they
exist for test fixtures that construct `Session` without bootstrap.

## Locked / untouched subsystems

| Feature | Source | File | LOC | Status |
|---|---|---|---|---|
| Grok adapter internals | agenc | `runtime/src/llm/grok/` → relocates to `llm/providers/grok/` | 8,144 | Relocated only — zero internal changes. Default provider, but not "locked" in the sense of being the only one. |
| ASCII girl | agenc | `watch/agenc-watch-art.mjs` | 168 | LOCKED — verbatim |
| Splash | agenc | `watch/agenc-watch-splash.mjs` | 169 | LOCKED — verbatim |
| Color palette | agenc | `watch/agenc-watch-ui-primitives.mjs` | 307 | LOCKED — verbatim |
| ANSI sequences | agenc | `watch/agenc-watch-terminal-sequences.mjs` | 89 | LOCKED — verbatim |
| Markdown stream modules | agenc | `watch/agenc-watch-markdown-*.mjs` + `agenc-watch-diff-render.mjs` + `agenc-watch-render-cache.mjs` + `agenc-watch-text-utils.mjs` | ~2,229 | LOCKED — logic modules consumed by Ink components |

## Explicit skips

| Feature | Source | Rationale |
|---|---|---|
| Dead compaction chain | agenc | No live call sites; delete in T4 |
| Rust OS sandbox primitives (Seatbelt/Landlock/seccomp/bubblewrap) | codex | Not portable to TS; worktree + permission evaluator + env jail suffice |
| Realtime voice conversation | codex | Out of scope for coding CLI |
| Guardian review | codex | Codex-specific |
| Collab agents | codex | Out of scope; subagents via mailbox are sufficient |
| Plan update/delta events | codex | `/plan` mode via permission mode is sufficient |
| Image generation tools | codex | Out of scope |
| Skills marketplace | oc | Can revive later as MCP plug-in |
| Team memory / private mode | oc | Defer until multi-user needed |
| Feature flag system (GrowthBook) | oc | Ant-internal; AgenC uses env vars + config |
| CCR v2 client orchestrator | oc | Anthropic-specific domain logic |
| Cloud tasks daemon | codex | Out of scope for lean CLI |
| Keyring store | codex | Platform-specific; env + config are enough |
| Process hardening | codex | Linux-specific |

## Dependency additions (npm)

Packages we'll need beyond AgenC's current deps:

| Package | For | Scope |
|---|---|---|
| `react@19.x` | Ink TUI | prod |
| `react-reconciler@0.33.x` | Ink reconciler | prod |
| `@alcalzone/ansi-tokenize@0.3.x` | ANSI style transitions | prod |
| `cli-boxes@3.x` | Border characters | prod |
| `lodash-es` | throttle, noop | prod |
| `auto-bind` | class method binding | prod |
| `signal-exit` | terminal restoration | prod |
| `indent-string` | text wrap helpers | prod |
| `js-yaml` | frontmatter parsing (memory files) | prod |
| `zod` (existing in oc tool hooks) | tool input validation | prod |
| `jimp` (existing) | ASCII art rasterization | prod |
| `@modelcontextprotocol/sdk` (existing) | MCP client | prod |
| `openai` (existing in Grok adapter) | OpenAI-compat SDK | prod |
| `eventsource` | SSE transport | prod |
| `ws` | WebSocket transport | prod |
| `undici` | HTTP POST transport | prod |
| `rxjs` or custom impl | BehaviorSubject equivalent | prod (pick one) |
