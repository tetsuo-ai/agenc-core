# OpenClaude TUI Complete Parity Plan

## Scope

Owner repo: `/home/tetsuo/git/AgenC/agenc-core`

Worktree: `/home/tetsuo/git/AgenC-worktrees/agenc-core-openclaude-tui-complete-parity`

Branch: `feature/openclaude-tui-complete-parity`

Upstream source: `/home/tetsuo/git/openclaude`

Baseline commit: `57fb4dd9 fix(tui): align openclaude parity flows`

This branch exists to close all known AgenC TUI parity gaps against OpenClaude. It must remain local only. Do not push this branch or any intermediate branch to a remote.

Allowed differences:

- AgenC branding, names, copy, color palette, and visual identity.
- AgenC/Codex agent-specific behavior, including local task/subagent/runtime surfaces.
- Runtime-owned local concepts that have no OpenClaude equivalent, provided they are surfaced with the same cleanliness and ordering discipline as OpenClaude.

Everything else is a parity target. A local simplification is not acceptable when OpenClaude already has a working behavior or component contract.

## Why This Branch Exists

The previous parity branch merged with green unit tests, but a live run still showed a choppy transcript:

- Internal provider metadata was written to `errors/*.jsonl`.
- Assistant tool-chatter appeared as user-visible assistant rows.
- Tool bursts rendered as many literal rows instead of OpenClaude-style grouped/collapsed activity.
- Some OpenClaude-style components existed in the tree but were not the live render path.
- No real-log replay test proved that the latest messy AgenC run became clean.

Latest messy run used for the first golden fixture:

- Project log: `/home/tetsuo/.agenc/projects/home-tetsuo-git-stream-test-agenc-shell-843ca075`
- Thread: `conv-mojpvw10`
- Rollout: `/home/tetsuo/.agenc/projects/home-tetsuo-git-stream-test-agenc-shell-843ca075/sessions/conv-mojpvw10/rollout-2026-04-29T07-12-01-769Z-conv-mojpvw10.jsonl`
- Errors: `/home/tetsuo/.agenc/projects/home-tetsuo-git-stream-test-agenc-shell-843ca075/errors/2026-04-29.jsonl`

Observed rollout counts:

- 2927 lines
- 2797 `event_msg`
- 126 `response_item`
- 2 `turn_context`
- 1 `session_state`
- 1 `session_meta`

Observed `event_msg` counts:

- 2449 `agent_message_delta`
- 65 `warning`
- 63 `token_count`
- 61 `tool_call_started`
- 61 `tool_call_completed`
- 32 `exec_command_begin`
- 32 `exec_command_end`
- 23 `agent_message`
- 2 `user_message`
- 2 `turn_started`
- 2 `turn_context`
- 2 `turn_complete`
- 1 `session_configured`
- 1 `plan_started`
- 1 `plan_item_completed`

The current reducer turns that run into 86 visible messages: 2 user rows, 23 assistant rows, 60 tool rows, and 1 plan row. That is the contract failure this branch must fix.

## Upstream Source Map

### Transcript and Message Pipeline

OpenClaude:

- `src/components/Messages.tsx`
- `src/components/Message.tsx`
- `src/components/MessageRow.tsx`
- `src/components/MessageResponse.tsx`
- `src/components/messages/**`
- `src/utils/messages.ts`
- `src/utils/groupToolUses.ts`

AgenC:

- `runtime/src/tui/state/events-to-messages.ts`
- `runtime/src/tui/transcript/normalize.ts`
- `runtime/src/tui/transcript/MessageList.tsx`
- `runtime/src/tui/transcript/Message.tsx`
- `runtime/src/tui/transcript/MessageRow.tsx`
- `runtime/src/tui/transcript/messages/**`
- `runtime/src/tui/transcript/ToolCell.tsx`
- `runtime/src/tui/transcript/ExecCell.tsx`
- `runtime/src/tui/transcript/tool-renderers.ts`

Required outcome:

- One canonical live render path.
- The live path must not bypass the OpenClaude-style `Message -> messages/**` dispatcher if those ports are retained.
- Tool-use and tool-result behavior must preserve OpenClaude semantics: grouped tool use, tool-owned render hooks or equivalent registry entries, queued/resolved/error state, progress state, cancellation/rejection/interruption display, and schema-validated fallbacks.

### Logging, Diagnostics, and Error Surfaces

OpenClaude:

- `src/utils/debug.ts`
- `src/utils/log.ts`
- `src/utils/warningHandler.ts`
- `src/services/analytics/config.ts`
- `scripts/no-telemetry-plugin.ts`

AgenC:

