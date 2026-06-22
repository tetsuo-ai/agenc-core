# Codebase Quality Audit

This log tracks concrete slices of the ongoing agenc-core quality pass. It is
not a completion claim for the whole repository. Each entry records the code
paths traced, the defect or risk found, and the validation run before commit.

## 2026-06-22: Context Compaction Permission Context Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/session-compact.ts#buildAgenCToolUseContext` builds the
  fallback app-state surface used by `/compact` and `/context`.
- `runtime/src/commands/session-compact.ts#buildSyntheticSystemMessage`
  reconstructs the system prompt counted by `/context`.
- `runtime/src/prompts/permissions-prompt.ts#getPermissionsSection` renders the
  permissions section from the active permission context mode.

### Finding

`/context` compaction paths passed live permission-mode registry output directly
into app-state and synthetic system-prompt assembly. Array-shaped registry
values with a spoofed `mode` property could therefore render an inaccurate
permissions section in the synthetic prompt instead of being treated as absent.

### Change

- Added a local permission-context reader that requires non-array record shape
  and a valid permission mode before accepting registry output.
- Applied that reader to both fallback app-state construction and synthetic
  system-prompt assembly.
- Added a regression proving array-shaped `bypassPermissions` contexts produce
  the same `/context` modal text as an absent permission context.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/commands/session-compact-context.test.ts --reporter=dot`

## 2026-06-22: Stop-Hook Permission Mode Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/phases/stop-hooks.ts#evaluateStopHooks` builds the `StopRequest`
  sent to configured stop hooks.
- `runtime/src/phases/stop-hooks.ts#currentPermissionMode` prefers live
  permission-mode registry output over the turn context fallback.
- `runtime/tests/phases/stop-hooks.test.ts` covers hook request metadata and
  configured Stop stdin payloads.

### Finding

Stop-hook request construction read `.mode` from any object returned by the
permission-mode registry. Array-shaped mode values with spoofed `mode`
properties could therefore be reported to hooks instead of falling back to the
turn context's permission mode.

### Change

- Reused `runtime/src/utils/record.ts#asRecord` for both direct-session and
  service-backed permission-mode registry outputs.
- Added a regression proving array-shaped live permission-mode values fall back
  to the turn context value in hook requests.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/phases/stop-hooks.test.ts tests/hooks/configured-hooks.test.ts --reporter=dot`

## 2026-06-22: Tool Orchestrator Permission Mode Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/orchestrator.ts#orchestrateToolCall` reads the current
  permission mode from `approvalCtx.invocation.session.permissionModeRegistry`.
- The derived `bypassPermissions` flag is passed into
  `classifyToolApproval`, where it can suppress approval prompts under
  granular policies.
- `runtime/tests/tools/orchestrator.test.ts` covers granular policy lifecycle
  decisions and resolver invocation.

### Finding

The orchestrator accepted any non-null object returned by the permission-mode
registry. Array-shaped values with a spoofed `mode: "bypassPermissions"` could
therefore skip approval prompting even though permission modes are expected to
be object records.

### Change

- Reused `runtime/src/utils/record.ts#asRecord` before checking the mode value.
- Added a regression proving array-shaped mode values cannot spoof
  `bypassPermissions` and still go through the resolver.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/orchestrator.test.ts tests/phases/execute-tools.test.ts --reporter=dot`

## 2026-06-22: Run-Turn Session Source Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/run-turn.ts#sessionQuerySourceForPostSampling` derives
  the post-sampling query source used by MagicDocs and session-memory hooks.
- `runtime/src/session/run-turn.ts#launchMagicDocsPostSampling` skips MagicDocs
  updates when the query source is converted to `agent:<conversationId>`.
- `runtime/tests/session/run-turn.test.ts` already covers the structured
  subagent source suppression path.

### Finding

The session-source query-source bridge still read `sessionSource.kind` from any
non-null object. Array-shaped session sources with a spoofed `kind: "subagent"`
could therefore suppress main-thread MagicDocs updates even though structured
session sources are expected to be records.

### Change

- Reused `runtime/src/utils/record.ts#asRecord` before reading
  `sessionConfiguration.sessionSource.kind`.
- Added a regression proving array-shaped `sessionSource` values no longer
  suppress MagicDocs post-sampling work.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/session/run-turn.test.ts tests/services/MagicDocs/magicDocs.test.ts --reporter=dot`

## 2026-06-22: Agent Service Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/agents/run-agent.ts#initMcpForAgent` calls `readMcpManager`
  before deciding whether required MCP servers can be polled for readiness.
- `runtime/src/agents/run-agent.ts#runAgent` calls `providerFromParent` before
  driving the child agent's model turn with the parent provider.
- `runtime/tests/agents/run-agent.test.ts` covers the provider-driving loop and
  MCP-readiness branches.

### Finding

Subagent startup still read `parent.services.mcpManager` and
`parent.services.provider` from any non-null object. Array-shaped service bags
with spoofed `mcpManager` or `provider` properties could therefore participate
in MCP polling or child provider execution even though the session service bag
is expected to be a record.

### Change

- Added a shared `readParentServices` helper backed by
  `runtime/src/utils/record.ts#asRecord`.
- Reused the helper for both MCP manager lookup and parent provider lookup.
- Tightened the nested provider and MCP manager values with the same guard.
- Added regressions proving array-shaped parent services are ignored for both
  provider resolution and MCP readiness.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/agents/run-agent.test.ts tests/agents/run-agent-mailbox.test.ts --reporter=dot`

## 2026-06-22: Guardian Arbiter Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/permissions/guardian/arbiter.ts#arbitratePermissionMode` reads
  `toolPermissionContext` before merging PreToolUse hook decisions with
  rule-based deny/ask checks.
- `runtime/src/permissions/guardian/arbiter.ts#requestApproval` and
  `#requestToolUserApproval` call `resolveApprovalCache` before consulting
  guardian review, modal resolver, or user approval prompts.
- `runtime/tests/permissions/guardian/arbiter.test.ts` covers approval cache
  sharing and permission-mode arbitration.

### Finding

The guardian arbiter still accepted any non-null object for
`toolPermissionContext` and `session.services`. Array-shaped runtime values with
spoofed rule or `toolApprovals` properties could therefore influence hook/rule
merging or expose an approval cache even though both paths expect object
records.

### Change

- Reused `runtime/src/utils/record.ts#asRecord` for guardian
  `toolPermissionContext` reads.
- Reused the same guard before reading `session.services.toolApprovals`.
- Added regressions proving array-shaped permission contexts do not trigger
  rule-based asks and array-shaped service containers do not enable approval
  caching.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/permissions/guardian/arbiter.test.ts tests/tools/execution.test.ts --reporter=dot`

## 2026-06-22: Plugin Config Entry Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/plugins/loader.ts#configuredPluginEntries` merges legacy
  `enabledPlugins` and `plugins.plugins` config maps before discovery.
- `runtime/src/plugins/loader.ts#discoverPluginRoots` uses configured entry
  `path` values to add explicit plugin roots and configured entry `enabled`
  values to gate discovered roots.
- `runtime/src/skills/local-loader.ts#skillsForConfig` caches the active plugin
  config view before loading plugin-provided skills and restarting watchers.

### Finding

Configured plugin entry helpers still read `path` and `enabled` from any
non-null object. Array-shaped runtime config values with spoofed `path` or
`enabled` properties could therefore activate explicit plugin roots or disable
auto-discovered plugins. The skill loader had the same broad top-level config
view and would treat an array-shaped config with a `plugins` property as valid
for plugin skill discovery.

### Change

- Reused the shared plugin manifest `isRecord` guard before reading configured
  plugin entry `path` or `enabled`.
- Imported `runtime/src/utils/record.ts#isRecord` for the local skill loader's
  plugin config view.
- Added regressions for array-shaped configured plugin entries and array-shaped
  per-call skill-loader configs.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/plugins/loader.test.ts tests/skills/local-loader.test.ts --reporter=dot`

## 2026-06-22: Compact Content Block Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/compact/sessionMemoryCompact.ts#preserveToolPairsFromIndex`
  scans kept content blocks for `tool_result` ids, then walks older messages to
  preserve paired `tool_use` blocks.
- `runtime/src/services/compact/microCompact.ts#collectCompactableToolUseIds`,
  `#collectReadFilePaths`, `#collectCompactableToolResultPositions`, and
  `#microcompactContentBlocks` all share the content-block filter before
  deciding which tool results can be cleared.
- `runtime/src/services/compact/microCompact.ts#readFilePathFromInput` feeds the
  path-aware retention rule that keeps the latest read result per file path.

### Finding

The compact services treated any non-null object as a content block or read
input record. Array-shaped runtime values with spoofed `type`, `tool_use_id`,
or `file_path` properties could therefore participate in session-memory tool
pair preservation, microcompact clearing, or path-aware retention even though
those paths expect object records.

### Change

- Replaced the local compact content-block filters with
  `runtime/src/utils/record.ts#isRecord`.
- Reused the same strict guard for microcompact file-path extraction from
  block-form `tool_use.input`.
- Added regressions for spoofed array blocks in session-memory preservation,
  microcompact clearing, and path-aware read retention.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/services/compact/compact-surfaces.test.ts tests/services/compact/microCompact.test.ts tests/gaphunt3/compaction.test.ts --reporter=dot`

## 2026-06-22: Legacy Tool Runtime Argument Record Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/phases/_deps/tool-runtime.ts#safeParseArgs` parses tool-call
  arguments before the legacy phase-dependency executor invokes PreToolUse hooks,
  permission arbitration, approval preview construction, and final dispatch.
- `runtime/src/phases/_deps/tool-runtime.ts#runOne` passes the parsed args to
  hook observers and re-stringifies the effective args for dispatch.
- `runtime/tests/phases/tool-runtime-deps.test.ts` now exercises the direct
  legacy executor surface without going through the production
  `execute-tools` executor.

### Finding

The legacy phase-dependency executor had the same permissive
`typeof parsed === "object"` cast as the production streaming executor. A
model-supplied array JSON payload could therefore reach PreToolUse hooks as an
array with numeric keys even though the downstream contract is
`Record<string, unknown>`.

### Change

- Replaced the local permissive cast with `runtime/src/utils/record.ts#asRecord`.
- Added a focused regression proving array-shaped model arguments are normalized
  to `{}` before legacy PreToolUse hooks run.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/phases/tool-runtime-deps.test.ts tests/phases/execute-tools.test.ts --reporter=dot`

## 2026-06-22: Streaming Tool Executor Argument Record Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/streaming-executor.ts#addTool` parses model-supplied tool
  call arguments for concurrency classification and per-tool
  `isConcurrencySafe(args)` decisions before dispatch.
- `runtime/src/phases/execute-tools.ts` wires this executor into the production
  model-stream tool execution path.
- `runtime/tests/tools/streaming-executor.test.ts` covers ordering,
  concurrency, progress, and malformed executor behavior.

### Finding

The production streaming executor parsed `toolCall.arguments` with
`JSON.parse(...)` and cast any parsed object-like value to
`Record<string, unknown>`. Array-shaped argument JSON therefore reached
classification and `isConcurrencySafe` hooks as an array with numeric keys
instead of falling back to the malformed-arguments default.

### Change

- Added a small `parseToolCallArguments` helper that delegates parsed values to
  `runtime/src/utils/record.ts#asRecord`.
- Kept invalid JSON, primitives, `null`, and arrays on the existing `{}` fallback
  path for classification.
- Added a regression proving array-shaped arguments are normalized to `{}` before
  invoking per-tool concurrency hooks.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/streaming-executor.test.ts tests/phases/execute-tools.test.ts --reporter=dot`

## 2026-06-22: Shared TUI/CLI Daemon Event Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tui/realtime/controller.ts` accepts daemon realtime transcript
  notifications and local realtime events before updating TUI realtime state.
- `runtime/src/tui/daemon-session.ts` normalizes daemon session notifications,
  realtime notification payloads, elicitation payloads, and connection-state
  notice events for the TUI.
- `runtime/src/bin/agenc.ts` parses daemon one-shot message/status events before
  writing streamed CLI output and choosing the final exit code.

### Finding

The TUI and top-level CLI daemon event boundaries repeated the same strict
non-array object guard already centralized in `runtime/src/utils/record.ts`.
Leaving these local predicates duplicated increases the chance that malformed
array-shaped daemon events drift between the TUI, CLI, and app-server paths.

### Change

- Delegated the TUI realtime, TUI daemon-session, and one-shot CLI event object
  wrappers to `runtime/src/utils/record.ts#isRecord`.
- Added regressions proving array-shaped realtime events, daemon notification
  params, and one-shot daemon events are ignored as malformed.
- Kept `runtime/src/thread-store/thread-source.ts` out of scope because that
  helper is shared persistence-specific metadata parsing covered by its own
  gotcha and tests.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tui/realtime/controller.contract.test.ts tests/tui/daemon-session.wave200-065.coverage.test.ts tests/tui/daemon-session.contract.test.ts tests/gaphunt3/tui-daemon-session.test.ts tests/bin/agenc.test.ts --reporter=dot`

## 2026-06-22: Shared App-Server JSON Object Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/app-server/daemon-dispatcher.ts` validates daemon JSON-RPC
  method params, nested config objects, and realtime/media object fields before
  handing requests to managers.
- `runtime/src/app-server/command-exec.ts` validates command execution env,
  terminal size, sandbox policy, and permission-profile objects.
- `runtime/src/app-server/agent-cli.ts` and
  `runtime/src/app-server/daemon-cli.ts` parse daemon JSON-line responses and
  notifications before resolving CLI clients.
- `runtime/src/app-server/background-agent-runner.ts` normalizes daemon event
  payloads and persisted budget metadata.
- `runtime/src/app-server/realtime-transport.ts` parses realtime websocket
  events, nested response/error objects, and function-call arguments.

### Finding

These app-server modules each had local strict JSON-object predicates with the
same non-array object semantics. The wrappers still expose local `JsonObject`
type guards, but the raw predicate should stay aligned with the shared record
contract so malformed array payloads are rejected consistently.

### Change

- Delegated app-server daemon/client/realtime JSON-object wrappers to
  `runtime/src/utils/record.ts#isRecord`.
- Added command-exec regressions for array-shaped `env` and terminal `size`
  inputs.
- Kept existing dispatcher array-object coverage for session metadata and
  existing realtime/background-agent malformed payload coverage.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/app-server/daemon-dispatcher.contract.test.ts tests/app-server/command-exec.contract.test.ts tests/app-server/agent-cli.contract.test.ts tests/app-server/daemon-cli.contract.test.ts tests/app-server/background-agent-runner.contract.test.ts tests/app-server/realtime.contract.test.ts tests/app-server/realtime-transport.transcript-cap.test.ts tests/gaphunt3/app-server-agent-cli.test.ts --reporter=dot`

## 2026-06-22: Shared Transport JSON Object Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/app-server/transport/auth.ts` validates daemon initialize
  params before accepting cookie-authenticated transports.
