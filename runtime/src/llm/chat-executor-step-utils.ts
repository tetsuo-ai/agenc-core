/**
 * Small utility helpers for chat executor step parsing and request
 * analysis. Extracted from `chat-executor-planner.ts` in Phase 2d of
 * the planner subsystem rip-out so gateway code can depend on the
 * utilities without pulling in the planner file.
 *
 * @module
 */

/**
 * Safely coerce an `unknown` value into `readonly string[]`, filtering
 * out non-string / empty entries. LLM-parsed step fields may violate
 * their declared type at runtime; this helper is used at every
 * spread / iteration site so consumers are independently safe.
 */
export function safeStepStringArray(
  value: unknown,
): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return [];
}