- `runtime/src/llm/providers/openai/adapter.ts`
- `runtime/src/llm/providers/**`
- `runtime/src/session/event-log.ts`
- `runtime/src/session/error-log.ts`
- `runtime/src/session/event-log-reducer.ts`
- `runtime/src/bin/bootstrap.ts`
- `runtime/src/tui/state/events-to-messages.ts`

Required outcome:

- Internal diagnostics, provider request metadata, telemetry-like traces, and debug rows must not use the user-facing warning/error channel.
- `llm_request_metadata` must not appear in `errors/*.jsonl`.
- Error logs must store sanitized, actionable error records, not complete internal event envelopes.
- Hidden warning causes must be filtered at the source/surface boundary, not only at TUI render time.

### Composer, Prompt Input, Status, Resume, Permissions, and Keybindings

OpenClaude:

- `src/components/PromptInput/**`
- `src/components/StatusNotices.tsx`
- `src/components/App.tsx`
- `src/components/ResumeTask.tsx`
- `src/components/permissions/**`
- `src/keybindings/**`

AgenC:

- `runtime/src/tui/composer/Composer.tsx`
- `runtime/src/tui/composer/PromptInput.tsx`
- `runtime/src/tui/composer/**`
- `runtime/src/tui/cockpit/StatusNotices.tsx`
- `runtime/src/tui/screens/REPL.tsx`
- `runtime/src/tui/screens/ResumeConversation.tsx`
- `runtime/src/tui/screens/repl-startup-gates.ts`
- `runtime/src/tui/permissions/**`
- `runtime/src/permissions/**`
- `runtime/src/tui/keybindings/**`

Required outcome:

- `PromptInput.tsx` must either become the real live path with complete behavior or be removed/retired. It must not remain a parallel partial port.
- Live shortcut display/help must reflect the actual AgenC keybinding system.
- Startup/status notices must have explicit parity decisions, including config/project-memory/definition warnings where AgenC has equivalent signals.
- Permission UI must integrate the per-tool bodies or delete duplicate unused render paths.
- Resume selection must be bounded/scrollable before parity is claimed.

## Known Blockers

B1. `llm_request_metadata` is emitted through `emitWarning` in `runtime/src/llm/providers/openai/adapter.ts` and persisted by `runtime/src/session/error-log.ts`.

B2. `ErrorLogSidecar` persists every warning and stores `raw: event`, so hidden/internal rows become durable user-visible noise.

B3. Assistant tool-chatter like "Let me check...", "Still failing...", "Wait...", and tool-status narration remains visible as assistant output.

B4. Tool bursts render as many literal rows. OpenClaude grouping/collapse semantics are not yet preserved end to end.

B5. The live `MessageList` path bypasses much of the OpenClaude-style `Message.tsx`, `MessageRow.tsx`, and `messages/**` port.

B6. Bash/exec output does not yet match OpenClaude result affordances: no-output text, timeout display, cwd-reset handling, background hints, image output, and sandbox tag stripping.

B7. `PromptInput.tsx` is a partial parallel implementation with no-op behaviors and must not be counted as live parity.

B8. Permission UI parity is incomplete and has duplicate unused paths.

B9. Resume selection lacks viewport caps/scrolling and can dump every session row.

B10. There is no golden replay fixture/test for the actual latest messy run.

## Phases

### Phase 0: Guardrails

- Keep work on `feature/openclaude-tui-complete-parity`.
- Do not push to remote.
- Commit only logical local checkpoints.
- Keep unrelated dirty files in the umbrella repo untouched.

Rollback:

- Delete this worktree and branch. No remote cleanup should be needed.

### Phase 1: Golden Replay and Red Gates

- Add reducer/render tests that fail on the current visible transcript noise.
- Add error-log/provider tests that fail while request metadata is warning-backed.
- Add a real-log replay fixture or replay harness for the `conv-mojpvw10` rollout.
- Add static shell-surface gates so composer, message rendering, permissions, keybindings, resume, status notices, and Bash/exec affordances cannot be waived by manual smoke testing alone.

Merge gate:

- The branch must not merge until these tests pass without weakening assertions.

### Phase 2: Diagnostics Surface Split

- Move provider metadata to a diagnostic/debug-only channel or equivalent non-user-facing event.
- Add severity/surface/visibility metadata where needed.
- Filter `ErrorLogSidecar` by actionable user-facing causes.
- Sanitize error-log entries and remove full `raw: event` persistence for internal rows.

Merge gate:

- A live run must not append `llm_request_metadata` to `errors/*.jsonl`.

### Phase 3: Canonical Transcript Render Path

- Choose one live render path and remove/bypass no duplicate authoritative implementations.
- Wire the OpenClaude-style dispatcher/components or delete unused partial ports after equivalent behavior exists in the live path.
- Preserve AgenC colors/branding.
- Re-run the source-map audit after tool grouping/result parity lands, not only before, so `MessageList` cannot keep bypassing retained OpenClaude-style message ports.