- `runtime/src/app-server/transport/stdio.ts#parseJsonObjectLine` validates
  newline-delimited JSON-RPC frames.
- `runtime/src/app-server/transport/websocket.ts#parseJsonObjectPayload`
  validates websocket JSON-RPC payloads before dispatch.
- Focused contract tests cover auth cookie initialization, stdio frame parsing,
  websocket malformed payload handling, and websocket accept-auth teardown.

### Finding

The app-server transport layer had three local JSON-object predicates with the
same strict non-array object semantics. These wrappers still need their local
`JsonObject` type guard API, but the raw predicate should not drift from the
shared record contract used elsewhere.

### Change

- Delegated the auth, stdio, and websocket `isJsonObject` wrappers to
  `runtime/src/utils/record.ts#isRecord`.
- Added a missing auth regression proving array-shaped initialize params do not
  authenticate.
- Kept existing stdio/websocket array-frame rejection coverage intact.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/app-server/transport-auth.contract.test.ts tests/app-server/stdio-transport.contract.test.ts tests/app-server/websocket-transport.contract.test.ts tests/gaphunt3/app-server-transport-websocket.test.ts --reporter=dot`

## 2026-06-22: Shared Task Board Metadata Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/tasks/task-board.ts#parseTaskMetadata` validates optional
  `metadata` arguments for the model-facing `TaskCreate` and `TaskUpdate`
  durable task-board tools.
- Valid metadata is passed through to `runtime/src/bin/task-store.ts`, which
  persists task metadata under the project task directory.
- `runtime/tests/tools/tasks/task-tools.test.ts` covers durable task creation,
  update, listing, and app-state expansion behavior.

### Finding

Task-board tool argument validation still repeated the local strict non-array
object predicate even though persisted task-store validation now uses the shared
guard. Array-shaped metadata must be rejected at the tool boundary before any
task mutation or task-panel expansion occurs.

### Change

- Replaced the local metadata predicate with
  `runtime/src/utils/record.ts#isRecord`.
- Added create/update regressions proving array-shaped metadata returns the
  existing `"metadata must be an object"` tool error and does not trigger task
  panel expansion.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tools/tasks/task-tools.test.ts tests/bin/task-store.test.ts --reporter=dot`

## 2026-06-22: Shared Error Log Payload Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/error-log.ts#classifyErrorLogEvent` decides whether
  error, warning, and stream-error session events are persisted to the sidecar
  JSONL error log.
- `payloadRecord` normalizes untrusted event payloads before checking
  internal/debug visibility, diagnostic surface, and internal warning causes.
- `runtime/tests/session/error-log.test.ts` covers error-log writes,
  sanitized warning entries, and classifier persistence decisions.

### Finding

The classifier had a local strict non-array object predicate at a persistence
decision boundary. Array-shaped payloads must stay malformed; otherwise an array
with spoofed `visibility`, `surface`, or internal `cause` properties could
suppress an otherwise actionable warning.

### Change

- Replaced the local payload object predicate with
  `runtime/src/utils/record.ts#isRecord`.
- Added a regression proving an array-shaped warning payload with
  internal-looking properties is ignored as malformed and remains persistable.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/session/error-log.test.ts --reporter=dot`

## 2026-06-22: Shared Command Plugin Config Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands.ts#getCommands` derives the plugin-facing config
  surface before loading production plugin command and skill sources.
- `runtime/src/plugins/registration/load-plugin-commands.ts` treats explicit
  plugin config as an opt-in discovery input and may load configured plugin
  markdown commands from that surface.
- `runtime/tests/commands/command-surface.test.ts` covers model-facing command
  loading and now pins the array-shaped config boundary with a temp plugin
  fixture.

### Finding

The command loader already imported the shared strict record helper for other
legacy context parsing, but `pluginConfigSurface` still repeated the raw
non-array object predicate. That boundary is security-sensitive enough to keep
arrays malformed: an array with a `plugins` property must not opt into plugin
command discovery.

### Change

- Replaced the local `pluginConfigSurface` predicate with
  `runtime/src/utils/record.ts#isRecord`.
- Added a regression proving array-shaped config carrying a valid plugin path is
  ignored while the equivalent object config still loads the plugin command.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/commands/command-surface.test.ts tests/plugins/registration.test.ts --reporter=dot`

## 2026-06-22: Shared Trust Record Utility Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/permissions/trust/records.ts` exports the trust-subsystem record
  predicate used by project trust file parsing and trust-source summarization.
- `runtime/tests/permissions/trust/records.test.ts` pins null-prototype,
  object-instance, array, null, and primitive handling for that predicate.

### Finding

The trust subsystem had already centralized its domain-specific record guard in
`isTrustRecord`, but that helper still repeated the shared strict non-array
object predicate. Keeping the wrapper while delegating the raw predicate avoids
future drift without changing the trust-specific API surface.

### Change

- Replaced the local predicate implementation with
  `runtime/src/utils/record.ts#isRecord`.
- Preserved `isTrustRecord` as the trust-subsystem type guard exported to
  project-trust and trust-source callers.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/permissions/trust/records.test.ts tests/permissions/trust/project-trust.test.ts tests/permissions/trust/trust-sources.test.ts --reporter=dot`

## 2026-06-22: Shared Task Store Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/bin/task-store.ts` persists the durable task-board files under
  each project-specific `AGENC_HOME` task directory.
- `isStoredTask` validates parsed task JSON before `loadOne`, `loadAll`, and
  dependency resolution expose it to CLI, TUI, and task-tool callers.
- `updateOne` merges task metadata patches with existing persisted metadata.

### Finding

Task storage still carried a local strict non-array object predicate for parsed
task records and task metadata maps. This duplicated the shared record guard at
a persistence boundary where array-shaped metadata must keep invalidating the
stored task instead of being accepted as a numeric-keyed metadata record.

### Change

- Replaced the local task-store object guard with
  `runtime/src/utils/record.ts#isRecord`.
- Added a regression proving persisted tasks with array-shaped `metadata` are
  rejected by both single-task and list loaders.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/bin/task-store.test.ts tests/tools/tasks/task-tools.test.ts --reporter=dot`

## 2026-06-22: Shared Tool Execution Schema Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/execution.ts` validates model-supplied tool arguments
  against the JSON schemas attached to runtime tools.
- `validateNode` handles `$ref`, union combinators, array item schemas, object
  properties, additional properties, and deep enum/const comparison.
- `runtime/tests/tools/execution.test.ts` covers the validator directly and the
  `runToolUse` schema-validation integration path.

### Finding

Tool execution still carried a local strict non-array object predicate for JSON
schema nodes. This duplicated the shared record guard at the tool boundary,
where array-shaped `anyOf`/`oneOf`/`allOf` branches must stay malformed instead
of becoming unconstrained schemas that make invalid tool arguments pass.

### Change

- Replaced the local `isSchemaObj` predicate with
  `runtime/src/utils/record.ts#isRecord`.
- Added regressions proving array-shaped union schema branches are ignored as
  malformed while valid object branches still control validation.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tools/execution.test.ts tests/tools/schema-errors.test.ts --reporter=dot`

## 2026-06-22: Shared Structured Output Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/structured-output.ts` builds strict provider-facing JSON
  schema payloads and validates parsed structured-output values returned by
  provider adapters.
- `validateStructuredValue` walks object, array, and union schema nodes before
  enforcing the parsed value shape.
- `parseStructuredOutputText` and `parseStructuredOutputValue` reject malformed
  top-level provider payloads before exposing structured output to callers.

### Finding

Structured-output validation still carried a local strict non-array object
predicate for schema branch filtering, schema cloning, and parsed-result
checks. That duplicated the shared record guard at an LLM boundary where
array-shaped schema branches must not become unconstrained object schemas and
array-shaped provider payloads must remain invalid top-level results.

### Change

- Replaced the local structured-output object guard with
  `runtime/src/utils/record.ts#isRecord`.
- Added regressions proving array-shaped union schema branches are ignored and
  array-shaped structured payloads are rejected as non-object results.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/llm/structured-output.test.ts tests/gaphunt3/llm-structured-output.test.ts --reporter=dot`

## 2026-06-22: Shared Snapshot Policy Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/state/snapshot-policy.ts` records session events, tool-call
  lifecycle state, agent status transitions, and periodic/hydrated session
  snapshots.
- `agentStatusMetadataPatch` filters optional budget metadata before merging it
  into agent-run metadata and status-transition snapshots.
- `normalizeToolState` and `normalizeMcpConnectionState` hydrate persisted
  snapshot state back into the in-memory snapshot policy.

### Finding

Snapshot policy still carried local strict non-array object checks for event
payload fallback, optional metadata patches, and hydration normalization. These
duplicated the shared record guard at a state-persistence boundary where
array-shaped values must remain malformed instead of becoming numeric-keyed
maps or metadata patches.

### Change

- Replaced local snapshot-policy record checks with
  `runtime/src/utils/record.ts#asRecord`.
- Added regressions proving array-shaped budget metadata is ignored and
  array-shaped hydrated `inFlight`/`completed` maps are dropped before flush.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/state/snapshot-policy.test.ts tests/state/recovery-restart.test.ts --reporter=dot`

## 2026-06-22: Shared Recovery Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/state/recovery.ts` recovers daemon startup state from persisted
  agent runs, session snapshots, and stale in-flight tool calls.
- `applyRecoveredToolState` reconciles snapshot `pending`, `inFlight`, and
  `completed` tool-state maps with recovered tool-call rows.
- `toRecoveredAgentRun` parses persisted agent-run `metadata_json` before
  returning recovered run records to daemon/app-server recovery paths.

### Finding

Daemon recovery carried local strict-record checks for recovered tool-state maps,
existing recovered tool-call entries, and agent-run metadata parsing. These
duplicated the shared non-array object contract at a persisted recovery boundary
where array-shaped JSON must be treated as malformed state rather than merged as
records.

### Change

- Replaced the local recovery record checks with
  `runtime/src/utils/record.ts#asRecord`.
- Added regressions proving array-shaped `metadata_json`, `inFlight`, and
  `completed` recovery maps are discarded before recovered state is surfaced.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/state/recovery-restart.test.ts tests/state/pruning.test.ts --reporter=dot`

## 2026-06-22: Shared SDK MCP Schema Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/mcp/client.ts` fetches SDK MCP tool descriptors and
  sanitizes untrusted tool descriptions/search hints/input schemas before
  exposing them to runtime tools.
- `runtime/tests/services/mcp/client.test.ts` and
  `runtime/tests/mcp-client/tools.test.ts` cover model-facing MCP tool metadata
  sanitization, schema stripping, schema-size fallback, and MCP tool bridging.

### Finding

SDK MCP schema sanitization still had a local `asObjectRecord` helper with the
same strict non-array object semantics as `runtime/src/utils/record.ts`. The
local duplicate sat on a sensitive untrusted-server boundary where accidentally
accepting arrays as records would expose array-shaped input schemas instead of
falling back to the safe open-object schema.

### Change

- Replaced the local `asObjectRecord` helper with
  `runtime/src/utils/record.ts#asRecord`.
- Added a regression that array-shaped SDK MCP input schemas are rejected and
  normalized to `{ type: "object", properties: {} }`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/services/mcp/client.test.ts tests/mcp-client/tools.test.ts --reporter=dot`

## 2026-06-22: Shared Agent Run Metadata Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/state/agent-runs.ts` persists agent-run rows and merges status
  metadata patches into existing `metadata_json`.
- `runtime/src/state/snapshot-policy.ts` and app-server lifecycle paths call
  `updateAgentRunStatus` when status transitions add budget/snapshot metadata.

### Finding

Agent-run metadata parsing still carried a local non-array object guard. The
behavior matched the shared strict record guard, but keeping a local helper at
the persisted state boundary made it easier for future edits to accidentally
accept array-shaped `metadata_json` and merge numeric array keys into agent-run
metadata.

### Change

- Replaced the local metadata object guard with
  `runtime/src/utils/record.ts#asRecord`.
- Added a state regression proving array-shaped stored metadata is discarded
  before applying a status metadata patch.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/state/agent-runs.test.ts tests/state/snapshot-policy.test.ts --reporter=dot`

## 2026-06-22: Shared Plugin Registration Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/plugins/registration/manager.ts` loads enabled plugins, merges
  their commands/agents/hooks/servers into active discovery snapshots, and
  refreshes plugin-related app-state.
- `runtime/tests/plugins/registration.test.ts` covers active plugin refresh,
  existing plugin errors, agent definition merging, and app-state publication.

### Finding

The registration manager still used a local loose record guard for app-state
containers and plugin error records. Array-shaped `plugins`, `agentDefinitions`,
or `mcp` containers could be merged as records, preserving stale array entries
and reconnect counters from malformed state.

### Change

- Replaced the local registration manager `isRecord` helper with
  `runtime/src/utils/record.ts#isRecord`.
- Added a regression that array-shaped plugin app-state containers are treated
  as malformed and rebuilt from the fresh plugin snapshot.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/plugins/registration.test.ts --reporter=dot`

## 2026-06-22: Shared AgenC Tool-Use Context Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/agenc-tool-use-context.ts` builds provider-neutral tool
  context from live sessions, session state snapshots, app-state bridges, and
  per-turn metadata.
- `runtime/tests/session/agenc-tool-use-context.test.ts` now covers malformed
  app-state snapshots at this boundary.

### Finding

The context builder used a local loose record guard for session/app-state shape
checks. Array-shaped app-state snapshots could be trusted if they carried
object-like properties, even though this boundary should only accept non-array
records.

### Change

- Replaced the local context builder `isRecord` helper with
  `runtime/src/utils/record.ts#isRecord`.
- Added a direct regression that array-shaped app-state snapshots fall back to
  the safe default app-state surface.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/session/agenc-tool-use-context.test.ts tests/phases/commit.test.ts --reporter=dot`

## 2026-06-22: Shared Tool Result Storage Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/toolResultStorage.ts` walks persisted transcript messages
  to find user `tool_result` blocks, assistant `tool_use` blocks, and
  previously persisted replacement records.
- `runtime/tests/utils/toolResultStorage.test.ts` covers malformed transcript
  blocks that must be ignored while valid tool results are replaced.

### Finding

The transcript shape reader used a local loose record guard that accepted
arrays. An array with synthetic `tool_result` fields could be treated as a
valid transcript block, even though the code only needs non-array object
records for message envelopes and content blocks.

### Change

- Replaced the local tool-result storage `isRecord` helper with
  `runtime/src/utils/record.ts#isRecord`.
- Added a regression case that array-shaped `tool_result` blocks are ignored.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- bun test tests/utils/toolResultStorage.test.ts`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts --reporter=dot`

## 2026-06-22: Shared PowerShell Parser Error Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/shell-command/powershell-parser.ts` runs a native PowerShell AST
  helper process, polls stdout/stderr pipes synchronously, and treats
  `EAGAIN`/`EWOULDBLOCK` reads as nonblocking retry conditions.
