/** Maximum raw `addDirs` entries accepted at any session ingress. */
export const MAX_ADDITIONAL_WORKING_DIRECTORIES = 32;

/**
 * Enforce the raw-input bound, then collapse exact duplicates in first-seen
 * order. Duplicate entries still count toward the wire/CLI bound so JSON
 * schema and runtime admission have identical semantics. Path aliases are
 * canonicalized and deduplicated later, at the permission boundary.
 */
export function validateAndDedupeAdditionalWorkingDirectoryInputs(
  values: readonly string[],
  context: string,
): readonly string[] {
  if (values.length > MAX_ADDITIONAL_WORKING_DIRECTORIES) {
    throw new RangeError(
      `${context} accepts at most ${MAX_ADDITIONAL_WORKING_DIRECTORIES} paths`,
    );
  }

  const seen = new Set<string>();
  const deduplicated: string[] = [];
  for (const value of values) {
    if (value.length === 0) {
      throw new TypeError(`${context} must not contain an empty path`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    deduplicated.push(value);
  }
  return Object.freeze(deduplicated);
}
