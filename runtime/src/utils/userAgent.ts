// @ts-nocheck
/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getAgenCCodeUserAgent(): string {
  return `agenc-code/${MACRO.VERSION}`
}