- `runtime/tests/shell-command/powershell-parser.test.ts` covers missing
  executable behavior and native parser reuse when PowerShell is present.

### Finding

The nonblocking-read error check used a local loose record guard that accepted
arrays. It only needs object-shaped Node error values with a `code` field, so
the shared strict non-array guard is a better fit.

### Change

- Replaced the local parser `isRecord` helper with
  `runtime/src/utils/record.ts#isRecord`.
- Kept `EAGAIN` and `EWOULDBLOCK` retry handling unchanged.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/shell-command/powershell-parser.test.ts tests/shell-command/parser.test.ts tests/shell-command/safety.test.ts --reporter=dot`

## 2026-06-22: Split UserPromptSubmit Record And Iterable Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/hooks/user-prompt-submit.ts` reads live session/turn/app-state
  context to locate configured `UserPromptSubmit` hooks and build hook input
  metadata.
- The same executor accepts hook return values as a single result, a promise,
  an iterable, or an async iterable, so array-returning hooks must still yield
  multiple results.
- `runtime/tests/hooks/user-prompt-submit.test.ts` now covers array-returning
  hook results for the newer hook executor directly.

### Finding

The file used one local loose `isRecord` helper for two different purposes:
record-shaped context reads and iterable detection. That made the record helper
accept arrays, even though only iterable detection needs array support.

### Change

- Replaced context and nested metadata reads with
  `runtime/src/utils/record.ts#isRecord`.
- Removed the loose local `isRecord` helper and made iterable detection check
  for non-null objects directly, preserving array-returning hook behavior.
- Added a focused regression test for array-returning `UserPromptSubmit` hooks.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/hooks/user-prompt-submit.test.ts tests/hooks/configured-hooks.test.ts tests/bin/agenc.user-prompt-submit.test.ts --reporter=dot`

## 2026-06-22: Shared Legacy Command Adapter Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands.ts` adapts older local command invocations into the
  runtime-owned slash-command dispatcher by reading `session`, `services`,
  `sessionConfiguration`, and optional app-state bridge fields.
- `runtime/tests/commands/dispatcher.test.ts`,
  `runtime/tests/commands/registry.test.ts`,
  `runtime/tests/commands/tui-command-list.test.ts`, and
  `runtime/tests/commands/command-surface.test.ts` cover slash-command
  dispatch, registry exposure, TUI command filtering, and the command surface.

### Finding

The legacy adapter used a local loose object guard that accepted arrays as
records. The adapter reads session and app-state bridge objects; arrays with
custom properties are malformed compatibility payloads and should not pass the
record boundary.

### Change

- Replaced the local `commands.ts` `isRecord` helper with
  `runtime/src/utils/record.ts#isRecord`.
- Preserved fallback behavior when a legacy invocation lacks a usable session
  context: the command still returns the existing dispatcher-context message.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/commands/dispatcher.test.ts tests/commands/registry.test.ts tests/commands/tui-command-list.test.ts tests/commands/command-surface.test.ts --reporter=dot`

## 2026-06-22: Shared Command App-State Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/skills.ts` reads MCP-derived skill commands from the
  slash-command app-state bridge and merges them into the `/skills` listing.
- `runtime/src/commands/status-menu.tsx` reads live TUI app-state snapshots to
  render model, MCP, and task rows in the `/status` menu.
- `runtime/tests/commands/skills.test.ts` covers MCP-derived skills, formatting,
  filtering, and project skill creation. `runtime/tests/commands/status.test.ts`
  covers the status dashboard snapshot rows and attention summary.

### Finding

Both command surfaces had local loose object guards that accepted arrays as
records. Their callers only need plain object app-state payloads; array-shaped
payloads already degrade to empty/default rows unless custom properties are
attached, so the shared strict non-array guard is the safer boundary.

### Change

- Replaced the local `/skills` and `/status` app-state record helpers with
  `runtime/src/utils/record.ts#isRecord`.
- Preserved scalar display behavior for arrays in `/status` values; only
  record-shaped app-state parsing became strict.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/commands/skills.test.ts tests/commands/status.test.ts tests/commands/tui-command-list.test.ts tests/commands/command-surface.test.ts --reporter=dot`

## 2026-06-22: Shared Config Migration Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/state/migrations/config-migrations.ts` deep-clones raw config
  JSON, normalizes provider/profile aliases, and applies startup settings
  migrations from leniently-read settings files.
- `runtime/src/config/loader.ts`, `runtime/src/config/migrate.ts`, and
  `runtime/src/config/edit.ts` call `migrateRawAgenCConfig` before exposing or
  writing config.
- `runtime/tests/state/config-migrations.test.ts` covers raw config alias
  migration, settings migration versions, skipped migration paths, and project
  approval migration behavior.

### Finding

Config migrations used a local strict non-array object guard identical to
`utils/record.ts#isRecord`. The local `JsonRecord` alias is
`Record<string, unknown>`, so the shared guard preserves the same narrowing and
array rejection.

### Change

- Replaced the local `isRecord` implementation with
  `runtime/src/utils/record.ts#isRecord`.
- Kept recursive clone behavior unchanged: arrays are cloned before object
  recursion, and primitives pass through unchanged.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/state/config-migrations.test.ts tests/config/config.test.ts tests/config/json.test.ts tests/personality/personality-migration.contract.test.ts --reporter=dot`

## 2026-06-22: Shared Message Normalization Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/messages.ts` decodes nested JSON strings in tool-use input
  payloads before validating them against tool schemas, preserving JSON arrays,
  objects, and strings while rejecting non-JSON values.
- `runtime/tests/conversation/messages-core.test.ts` covers nested tool input
  decoding for canonical tools and MCP schema-only tools, including arrays
  nested inside JSON strings.

### Finding

The message normalization path used a local `isRecordValue` strict non-array
object guard equivalent to `utils/record.ts#isRecord`. Arrays are already
handled in a separate branch before object recursion, so sharing the strict
helper preserves nested JSON decoding behavior.

### Change

- Replaced the local `isRecordValue` implementation with the shared
  `runtime/src/utils/record.ts` utility imported under the existing local name.
- Preserved explicit array decoding before object recursion in
  `decodeNestedJsonStrings`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/conversation/messages-core.test.ts tests/tools/code-mode/turn-host.test.ts tests/tools/tool-surface-consolidation.test.ts --reporter=dot`

## 2026-06-22: Shared Plugin Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/plugins/manifest-schema.ts` validates plugin manifests,
  component declarations, hook/MCP/LSP maps, metadata objects, and nested
  manifest interfaces. It also exports `isRecord` for plugin registration
  helpers.
- `runtime/src/plugins/resolution.ts` validates npm pack entries and plugin
  signature file wrappers during plugin source resolution.
- `runtime/src/plugins/marketplace/marketplace.ts` validates marketplace index
  files, marketplace manifests, plugin entries, and persisted marketplace
  records.
- `runtime/src/plugins/cli/pluginOperations.ts` validates installed plugin
  metadata while removing plugin config entries and data directories.
- `runtime/src/utils/plugins/pluginLoader.ts` validates cached plugin settings
  and parsed plugin manifests during plugin discovery/loading.

### Finding

These plugin modules duplicated strict non-array object guards equivalent to
`utils/record.ts#isRecord`. `manifest-schema.ts` exported the helper to sibling
registration modules, so that exported surface needed to be preserved while
centralizing the predicate implementation.

### Change

- Replaced compatible strict plugin `isRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved the `manifest-schema.ts` `isRecord` export by re-exporting the
  shared helper.
- Left `plugins/registration/manager.ts` unchanged because its local guard
  intentionally accepts arrays at app-state merge boundaries.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/plugins/loader.test.ts tests/plugins/pluginLoader-core.test.ts tests/plugins/pluginLoader-merge-sources.test.ts tests/utils/plugins/pluginLoader.test.ts tests/plugins/resolution.test.ts tests/plugins/marketplace/marketplace.test.ts tests/plugins/cli/pluginCliCommands.test.ts tests/plugins/registration.test.ts --reporter=dot`

## 2026-06-22: Shared Thread Store Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/thread-store/store.ts` normalizes registry entries read from the
  filesystem-backed thread registry and canonicalizes `ThreadSource` JSON before
  persistence/listing.
- `runtime/tests/session/thread-store.test.ts` covers structured thread-source
  creation, metadata updates, registry durability, corrupt registry recovery,
  and legacy import paths.
- `runtime/tests/session/live-thread.test.ts`,
  `runtime/tests/state/backfill.test.ts`, and app-server lifecycle contract
  tests cover callers that create, resume, archive, and index persisted
  `FileThreadStore` threads.

### Finding

The thread store duplicated the strict non-array object guard already provided
by `utils/record.ts#isRecord` for registry entries and nested thread-source JSON
objects. Arrays are handled explicitly in `canonicalizeJsonValue` before object
recursion, so the shared strict guard preserves source validation.

### Change

- Replaced the local thread-store `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved strict array/null rejection for registry entries and structured
  thread-source object recursion while keeping arrays valid only in JSON value
  positions.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/session/thread-store.test.ts tests/session/live-thread.test.ts tests/state/backfill.test.ts tests/state/rollout-parse-guards.test.ts tests/app-server/session-lifecycle.contract.test.ts tests/app-server/agent-lifecycle.contract.test.ts --reporter=dot`

## 2026-06-22: Shared Rollout Spawn-Edge Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/session/rollout-store.ts` loads legacy and current
  `thread-spawn-edges.json` snapshots during `RolloutStore` construction, then
  normalizes direct arrays, versioned edge arrays, keyed legacy objects, and
  `threadSpawnEdges` maps.
- `runtime/tests/session/rollout-store.test.ts` covers persisted spawn-edge
  recovery, descendant lookup, legacy snapshot migration, corrupt snapshot
  quarantine, and path-collision handling.

### Finding

The rollout store duplicated the strict non-array object predicate already
centralized in `utils/record.ts#isRecord` for thread-spawn snapshot, edge, and
agent-metadata validation.

### Change

- Replaced the local rollout-store `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved strict array/null rejection for snapshot wrappers, keyed edge
  objects, edge records, and agent metadata.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/session/rollout-store.test.ts tests/agents/control.test.ts tests/state/rollout-parse-guards.test.ts --reporter=dot`

## 2026-06-22: Shared Guardian Metadata Record Helper

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/permissions/guardian/arbiter.ts` builds approval context
  metadata from invocation session/turn objects, including cwd, session id,
  transcript path, model, permission mode, and tool matcher aliases.
- `runtime/tests/permissions/guardian/arbiter.test.ts` covers guardian versus
  resolver routing, approved-for-session cache reuse, stale-turn rejection,
  and permission-mode arbitration.

### Finding

The guardian arbiter carried a local strict `asRecord` helper equivalent to
`utils/record.ts#asRecord`, except that the local helper returned `undefined`
for invalid values. Its call sites use optional chaining, so the shared helper's
`null` fallback preserves the malformed-metadata behavior.

### Change

- Replaced the local guardian metadata `asRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved strict array/null rejection for session, turn, model, config, and
  tool-name metadata wrappers.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/permissions/guardian/arbiter.test.ts tests/mcp-client/tools.test.ts tests/hooks/configured-hooks.test.ts --reporter=dot`

## 2026-06-22: Shared Agent Loader Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/AgentTool/loadAgentsDir.ts` parses custom agent JSON
  definitions, markdown frontmatter, hook settings, and plugin-provided agent
  definitions before merging agent sources by precedence.
- `runtime/tests/tools/AgentTool/loadAgentsDir.test.ts` covers JSON and
  markdown agent parsing, invalid hook/MCP settings, source precedence,
  project/user discovery, symlink dedupe, and plugin-agent loading.

### Finding

The agent loader carried a local strict `isRecord` helper equivalent to
`utils/record.ts#isRecord`. It gates untrusted/custom agent configuration
objects where arrays and `null` are not valid wrapper records.

### Change

- Replaced the local AgentTool loader `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved strict array/null rejection for hook maps, markdown frontmatter,
  JSON agent objects, JSON agent maps, and plugin-agent wrappers.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tools/AgentTool/loadAgentsDir.test.ts tests/tools/AgentTool/agent-memory.contract.test.ts --reporter=dot`

## 2026-06-22: Shared Startup Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/bin/startup-internal-events.ts` fetches worker startup
  internal-event pages, validates envelopes, skips malformed event rows, and
  preserves `agent_id` on subagent events.
- `runtime/src/bin/bootstrap-services.ts` normalizes bootstrap compact-hook
  arguments, stop-hook context objects, managed network approval requests, and
  provider factory extras used to derive auth mode.
- `runtime/tests/bin/bootstrap.session-ingress.test.ts` covers remote startup
  internal-event pagination, malformed JSON/envelopes, repeated cursors, and
  subagent event reads.
- `runtime/tests/bin/bootstrap-services.test.ts` covers bootstrap hook/service
  wiring and startup service behavior around the touched helpers.

### Finding

Startup internal-event parsing and bootstrap service construction each carried
local strict `isRecord` helpers equivalent to `utils/record.ts#isRecord`.
They gate startup and service payloads where arrays and `null` are not valid
record wrappers.

### Change

- Replaced the local startup/bootstrap `isRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved strict array/null rejection for internal-event envelopes, hook
  context payloads, managed network approval shapes, and provider extra data.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/bin/bootstrap.session-ingress.test.ts tests/bin/bootstrap-services.test.ts --reporter=dot`

## 2026-06-22: Shared Provider Policy Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/policyLimits/types.ts` validates policy-limit API/cache
  payloads before accepting per-policy restriction objects.
- `runtime/src/llm/providers/ollama/adapter.ts` normalizes native Ollama SDK
  chat and stream response payloads, including tool-call wrapper objects and
  parsed string tool arguments.
- `runtime/tests/services/policyLimits/policyLimits.test.ts` covers malformed
  restriction payload rejection and null-prototype restriction maps.
- `runtime/tests/llm/providers/ollama/provider.test.ts` covers malformed
  native SDK response fields and mixed valid/invalid Ollama tool calls in chat
  and streaming paths.

### Finding

Policy-limit response parsing and the Ollama provider adapter each carried a
local strict `isRecord` helper equivalent to `utils/record.ts#isRecord`.
Both helpers gate untrusted provider/service payloads where arrays and `null`
must continue to be rejected before nested fields are read.

### Change

- Replaced the local policy-limit and Ollama `isRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved array/null rejection, malformed policy-limit response fallback,
  native SDK tool-call filtering, and parsed string argument validation.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/services/policyLimits/policyLimits.test.ts tests/llm/providers/ollama/provider.test.ts --reporter=dot`

## 2026-06-22: Shared Parsing Record Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/providerDiscovery.ts` normalizes OpenAI-compatible and
  Ollama model-list payloads, including nested Ollama model details and
  string-array fields.
- `runtime/src/onboarding/projectOnboardingState.ts` reads and normalizes
  persisted first-run/project onboarding state, including per-project records,
  completed step ids, and corrupt/malformed state fallbacks.
