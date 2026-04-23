/**
 * Per-dir CLI startup-config gate for `runtime/src/bin/**`.
 *
 * The openclaude `utils/config.ts::enableConfigs` runs the legacy
 * Claude-Code-era global config preload + lock-out. The lean-rebuild
 * runtime owns its own config layer in `runtime/src/config/**`, so the
 * gate is reduced to a no-op stub.
 *
 * Carved as a local `_deps/` to cut the gut→openclaude crossing.
 */

let configsEnabled = false;

/**
 * No-op gate retained for shape parity with the openclaude runtime.
 * Idempotent. Callers (`agenc.ts::initializeCliRuntime`) invoke this
 * exactly once during CLI bootstrap.
 */
export function enableConfigs(): void {
  if (configsEnabled) return;
  configsEnabled = true;
}