Merge gate:

- A source-map audit must show every retained OpenClaude-style port is either live or intentionally non-live with a documented reason.

### Phase 4: Tool Use, Result, and Grouping Parity

- Port OpenClaude grouping semantics from `groupToolUses.ts`.
- Preserve tool result/progress data in grouped rows.
- Restore active/verbose expansion behavior.
- Add Bash/exec parity affordances.
- Keep AgenC agent/collaboration tool differences where they are product-specific.

Merge gate:

- Golden replay produces a clean, ordered transcript with grouped/collapsed tool bursts and no assistant tool-chatter rows.

### Phase 5: Composer, Status, Resume, Permissions, Keybindings

- Retire or complete `PromptInput.tsx`.
- Fill live keybinding help/shortcut surfaces.
- Make status/startup notices explicit and bounded.
- Integrate per-tool permission renderers or delete duplicate dead paths.
- Bound/virtualize resume session selector.

Merge gate:

- Manual TUI smoke test covers new prompt, multiline input, paste/image handling where supported, resume selector, approval flow, and keybinding help.

### Phase 6: Full Validation and Local-Only Merge

- Run focused parity tests.
- Run full runtime validation.
- Rebuild `@tetsuo-ai/runtime`.
- Perform a live TUI run and inspect rollout/error logs.
- Merge locally only when every gate is satisfied.
- After local merge, clean up this worktree and branch.

Merge gate:

- No unresolved required deviations.
- No failing tests.
- No dirty setup-only artifacts left outside committed branch changes.
- `agenc` rebuilt from the locally merged `agenc-core/main`.

## Final Acceptance Checklist

- [ ] Source map complete and reviewed.
- [ ] Red setup gates from `openclaude-clean-transcript.test.ts`, `openclaude-real-log-replay.test.ts`, and `openclaude-shell-parity.test.ts` pass without weakening assertions.
- [ ] No retained duplicate partial ports for live behavior.
- [ ] `llm_request_metadata` absent from `errors/*.jsonl`.
- [ ] Provider request metadata is routed through a diagnostic/debug channel, not hidden by error-log filtering after warning emission.
- [ ] Error logs contain sanitized actionable entries only.
- [ ] Hidden/internal warning causes are excluded from error logs as a class, not one cause at a time.
- [ ] Assistant tool-chatter suppressed/folded in normal transcript mode.
- [ ] Tool bursts grouped/collapsed with result/progress data preserved.
- [ ] Bash/exec result display matches OpenClaude behavior where applicable.
- [ ] Compact boundaries intentionally visible/hidden with documented parity decision.
- [ ] Prompt/composer path is single and complete.
- [ ] Permission UI uses one authoritative render path.
- [ ] Resume selector is bounded/scrollable.
- [ ] Golden replay of `conv-mojpvw10` is clean.
- [ ] Live TUI run is clean.
- [ ] Resume/replay path is clean.
- [ ] Full tests and build pass.
- [ ] Local merge only; no remote push.

## Setup Review Follow-up

The first setup review returned `NEEDS_REVISION` because the initial gates were still too synthetic. The branch now requires:

- Golden replay of `conv-mojpvw10` through `runtime/src/tui/state/openclaude-real-log-replay.test.ts`.
- Broader OpenAI provider assertions that no request path emits `llm_request_metadata` through `emitWarning`, plus a diagnostic-channel expectation for chat-completions metadata.
- Error-log table coverage for multiple hidden/internal warning causes, and sanitized `stream_error` entries.
- Static shell-surface gates in `runtime/src/tui/openclaude-shell-parity.test.ts` for composer ownership, canonical message rendering, Bash affordances, per-tool permission bodies, OpenClaude-shaped keybinding modules, bounded resume rows, and active status notice resolution.

These setup gates are expected to fail on the baseline branch. They are merge blockers, not implementation suggestions.

The second setup review also returned `NEEDS_REVISION` because several shell gates were source-string checks that could pass through comments or unused exports. The gates now additionally require:

- Rendered `ExecCell` behavior for OpenClaude no-output and done affordances.
- A callable Bash result formatter contract for cwd-reset, sandbox-tag stripping, background-task hints, and image output.
- An `ApprovalOverlay` permission-body resolver that returns the same per-tool bodies as the `PermissionRequest` registry.
- Behavioral keybinding parser/resolver/schema/validation/reserved-shortcut modules.
- A callable bounded resume-window helper.
- A callable active status-notice resolver for config, project-memory, and agent-definition warnings.
- A semantic `classifyErrorLogEvent` contract for internal diagnostics instead of only a fixed cause blacklist.
- A typed provider diagnostic channel; the OpenAI test now passes `emitDiagnostic` without an `unknown` cast so typecheck stays red until provider config supports the channel honestly.