- `runtime/src/tools/system/file-read.ts` parses Jupyter notebook JSON, cell
  metadata, notebook language metadata, outputs, embedded images, and PDF
  extraction command payloads for the FileRead tool.
- `runtime/tests/utils/providerDiscovery.test.ts`,
  `runtime/tests/onboarding/projectOnboardingState.test.ts`,
  `runtime/tests/tools/system/file-read.test.ts`,
  `runtime/tests/utils/pdfInfo.test.ts`, and
  `runtime/tests/utils/pdfUtils.test.ts` cover provider payload normalization,
  onboarding state recovery, file-read notebook/PDF paths, and PDF helper
  parsing.

### Finding

Provider discovery, onboarding state, and FileRead notebook/PDF parsing each
carried local `asRecord` helpers equivalent to `utils/record.ts#asRecord`.
They gate untrusted JSON payloads before reading nested model, state, notebook,
output, and command-result fields.

### Change

- Replaced the local parsing `asRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved truthy fallback behavior in provider discovery, `null` fallback
  behavior in onboarding/FileRead parsing, array rejection, and malformed-state
  recovery paths.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/utils/providerDiscovery.test.ts tests/onboarding/projectOnboardingState.test.ts tests/tools/system/file-read.test.ts tests/utils/pdfInfo.test.ts tests/utils/pdfUtils.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Tool Surface Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/canonicalToolSurface.ts` converts canonical runtime tool
  results into legacy tool-result blocks, including text, image content items,
  error flags, metadata, and canonical result summaries.
- `runtime/src/tools/router.ts` dispatches model/runtime tool calls, resolves
  current exec policies from session services, applies guardian/pre-hook
  approval flow, and preserves code-mode/diff-tracker behavior.
- `runtime/src/tools/context.ts` projects structured tool outputs back to
  code-mode results, including tool-search and MCP structured response items.
- `runtime/tests/tools/context.test.ts`, `runtime/tests/tools/router.test.ts`,
  `runtime/tests/tools/tool-surface-consolidation.test.ts`, and
  `runtime/tests/tools/system/signed-allowed-roots.test.ts` cover structured
  output projection, router dispatch/policy behavior, canonical tool surfaces,
  and signed session-root propagation.

### Finding

The canonical tool surface, router, and tool context modules each carried local
strict `isRecord` helpers equivalent to `utils/record.ts#isRecord`. They gate
structured wrapper payloads before reading fields from tool result data, exec
policy wrappers, and code-mode response item metadata.

### Change

- Replaced the local tool-surface/router/context `isRecord` helpers with the
  shared `runtime/src/utils/record.ts` utility.
- Preserved strict array/null rejection for wrapper payloads, canonical result
  formatting, exec-policy extraction, and structured response projection.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tools/context.test.ts tests/tools/router.test.ts tests/tools/tool-surface-consolidation.test.ts tests/tools/system/signed-allowed-roots.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared File Mention Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/prompts/file-mentions.ts` parses prompt `@file` mentions,
  validates workspace/allowed-root boundaries, expands readable text files
  into prompt attachments, leaves image/PDF mentions for media pipelines, and
  reads direct plus `_unknown.attachments` allowed-root config.
- `runtime/tests/prompts/file-mentions.test.ts` covers mention scanning,
  path validation, typed and preserved config shapes, prompt expansion,
  sanitization, media pass-through, root rejection, symlink rejection, and file
  count/line limits.
- `runtime/tests/prompts/attachments/integration.test.ts` and
  `runtime/tests/prompts/attachments/messages.test.ts` cover the downstream
  attachment prompt/message paths that consume file-mention output.

### Finding

The file-mention prompt helper carried a local strict `isRecord` helper
equivalent to `utils/record.ts#isRecord`. It only gates untrusted config
objects before reading direct and preserved allowed-root attachment settings.

### Change

- Replaced the local file-mention `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved array/null rejection for config objects, `_unknown.attachments`
  fallback behavior, and the surrounding file/media mention expansion logic.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/prompts/file-mentions.test.ts tests/prompts/attachments/integration.test.ts tests/prompts/attachments/messages.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared API Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/api/toolArgumentNormalization.ts` parses provider
  tool-call argument strings, preserves structured JSON object arguments,
  wraps plain strings for known tools, and leaves arrays/scalars for schema
  validation.
- `runtime/src/services/api/openAiCodeOAuthShared.ts` normalizes OAuth token
  exchange JSON payloads before extracting access, refresh, and id tokens.
- `runtime/src/services/api/openAiCodeTransform.ts` parses ProviderCode SSE
  JSON payloads, reads nested response records, detects completed
  function-call output, filters malformed completed response entries, and
  converts output text/function calls back to provider message content.
- `runtime/tests/services/api/toolArgumentNormalization.test.ts`,
  `runtime/tests/services/api/openAiCodeTransform.test.ts`,
  `runtime/tests/services/api/openAiCodeOAuthShared.test.ts`,
  `runtime/tests/services/api/providerConfig.github.test.ts`, and
  `runtime/tests/services/api/providerConfig.openAiCodeSecureStorage.test.ts`
  cover argument normalization, malformed SSE payloads, completed response
  filtering, token exchange failure handling, and ProviderCode credential
  resolution.

### Finding

The API transform, OAuth shared helper, and tool-argument normalizer each
carried local strict record guards equivalent to `utils/record.ts`. They gate
untrusted JSON payloads before extracting fields or deciding whether arrays and
scalars should be skipped, passed through, or rejected by later validation.

### Change

- Replaced local `isRecord` / `asRecord` helpers in the API modules with the
  shared `runtime/src/utils/record.ts` utility.
- Preserved non-object SSE skipping, completed-response malformed-entry
  filtering, JSON literal pass-through for tool arguments, and OAuth token
  payload fallback behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- bun test tests/services/api/toolArgumentNormalization.test.ts tests/services/api/openAiCodeTransform.test.ts`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/services/api/openAiCodeOAuthShared.test.ts tests/services/api/providerConfig.github.test.ts tests/services/api/providerConfig.openAiCodeSecureStorage.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Token Estimation Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/token-estimation.ts` estimates deterministic local token
  counts for strings, arrays, structured content blocks, tool-use/tool-result
  blocks, thinking blocks, media placeholders, file-type ratios, and
  provider/model tokenizer hints.
- `runtime/src/services/tokenEstimation.ts` layers provider API token counting
  on top of the local estimator, normalizes attachment payloads for estimation,
  detects thinking blocks, strips tool-search-only fields, and resolves Bedrock
  token-count model ids.
- `runtime/tests/llm/token-estimation.test.ts` covers local estimator ratios,
  structured blocks, media placeholders, provider hints, file-type ratios, and
  message aggregation.
- `runtime/tests/services/service-utilities.test.ts` and
  `runtime/tests/services/service-utilities.contract.test.ts` cover service
  token-estimation surfaces, attachment normalization, provider-count
  fallbacks, tool-reference stripping, thinking detection, and Bedrock
  token-count loading.

### Finding

Both token-estimation modules carried local strict `isRecord` helpers
equivalent to `utils/record.ts#isRecord`. They gate untrusted content blocks,
attachment records, message blocks, and tool-reference blocks before
specialized token estimation or provider-count request shaping.

### Change

- Replaced the local `isRecord` helpers in the LLM and service
  token-estimation modules with the shared `runtime/src/utils/record.ts`
  utility.
- Preserved scalar/array JSON fallback behavior, media placeholder token costs,
  attachment normalization, thinking-block detection, and tool-reference
  stripping.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/llm/token-estimation.test.ts tests/services/service-utilities.test.ts tests/services/service-utilities.contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Feature Registry Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/registry/features.ts` builds the staged feature set from
  defaults, canonical/legacy feature config keys, structured feature entries,
  `_unknown.features`, and dependency normalization.
- `runtime/tests/llm/registry/registry.test.ts` covers feature defaults, legacy
  aliases, ignored removed keys, structured entries, dependency normalization,
  and managed feature construction from config tables.

### Finding

The feature registry carried a local strict `isRecord` helper equivalent to
`utils/record.ts#isRecord`. It gates config feature tables and structured
entries before reading `enabled` and `apps_mcp_path_override.path` values.

### Change

- Replaced the local feature-registry `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved feature-table fallback behavior, structured entry parsing, ignored
  feature handling, and dependency normalization.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/llm/registry/registry.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared LLM Tool Argument Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/types.ts` validates provider tool-call payloads, normalizes
  parsed JSON/string arguments, preserves shell-command string shortcuts, and
  rejects non-object decoded arguments before dispatch.
- `runtime/src/llm/stream-parser.ts` consumes `validateToolCallDetailed` when
  batching streamed tool calls for execution.
- `runtime/tests/llm/types.test.ts` covers plain-string argument wrapping,
  structured argument preservation, malformed structured fallbacks, and
  shell-command edge cases.
- `runtime/tests/llm/stream-parser.test.ts` covers downstream valid and
  malformed tool-call batching.

### Finding

LLM tool-call argument normalization carried a local strict `isRecord` helper
equivalent to `utils/record.ts#isRecord`. It gates parsed argument objects
before the later validation path rejects arrays, null, and primitives as
non-object tool arguments.

### Change

- Replaced the local LLM tool argument `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved plain-string command/path wrapping, malformed structured fallback,
  and non-object argument rejection behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/llm/types.test.ts tests/llm/stream-parser.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Model Metadata Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/model-metadata.ts` resolves model context/output-token
  metadata from explicit config, built-in catalog heuristics, live
  OpenAI-compatible `/models` endpoints, OpenRouter, models.dev, LiteLLM, and
  conservative fallback values.
- `runtime/tests/llm/models-manager.test.ts` covers explicit metadata,
  live-compatible endpoint metadata, OpenRouter metadata, models.dev fallback,
  LiteLLM fallback, missing metadata fallback, and output-token bounds.
- `runtime/tests/llm/model-registry.test.ts` covers synchronous registry
  resolution and model-info conversion through the metadata resolver.

### Finding

Model metadata carried a local strict `asRecord` helper equivalent to
`utils/record.ts#asRecord`, except it returned `undefined` instead of `null`.
The helper gates untrusted registry payloads before reading token-limit fields
from nested provider, model, limit, and top-provider records.

### Change

- Replaced the local model metadata `asRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Widened local metadata reader parameters to accept the shared helper's
  `null` result while preserving the existing falsy fallback behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/llm/models-manager.test.ts tests/llm/model-registry.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Hook Output Parser Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/hooks/engine/output-parser.ts` parses command-hook JSON stdout,
  selects nested `hookSpecificOutput`, validates known fields, merges
  common/root event fields, and normalizes permission decisions and updated
  input/permission records.
- `runtime/tests/hooks/engine/dispatcher.test.ts` covers nested
  `hookSpecificOutput` normalization, malformed structured output, universal
  field merging, and event-specific `hookSpecificOutput` validation.

### Finding

Hook output parsing carried a local strict `isRecord` helper equivalent to
`utils/record.ts#isRecord`: accept non-array objects and reject arrays, null,
functions, and primitives. The helper gates untrusted hook JSON before
field-specific validation reports exact parser errors.

### Change

- Replaced the local hook output parser `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved `hookSpecificOutput` object validation, malformed array rejection,
  and field-specific parser messages.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/hooks/engine/dispatcher.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Configured Hooks Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/hooks/configured-hooks.ts` builds configured command-hook
  runtime inputs for tool hooks, permission decision hooks, prompt-submit hooks,
  stop hooks, lifecycle hooks, and test-hook diagnostics.
- `runtime/tests/hooks/configured-hooks.test.ts` covers configured hook loading,
  diagnostics, redaction, permission hook behavior, stop/lifecycle hooks, trust
  gating, and abort cleanup.
- `runtime/tests/hooks/hooks-core.test.ts` covers the public hook execution
  wrappers and tool-use context paths that feed configured hooks.

### Finding

Configured hooks carried a local strict `asRecord` helper equivalent to
`utils/record.ts#asRecord`, except it returned `undefined` instead of `null`.
Its call sites already use optional chaining while extracting session, turn,
model, collaboration mode, and config fields from unknown invocation context.

### Change

- Replaced the local configured-hooks `asRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved hook input fallback values and hook output parsing behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/hooks/configured-hooks.test.ts tests/hooks/hooks-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared MCP Tool Bridge Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/mcp-client/tools.ts` normalizes MCP tool descriptors, sanitizes
  model-facing schemas, renders MCP tool-call content, normalizes tool-call
  responses, and builds approval prompt metadata for MCP client tools.
- `runtime/tests/mcp-client/tools.test.ts` covers malformed tool descriptors,
  unsafe tool names, schema metadata stripping, oversized schemas, malformed
  call results, observer wiring, filters, and approval flows.
- `runtime/tests/services/mcp/client.test.ts` covers service-level MCP client
  tool mapping and schema sanitization behavior through the same bridge path.

### Finding

The MCP tool bridge carried a local strict `asRecord` helper with the same
nullable non-array object contract as `utils/record.ts#asRecord`. The helper
backs untrusted MCP descriptor parsing, result parsing, and approval metadata
reads. The adjacent schema sanitizer intentionally still walks any object after
handling arrays, so that broader traversal should not be replaced by a strict
record predicate.

### Change

- Replaced the local MCP tool bridge `asRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved schema traversal, malformed payload rendering, approval prompt
  metadata, and model-facing schema fallback behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/mcp-client/tools.test.ts tests/services/mcp/client.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared MCP Resource/Prompt Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/mcp-client/resources.ts` lists MCP resources, normalizes
  resource descriptors, reads resource content, skips malformed entries, and
  enforces the 5MB resource read cap.
- `runtime/src/mcp-client/prompts.ts` lists MCP prompts, normalizes prompt
  argument specs, renders prompt messages, and frames untrusted prompt content.
- `runtime/tests/mcp-client/resources.test.ts` and
  `runtime/tests/mcp-client/prompts.test.ts` cover malformed catalogs,
  malformed content/messages, non-array payloads, disposal, and untrusted prompt
  framing.

### Finding

The MCP resource and prompt bridges each carried a local strict `asRecord`
adapter equivalent to `utils/record.ts#asRecord`, except the local helpers
returned `undefined` instead of `null`. The bridge field readers already treat
missing records as absent payloads, so they can accept the shared helper's
nullable result directly.

### Change

- Replaced the local MCP resource/prompt `asRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Widened the bridge field-reader parameters to accept `null` while preserving
  malformed-payload behavior and output shapes.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/mcp-client/resources.test.ts tests/mcp-client/prompts.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Config Menu Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/config-menu.tsx` builds the persistent v2 `/config`
  menu snapshot, including provider, MCP server, plugin, and profile summary
  rows.
- `runtime/tests/commands/config.test.ts` covers the `/config` command surface,
  menu snapshot rows, config reload behavior, and config path handling.

