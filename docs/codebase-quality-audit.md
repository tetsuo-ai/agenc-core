# Codebase Quality Audit

This log tracks concrete slices of the ongoing agenc-core quality pass. It is
not a completion claim for the whole repository. Each entry records the code
paths traced, the defect or risk found, and the validation run before commit.

## 2026-06-22: Shared LLM Message Snapshot Helper

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/phases/commit.ts#commitPhase` snapshots turn messages before
  scheduling async memory extraction work.
- `runtime/src/services/extractMemories/extractMemories.ts#snapshotContext`
  clones queued extraction context before dispatching the background memory
  extractor.
- `runtime/src/memory/session/sessionMemory.ts` clones messages before
  session-memory child-agent requests and before passing context messages into
  the agent runner.
- `runtime/src/llm/content-conversion.ts#cloneLlmMessageSnapshot` now owns the
  shared message snapshot semantics.
- `runtime/tests/llm/content-conversion.test.ts`,
  `runtime/tests/phases/commit.test.ts`,
  `runtime/tests/services/extractMemories/extractMemories.test.ts`, and
  `runtime/tests/memory/session/sessionMemory.test.ts` cover the shared helper
  and its callers.

### Finding

Three async memory/session paths carried identical private `cloneMessage`
helpers. Each cloned the message shell, tool calls, and `runtimeOnly`, but
only shallow-copied each content block. That left nested image/document source
objects shared with the original history and made future snapshot semantics
easy to drift between commit, queued extraction, and session-memory child-agent
flows.

### Change

- Added `cloneLlmMessageSnapshot` beside the existing LLM content conversion
  helpers, reusing `cloneLlmContent` for deep content-block clones.
- Replaced the three private snapshot helpers in commit, extract-memories, and
  session-memory code with the shared helper.
- Added direct unit coverage for message snapshot independence across content
  blocks, nested document source data, tool calls, and `runtimeOnly` metadata.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/llm/content-conversion.test.ts tests/phases/commit.test.ts tests/services/extractMemories/extractMemories.test.ts tests/memory/session/sessionMemory.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Compact Kept Media Preservation

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/compact/compact.ts#compactConversationImpl` strips
  media from summary input before provider calls, chooses the kept suffix, and
  builds the post-compact replacement payload for manual/full compaction.
- `runtime/src/services/compact/compact.ts#partialCompactConversationAsync`
  summarizes either side of the selected message for daemon-backed partial
  compaction.
- `runtime/src/session/session.ts#partialCompactFromMessage` converts
  `LLMMessage` history into compact runtime messages, calls partial compact,
  rehydrates the replacement history, and commits it to session state and
  rollout storage.
- `runtime/src/session/session.ts#fromCompactRuntimeContent` restores runtime
  image/document blocks into `LLMMessage.content`.
- `runtime/tests/services/compact/compact.test.ts` and
  `runtime/tests/session/session.test.ts` cover the service-level and
  end-to-end session contracts.

### Finding

The compact service stripped image and document blocks before slicing the
messages that should be kept verbatim. That protected summarization provider
calls, but it also meant kept media could be committed back as `[image]` or
`[document]` placeholders. The session rehydration path also restored compacted
PDF document blocks without `fallbackText`, `fallbackTextTruncated`, or
`fallbackTextError`, so even unstripped kept documents lost fallback metadata
after daemon partial compaction.

### Change

- Kept stripped copies for summary input and token estimates, but now slices
  `messagesToKeep` from the original runtime message list for both full and
  partial compact flows.
- Preserved PDF document fallback metadata in
  `fromCompactRuntimeContent`.
- Added service regression coverage for manual compact and async partial
  compact kept-media preservation, plus a session-level partial-compact test
  that preserves a kept document and image through committed replacement
  history.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/services/compact/compact.test.ts tests/session/session.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared LLM Content Conversion Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/run-turn.ts#toAgenCRuntimeMessages` projects
  `LLMMessage` history into compact-service runtime messages before
  microcompact and auto-compact paths.
- `runtime/src/session/run-turn.ts#fromAgenCRuntimeMessages` rehydrates runtime
  compact output back into `LLMMessage` history before subsequent sampling.
- `runtime/src/phases/post-sample-recovery.ts#toCollapseRuntimeMessages` and
  `#fromCollapseRuntimeMessages` perform the same projection during
  prompt-too-long context-collapse recovery.
- `runtime/src/commands/session-compact.ts#toAgenCRuntimeMessages` and
  `#fromAgenCRuntimeMessages` use the same conversion for manual `/compact`
  and `/context` fallback counting paths.
- `runtime/tests/session/run-turn.compact-contract.test.ts`,
  `runtime/tests/phases/post-sample-recovery.compact-contract.test.ts`,
  `runtime/tests/runtime-session.compact-contract.test.ts`, and
  `runtime/tests/commands/session-compact-context.test.ts` cover the
  caller-level compact contracts.

### Finding

Three hot compact/recovery paths carried identical private helpers for cloning
LLM content, converting provider-compatible `image_url` blocks into runtime
`image` URL blocks, restoring runtime image blocks back to `image_url`, and
cloning PDF document parts with fallback metadata. A future copy drift in this
logic would corrupt multimodal history differently depending on whether the
turn was auto-compacted, manually compacted, or collapsed after a provider
prompt-too-long response.

### Change

- Added `runtime/src/llm/content-conversion.ts` with shared helpers for LLM
  content cloning and runtime content projection.
- Replaced the duplicate helper clusters in run-turn, post-sample recovery,
  and `/compact` command code.
- Added direct unit coverage for provider-compatible images, runtime image
  rehydration, PDF document fallback metadata, text-only runtime collapse, and
  legacy fallback behavior for invalid content values.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/llm/content-conversion.test.ts tests/runtime-session.compact-contract.test.ts tests/commands/session-compact-context.test.ts tests/phases/post-sample-recovery.compact-contract.test.ts tests/phases/post-sample-recovery.token-budget-cap.test.ts tests/session/run-turn.compact-contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: State SQL Placeholder Helper

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/state/export-import.ts#exportAgentState` loads session
  snapshots and in-flight tool calls for the exported agent session set.
- `runtime/src/state/export-import.ts#importAgentState` checks imported
  session ownership before replacing target rows.
- `runtime/src/state/recovery.ts#recoverDaemonStateOnStartup` loads
  recoverable agent runs, stale in-flight tool calls, and previously recovered
  tool calls during daemon startup recovery.
- `runtime/src/state/pruning.ts#pruneTerminalAgentRuns` loads terminal
  agent-run prune candidates by retention status group.
- `runtime/tests/state/export-import.test.ts`,
  `runtime/tests/state/recovery-restart.test.ts`, and
  `runtime/tests/state/pruning.test.ts` cover the SQLite paths using dynamic
  `IN` / `NOT IN` bind lists.

### Finding

