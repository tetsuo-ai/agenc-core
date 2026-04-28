/**
 * teamMemSaved — segment helper for the "memory saved" system row.
 *
 * Adapted from the upstream memory-saved segment helper.
 *
 * AgenC scope notes:
 *   - Upstream gates this module behind a `feature('TEAMMEM')` macro so
 *     dead-code elimination can drop it from external builds. AgenC has
 *     no bundler-feature macro, so the helper is always available and
 *     callers decide whether to invoke it based on the saved-memory
 *     payload.
 *   - The upstream `SystemMemorySavedMessage` type with `teamCount` is
 *     replaced here by the minimal `TeamMemSavedInput` shape so the
 *     helper does not transitively pull in upstream message types we
 *     have not ported.
 *
 * @module
 */

export interface TeamMemSavedInput {
  /** How many of the saved memories went into team-shared storage. */
  readonly teamCount?: number
}

/**
 * Returns the team-memory segment for the memory-saved UI, plus the count
 * so the caller can derive the private (non-team) count without reaching
 * back to the original payload.
 *
 * Plain function (not a React component) so it can be safely tree-shaken
 * by callers that branch on the count first.
 */
export function teamMemSavedPart(
  message: TeamMemSavedInput,
): { readonly segment: string; readonly count: number } | null {
  const count = message.teamCount ?? 0
  if (count === 0) return null
  return {
    segment: `${count} team ${count === 1 ? 'memory' : 'memories'}`,
    count,
  }
}