### Finding

The config-menu key-count/key-list helpers carried a local nullable
`optionalRecord` adapter with the same strict non-array object contract as
`utils/record.ts#asRecord`. The broader display helpers intentionally still
format arrays and generic objects directly, so only the record-specific helper
should be shared.

### Change

- Replaced the local object/array check in `optionalRecord` with
  `runtime/src/utils/record.ts#asRecord`.
- Preserved the menu's existing scalar/object display formatting.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/commands/config.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared LSP Config Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/lsp/config.ts` validates and normalizes LSP server
  config records, env/string maps, extension-to-language maps, and server
  config source output.
- `runtime/tests/services/lsp/config.test.ts` covers valid normalization,
  extension language trimming, invalid server config errors, unsupported
  lifecycle fields, command/workspace whitespace, and injectable source
  behavior.

### Finding

LSP config parsing carried a local strict `isRecord` predicate equivalent to
`utils/record.ts#isRecord`: accept non-array objects and reject arrays, null,
functions, and primitives. The helper is used for config object narrowing before
field-specific validation reports exact parse failures.

### Change

- Replaced the local `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved validation messages and extension/language normalization.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/services/lsp/config.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared NotebookEdit Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/system/notebook-edit.ts` parses Jupyter notebook JSON,
  finds cells by literal id, numeric id, or index fallback, resolves notebook
  metadata language info, and mutates cells for replace, insert, and delete
  modes.
- `runtime/tests/tools/system/notebook-edit.test.ts` covers invalid notebook
  shapes, cell lookup edge cases, language fallback, and edit behavior.
- `runtime/tests/tools/tool-surface-consolidation.test.ts` covers the
  model-facing canonical NotebookEdit wrapper that delegates to the same
  session-backed implementation.

### Finding

NotebookEdit carried a local strict `isRecord` predicate equivalent to
`utils/record.ts#isRecord`: accept non-array objects and reject arrays, null,
functions, and primitives. The helper is used only to narrow parsed notebook
objects and cell/metadata records before field-specific validation.

### Change

- Replaced the local `isRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved NotebookEdit's existing validation and error messages.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tools/system/notebook-edit.test.ts tests/tools/tool-surface-consolidation.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared GitHub Device-Flow Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/github/deviceFlow.ts` parses GitHub OAuth device-code
  responses, access-token polling responses, and Copilot token exchange
  responses from untrusted JSON.
- `runtime/tests/services/github/deviceFlow.test.ts` covers successful parsing,
  malformed `null` payloads, non-JSON payloads, HTTP failures, and OAuth error
  responses for the device-code, polling, and Copilot exchange paths.
- `runtime/tests/utils/githubModelsCredentials.refresh.test.ts` covers the
  downstream Copilot token refresh path that mocks the device-flow exchange.

### Finding

The GitHub device-flow parser carried a local nullable `asRecord` adapter
equivalent to `utils/record.ts#asRecord`: accept non-array objects and reject
arrays, null, functions, and primitives. The parser already treats rejected
payloads as empty records before surfacing field-specific malformed-response
errors.

### Change

- Replaced the local `asRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Preserved the existing response-specific malformed JSON and malformed payload
  errors.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- bun test tests/services/github/deviceFlow.test.ts`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/utils/githubModelsCredentials.refresh.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Ask-User-Question Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/ask-user-question/tool.ts` parses model-facing
  `AskUserQuestion` tool payloads, TUI-recorded answers, annotations, metadata,
  and one-shot answered inputs keyed by tool call id.
- `runtime/tests/tools/ask-user-question/tool.test.ts` covers malformed
  payload rejection, recorded answer consumption, and schema exposure.
- `runtime/tests/tools/ask-user-question/tui-tool.test.tsx` and
  `runtime/tests/tools/ask-user-question-tui-routing.test.tsx` cover the TUI
  adapter and routing contract for the same tool surface.

### Finding

The ask-user-question parser carried a local nullable `asRecord` adapter
equivalent to `utils/record.ts#asRecord`: accept non-array objects and reject
arrays, null, functions, and primitives. The parser's adjacent `nonEmptyString`
helper remains domain-specific because it trims accepted labels, descriptions,
headers, and preview strings.

### Change

- Replaced the local `asRecord` helper with the shared
  `runtime/src/utils/record.ts` utility.
- Left ask-user-question string normalization local to preserve trimmed
  payload fields.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tools/ask-user-question/tool.test.ts tests/tools/ask-user-question/tui-tool.test.tsx tests/tools/ask-user-question-tui-routing.test.tsx --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Planning Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/planning/plan-files.ts` recovers plan content from untrusted
  nested message records, plan-file attachments, and `ExitPlanMode` tool input
  records.
- `runtime/src/planning/exit-plan-approval.ts` parses allowed prompt entries
  from TUI approval payloads before converting them to session permission
  updates.

### Finding

Both planning paths carried local nullable `asRecord` adapters equivalent to
`utils/record.ts#asRecord`: accept non-array objects and reject arrays, null,
functions, and primitives. The local copies were identical in contract to the
shared untrusted-record helper, while the adjacent planning string parsers keep
domain-specific trimming behavior.

### Change

- Replaced the two local `asRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Left planning-specific non-empty string trimming helpers local.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/planning/plan-files.test.ts tests/planning/exit-plan-approval.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Elicitation Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/elicitation/mcp.ts` normalizes untrusted MCP elicitation
  requests, schema records, and completion notification params before they cross
  session, UI, or hook boundaries.
- `runtime/src/elicitation/respond.ts` normalizes `request_user_input` and MCP
  elicitation responses before forwarding them to session pending-responder
  maps.
- `runtime/src/elicitation/request-user-input.ts` keeps custom object parsing
  because its error messages name request fields and malformed payload classes.

### Finding

The MCP request and elicitation-response paths carried identical local
`asRecord` guards equivalent to `utils/record.ts#asRecord`: accept non-array
objects and reject arrays, null, and primitives. Keeping local copies made it
easier for untrusted elicitation payload handling to drift between request and
response normalization.

### Change

- Replaced the two local `asRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Left the request-user-input parser's field-specific validation logic intact.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/elicitation/mcp.test.ts tests/elicitation/respond.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared TUI Tool Result Record Guards

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tui/tool-result-denial.ts` recursively detects permission-denied
  tool results from raw strings, JSON strings, arrays, and structured records.
- `runtime/src/tui/tool-result-routing.ts` flattens tool result content before
  routing structured results to specialized TUI renderers.
- `runtime/src/tui/tool-rendering.tsx` converts unknown tool input/results into
  display records and fallback summaries.
- `runtime/src/tui/edit-diff-preview.ts` extracts edit/write diff previews from
  unknown tool-use input.

### Finding

These TUI tool-result paths each carried a local strict record guard equivalent
to `utils/record.ts#isRecord`: accept non-array objects and reject arrays, null,
and primitives. Keeping local copies made it easier for tool result parsing,
routing, and edit preview extraction to drift from the shared untrusted-record
contract.

### Change

- Replaced the four local `isRecord` helpers with the shared
  `runtime/src/utils/record.ts` utility.
- Added direct permission-denied parser coverage for nested records, arrays,
  JSON strings, and non-denial values.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/tui/tool-result-denial.test.ts tests/tui/tool-result-routing.test.ts tests/tui/tool-result-routing.editSuccessSuppress.test.ts tests/tui/tool-rendering.test.tsx tests/tui/tool-rendering.coverage.test.tsx tests/tools/tool-rendering-edit.test.tsx tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.test.tsx tests/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.wave200-049.coverage.test.tsx --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Config Command Path Context

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/config.ts` resolves the active AgenC home for `/config
  edit` and `/config path`.
- `runtime/src/commands/config-menu.tsx` resolves the active `config.toml`
  path shown in the interactive config menu snapshot.
- `runtime/src/commands/config-context.ts` already owns command-context config
  store lookup for model/provider/menu command surfaces.

### Finding

The text command and menu command carried duplicate `ctx.agencHome ??
join(ctx.home, ".agenc")` helpers. That fallback is part of the command-context
contract and should be shared with the existing config-context bridge so future
config command surfaces do not drift between explicit `AGENC_HOME` and default
`$HOME/.agenc` resolution.

### Change

- Moved command-context AgenC home and `config.toml` path construction into
  `runtime/src/commands/config-context.ts`.
- Kept `getConfigFilePath` re-exported from `runtime/src/commands/config.ts`
  for existing callers and tests.
- Routed `/config edit`, `/config path`, and the config menu snapshot through
  the shared helpers.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/commands/config-context.test.ts tests/commands/config.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared TUI Planning Display String Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/planning/plan-files.ts` recovers plan metadata fields from
  persisted JSON plan records.
- `runtime/src/tui/approval-input-text.ts` formats approval prompt text from
  tool command/input payloads.
- `runtime/src/tui/message-renderers/toolRowPreview.tsx` builds one-line tool
  argument previews for file paths, commands, URLs, prompts, and descriptions.
- `runtime/src/tui/workbench/agents/AgentsRail.tsx` formats agent rail labels,
  branch names, goals, and status text from loose task metadata.

### Finding

These UI/planning paths used local copies of the return-original non-blank
string predicate already covered by `nonEmptyString`. A few of the helpers
expose `null` at their local boundary, but the acceptance rule is still the
shared one: reject non-strings and whitespace-only strings while preserving the
accepted text exactly.

### Change

- Reused `nonEmptyString` in plan-record field recovery and approval input
  text extraction, adapting `undefined` back to existing `null` return values.
- Reused `nonEmptyString` for tool-row preview file, path, command, and known
  scalar fields while leaving whitespace-sensitive generic/pattern behavior
  unchanged.
- Replaced the agent rail's local `nonBlankString` helper with a local import
  alias of `nonEmptyString`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/stringUtils.test.ts tests/planning/plan-files.test.ts tests/tui/workbench/approval-input-text.test.ts tests/tui/message-renderers/toolRowPreview.render.test.tsx tests/tui/workbench/agents-rail.test.tsx tests/tui/workbench/agents.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Provider Guard String Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/transaction-guard/tool-intent.ts` extracts command, cwd, and
  script-like arguments from tool invocations before Solana transaction intent
  classification and docket construction.
- `runtime/src/utils/providerDiscovery.ts` normalizes OpenAI-compatible and
  Ollama model descriptors returned from local provider discovery endpoints.
- `runtime/src/llm/providers/bedrock/index.ts` filters serialized message text
  before constructing Bedrock Converse user/assistant blocks.

### Finding

These paths used the same return-original non-blank string predicate as the
shared `nonEmptyString` helper. Nearby provider and agent helpers often trim
accepted strings before returning them, but these call sites preserve the
accepted string and only use `trim()` as the blankness check. Local copies made
that distinction easy to miss during future provider or guard changes.

### Change

- Reused `nonEmptyString` for transaction-guard command/cwd extraction.
- Reused `nonEmptyString` for local provider model descriptor parsing.
- Reused `nonEmptyString` as Bedrock's `nonBlankText` helper to keep the
  message serialization contract unchanged.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/stringUtils.test.ts tests/utils/providerDiscovery.test.ts tests/transaction-guard/transaction-guard.test.ts tests/gaphunt3/transaction-guard-ollama-courtguard.test.ts tests/llm/providers/bedrock/provider.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Tool Argument String Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/apply-patch/tool.ts` validates freeform patch input, cwd,
  and injected session ids before parsing and path permission checks.
- `runtime/src/tools/system/file-edit.ts` validates `Edit` / `MultiEdit` paths
  and cwd values before read-before-write and mutation guards.
- `runtime/src/tools/system/exec-command.ts` validates command, workdir, call id,
  and shell arguments before sandbox/runtime execution setup.
- `runtime/src/tools/system/filesystem.ts` resolves injected session ids used by
  filesystem mutation guards.
- `runtime/src/tools/system/monitor.ts` validates background command and
  description inputs.
- `runtime/src/tools/system/worktree.ts` validates worktree names, actions, and
  active session ids.

### Finding

These tool paths had exact local copies of the guard now owned by
`nonEmptyString`: reject non-strings and whitespace-only strings, but return the
accepted original string unchanged. That distinction is important for paths,
commands, shell names, and injected ids; it should not be conflated with nearby
helpers that trim accepted values or intentionally accept whitespace-only
strings.

### Change

- Reused `runtime/src/utils/stringUtils.ts` `nonEmptyString` in six tool-path
  parsers.
- Kept local aliases (`asNonEmptyString` / `asString`) where they describe the
  argument parser role at the call site.
- Left the trim-returning tool helpers in Grep, Glob, planning, task helpers,
  and ask-user-question untouched because they intentionally normalize accepted
  values.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/stringUtils.test.ts tests/tools/apply-patch/tool.test.ts tests/tools/system/file-edit.test.ts tests/tools/system/exec-command.test.ts tests/tools/system/filesystem.test.ts tests/tools/system/monitor.test.ts tests/tools/system/worktree.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Non-Empty String Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/hooks/configured-hooks.ts` builds hook execution metadata from
  untyped runtime/session context.
- `runtime/src/hooks/user-prompt-submit.ts` reads prompt-submit session, turn,
  transcript, model, and abort-signal context.
- `runtime/src/permissions/guardian/arbiter.ts` builds permission-decision hook
  inputs from current tool invocation state.
- `runtime/src/mcp-client/tools.ts`,
  `runtime/src/mcp-client/resources.ts`, and
  `runtime/src/mcp-client/prompts.ts` normalize untrusted MCP descriptors.
- `runtime/src/tui/session-transcript.ts` formats daemon/task/collaboration
  transcript payloads for display.
- `runtime/src/tools/system/notebook-edit.ts` validates notebook-edit tool
  arguments before path permission checks and cell mutation.

### Finding

These paths each carried the same guard for accepting only strings with
non-whitespace content while returning the original, untrimmed string. That
contract matters for path, label, transcript, and descriptor values where
validation should reject blank strings but must not silently alter accepted
content. Keeping local copies made it easy for one call site to start trimming
or accepting blank strings independently.

### Change

- Added `nonEmptyString` to `runtime/src/utils/stringUtils.ts` and direct unit
  coverage that asserts accepted strings are returned unchanged.
- Replaced eight exact local helper copies with the shared utility, using local
  import aliases where the surrounding code already used `stringValue`.
- Left similar-but-different helpers untouched, including helpers that return
  `null`, trim accepted values, or intentionally accept any non-empty string
  without a whitespace-only check.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/stringUtils.test.ts tests/hooks/configured-hooks.test.ts tests/hooks/hooks-core.test.ts tests/hooks/engine/dispatcher.test.ts tests/permissions/guardian/arbiter.test.ts tests/mcp-client/tools.test.ts tests/mcp-client/resources.test.ts tests/mcp-client/prompts.test.ts tests/tools/system/notebook-edit.test.ts --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tui/session-transcript.coverage2.test.ts tests/tui/session-transcript.wave200-003.coverage.test.ts tests/tui/session-transcript.envelope-clamp-ihunt.test.ts tests/tui/parity/session-transcript.test.ts tests/tui/parity/session-transcript.contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Strict Record Guard

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/mcp-server/framework.ts` parses transport-neutral JSON-RPC
  request, response, notification, initialize, and tool-call envelopes.