The state layer had three private `placeholders()` helpers that generated the
same `?, ?, ?` SQL bind-list string in export/import, startup recovery, and
retention pruning. The duplication was small but sat on persistence code paths
where a future copy could silently drift, including whether empty dynamic lists
are rejected before constructing invalid `IN ()` SQL.

### Change

- Added `runtime/src/state/sql.ts#sqlPlaceholders` as the single state-layer
  helper for SQLite bind-list placeholder strings.
- Replaced the private helpers in export/import, recovery, and pruning.
- Added focused tests for one-item, multi-item, zero, negative, and fractional
  counts.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/state/sql.test.ts tests/state/export-import.test.ts tests/state/recovery-restart.test.ts tests/state/pruning.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Message API Normalization Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/turn-compat.ts#runTurnStreamCompat` normalizes legacy
  turn messages before SDK / compatibility event emission.
- `runtime/src/services/vcr.ts#recordRequest` normalizes model-bound messages
  before recording VCR payloads.
- `runtime/src/services/api/anthropic.ts` normalizes messages and then runs
  `ensureToolResultPairing` before provider requests.
- `runtime/src/utils/analyzeContext.ts`, `runtime/src/llm/wire/shared.ts`, and
  `runtime/src/llm/messages.ts` route adjacent message-shape analysis through
  the same API-facing normalization contracts.
- `runtime/tests/conversation/messages-core.test.ts` covers tool-reference
  stripping, unavailable tool references, assistant caller stripping, local
  command/user merging, content-size error replay stripping, errored
  tool-result sanitization, and trailing thinking/non-final empty assistant
  content.

### Finding

`normalizeMessagesForAPI` still mixed content-size replay mitigation,
tool-reference compatibility, local-command conversion, user/assistant/
attachment append semantics, assistant tool-use block normalization, and final
cleanup pass orchestration in one 377-line function. The function is on every
model request path and its pass order is fragile: content-size strip targets
must be computed before synthetic API errors are filtered, attachment/user/
assistant expansion must happen before thinking and whitespace cleanup, and
history-snip tags must stay after merging and sanitization.

### Change

- Added focused helpers for API input filtering, content-size strip target
  discovery, targeted meta-content stripping, tool-reference normalization,
  tool-reference turn-boundary injection, assistant tool-use block
  normalization, and user/assistant/attachment append/merge behavior.
- Preserved the existing collapsed feature-gate behavior and kept the final
  cleanup sequence unchanged.
- Kept content-size error-message lookup lazy. The first full-suite validation
  run caught that a top-level map called environment-sensitive error helpers at
  module import time; the lookup now executes only inside the normalization
  path, matching the prior behavior.
- Confirmed `normalizeMessagesForAPI` now measures 161 lines after extraction.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/context.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Tool Result Pairing Repair Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/turn-compat.ts#runTurnStreamCompat` converts phase
  events into legacy messages and runs `normalizeMessagesForAPI` before SDK /
  compatibility event emission.
- `runtime/src/services/vcr.ts#recordRequest` calls `normalizeMessagesForAPI`
  before recording model-bound VCR payloads.
- `runtime/src/services/api/anthropic.ts` runs `normalizeMessagesForAPI` and
  then `ensureToolResultPairing` before sending Anthropic-compatible requests.
- `runtime/src/phases/stream-model.ts`, `runtime/src/phases/execute-tools.ts`,
  and `runtime/src/recovery/terminal-tool-result.ts` are upstream producers of
  tool-use and synthetic terminal tool-result events that this repair pass must
  tolerate after resume, compaction, fallback, or interruption.
- `runtime/src/utils/messages.ts#ensureToolResultPairing` validates and repairs
  duplicate tool-use IDs, orphaned tool results, missing tool results, and
  interrupted server-side tool uses.
- `runtime/tests/conversation/messages-core.test.ts` covers duplicate
  assistant tool-use blocks, duplicate tool-result blocks, orphaned leading
  tool results, unresolved server tool uses, and valid server tool-use/result
  pairs.

### Finding

`ensureToolResultPairing` was still a single 327-line repair function mixing
five distinct concerns: user-message orphan stripping, assistant tool-use
deduplication, interrupted server-tool cleanup, following user-message
patching, and strict-mode diagnostic formatting. The repair policy is
load-bearing because it prevents provider 400s after resume, compaction,
fallback, or aborted tool execution. Keeping every branch inline made it hard
to audit whether the user-message and assistant-message paths were truly
orthogonal.

### Change

- Added focused helpers for tool-result block detection, unpaired user
  tool-result stripping, assistant tool-use content normalization, following
  user-message tool-result collection, synthetic tool-result construction,
  following user-message patching, and repair diagnostic formatting.
- Preserved strict-mode behavior: repairs are still detected first and strict
  mode still throws before logging a repaired request.
- Kept existing repair strings and placeholder behavior unchanged, including
  the conversation-resume orphan placeholder and interrupted tool-use
  placeholder.
- Confirmed `ensureToolResultPairing` now measures 153 lines after extraction.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Compatibility Attachment Normalizers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#processMcpResourceAttachments` emits
  `mcp_resource` attachments from user-requested MCP resource mentions.
- `runtime/src/utils/attachments.ts#getRelevantMemoryAttachments` and
  `runtime/src/utils/attachments.ts#collectSurfacedMemories` emit and de-dupe
  `relevant_memories` attachments for persistent memory surfacing.
- `runtime/src/utils/attachments.ts#getAttachments` gates turn-zero
  `skill_discovery` and agent-swarm `teammate_mailbox` / `team_context`
  attachments before they reach model-message normalization.
- `runtime/src/utils/attachments.ts#getTeammateMailboxAttachments` and
  `runtime/src/utils/attachments.ts#getTeamContextAttachment` produce the
  swarm-specific attachments that must keep their string-literal guards for
  build-time dead-code elimination.
- `runtime/src/session/turn-compat.ts#runTurnStreamCompat` emits
  `max_turns_reached` as a non-error attachment when forked runs hit their turn
  cap.
