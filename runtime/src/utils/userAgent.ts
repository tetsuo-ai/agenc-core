// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getAgenCCodeUserAgent(): string {
  // @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
  return `agenc-code/${MACRO.VERSION}`
}