- `runtime/src/permissions/rpc/mcp-tool-approval-templates.ts` normalizes MCP
  tool approval template files and renders JSON-object tool parameter display.
- `runtime/src/permissions/rpc/request-permissions.ts` normalizes structured
  request-permissions args, grants, and responses.
- `runtime/src/transaction-guard/ollama-courtguard.ts` normalizes Ollama guard
  model responses before verdict parsing.
- `runtime/src/utils/record.ts` now owns the shared strict non-array object
  check.

### Finding

The MCP server framework, permissions RPC normalizers, and transaction guard
each carried the same `Record<string, unknown> | null` guard. These parsers are
all untrusted JSON/object boundaries and all intentionally reject arrays.
Keeping local copies invited small drift in null handling, array handling, or
domain-specific guards that only need to layer a narrower type predicate over
the same primitive check.

### Change

- Added `asRecord` and `isRecord` in `runtime/src/utils/record.ts` with direct
  unit coverage.
- Replaced four local `asRecord` helpers with the shared utility.
- Kept the MCP approval-template JSON-object predicate local, but made it
  delegate to the shared `isRecord` primitive check.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/record.test.ts tests/mcp-server/framework.test.ts tests/permissions/rpc/mcp-tool-approval-templates.test.ts tests/permissions/rpc/request-permissions.test.ts tests/gaphunt3/transaction-guard-ollama-courtguard.test.ts tests/transaction-guard/transaction-guard.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared LSP Error Message Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/services/lsp/LSPClient.ts` reports process, JSON-RPC, and
  notification errors through LSP diagnostics and crash callbacks.
- `runtime/src/services/lsp/LSPServerInstance.ts` wraps startup, restart,
  request, and notification failures.
- `runtime/src/services/lsp/LSPServerManager.ts` aggregates shutdown failures
  across running, starting, and error-state LSP servers.
- `runtime/src/services/lsp/manager.ts` records singleton initialization
  failures and best-effort reinitialize cleanup warnings.
- `runtime/src/services/lsp/config.ts` and
  `runtime/src/services/lsp/passiveFeedback.ts` surface config parse and
  diagnostic-handler failures.

### Finding

The LSP subsystem carried three private `errorMessage` helpers, one private
`toError` helper, and several inline `error instanceof Error ? error.message :
String(error)` conversions. These all matched the existing shared
`utils/errors.ts` behavior, but the local copies made LSP failure formatting
easy to drift from the rest of the runtime.

### Change

- Reused `errorMessage` and `toError` from `runtime/src/utils/errors.ts`.
- Removed LSP-local helper copies from the client, server instance, server
  manager, and singleton manager.
- Routed LSP config and passive diagnostic-handler error strings through the
  same shared helper.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/services/lsp/LSPClient.test.ts tests/services/lsp/LSPServerInstance.test.ts tests/services/lsp/LSPServerManager.test.ts tests/services/lsp/manager.test.ts tests/services/lsp/config.test.ts tests/services/lsp/passiveFeedback.test.ts tests/services/lsp/LSPDiagnosticRegistry.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Slash Command Config Context

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/model.ts` resolves configured provider/model defaults
  while handling `/model` arguments.
- `runtime/src/commands/model-menu.tsx` builds the interactive model picker
  snapshot from the same command context.
- `runtime/src/commands/provider-menu.tsx` builds the interactive provider
  picker snapshot from the same command context.
- `runtime/src/commands/config-context.ts` now owns the dispatch-context-first,
  session-services fallback used by these slash-command surfaces.

### Finding

The model command, model picker, and provider picker each carried the same
`ctx.configStore.current()` plus `session.services.configStore.current()`
fallback helper. That fallback is specific to slash-command dispatch across
runtime and daemon/TUI contexts; keeping three copies made it easy for one
surface to lose the daemon fallback or change the precedence order.

### Change

- Added `readCommandConfig` in `runtime/src/commands/config-context.ts`.
- Routed `/model`, the model picker, and the provider picker through the shared
  command helper.
- Added direct unit coverage for direct store lookup, session-services
  fallback, direct-store precedence, and missing-store handling.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/commands/config-context.test.ts tests/commands/model.test.ts tests/commands/provider.test.ts tests/config/model-catalog-drift.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Plain Text Tool Error Result

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/apply-patch/tool.ts` and the system `Edit`, `Read`,
  `Write`, `Grep`, planning, and worktree tools return plain-text tool errors
  through the same `ToolResult` envelope.
- `runtime/src/tools/results.ts` now owns the shared plain-text error result
  helper.
- `runtime/tests/tools/results.test.ts` pins the helper's envelope shape.

### Finding

Seven tools carried identical local helpers returning
`{ content: message, isError: true }`. That shape is part of the model-facing
tool contract for these legacy/plain-text tools, while nearby code-intelligence
and unified-exec tools intentionally use JSON error envelopes. The repeated
plain-text helpers made it easy to accidentally drift the common envelope or
confuse it with the JSON variant.

### Change

- Added `plainTextErrorToolResult` in `runtime/src/tools/results.ts`.
- Replaced the seven exact local helper bodies with an import alias preserving
  existing `errorResult(...)` call sites.
- Left JSON-encoded and metadata-capable error helpers untouched.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/results.test.ts tests/tools/apply-patch/tool.test.ts tests/tools/system/file-edit.test.ts tests/tools/system/file-read.test.ts tests/tools/system/file-write.test.ts tests/tools/system/grep.test.ts tests/tools/system/worktree.test.ts tests/tools/runtimes/runtime.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Runtime Path Target Resolution

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/runtimes/apply-patch.ts` resolves parsed patch file paths
  into write targets for runtime sandbox analysis.
- `runtime/src/tools/runtimes/shell.ts` resolves shell read operands into
  absolute read targets for sandbox preflight.
- `runtime/src/tools/runtimes/sandboxing.ts` resolves generic tool path
  arguments and caller-provided working directories before sandbox checks.
- `runtime/src/tools/runtimes/unified-exec.ts` resolves `cwd`/`workdir` for
  unified exec-like runtime commands.
- `runtime/src/tools/runtimes/paths.ts` now owns the shared absolute-normalize
  and relative-from-cwd resolution helper.

### Finding

Four runtime analyzer modules carried identical `resolveTarget` helpers. These
modules feed sandbox read/write decisions; if one copy changed absolute
normalization or relative path resolution independently, shell, apply-patch,
generic tool, and unified exec preflights could disagree on the same path.

### Change

- Added `resolveRuntimePathTarget` in `tools/runtimes/paths.ts`.
- Routed apply-patch, shell, sandboxing, and unified-exec runtime analyzers
  through the shared helper.
- Added direct runtime test coverage for absolute normalization and relative
  resolution from `cwd`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/runtimes/runtime.test.ts tests/tools/apply-patch/runtime.test.ts tests/tools/system/exec-command.test.ts tests/tools/system/bash.test.ts tests/tools/system/command-line.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Provider Fallback Retry Budget

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/providers/anthropic/adapter.ts`,
  `runtime/src/llm/providers/grok/adapter.ts`, and
  `runtime/src/llm/providers/openai/adapter.ts` wait between configured
  provider-fallback attempts and compare the consecutive failure count to the
  configured retry budget.
- `runtime/src/llm/api/fallback-ladder.ts` owns provider-fallback target,
  status, and failure-threshold normalization.
- `runtime/tests/llm/api/fallback-ladder.test.ts` now pins retry-budget
  defaults, non-finite handling, flooring, and negative clamping.

### Finding

The Anthropic, Grok, and OpenAI adapters each carried an identical
`normalizeFallbackRetryBudget` helper. That helper is part of the same
configured provider-fallback policy as `evaluateProviderFallback`; keeping
copies in each adapter made future fallback retry semantics easy to drift across
providers.

### Change

- Exported `normalizeFallbackRetryBudget` from the fallback-ladder module.
- Removed the three adapter-local copies and routed all adapters through the
  shared helper.
- Added direct fallback-ladder tests for the helper's boundary behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/llm/api/fallback-ladder.test.ts tests/llm/providers/grok/adapter.test.ts tests/llm/client-session.test.ts tests/llm/client.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Tool Result Text Extraction

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.tsx`
  checks tool-result text for cancel/reject markers before dispatching to the
  success or error renderers.
- `runtime/src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.tsx`
  checks tool-result text for interrupt, plan rejection, explicit rejection,
  and classifier-denial markers.
- `runtime/src/tui/message-renderers/UserToolResultMessage/utils.tsx` now owns
  the shared string and structured text-block extraction helper.
- `runtime/tests/tui/coverage-swarm/swarm-174-message-renderers-UserToolResultMessage-utils.test.tsx`
  pins string, mixed text-block, image-only, and non-array structured content
  handling.

### Finding

The normal and error tool-result renderers had identical local
`getTextToolResultContent` helpers. That parser decides whether hidden control
markers such as cancellation, rejection, and interruption are visible to the
renderer. Keeping two copies made it easy for one path to start recognizing a
different subset of structured result content than the other.

### Change

- Moved `getTextToolResultContent` into the local
  `UserToolResultMessage/utils.tsx` module.
- Routed both renderers through the shared helper.
- Added direct helper coverage for mixed structured content and ignored
  non-text blocks.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tui/coverage-swarm/swarm-174-message-renderers-UserToolResultMessage-utils.test.tsx tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.wave200-035.coverage.test.tsx tests/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.wave200-049.coverage.test.tsx tests/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.test.tsx --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `git diff --check`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Project Trust Record Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/permissions/trust/project-trust.ts` parses
  `trusted-projects.json` and coordinates async/sync lock acquisition.
- `runtime/src/permissions/trust/trust-sources.ts` summarizes risky project
  and local settings before a workspace trust prompt.
- `runtime/src/permissions/trust/records.ts` now owns the trust-subsystem
  non-array object guard.
- `runtime/tests/permissions/trust/records.test.ts` pins null-prototype,
  object-instance, array, null, and primitive handling.

### Finding

Project trust parsing and trust-source summarization duplicated the same strict
non-array record guard. The project-trust lock code also repeated the same
`EEXIST` error-shape test in its async and sync lock loops. These are small but
security-adjacent parsing paths; keeping their shape checks local to each caller
made future drift likely.

### Change

- Added trust-local `isTrustRecord`.
- Replaced the duplicated record guards in trust file parsing and trust-source
  summarization.
- Extracted the repeated `EEXIST` lock-error guard inside `project-trust.ts`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/permissions/trust/records.test.ts tests/permissions/trust/project-trust.test.ts tests/permissions/trust/trust-sources.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`

## 2026-06-22: Shared Task Payload Field Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/commands/tasks.ts` reads loose TUI app-state task records for the
  `/tasks` slash-command summary.
- `runtime/src/tui/state/collabAgentTaskSync.ts` reads loose collab/daemon
  event payload records and syncs them into background local-agent task state.
- `runtime/src/tasks/record-fields.ts` now owns the shared loose record guard,
  trimmed string-field reader, and finite number-field reader.
- `runtime/tests/tasks/record-fields.test.ts` pins trimming, finite-number
  handling, and the existing loose record semantics.

### Finding

The `/tasks` command and collab-agent task sync carried identical local
`isRecord` and trimmed `stringField` helpers. The `/tasks` command also had the
same style of finite-number field reader for `startTime`. These helpers sit on
the same task/event payload boundary; if one copy tightened array handling,
trimming, or empty-string treatment independently, the command output and TUI
task state could drift.

### Change

- Added `runtime/src/tasks/record-fields.ts`.
- Replaced the local helper blocks in `/tasks` and collab-agent sync with the
  shared helper.
- Preserved the existing loose object guard (`typeof value === "object" &&
  value !== null`), including array acceptance.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tasks/record-fields.test.ts tests/commands/tasks.test.ts tests/tui/state/collabAgentTaskSync.test.ts tests/tui/state/collabAgentTaskSync.wave200-116.coverage.test.ts tests/tui/coverage-swarm/swarm-140-state-collabAgentTaskSync.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`

## 2026-06-22: Shared Thread Source Metadata Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/app-server/session-lifecycle.ts` recovers stored threads into
  daemon session summaries and derives the owning agent id from structured
  thread source metadata.
- `runtime/src/app-server/agent-lifecycle.ts` recovers stored agent threads and
  detects `agent`, `agent_thread`, and `thread_spawn` sources.
- `runtime/src/state/pruning.ts` groups session snapshots by agent owner,
  including raw persisted `threads.source_json` when no explicit link exists.
- `runtime/src/thread-store/thread-source.ts` now owns shared thread-source
  record detection, non-empty string-field reads, agent-id extraction, persisted
  JSON parsing, and agent-source detection.

### Finding

Session recovery and snapshot pruning had duplicated parsers for direct and
nested thread-source agent ids. Agent recovery carried a related duplicate
detector for agent thread sources and direct string metadata fields. These paths
need identical handling for non-empty strings, arrays, nested `source` records,
and malformed persisted JSON; local copies made recovery and pruning easy to
drift.

### Change

- Added dependency-light `runtime/src/thread-store/thread-source.ts`.
- Routed session recovery and pruning through the shared agent-id helpers.
- Routed agent recovery through the shared agent-source detector and string
  field reader while preserving its existing direct-id-only fallback to
  `thread.threadId`.
- Added focused helper tests covering record detection, field extraction,
  direct/nested agent ids, malformed JSON, source labels, and nested source-kind
  boundaries.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/session/thread-source.test.ts tests/app-server/session-lifecycle.contract.test.ts tests/app-server/agent-lifecycle.contract.test.ts tests/state/pruning.test.ts --reporter=dot`
- `npm run typecheck`

## 2026-06-22: Shared Config JSON Helpers

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/bin/config-cli.ts` clones config values for `agenc config`
  get/set/unset/validate/edit flows and compares stable TOML snapshots.
- `runtime/src/config/edit.ts` performs the programmatic config edit builder
  clone/validate/write cycle.
- `runtime/src/config/migrate.ts` clones and compares config TOML/JSON during
  file-version migration.
- `runtime/src/config/json.ts` now owns the shared plain-record, clone, and
  stable JSON helpers.
- `runtime/tests/config/json.test.ts` covers plain-record detection, deep
  cloning, and recursive stable ordering.

### Finding

The config CLI, edit builder, and file migration code carried identical copies
of `isPlainRecord`, `cloneJsonValue`, `cloneRecord`, `stableValue`, and
`stableJson`. Those helpers are part of the config write-safety path: they
decide which objects can be merged/cloned and how rewritten TOML is compared to
avoid unnecessary writes. Keeping three copies made prototype handling and
stable ordering easy to drift.

### Change

