# Codebase Quality Audit

This log tracks concrete slices of the ongoing agenc-core quality pass. It is
not a completion claim for the whole repository. Each entry records the code
paths traced, the defect or risk found, and the validation run before commit.

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