- `runtime/src/utils/collapseTeammateShutdowns.ts#collapseTeammateShutdowns`
  emits `teammate_shutdown_batch` UI bookkeeping attachments.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` converts the
  remaining model-facing compatibility wrappers and drops model-inert
  bookkeeping attachments.
- `runtime/tests/conversation/messages-core.test.ts` and
  `runtime/tests/conversation/messages-skill-discovery.test.ts` cover unsafe
  relevant-memory, MCP-resource, skill-discovery, swarm-context, and no-op
  compatibility attachment normalization.

### Finding

The final inline cluster in `normalizeAttachmentForAPI` still mixed
feature-gated pre-switch branches, untrusted memory/resource wrappers, and the
legacy removed-attachment list directly inside the dispatcher. That made the
dead-code-elimination constraints around `teammate_mailbox`, `team_context`,
and `skill_discovery` easy to disturb during ordinary cleanup. It also left
known UI/bookkeeping attachment types such as `current_session_memory`,
`max_turns_reached`, and `teammate_shutdown_batch` to fall through to the
unknown-attachment logger if replayed through API normalization, even though
they intentionally contribute no model context.

### Change

- Added typed aliases and focused normalizers for teammate mailbox, team
  context, skill discovery, relevant memories, and MCP resource attachments.
- Moved the removed-attachment compatibility list to a module-level set and
  left the DCE-sensitive `bagel_console` string out of runtime case labels
  because no API producer exists for it.
- Made the known model-inert UI/bookkeeping attachments return `[]`
  explicitly, with regression coverage for `current_session_memory`,
  `max_turns_reached`, and `teammate_shutdown_batch`.
- Preserved the existing feature-gated pre-switch pattern for
  `teammate_mailbox`, `team_context`, and `skill_discovery`.
- Confirmed `normalizeAttachmentForAPI` now measures 191 lines, with the
  extracted compatibility helpers measuring 10 to 42 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts tests/conversation/messages-skill-discovery.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Session Reminder Attachment Normalizers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#getAttachments` wires thread-safe reminder
  attachments for `date_change`, `ultrathink_effort`, `skill_listing`,
  `plan_mode_reentry`, `plan_mode_exit`, `auto_mode_exit`, `todo_reminder`,
  `task_reminder`, `critical_system_reminder`, `compaction_reminder`, and
  `context_efficiency`.
- `runtime/src/utils/attachments.ts#processAgentMentions` emits
  `agent_mention` attachments from user `@agent-...` input after active-agent
  resolution.
- `runtime/src/utils/attachments.ts#getOutputStyleAttachment` emits
  `output_style` attachments for non-default configured styles on the main
  thread.
- `runtime/src/utils/attachments.ts#getVerifyPlanReminderAttachment` emits
  `verify_plan_reminder` while post-plan verification is pending and the turn
  cadence matches.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` converts these
  session reminders and mode-transition notices into legacy model-facing
  system reminders.
- `runtime/tests/conversation/messages-core.test.ts` covers unsafe
  skill-listing, todo/task reminder, plan-mode reentry/exit,
  critical-reminder, agent-mention, date-change, ultrathink, output-style,
  compaction, context-efficiency, and verify-plan reminder payloads.
- `runtime/tests/utils/monotonic.test.ts` covers monotonic clock advancement
  and elapsed-time helpers used by session timeout and duration paths.

### Finding

Session reminder normalization mixed user- and environment-originated reminder
content, mode-transition guidance, feature-gated snip nudges, and output-style
lookup directly inside the large attachment dispatcher. The branches are small
individually, but each owns a distinct compatibility string or sanitizer gate,
and several differ from the newer prompt attachment renderer. During validation,
the full Vitest gate also exposed a flaky monotonic timing assertion that
expected a 5 ms timer to always produce at least 4 ms of measured elapsed time
under full-suite scheduler load.

### Change

- Added typed aliases for `invoked_skills`, `todo_reminder`, `task_reminder`,
  `skill_listing`, `output_style`, `plan_mode_reentry`, `plan_mode_exit`,
  `critical_system_reminder`, `agent_mention`, `date_change`,
  `ultrathink_effort`, and `companion_intro` attachments.
- Split inline branches into focused normalizers for invoked skills, todo/task
  reminders, skill listing, output style, plan/auto mode exits and reentry,
  critical reminders, agent mentions, compaction, context efficiency, date
  changes, ultrathink effort, companion intro, and verify-plan reminders.
- Preserved legacy strings and gates, including `OUTPUT_STYLE_CONFIG` lookup,
  `AGENC_DISABLE_TOOL_REMINDERS`, Todo V2 gating, lazy `HISTORY_SNIP` require,
  and the AgenC-safe verify-plan reminder wording.
- Hardened `runtime/tests/utils/monotonic.test.ts` to assert monotonic
  advancement after a longer sleep instead of relying on a narrow timer
  threshold that can fail under load.
- Confirmed `normalizeAttachmentForAPI` now measures 263 lines, with the
  extracted session-reminder helpers measuring 6 to 30 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/monotonic.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: File Context Attachment Normalizers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#processAtMentionedFiles` emits
  `directory` attachments for at-mentioned directories and delegates regular
  files to `generateFileAttachment`.
- `runtime/src/utils/attachments.ts#generateFileAttachment` emits `file` and
  `compact_file_reference` attachments after permission checks and canonical
  FileRead execution.
- `runtime/src/utils/attachments.ts#tryGetPDFReference` emits
  `pdf_reference` attachments for large at-mentioned PDFs that should be read
  page-by-page.
- `runtime/src/utils/attachments.ts#getChangedFiles` emits
  `edited_text_file` attachments for changed text files already read into the
  session.
- `runtime/src/utils/attachments.ts#getSelectedLinesFromIDE` and
  `runtime/src/utils/attachments.ts#getOpenedFileFromIDE` emit IDE selection
  and opened-file context after permission checks.
- `runtime/src/utils/attachments.ts#memoryFilesToAttachments` emits
  `nested_memory` attachments for nested instruction files.
- `runtime/src/utils/plans.ts#recoverPlanFromMessages` and
  `runtime/src/planning/plan-files.ts#recoverPlanFromRecord` still consume
  `plan_file_reference` attachments as post-compaction plan preservation
  compatibility data.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` converts these
  attachments into legacy model-facing tool messages or system reminders.
- `runtime/tests/conversation/messages-core.test.ts` covers normal and unsafe
  directory, file, compact-file, PDF, IDE selection/opened-file, plan-file, and
  nested-memory payloads.

### Finding

File, IDE, plan-file, and nested-memory normalization mixed tool-message
simulation, truncation reminders, PDF read guidance, and system-reminder
sanitization directly inside the large attachment dispatcher. These attachments
carry user- or environment-originated paths and content, so the important
trust-boundary behavior is not the switch routing itself; it is the precise
sanitize-and-wrap sequence for each context shape.

### Change

- Added typed aliases for `directory`, `edited_text_file`, `file`,
  `compact_file_reference`, `pdf_reference`, `selected_lines_in_ide`,
  `opened_file_in_ide`, `plan_file_reference`, and `nested_memory`
  attachments.
- Split the inline branches into focused normalizers for each attachment kind.
- Preserved existing FileRead/Bash synthetic tool messages, truncation text,
  PDF page-read guidance, IDE selection truncation, plan-file wording, and
  nested-memory wrapping.
- Confirmed `normalizeAttachmentForAPI` now measures 429 lines, with the
  extracted context helpers measuring 22, 12, 23, 11, 16, 18, 11, 14, and
  12 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Delta Attachment Normalizers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#getDeferredToolsDeltaAttachment` emits
  `deferred_tools_delta` notices after ToolSearch and deferred-tool gating.