- Added dependency-free `runtime/src/config/json.ts`.
- Replaced the three local helper blocks with imports from the shared module.
- Added focused tests that pin null-prototype object support, non-plain object
  rejection, deep clone behavior, and recursive stable key ordering.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/config/json.test.ts tests/config/config.test.ts tests/personality/personality-migration.contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared PDF Info Page Count Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/pdf.ts#getPDFPageCount` shells out to `pdfinfo` for
  attachment/media PDF page counts.
- `runtime/src/tools/system/file-read.ts#getPDFPageCount` shells out to
  `pdfinfo` before deciding whether `FileRead` requires an explicit `pages`
  range.
- `runtime/src/utils/pdfInfo.ts#parsePDFInfoPageCount` now owns the shared
  positive page-count parsing for `pdfinfo` stdout.
- `runtime/tests/utils/pdfInfo.test.ts` covers valid output, missing output,
  zero counts, and malformed counts.

### Finding

The two `pdfinfo` wrappers parsed `Pages:` output independently. `FileRead`
required a positive page count, while the general PDF utility accepted `0` as a
valid count. Sharing the full utility module was not appropriate because it
pulls in heavier PDF and tool-result dependencies; only the stdout parser needed
to be shared.

### Change

- Added a dependency-free `parsePDFInfoPageCount` helper.
- Routed both PDF page-count wrappers through the shared parser while preserving
  their existing subprocess wrappers and timeouts.
- Added focused parser coverage for positive, absent, zero, and malformed page
  counts.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/pdfInfo.test.ts tests/tools/system/file-read.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared PDF Page Range Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/pdfPageRange.ts#parsePDFPageRange` owns dependency-free
  PDF page range grammar.
- `runtime/src/utils/pdfUtils.ts` re-exports the parser for existing utility
  callers while keeping model-dependent PDF support checks local.
- `runtime/src/tools/system/file-read.ts#readPdfFile` validates the
  model-facing `pages` argument before calling `pdfinfo` and `pdftotext`.
- `runtime/tests/utils/pdfUtils.test.ts` now pins accepted and rejected page
  range syntax directly.
- `runtime/tests/tools/system/file-read.test.ts` covers the user-facing
  `FileRead` error envelope for malformed page ranges.

### Finding

The exported PDF parser and the `FileRead` tool carried separate page-range
parsers. The utility version used `parseInt` on partial slices, so malformed
values such as `1-2abc` or `1-2-3` could be accepted by the shared utility even
though `FileRead` correctly rejected them with anchored regex validation.

### Change

- Added a dependency-free shared parser that uses the same anchored page,
  closed-range, and open-ended-range grammar as `FileRead`.
- Re-exported the parser from `pdfUtils.ts` without making `FileRead` import
  model-selection dependencies.
- Routed `FileRead` through the shared parser with a small wrapper that
  preserves its existing `undefined`/empty/non-string argument errors.
- Added direct parser tests and extended `FileRead` malformed-page coverage for
  the multi-dash case.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/pdfUtils.test.ts tests/tools/system/file-read.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Process PID Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/genericProcessUtils.ts#getAncestorPidsAsync` parses
  PowerShell comma-separated ancestor PIDs on Windows and newline-separated
  `ps` output on Unix.
- `runtime/src/utils/genericProcessUtils.ts#getChildPids` parses child PID
  output from PowerShell or `pgrep`.
- `runtime/src/utils/genericProcessUtils.ts#parsePidList` now owns the shared
  PID token parsing.
- `runtime/tests/utils/genericProcessUtils.test.ts` covers comma/newline
  separators, whitespace, invalid tokens, and blank output.

### Finding

The process utilities repeated the same trim/split/parse/filter pipeline in
three places. Two call sites split newlines and one split commas, even though
the logical operation is the same: turn process-command output into valid PID
numbers. Keeping those parser details local made Windows and Unix behavior easy
to change inconsistently.

### Change

- Added `parsePidList` with shared comma/newline splitting and invalid-token
  filtering.
- Routed ancestor PID parsing and child PID parsing through the helper.
- Added focused unit coverage for the shared parser behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/genericProcessUtils.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Git Worktree Porcelain Parsing

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/system/git-tools.ts#repoInventoryTool` parses
  `git worktree list --porcelain` output for the repo inventory payload.
- `runtime/src/tools/system/git-tools.ts#gitWorktreeListTool` parses the same
  porcelain format for the dedicated worktree-list tool.
- `runtime/src/tools/system/coding-common.ts` now owns the shared worktree
  porcelain parser next to the existing git status parser.
- `runtime/tests/tools/system/git-tools.test.ts` covers branch, detached, bare,
  empty-output, and tool-level worktree-list parsing.

### Finding

Repo inventory and worktree-list both parsed the same git porcelain blocks with
separate inline `split`/`find` chains. Because the two payloads expose slightly
different public field names (`worktree` versus `path`), keeping the parsing
duplicated made it easy for branch/head/detached/bare handling to drift while
the shape-mapping difference stayed intentional.

### Change

- Added `parseWorktreePorcelain` and a typed `ParsedGitWorktree` result in
  `coding-common.ts`.
- Reused the parser from both worktree consumers, preserving `repoInventory`'s
  historical `worktree` field.
- Added direct parser coverage and a tool-level `system.gitWorktreeList` check.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/system/git-tools.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm run test:bun`
- `npm test`

## 2026-06-22: Shared Teammate Spawn Flags

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/shared/spawnMultiAgent.ts#handleSpawnSplitPane` and
  `#handleSpawnSeparateWindow` build the command used for tmux/iTerm2 teammate
  processes.
- `runtime/src/utils/swarm/backends/PaneBackendExecutor.ts#spawn` builds the
  pane-backend teammate command through the newer executor abstraction.
- `runtime/src/utils/swarm/spawnUtils.ts#buildInheritedCliFlags` owns shared
  propagation for permission mode, model selection, teammate mode, settings,
  plugins, and browser flags.
- `runtime/tests/utils/swarm/spawnUtils.flags.test.ts` covers the shared flag
  builder for auto permissions, teammate mode, and explicit model overrides.

### Finding

The legacy spawn path carried a local copy of the teammate command and inherited
flag builders while the pane backend used `spawnUtils.ts`. The two copies had
already drifted: the local copy propagated `--permission-mode auto`, while the
shared copy propagated `--teammate-mode`. The per-call-site model replacement
also split a shell-quoted flag string, which could corrupt a leader model value
containing spaces before appending the teammate model.

### Change

- Removed the duplicated command and flag builders from `spawnMultiAgent.ts`.
- Extended the shared flag builder to preserve auto permission propagation and
  accept a teammate-specific model before shell formatting.
- Routed both legacy spawn handlers and `PaneBackendExecutor` through the
  shared model-aware flag builder.
- Added direct tests for auto permission propagation, teammate-mode propagation,
  and quoted explicit model replacement.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/swarm/spawnUtils.flags.test.ts tests/auth/remote-token-path.test.ts --reporter=dot`
- `npm run typecheck`

## 2026-06-22: Shared LSP Result Partitioning

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/LSPTool/LSPTool.ts#formatResult` logs malformed
  location/symbol responses, computes result counts, and computes file counts
  for definition, reference, workspace-symbol, and implementation results.
- `runtime/src/tools/LSPTool/formatters.ts#formatGoToDefinitionResult`,
  `#formatFindReferencesResult`, and `#formatWorkspaceSymbolResult` apply the
  formatter-side defensive filtering before rendering user-facing output.
- `runtime/src/tools/LSPTool/locations.ts` now owns the valid/invalid
  partitioning for LSP `Location` and `SymbolInformation` arrays.
- `runtime/tests/tools/LSPTool/locations.test.ts` covers malformed locations,
  malformed symbol locations, and the valid-count/invalid-count split.

### Finding

The LSP tool and formatter repeatedly filtered the same arrays twice: once to
count malformed entries for logging and once to keep valid entries for counts or
rendering. The predicates need to stay identical between formatter output and
tool metadata, otherwise malformed LSP responses can be counted differently than
they are displayed.

### Change

- Added `partitionValidLocations` and `partitionValidSymbolInformation` to the
  local LSP location helper module.
- Replaced repeated valid/invalid filter pairs in both formatter and tool
  result-counting paths.
- Extended helper tests to pin the malformed-entry counts and valid output
  arrays.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/LSPTool/locations.test.ts tests/tools/LSPTool/schemas.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`

## 2026-06-22: Shared LSP Location Conversion

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/LSPTool/LSPTool.ts#call` filters gitignored
  location-based results and `formatResult` computes result/file counts for
  definitions, references, workspace symbols, and implementations.
- `runtime/src/tools/LSPTool/formatters.ts#formatGoToDefinitionResult` formats
  both `Location` and `LocationLink` responses from LSP servers.
- `runtime/src/tools/LSPTool/locations.ts` now owns local LSP
  `LocationLink` detection and conversion to `Location`.
- `runtime/tests/tools/LSPTool/locations.test.ts` covers conversion, unchanged
  `Location` pass-through, and the malformed-link fallback to `targetRange`.

### Finding

The LSP tool and formatter each carried their own `LocationLink` detector and
conversion helper. These helpers define which target range is used when LSP
servers return link-shaped results, so duplicating them invited subtle mismatch
between filtering/counting and displayed locations.

### Change

- Added `runtime/src/tools/LSPTool/locations.ts` with a shared `toLocation`
  helper and private `LocationLink` detection/conversion.
- Reused the helper in both the LSP tool result path and formatter path.
- Added direct helper coverage for range selection and defensive fallback.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/LSPTool/locations.test.ts tests/tools/LSPTool/schemas.test.ts --reporter=dot`
- `npm run typecheck`

## 2026-06-22: Shared Streaming Executor Wait Path

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/streaming-executor.ts#getRemainingResults` drains
  completed terminal tool results in submission order and waits for either
  running tool completion or progress/close wake-ups.
- `runtime/src/tools/streaming-executor.ts#getRemainingUpdates` drains progress
  events and terminal results through the same queue lifecycle.
- `runtime/src/tools/streaming-executor.ts#signalProgress` owns the wake signal
  consumed by both async drainers when tool state changes, progress arrives, or
  discard interrupts the stream.
- `runtime/tests/tools/streaming-executor.test.ts` covers ordered result
  draining, progress-event wake-up through `getRemainingUpdates`, discard
  behavior, and sibling-abort handling.

### Finding

Both async drainers repeated the same executing-promise collection,
progress-promise registration, and `Promise.race` wake-up logic. That logic is
load-bearing for progress events and discard responsiveness, so duplicating it
made future changes easy to apply to one iterator but miss the other.

### Change

- Added a private `waitForExecutingToolOrProgress` helper that owns the shared
  executing-tool/progress wake path.
- Reused the helper from both result-only and progress+result async drainers.
- Tightened the fallback comment to describe the real "executing status without
  attached promise yet" case.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/streaming-executor.test.ts --reporter=dot`
- `npm run typecheck`

## 2026-06-22: Shared Shell Operator Sets

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/system/command-line.ts` owns shell tokenization,
  direct-command parsing, command separators, and redirect operators for the
  daemon system shell surface.
- `runtime/src/tools/system/bash.ts` validates direct-mode arguments,
  strips safe redirections, and classifies read/search command segments using
  the same separator and redirect definitions.
- `runtime/tests/tools/system/command-line.test.ts` and
  `runtime/tests/tools/system/bash.test.ts` cover parser behavior and bash
  safety paths that consume those operator sets.

### Finding

The bash tool imported the shared shell parser but carried private copies of
the parser's command separator and redirect operator sets. Any future shell
syntax adjustment could update parser behavior without updating bash safety
classification, creating avoidable parser/validator drift.

### Change

- Removed the duplicated operator set declarations from `bash.ts`.
- Imported `SHELL_COMMAND_SEPARATORS` and `SHELL_REDIRECT_OPERATORS` from the
  existing `command-line.ts` parser module.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/system/command-line.test.ts tests/tools/system/bash.test.ts --reporter=dot`
- `npm run typecheck`

## 2026-06-22: Shared MCP Resource Server Lookup

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/prompts/attachments/mcp-resources.ts#mcpResourcesProducer`
  resolves `@server:uri` prompt mentions to connected MCP resource servers
  before fetching resource metadata and content.
- `runtime/src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts#call`
  validates an optional target server before listing resources from connected
  MCP servers.
- `runtime/src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts#call`
  validates a named server, resource capability support, and reconnectability
  before issuing `resources/read`.
- `runtime/src/utils/mcpServerLookup.ts` centralizes server name formatting,
  lookup, connected resource capability checks, and read-tool error messages.
- `runtime/tests/utils/mcpServerLookup.test.ts` and
  `runtime/tests/prompts/attachments/integration.test.ts` cover lookup
  behavior plus live prompt resource mention resolution.

### Finding

MCP resource producers and tools repeated server-name lookup, connected-server
checks, resource-capability checks, and available-server error formatting. The
prompt producer intentionally skips unavailable servers while the read tool must
raise user-facing errors, but both paths need the same definition of "a usable
MCP resource server." Duplicating that logic risks prompt/resource-tool parity
drift when MCP connection states or resource capability semantics change.

### Change

- Added `runtime/src/utils/mcpServerLookup.ts` with shared MCP server name
  formatting, generic name lookup, resource-server lookup, and lookup error
  formatting helpers.
- Replaced the prompt resource producer's local connected-client lookup with
  `findMcpResourceServer`, preserving its silent-skip behavior.
- Reused the shared not-found formatting in `ListMcpResourcesTool` and the
  shared resource lookup/error formatting in `ReadMcpResourceTool`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/mcpServerLookup.test.ts tests/prompts/attachments/integration.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared File Mention Media Collector

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/prompts/attachments/file-mentions.ts#fileMentionsProducer`
  expands text file mentions and emits image/PDF mention attachments for the
  per-turn prompt attachment pipeline.
- `runtime/src/prompts/attachments/file-mentions.ts#collectImageMentionAttachment`
  resolves supported image mentions through path validation, realpath allowance,
  stat checks, byte caps, dedupe, and data URL normalization.
- `runtime/src/prompts/attachments/file-mentions.ts#collectPdfMentionAttachment`
  applies the parallel PDF path with PDF byte caps, PDF normalization, and text
  fallback metadata preservation.
- `runtime/tests/prompts/attachments/integration.test.ts`,
  `runtime/tests/prompts/file-mentions.test.ts`, and
  `runtime/tests/prompts/attachments/messages.test.ts` cover live producer
  composition, mention expansion, media limits, and renderer output.

### Finding

Image and PDF file mention collection carried near-identical loops for mention
scanning, path validation, duplicate suppression, symlink-safe allowance,
`stat` filtering, per-file byte limits, and total byte limits. The only
meaningful differences were supported-extension checks, caps, and item
construction. That duplication made media attachment hardening easy to apply to
one path but miss in the other, especially around symlink and size handling.

### Change

