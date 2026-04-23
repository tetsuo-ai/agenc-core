/**
 * Lean session-storage stub for `phases/prepare-context.ts`.
 *
 * The upstream `utils/sessionStorage.ts::recordContentReplacement`
 * persists tool-result content replacements into the project transcript
 * so resume rebuilds the same prompt-cache shape. The lean rebuild has
 * not yet ported the project transcript writer; this stub matches the
 * call signature with a no-op so prepare-context compiles without the
 * openclaude port. Replace with a real implementation when the
 * transcript writer lands in gut.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ContentReplacementRecord = any;

export async function recordContentReplacement(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _replacements: ReadonlyArray<ContentReplacementRecord>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _agentId?: string,
): Promise<void> {
  // no-op
}