- `runtime/src/utils/attachments.ts#getAgentListingDeltaAttachment` emits
  `agent_listing_delta` notices after filtering available agent definitions and
  reconstructing prior transcript state.
- `runtime/src/utils/attachments.ts#getMcpInstructionsDeltaAttachment` emits
  `mcp_instructions_delta` notices from MCP instruction diffs, including the
  ToolSearch client-side instruction entry.
- `runtime/src/prompts/mcp-instructions-framing.ts#renderMcpInstructionsDeltaSection`
  frames added MCP instructions as untrusted server-provided content.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` converts the delta
  attachments into legacy model-facing reminders.
- `runtime/src/prompts/attachments/messages.ts` contains the newer prompt
  attachment renderer for the same delta attachment kinds, with intentionally
  different wording in a few places.
- `runtime/tests/conversation/messages-core.test.ts` covers normal and unsafe
  deferred-tool, agent-listing, and MCP-instructions delta payloads.

### Finding

The deferred-tool, agent-listing, and MCP-instructions delta branches mixed
dynamic ToolSearch/agent/MCP capability-change notices, sanitization of
untrusted added and removed names or lines, and MCP instruction framing directly
inside the large attachment dispatcher. Since the newer prompt renderer covers
similar attachment kinds but intentionally uses different wording, leaving the
legacy compatibility formatting inline made accidental drift more likely.

### Change

- Added typed aliases for `deferred_tools_delta`, `agent_listing_delta`, and
  `mcp_instructions_delta` attachments.
- Split the inline branches into `normalizeDeferredToolsDeltaAttachment`,
  `normalizeAgentListingDeltaAttachment`, and
  `normalizeMcpInstructionsDeltaAttachment`.
- Preserved legacy `utils/messages.ts` wording, including the ToolSearch
  removed text with an em dash and no MCP-specific direct-call nudge, the
  `Agent tool` label and concurrency note, and MCP instruction framing through
  `renderMcpInstructionsDeltaSection`.
- Confirmed `normalizeAttachmentForAPI` now measures 528 lines, with the
  extracted delta helpers measuring 22, 26, and 23 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Usage And Budget Attachment Normalizers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#getTokenUsageAttachment` emits
  `token_usage` attachments when `AGENC_ENABLE_TOKEN_USAGE_ATTACHMENT` is set.
- `runtime/src/utils/attachments.ts#getMaxBudgetUsdAttachment` emits
  `budget_usd` attachments when a max USD budget is configured.
- `runtime/src/utils/attachments.ts#getOutputTokenUsageAttachment` emits
  `output_token_usage` attachments when the token-budget feature is active and
  a positive turn budget exists.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` wraps these
  accounting notices in model-facing system reminders.
- `runtime/src/prompts/attachments/messages.ts` contains the newer prompt
  attachment renderer for the same attachment kinds, which makes preserving
  legacy `utils/messages.ts` formatting explicit.
- `runtime/tests/conversation/messages-core.test.ts` covers token usage,
  USD budget, output token budget formatting, and null output token budget
  formatting.

### Finding

Token, USD budget, and output-token usage normalization kept small but distinct
accounting formatting rules directly inside the large attachment dispatcher.
The branches are not security-sensitive, but they are user-facing budget
notices, and the legacy compatibility renderer intentionally does not format
`token_usage` and `budget_usd` the same way as the newer prompt-attachment
renderer. Keeping that detail inline made accidental formatter drift more likely
during unrelated dispatcher edits.

### Change

- Added typed aliases for `token_usage`, `budget_usd`, and
  `output_token_usage` attachments.
- Split the inline branches into `normalizeTokenUsageAttachment`,
  `normalizeBudgetUsdAttachment`, and `normalizeOutputTokenUsageAttachment`.
- Preserved the existing token and USD strings exactly, including raw
  `token_usage` and `budget_usd` values and abbreviated output-token values.
- Confirmed `normalizeAttachmentForAPI` now measures 586 lines, with the
  extracted accounting helpers measuring 12, 12, and 16 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Runtime Hook Attachment Normalizers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/hooks.ts`, `runtime/src/utils/hooks/execPromptHook.ts`,
  and `runtime/src/utils/hooks/execAgentHook.ts` emit hook success and blocking
  error attachments from configured hook execution.
- `runtime/src/tools/execution.ts` emits `hook_additional_context`,
  `hook_blocking_error`, and `hook_stopped_continuation` attachments from live
  tool hook decisions.
- `runtime/src/llm/hooks/dispatcher.ts` emits hook additional context and
  stopped-continuation attachments from LLM hook dispatch results.
- `runtime/src/prompts/hook-context-framing.ts#renderHookAdditionalContextSection`
  frames hook-provided context as untrusted command output.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` converts hook
  attachments into model-facing reminders or framed context.
- `runtime/tests/conversation/messages-core.test.ts` covers hook blocking
  errors, event-filtered hook success, empty hook content suppression,
  additional-context framing, escaped hook context delimiters, and stopped
  continuations.

### Finding

Runtime hook normalization handled multiple untrusted hook-output shapes
directly inside the large attachment dispatcher. The branch cluster mixed
system-reminder sanitization, success event filtering, empty-content
suppression, and dedicated hook-context framing beside unrelated attachment
cases, increasing the chance that future hook edits would bypass the intended
trust boundary.

### Change

- Added typed aliases for `hook_blocking_error`, `hook_success`,
  `hook_additional_context`, and `hook_stopped_continuation` attachments.
- Split the inline hook branches into
  `normalizeHookBlockingErrorAttachment`,
  `normalizeHookSuccessAttachment`,
  `normalizeHookAdditionalContextAttachment`, and
  `normalizeHookStoppedContinuationAttachment`.
- Preserved the existing `SessionStart`/`UserPromptSubmit` success filter,
  empty-content suppression, system-reminder sanitization, and
  `renderHookAdditionalContextSection` framing.
- Confirmed `normalizeAttachmentForAPI` now measures 609 lines, with the
  extracted hook helpers measuring 19, 21, 21, and 14 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Diagnostics Attachment Normalizer

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#getDiagnosticAttachments` emits new
  Bash-triggered IDE diagnostics as `diagnostics` attachments.
- `runtime/src/utils/attachments.ts#getLSPDiagnosticAttachments` emits passive
  LSP diagnostics and clears delivered registry entries.