- Added a shared `collectMentionMediaItems` helper that owns the common media
  mention filtering, dedupe, realpath allowance, stat, count, and total-byte
  logic.
- Kept image and PDF normalization as type-specific builders so provider data
  URL generation, PDF base64 data, and PDF fallback text metadata remain local
  to the relevant attachment type.
- Scanned `mentionInput` once in `fileMentionsProducer` and reused the detected
  mentions for both media collectors.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/prompts/attachments/integration.test.ts tests/prompts/file-mentions.test.ts tests/prompts/attachments/messages.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared Agent Mention Parser

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#processAgentMentions` resolves legacy
  `@agent-<type>` and autocomplete `@"<type> (agent)"` user input into
  `agent_mention` attachments.
- `runtime/src/utils/attachments.ts#getRelevantMemoryAttachments` uses the
  same mention parser to restrict memory lookup to mentioned agents.
- `runtime/src/prompts/attachments/agent-mentions.ts#agentMentionsProducer`
  resolves the newer prompt attachment producer's agent mentions from the
  latest user input.
- `runtime/tests/prompts/attachments/agent-mentions.test.ts`,
  `runtime/tests/prompts/attachments/extractors.test.ts`, and
  `runtime/tests/memory/project-memory-routing.test.ts` cover prompt parsing,
  extractor compatibility, and mention-scoped memory lookup.

### Finding

The legacy attachment pipeline and prompt attachment producer each carried a
local regex/dedupe parser for agent mentions. The implementations looked nearly
identical, but their exported contracts intentionally differed: legacy
`utils/attachments.ts` callers expect autocomplete mentions as bare types and
manual `@agent-...` mentions with the `agent-` prefix preserved, while the
prompt producer expects bare agent types for both forms. Keeping separate
regexes made future drift likely and would be easy to miss because both paths
accept plugin-scoped names containing colons, dots, at-signs, and hyphens.

### Change

- Added `runtime/src/utils/agentMentions.ts` with a shared token parser and
  two explicit adapters: `extractLegacyAgentMentions` and
  `extractAgentMentionTypes`.
- Re-exported `extractLegacyAgentMentions` from `utils/attachments.ts` under
  the existing `extractAgentMentions` name so legacy tests and callers keep
  their import path and return shape.
- Switched the prompt agent mention producer to `extractAgentMentionTypes` while
  preserving its existing bare-type export as `extractAgentMentions`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/prompts/attachments/agent-mentions.test.ts tests/prompts/attachments/extractors.test.ts tests/memory/project-memory-routing.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared MCP Resource Mention Parser

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/attachments.ts#processMcpResourceAttachments` resolves
  legacy `@server:uri` MCP resource mentions from user input.
- `runtime/src/prompts/attachments/mcp-resources.ts#mcpResourcesProducer`
  resolves the newer prompt attachment producer's MCP resource mentions.
- Both paths filter memory mentions and Windows drive-letter/file-mention
  collisions before reading remote MCP resource content.
- `runtime/tests/utils/attachments.extractors.test.ts`,
  `runtime/tests/memory/project-memory-routing.test.ts`,
  `runtime/tests/prompts/attachments/extractors.test.ts`, and
  `runtime/tests/prompts/attachments/integration.test.ts` cover parser edge
  cases and live MCP resource attachment rendering.

### Finding

The legacy attachment pipeline and the newer prompt attachment producer each
carried a local MCP resource mention parser with the same regex, dedupe, memory
mention filtering, and Windows drive-letter guard. That duplicated a security
and compatibility-sensitive parser: a future fix in one path could drift from
the other and reintroduce false MCP resource matches for file mentions or
memory references.

### Change

- Added `runtime/src/utils/mcpResourceMentions.ts` with shared
  `extractMcpResourceMentions` and `parseMcpResourceMention` helpers.
- Re-exported `extractMcpResourceMentions` from `utils/attachments.ts` so
  existing callers and tests keep their import path.
- Switched the prompt MCP resource producer to the shared parser while keeping
  its fetch/ensure-connected behavior unchanged.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/utils/attachments.extractors.test.ts tests/memory/project-memory-routing.test.ts tests/prompts/attachments/extractors.test.ts tests/prompts/attachments/integration.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Table-Driven Provider Capability Overrides

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/llm/capabilities.ts#resolveProviderModelCapabilities` builds
  provider/model capability metadata from provider defaults, model catalog
  hints, and optional config overrides.
- `runtime/src/llm/capabilities.ts#applyCapabilityOverrides` applies
  `ProviderCapabilityOverrides` onto resolved provider capabilities.
- `runtime/src/llm/registry/model-registry.ts` consumes the resolved
  capabilities when building registry entries for the TUI/model commands.
- `runtime/tests/llm/capabilities.test.ts` and
  `runtime/tests/llm/model-registry.test.ts` cover direct capability
  resolution plus registry-level configured override behavior.

### Finding

`applyCapabilityOverrides` repeated one conditional spread per override key.
The provider capability matrix itself is data and should stay explicit, but
the override copy path was mechanical and easy to drift when adding new
boolean capability fields. The only special behavior is that
`supportsImageInput` must also update the derived `supportsVisionInput` field.

### Change

- Added `DIRECT_PROVIDER_CAPABILITY_OVERRIDE_KEYS` for normal boolean override
  fields.
- Replaced repeated override spreads with a typed loop over that key list.
- Kept `supportsImageInput` handling explicit so `supportsVisionInput` remains
  coupled to image-input overrides.
- Expanded the capability override test to cover every override key and the
  image/vision parity rule.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/llm/capabilities.test.ts tests/llm/model-registry.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared Agent CLI Operation Wrapper

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/app-server/agent-cli.ts#runAgenCAgentCli` dispatches
  `agenc agent start/list/attach/stop/logs` to command-specific handlers.
- `runtime/src/app-server/agent-cli.ts#startAgenCAgent`,
  `#listAgenCAgents`, `#attachAgenCAgent`, `#stopAgenCAgent`, and
  `#logsAgenCAgent` all need the same daemon-readiness and CLI error envelope.
- `runtime/src/app-server/agent-cli.ts#defaultEnsureDaemonReady` owns the
  default daemon autostart readiness path when tests or callers do not inject
  `ensureDaemonReady`.
- `runtime/tests/app-server/agent-cli.contract.test.ts` covers argument
  parsing, injected readiness/client paths, daemon socket behavior, TUI attach,
  and command error output.

### Finding

The five agent CLI command handlers each repeated the same readiness call,
default daemon client construction, `try`/`catch`, and `agenc: ...` stderr
formatting. That made a user-facing command path harder to extend consistently:
future commands could easily drift on autostart timing, injected-client usage,
or non-`Error` exception formatting.

### Change

- Added `runAgenCAgentCliOperation` for the shared readiness and error envelope.
- Added `resolveAgenCAgentCliDaemonClient` so command handlers reuse the same
  injected-client/default-client fallback.
- Kept `attach` lazy with respect to daemon client construction when an
  `attachTui` launcher is supplied.
- Reduced the command handlers to command-specific request and output logic.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/app-server/agent-cli.contract.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared Bash Pending Classifier Spread

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/BashTool/bashPermissions.ts#bashToolHasPermission` has
  multiple ask/passthrough return branches that attach
  `pendingClassifierCheck` when `BASH_CLASSIFIER` is enabled.
- `runtime/src/tools/BashTool/bashPermissions.ts#buildPendingClassifierCheck`
  gates pending classifier metadata by classifier availability, permission
  mode, and prompt-allow descriptions.
- `runtime/src/types/permissions.ts#PendingClassifierCheck` defines the
  metadata shape consumed by asynchronous permission approval paths.
- `runtime/tests/tools/BashTool/bashPermissions.test.ts` and
  `runtime/tests/permissions/bash.test.ts` cover Bash permission behavior in
  the runtime and compatibility permission surfaces.

### Finding

Eight `bashToolHasPermission` branches duplicated the same
`feature('BASH_CLASSIFIER')` spread and `buildPendingClassifierCheck(...)`
payload. This file is already close to Bun's feature DCE complexity cliff, so
the repeated branch-local shape made future edits easier to drift and harder to
review.

### Change

- Added `pendingBashClassifierCheckSpread` to centralize the feature-gated
  spread object.
- Preserved the previous object shape exactly: feature off returns `{}`, while
  feature on returns `{ pendingClassifierCheck: maybeUndefined }`.
- Replaced all eight repeated pending-classifier spreads in
  `bashToolHasPermission`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/permissions/bash.test.ts --reporter=dot`
- `npm --workspace=@tetsuo-ai/runtime exec -- bun test tests/tools/BashTool/bashPermissions.test.ts`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Isolated PowerShell Parse-Failed Deny Scan

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/PowerShellTool/powershellPermissions.ts#powershellToolHasPermission`
  checks exact/prefix deny and ask rules before parse validity, then handles
  parse-failed commands with a degraded fallback before the generic parse-error
  prompt.
- The parse-failed fallback normalizes PowerShell backtick continuations,
  assignment prefixes, invocation operators, quoted command names, and raw
  `Remove-Item` positional paths before checking deny rules.
- `runtime/src/tools/PowerShellTool/pathValidation.ts#dangerousRemovalDeny`
  is the shared hard-deny result for protected root/home/system removal paths.
- `runtime/tests/tools/PowerShellTool.permissions.test.ts` mocks the parser to
  return `valid: false` so the degraded permission path is deterministic.

### Finding

The large PowerShell permission function embedded the full parse-failed
fallback scan inline. That made the degraded security path harder to review
because fragment normalization, dangerous-removal hard-deny, and sub-command
deny-rule matching were interleaved with generic parse-error prompt assembly.
The focused extraction test also exposed a defect: simple parse-failed commands
like `Remove-Item / -Recurse` skipped the raw dangerous-removal check because
the full-command fragment was treated as already covered by pre-parse rule
matching.

### Change

- Extracted `getParseFailedPowerShellDenyDecision` as a private helper.
- Kept the existing permission precedence: parse-failed deny/dangerous-removal
  decisions still beat deferred pre-parse asks and the generic malformed-syntax
  prompt.
- Moved the protected-path removal check ahead of the full-command duplicate
  rule-match skip so parser-unavailable `Remove-Item /` stays a hard deny.
- Added focused coverage for assignment-normalized deny rules and
  parser-unavailable `Remove-Item /` hard-deny behavior.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/PowerShellTool.permissions.test.ts tests/tools/PowerShellTool.pathValidation.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared Plugin Component Missing-Path Reporting

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/utils/plugins/pluginLoader.ts#validatePluginPaths` validates
  manifest agents, skills, output styles, and apps paths with parallel
  existence checks.
- `runtime/src/utils/plugins/pluginLoader.ts#createPluginFromPath` validates
  manifest command source paths and additional hooks files.
- `runtime/src/utils/plugins/pluginLoader.ts#finishLoadingPluginFromPath`
  validates cached marketplace command and skill paths while merging
  marketplace metadata with plugin manifests.
- `runtime/tests/plugins/loader.test.ts` and
  `runtime/tests/plugins/pluginLoader-core.test.ts` cover manifest and
  cache-only loader paths, including missing marketplace components.

### Finding

Nine plugin loader branches duplicated the same `logError(new Error(...))` and
`PluginError` construction for missing component files. The debug messages are
context-specific and useful, but the error payload itself should not drift
between manifest, hooks, and marketplace cache-only paths.

### Change

- Added `recordPluginComponentPathNotFound` to centralize missing-component
  error logging and `path-not-found` issue construction.
- Kept each branch's local debug message and log level unchanged.
- Replaced duplicated missing-file payload blocks in manifest, hooks, and
  marketplace component validation.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/plugins/loader.test.ts tests/plugins/pluginLoader-core.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared Subagent Error Finalization

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/agents/run-agent.ts#runAgent` drives subagent lifecycle
  startup, provider streaming, terminal turn handling, role-timeout handling,
  abort/interruption classification, and cleanup.
- The provider-missing, child turn error/max-turns, role-timeout, and thrown
  exception branches all mark the live status errored, notify the parent, emit
  a `run_error` progress event, and return an errored `RunAgentResult`.
- `runtime/tests/agents/run-agent.test.ts` covers provider rejection,
  role-timeout classification, max-turns-as-error handling, and interrupted
  abort behavior.

### Finding

The subagent runner repeated the same terminal error side effects across
several branches. That made this lifecycle path harder to audit because a
future change to errored status, parent notification, mailbox relay metadata,
or result assembly would need to be copied into every branch without changing
the order observed by generator consumers.

### Change

- Added a local `finishErroredRun` helper inside `runAgent` to centralize
  `markErrored`, parent notification, optional `subagent_error` relay, and
  errored-result construction.
- Preserved the existing event ordering by finalizing the live status before
  yielding `run_error`.
- Kept the provider-missing branch's existing no-relay behavior explicit with
  `relayToParent: false`.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/agents/run-agent.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

## 2026-06-22: Shared PowerShell Path Allowance

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/1276>

### Code Paths Traced

- `runtime/src/tools/PowerShellTool/pathValidation.ts#validatePath` extracts
  PowerShell file targets, resolves symlinks with `safeResolvePath`, and checks
  the final path allowance for reads, writes, creates, globs, and redirections.
- `runtime/src/tools/PowerShellTool/pathValidation.ts#checkPathConstraints`
  reduces parsed PowerShell statements, explicit path arguments, nested command
  paths, and redirection targets into permission decisions.
- `runtime/src/utils/permissions/pathValidation.ts#isPathAllowed` is the shared
  donor-stack path allowance helper used by Bash and now PowerShell.
- `runtime/tests/tools/PowerShellTool.pathValidation.test.ts` covers
  PowerShell path constraint allow and deny-rule behavior without requiring a
  local PowerShell binary.
- `runtime/tests/permissions/donor-stack-import-boundary.test.ts` confirms the
  donor permission-stack importer set did not grow.

### Finding

PowerShell path validation carried a private `isPathAllowed` clone that
mirrored the shared donor-stack helper, including deny rules, internal editable
paths, write-safety checks, working-directory gating, internal readable paths,
sandbox write allowlists, and allow rules. This was another security-sensitive
copy where future changes to Bash/shared path allowance could silently miss the
PowerShell tool.

### Change

- Removed the private PowerShell `isPathAllowed` implementation and imported
  the shared helper from `runtime/src/utils/permissions/pathValidation.ts`.
- Dropped now-unused local imports from `filesystem.ts`.
- Added focused PowerShell path-validation tests that pin acceptEdits allowance
  inside an extra working directory and deny-rule precedence over working-dir
  allowance.

### Validation

- `npm --workspace=@tetsuo-ai/runtime exec -- vitest run tests/tools/PowerShellTool.pathValidation.test.ts tests/permissions/donor-stack-import-boundary.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run check:unused`
- `npm run build --workspace=@tetsuo-ai/runtime`
- `npm test`
- `npm run test:bun`
- `git diff --check`

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
