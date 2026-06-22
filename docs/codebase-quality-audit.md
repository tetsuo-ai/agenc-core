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

- Continue auditing large runtime slices, especially public SDK stubs,
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