- `runtime/src/services/diagnosticTracking.ts#formatDiagnosticsSummary`
  centralizes diagnostic file formatting before model delivery.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` wraps formatted
  diagnostics in a system-reminder `<new-diagnostics>` block.
- `runtime/tests/conversation/messages-core.test.ts` covers empty diagnostics,
  regular diagnostics, and unsafe diagnostic payloads containing
  `</system-reminder>` and `</new-diagnostics>` text.

### Finding

Diagnostics normalization mixed centralized formatting, diagnostic tag
neutralization, and system-reminder wrapping directly inside the large
attachment dispatcher. Because diagnostics are untrusted IDE/LSP-originated
content and the branch owns `<new-diagnostics>` framing, leaving the behavior
inline increased the risk that a future attachment edit would bypass the
neutralization boundary.

### Change

- Added a typed `DiagnosticsAttachment` helper alias and
  `normalizeDiagnosticsAttachment`.
- Moved empty diagnostics handling, centralized formatting, tag neutralization,
  and `<new-diagnostics>` wrapper construction into the helper.
- Left `normalizeAttachmentForAPI` delegating the `diagnostics` case without
  changing wrapper semantics.
- Confirmed `normalizeAttachmentForAPI` now measures 663 lines, with the
  extracted diagnostics helper measuring 16 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Queued Command Attachment Normalizer

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#getQueuedCommandAttachments` converts
  queued user input, pasted images, and task notifications into
  `queued_command` attachments.
- `runtime/src/utils/attachments.ts#getAgentPendingMessageAttachments` creates
  coordinator-origin queued messages for pending agent messages.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` maps queued
  commands into model-facing user messages while preserving UUID, origin,
  transcript visibility, text wrapping, and image blocks.
- `runtime/tests/conversation/messages-core.test.ts` covers plain queued text,
  unsafe text sanitization, task-notification origin/meta behavior, image block
  preservation, and UUID propagation.

### Finding

The queued-command branch carried several compatibility rules directly inside
the large attachment dispatcher. The most important rule is that human input
drained mid-turn must remain visible, while system-generated queued commands
must be meta and carry origin. Keeping that logic inline made future attachment
edits riskier because the branch also handles content-block prompts and image
preservation.

### Change

- Added a typed `QueuedCommandAttachment` helper alias and
  `normalizeQueuedCommandAttachment`.
- Moved origin fallback, meta visibility, string prompt wrapping, content-block
  prompt wrapping, image block preservation, and UUID propagation into the
  helper.
- Kept concise comments next to the origin/meta rules that protect transcript
  visibility.
- Confirmed `normalizeAttachmentForAPI` now measures 676 lines, with the
  extracted queued-command helper measuring 53 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Async Hook Response Attachment Normalizer

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#getAsyncHookResponseAttachments` converts
  completed async hook responses into `async_hook_response` attachments.
- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` maps those
  attachments into model-facing system-reminder messages and hook additional
  context sections.
- `runtime/prompts/hook-context-framing.ts` frames hook additional context as
  untrusted command output.
- `runtime/tests/conversation/messages-core.test.ts` covers async hook system
  messages, additional context framing, and empty-response normalization.

### Finding

The async hook response branch mixed two separate message shapes inside the
large attachment dispatcher: system messages that must be sanitized and wrapped
as system reminders, and additional-context sections that are already framed by
the hook-context renderer. Keeping that branch inline made the wrapper boundary
harder to see beside unrelated attachment cases.

### Change

- Added a typed `AsyncHookResponseAttachmentForAPI` helper alias and
  `normalizeAsyncHookResponseAttachment`.
- Moved the existing system-message sanitization and additional-context framing
  logic into the helper.
- Left `normalizeAttachmentForAPI` delegating the `async_hook_response` case
  without changing message order or wrapper semantics.
- Confirmed `normalizeAttachmentForAPI` now measures 731 lines, with the
  extracted async hook helper measuring 42 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Task Status Attachment Normalizer

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/messages.ts#normalizeAttachmentForAPI` converts persisted
  attachment records into model-facing `UserMessage` entries.
- The `task_status` attachment branch handles stopped, running, completed, and
  failed background task state after transcript compaction.
- `runtime/tests/conversation/messages-core.test.ts` covers stopped, running,
  and completed task-status normalization, including system-reminder
  neutralization.

### Finding

`normalizeAttachmentForAPI` remained a large attachment dispatcher with
state-specific background-task formatting embedded directly in the switch. That
made the task-status behavior harder to review beside unrelated attachment
cases and kept a future attachment edit close to duplicate-spawn warning logic.

### Change

- Added a typed `TaskStatusAttachment` helper alias and
  `normalizeTaskStatusAttachment`.
- Moved the existing task-status formatting and sanitization logic into the
  helper while preserving stopped/running/completed output shape.
- Left the dispatcher as a narrow type switch that delegates `task_status` to
  the helper.
- Confirmed `normalizeAttachmentForAPI` now measures 770 lines, with the
  extracted helper measuring 82 lines.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/conversation/messages-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Public Package Identity In Build Macros

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/build.config.ts` injects `MACRO.PACKAGE_URL` into the bundled runtime.
- `runtime/src/utils/autoUpdater.ts` uses `MACRO.PACKAGE_URL` for `npm view`
  and `npm install -g` update paths.
- `runtime/src/utils/localInstaller.ts` uses `MACRO.PACKAGE_URL` for local
  `~/.agenc/local` installs.
- `runtime/src/tui/components/AutoUpdater.tsx` renders recovery commands using
  `MACRO.PACKAGE_URL`.
- `runtime/src/utils/nativeInstaller/installer.ts` uses `MACRO.PACKAGE_URL` as
  the launcher package to clean up alongside the private runtime package.
- `runtime/src/utils/doctorDiagnostic.ts` includes `MACRO.PACKAGE_URL` in
  installation diagnostics and cleanup guidance.

### Finding

The build macro still pointed at `@tetsuo-ai/runtime`, which is the private
runtime package. User-facing update/install paths should use the public launcher
package, `@tetsuo-ai/agenc`.

### Change

- `runtime/build.config.ts` now defines a single `publicPackageName` constant
  and injects it through `MACRO.PACKAGE_URL`.
- Tests that seeded the obsolete package name now use `@tetsuo-ai/agenc`.
- `runtime/tests/meta/license-and-version.test.ts` has a build-contract check
  that prevents the macro from drifting back to the private runtime package.
- `runtime/tests/utils/agencInstallSurfaces.test.ts` now asserts cleanup checks
  both `@tetsuo-ai/runtime` and `@tetsuo-ai/agenc`.
- The obsolete unexported SDK declaration stub was removed after the follow-up
  SDK surface audit; the runtime root export remains daemon-embedding focused.
- `runtime/tests/scripts/check-local-vllm-smoke.test.ts` clears ambient local
  model environment variables in its child-process smoke run so developer
  machine settings cannot override the fake server's model ID.

### Validation

- `npm run typecheck`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `npm run check:unused`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/meta/license-and-version.test.ts tests/bin/doctor-cli.test.ts tests/utils/agencInstallSurfaces.test.ts tests/tui/components/AutoUpdater.wave200-039.coverage.test.tsx tests/tui/coverage-swarm/swarm-050-components-AutoUpdater.test.tsx --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/zpurgec-build-resolution.test.ts --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/scripts/check-local-vllm-smoke.test.ts --reporter=dot`

