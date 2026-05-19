export const REPL_TOOL_NAME = 'REPL'

/**
 * The executable REPL tool has been removed. Keep this function as a stable
 * query point for older transcript/rendering code, but never hide direct tools.
 */
export function isReplModeEnabled(): boolean {
  return false
}
