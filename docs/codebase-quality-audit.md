# Codebase Quality Audit

This log tracks concrete slices of the ongoing agenc-core quality pass. It is
not a completion claim for the whole repository. Each entry records the code
paths traced, the defect or risk found, and the validation run before commit.

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
