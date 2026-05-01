/**
 * Per-dir CLI startup-config gate for `runtime/src/bin/**`.
 *
 * The lean-rebuild runtime owns its own config layer in
 * `runtime/src/config/**`. But the upstream-mirrored UI under
 * `runtime/src/agenc/upstream/**` still reads the upstream global
 * config at mount (e.g. `ThemeProvider::defaultInitialTheme` calls
 * `getGlobalConfig()`), and that read is gated by the upstream
 * `configReadingAllowed` flag. If we leave this stub as a true no-op,
 * mounting the Ink tree throws `Error: Config accessed before
 * allowed.` from `agenc/upstream/utils/config.ts:getConfig`. The
 * upstream contract says exactly one call to its `enableConfigs()`
 * during startup; we forward to it here so the upstream mount path
 * works the same way it does in the upstream binary.
 *
 * Carved as a local `_deps/` to cut the gut→AgenC crossing.
 */

import { enableConfigs as enableUpstreamConfigs } from "../../agenc/upstream/utils/config.js";

let configsEnabled = false;

/**
 * Startup config gate. Idempotent. Callers
 * (`agenc.ts::initializeCliRuntime`) invoke this exactly once during
 * CLI bootstrap. Forwards to the upstream-mirrored
 * `agenc/upstream/utils/config::enableConfigs` so the upstream
 * `configReadingAllowed` flag flips before any Ink/ThemeProvider
 * render path runs.
 */
export function enableConfigs(): void {
  if (configsEnabled) return;
  configsEnabled = true;
  enableUpstreamConfigs();
}