### Remaining Work

- Continue auditing large runtime slices, especially SDK/package boundaries,
  dispatcher optional-service behavior, and repeated command-menu patterns.
- Do not mark the full quality goal complete until every repository area has
  stronger current-state evidence than this first slice provides.

## 2026-06-22: Runtime SDK Boundary Cleanup

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/package.json` exposes only the runtime root export from `dist/index`.
- `runtime/src/index.ts` exports daemon embedding primitives for in-process and
  WebSocket transports.
- `runtime/src/entrypoints/agentSdkTypes.ts` is internal type plumbing used by
  hooks, messages, and SDK event surfaces.
- `runtime/src/entrypoints/sdk.d.ts` had no importers, was not copied to
  `dist`, and was not part of package exports.
- `runtime/tests/app-server/*sdk*.contract.test.ts` validate the sibling
  `agenc-sdk` daemon wrapper and examples as the consumer-facing SDK package.

### Finding

`runtime/src/entrypoints/sdk.d.ts` advertised a standalone query-style SDK with
functions such as `queryAsync`, `deleteSession`, and `unstable_v2_*`. The file
was not exported or shipped, referenced a nonexistent `src/entrypoints/sdk`
implementation path, and claimed drift was caught by a validator that is not in
this repository.

### Change

- Removed the unexported SDK declaration stub instead of trying to maintain a
  false public contract.
- Updated the stale `sessionState` comment that still referenced `sdk.d.ts`.
- Added a meta test that prevents the hidden declaration stub from returning and
  asserts the runtime root export stays focused on daemon embedding primitives.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/meta/license-and-version.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Async Local JSX Command Helper

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/local-jsx-command.ts` owned the shared local JSX open
  and close payload for simple slash-command TUI surfaces.
- Remaining direct local JSX surfaces were `resume-menu.tsx`,
  `agents-menu.tsx`, `tasks.ts`, `memory/slash.ts`, `help.ts`, and
  `session-compact.ts`.
- `resume` and `agents` render synchronously but have command-specific bridge
  data (`requestResumeSession`, available tools).
- `tasks`, `memory`, `help`, and `context` lazily import TUI components only
  when a TUI bridge is present; headless command execution must keep falling
  back without loading those renderers.
- Focused tests cover the affected commands in
  `agent-management.test.tsx`, `resume-menu.test.tsx`, `help.test.ts`,
  `tasks.test.ts`, `memory.contract.test.tsx`, and
  `session-compact-context.test.ts`.

### Finding

The first local JSX helper removed duplication from simple menu openers, but
specialized command surfaces still repeated the same bridge check, local JSX
flags, and clear payload. The async surfaces needed a helper that preserves
lazy imports and headless fallbacks.

### Change

- Extended `local-jsx-command.ts` with `openAsyncLocalJsxCommand`, sharing the
  same bridge detection, local JSX flags, prompt visibility default, and clear
  payload as the synchronous opener.
- Migrated `resume`, `agents`, `tasks`, `memory`, `help`, and `context` command
  surfaces to the shared helpers while preserving their rendered components,
  command-specific bridge data, and fallback behavior.
- Added focused async-helper tests proving the no-bridge path does not invoke
  the render callback and the bridged path opens after the callback resolves.
- Updated the memory command contract to assert the lazy command body remains
  behind the shared async helper boundary.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/commands/local-jsx-command.test.ts tests/commands/agent-management.test.tsx tests/commands/resume-menu.test.tsx tests/commands/help.test.ts tests/commands/tasks.test.ts tests/commands/memory/memory.contract.test.tsx tests/commands/session-compact-context.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: LSP Tool Schema Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/LSPTool/schemas.ts` defines the discriminated union used
  by `LSPTool.validateInput` for operation-specific parsing.
- `runtime/src/tools/LSPTool/LSPTool.ts` exposes the model-facing input and
  output schemas and then validates inputs against the discriminated union.
- `runtime/src/tools/LSPTool/LSPTool.ts#getMethodAndParams` maps every current
  operation to the LSP request method while preserving the existing requirement
  that all tool inputs include `filePath`, 1-based `line`, and 1-based
  `character`.
- `runtime/tests/bin/model-facing-tools.test.ts` covers model-facing LSP
  definition, references, symbols, diagnostics, and no-server behavior.

### Finding

The LSP input schemas repeated the same operation list and
`filePath`/`line`/`character` field definitions across the discriminated union
and the tool-facing object schema. Adding or renaming an LSP operation required
manual edits in multiple places, which made schema drift easy.

### Change

- Added shared `LSP_TOOL_OPERATIONS` and `LSP_POSITION_INPUT_FIELDS` constants
  in `runtime/src/tools/LSPTool/schemas.ts`.
- Replaced the repeated operation branch bodies with a narrow
  `positionOperationSchema` helper while keeping each branch's operation
  literal for discriminated-union parsing.
- Reused the same operation tuple and position-field schemas in
  `runtime/src/tools/LSPTool/LSPTool.ts` for the public tool input schema.
- Added focused schema tests that assert every declared operation is accepted by
  both schemas and that unknown operations or non-positive editor positions are
  rejected.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/LSPTool/schemas.test.ts tests/bin/model-facing-tools.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: NVIDIA NIM Model Catalog Builder

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/model/nvidiaNimModels.ts` owns provider detection for
  NVIDIA NIM and the model-option list used by the picker.
- `runtime/src/utils/model/modelOptions.ts#getModelOptionsBase` calls
  `isNvidiaNimProvider()` and then prepends the default option to
  `getCachedNvidiaNimModelOptions()`.
- `runtime/tests/utils/model/providers.test.ts` covers provider detection for
  the `NVIDIA_NIM` flag and precedence around stale provider environment.
- `runtime/tests/services/api/client.test.ts`,
  `runtime/tests/llm/provider.test.ts`, and
  `runtime/tests/llm/provider-parity.test.ts` cover the request-path provider
  wiring, default base URL, default model, and API key handling.

### Finding

The NVIDIA NIM picker catalog repeated the same `description` field in every
row and included two picker entries with the same
`mistralai/mixtral-8x22b-instruct-v0.1` value. That made category drift easy
and rendered a duplicate selectable row in the model picker.

### Change

- Replaced the flat row list with grouped `[value, label]` tuples keyed by a
  shared group `description`.
- Added a build step inside the cached catalog path that rejects duplicate model
  values before returning picker options.
- Removed the duplicate Mixtral picker row while preserving all other model
  values and selected category metadata.
- Added focused catalog tests that assert unique picker values, pin selected
  category metadata, and preserve the existing cache reference behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/model/nvidiaNimModels.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Copilot Model Registry Builder

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/model/copilotModels.ts` exports the GitHub Copilot model
  registry and the `getCopilotModelIds`, `getCopilotModel`, and
  `getAllCopilotModels` accessors.
- `runtime/src/utils/model/modelOptions.ts#getCopilotModelOptions` maps
  `getAllCopilotModels()` into `/model` picker rows when
  `getAPIProvider() === 'github'`.
- `runtime/tests/utils/model/modelOptions.github.test.ts` verifies the GitHub
  provider picker includes Copilot registry entries.
- `runtime/tests/utils/model/providers.test.ts` covers provider detection and
  GitHub native-model mode behavior.

### Finding

The Copilot registry repeated the same cost, modality, capability, and date
metadata in nearly every model object. The header comment also still claimed
there were 19 models, while the current registry exports 21.

### Change

- Replaced the repeated full-object registry with a shared default metadata
  object plus per-model override definitions.
- Kept the exported `COPILOT_MODELS` object and accessor functions unchanged for
  current consumers.
- Added duplicate-ID rejection while building the registry.
- Added focused registry tests that pin model order, key/id sync, selected
  default and override metadata, and nested metadata object independence.
- Removed the stale hardcoded model-count comment.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/model/copilotModels.test.ts tests/utils/model/modelOptions.github.test.ts --reporter=dot`
- Old-vs-new registry comparison from `HEAD` confirmed exported JSON is
  identical across all 21 models.
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Anthropic Cache Breakpoint Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/api/anthropic.ts#addCacheBreakpoints` converts
  normalized runtime messages into Anthropic request messages, places the
  single message-level cache marker, inserts cached-microcompact edit blocks,
  and annotates cached-prefix tool results with `cache_reference`.
- `runtime/src/services/api/anthropic.ts#paramsFromContext` calls
  `addCacheBreakpoints` for logging, streaming requests, retries, and
  nonstreaming fallback requests.
- `runtime/src/services/compact/cachedMicrocompact.ts` is the disabled-surface
  feature gate used before the cache-edit path can run.
- `runtime/src/services/compact/microCompact.ts` owns pending and pinned cache
  edit state consumed by the request builder.
- `runtime/tests/services/api/anthropic-core.test.ts` is the focused request
  assembly harness for the Anthropic API adapter.

### Finding

`addCacheBreakpoints` was doing cache marker placement, cache-edit
deduplication/insertion, cache-edit pinning, and `cache_reference` annotation in
one 143-line helper. That made the sensitive request-shape logic hard to review
and left the cached-microcompact tool-result annotation path without direct
request-shape coverage.

### Change

- Split cache-edit deduplication, pinned/new edit insertion, mutable user
  content coercion, cache-control boundary detection, and tool-result
  annotation into private helpers.
- Kept the existing early return when cached microcompact is inactive, so
  cache-reference annotation remains scoped to the cache-edit feature path.
- Removed a stale comment that described the private helper as exported for
  testing.
- Extended the Anthropic core request test harness with feature-gate mocks for
  cached microcompact and added focused coverage that a tool result before the
  cache boundary receives `cache_reference` without mutating the original
  message block.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/services/api/anthropic-core.test.ts --reporter=dot`
- Node long-function heuristic confirmed `addCacheBreakpoints` no longer
  appears in the Anthropic `>=80` line helper list; `paramsFromContext` remains
  the next Anthropic hotspot.
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Anthropic Request Params Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/api/anthropic.ts#paramsFromContext` builds the final
  Anthropic request object for logging, retries, streaming attempts, and
  nonstreaming fallback attempts.
- Request assembly combines beta headers, extra body parameters, output config,
  thinking config, context management, prompt caching, fast-mode speed, AFK beta
  headers, cached-microcompact state, and temperature behavior.
- `configureEffortParams`, `configureTaskBudgetParams`,
  `getAPIContextManagement`, `getPromptCachingEnabled`, and
  `addCacheBreakpoints` are the direct helper dependencies of that request
  builder.
- `runtime/tests/services/api/anthropic-core.test.ts` captures request payloads
  through the mocked Anthropic client and is the focused harness for this code
  path.

### Finding

After splitting `addCacheBreakpoints`, `paramsFromContext` was still a
198-line closure mixing output-config mutation, thinking selection,
context-management payloads, mode beta headers, cached-microcompact flags, and
the final request object. That made retry request-shape changes hard to review,
and the budgeted-thinking branch had no direct request-payload assertion in the
core API harness.

### Change

- Extracted named helpers for output-config assembly, thinking parameter
  selection, fast-mode speed/header handling, AFK beta insertion,
  cached-microcompact request state, and context-management payload assembly.
- Preserved the final request-object ordering so `system` still appears before
  `messages` for Bun attestation cache replacement.
- Added focused coverage for budgeted thinking with adaptive thinking disabled:
  `thinking.budget_tokens` is capped below `max_tokens` and `temperature` is
  omitted while thinking is enabled.
- Added the missing `getCanonicalName` export to the Anthropic core test's
  model mock so real thinking-support logic can execute in that harness.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/services/api/anthropic-core.test.ts --reporter=dot`
- Node long-function heuristic confirmed `paramsFromContext` is now 119 lines,
  below the 120-line hotspot threshold used by this audit.
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Dispatcher Optional-Service Responses

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/app-server/daemon-dispatcher.ts` routes every known JSON-RPC
  method after connection initialization.
- Optional collaborators include `sessionManager`, `clientMultiplexer`,
  `daemonControl`, `authBackend`, and optional agent-manager hook/permission
  methods.
- Default collaborators cover `fuzzyFileSearch`, `commandExec`, `health`, and
  `realtime`; these remain intentionally available without explicit injection.
- `runtime/src/app-server/client-multiplexer.ts` reconciles session routes for
  detach/terminate calls when a multiplexer is present.
- Dispatcher tests already covered daemon reload auth, auth backend absence,
  command-exec notification requirements, and several session-manager fallbacks.

### Finding

Unavailable optional-method responses were duplicated across the dispatcher, and
coverage for some of those branches was incomplete. In particular, missing
`session.list`, missing `session.attach`, missing hook methods, and missing
`permission.list` were not locked to the same `-32601` JSON-RPC response as
the already-tested unavailable branches.

### Change

- Added a shared `methodNotImplementedResponse` helper for unavailable known
  daemon methods.
- Reused that helper across missing session manager, daemon control, hook, and
  permission branches.
- Extended dispatcher contract tests so optional-service absence returns
  `-32601` before parameter validation for session, hook, and permission
  methods.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/app-server/daemon-dispatcher.contract.test.ts tests/app-server/daemon-dispatcher.hooks.contract.test.ts tests/app-server/daemon-dispatcher.session-control.contract.test.ts tests/app-server/daemon-dispatcher.auth-backend.contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm run check:unused`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Internal SDK Type Barrel Tightening

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/entrypoints/agentSdkTypes.ts` is imported by hook, message,
  attachment, tool, and bootstrap code as an internal SDK event/type barrel.
- `runtime/src/entrypoints/sdk/coreTypes.ts` re-exports generated SDK
  message, hook, permission, and runtime event types.
- `runtime/src/entrypoints/sdk/coreSchemas.ts` is the Zod source of truth for
  generated SDK types, including hook outputs and permission updates.
- `runtime/src/types/hooks.ts`, `runtime/src/utils/hooks.ts`, and
  `runtime/src/utils/hooks/agentSdkHookTypes.ts` parse, guard, and consume hook
  JSON output.
- `runtime/src/types/runtime-ambient.d.ts` previously shadowed the internal SDK
  barrel with permissive ambient declarations.

### Finding

`agentSdkTypes.ts` mixed a real internal type/value barrel with query-style SDK
functions that all threw `not implemented`, broad `any` aliases that duplicated
generated SDK types, and a re-export of unused `SDKControl*` aliases from a
source-only `controlTypes.ts` stub. Removing those permissive aliases exposed a
generated type drift: schema fields declared as `z.array(PermissionUpdateSchema())`
had been emitted as a union whose array applied only to the last union branch.

### Change

- Reduced `agentSdkTypes.ts` to a narrow internal barrel for `HOOK_EVENTS`,
  `EXIT_REASONS`, generated core SDK types, runtime `EffortLevel`, and settings
  types.
- Deleted the unused `sdk/controlTypes.ts` stub and the ambient module block
  that shadowed `agentSdkTypes.ts` with `any` declarations.
- Replaced local hook `any` aliases with re-exports of generated SDK hook types.
- Corrected generated `PermissionUpdate[]` array shapes for
  `updatedPermissions` and `permission_suggestions`.
- Updated stale comments that described the old `any` collision.
- Added meta tests that prevent the internal SDK barrel from regaining throwing
  runtime functions and lock generated permission-update arrays to the schema
  shape.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/meta/license-and-version.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: SDK Committed-Type Workflow Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/entrypoints/sdk/coreSchemas.ts` is the Zod schema source for
  SDK serializable data types.
- `runtime/src/entrypoints/sdk/coreTypes.generated.ts` is the committed
  TypeScript type surface consumed through `coreTypes.ts`.
- `runtime/src/entrypoints/sdk/coreTypes.ts` documents the maintenance path for
  SDK consumers and internal builders.
- `runtime/package.json` owns runtime validation scripts and the build command.
- `runtime/tests/meta/license-and-version.test.ts` already guards SDK surface
  drift found during this audit.

### Finding

The committed SDK type files still instructed maintainers to run
`bun scripts/generate-sdk-types.ts`, but that generator is not present in this
repository. The previous slice had to correct generated permission-update array
types manually, so the repository needed a live workflow that at least verifies
the fragile schema/type contract it now depends on.

### Change

- Added `runtime/scripts/check-sdk-generated-types.mjs`, a deterministic source
  validator for the committed SDK type workflow.
- Wired `check:sdk-generated-types` into `runtime/package.json` and the runtime
  `build` command, so the check runs under the existing pre-commit build gate.
- Updated SDK source comments to point at the checked-in validation command
  instead of the absent generator.
- Extended the meta test suite to assert the validator exists, the stale
  generator reference stays out of SDK workflow comments, and the validator
  succeeds.

### Validation

- `npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/meta/license-and-version.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Daemon Initialize Method Capabilities

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/app-server/daemon-dispatcher.ts` handles the `initialize`
  JSON-RPC handshake and routes every known daemon method.
- Optional dispatcher collaborators include `sessionManager`, `authBackend`,
  `daemonControl`, and optional agent-manager hook/permission methods.
- `runtime/src/app-server/protocol/index.ts` defines the daemon method registry,
  initialize request/result types, and the public `capabilities` field.
- Dispatcher contract tests cover missing optional collaborators returning
  `-32601` or explicit unavailable-service errors before parameter validation.
- `runtime/tests/app-server/agent-lifecycle.contract.test.ts` checks the stored
  initialize state after protocol negotiation.

### Finding

`initialize` always returned an empty server `capabilities` object even though
method availability depends on the daemon host's configured collaborators. A
client could not tell during negotiation whether session lifecycle, daemon
reload, or auth methods were usable until it attempted the call and received an
unavailable-method response.

### Change

- Added the `daemon.methods` capability map to the daemon protocol types.
- The dispatcher now computes method capability flags from its actual
  configured services and returns them in `InitializeResult.capabilities`.
- The method capability builder is exhaustive over every known public and
  internal daemon method, so new protocol methods must declare availability
  semantics.
- Added contract coverage for both omitted optional collaborators and configured
  session/reload/auth collaborators.
- Updated initialize-state coverage to assert representative negotiated method
  capability flags instead of the obsolete empty server capability object.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/app-server/daemon-dispatcher.contract.test.ts tests/app-server/agent-lifecycle.contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Slash Command Local JSX Opener Helper

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/types.ts` defines the `SlashCommandContext.appState`
  bridge used by commands that open local TUI surfaces.
- Repeated menu openers in `compact-menu.tsx`, `config-menu.tsx`,
  `diff-menu.tsx`, `hooks-menu.tsx`, `hooks.ts`, `mcp-menu.tsx`,
  `model-menu.tsx`, `permissions-menu.tsx`, `plan-menu.tsx`, `plugins.tsx`,
  `provider-menu.tsx`, `skills-menu.tsx`, and `status-menu.tsx` all used the
  same `setToolJSX` availability check, close payload, and local JSX flags.
- Existing command tests assert the `setToolJSX` payloads for provider, MCP,
  diff, config, plan, plugin, session-compact, and memory command paths.

### Finding

The slash-command menu layer repeated the same local JSX opener and close
callback boilerplate across many files. A change to close semantics or prompt
visibility would have required coordinated edits in every menu opener and made
future local JSX surfaces easy to drift.

### Change

- Added `runtime/src/commands/local-jsx-command.ts` with
  `openLocalJsxCommand`, a small helper for opening and clearing TUI-local JSX
  command surfaces.
- Migrated the repeated menu openers listed above to the helper while preserving
  each menu's rendered component and callback wiring.
- Added focused tests that lock the helper's no-bridge fallback, open payload,
  close payload, and optional prompt-visibility override.
- Left specialized local JSX flows (`resume`, `agents`, `tasks`, `memory`,
  help/context usage) for later slices because some of them perform async
  imports, request relaunches, or re-render after user actions.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/commands/local-jsx-command.test.ts tests/commands/config.test.ts tests/commands/hooks.test.ts tests/commands/diff.test.ts tests/commands/mcp.test.ts tests/commands/plugins.test.tsx tests/commands/provider.test.ts tests/commands/plan.test.ts --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/commands/session-compact-context.test.ts tests/commands/memory/memory.contract.test.tsx --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`
