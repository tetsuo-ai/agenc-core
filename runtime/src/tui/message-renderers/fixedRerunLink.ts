import type { MessageLookups } from '../../utils/messages.js'

/**
 * "Fixed re-run" linkage detection for command-bearing tool rows (Run/Bash).
 *
 * In an error → fix → re-run loop the user runs a command, it FAILS (`✕`), they
 * fix the code, then run the SAME command again in a LATER user turn and it now
 * PASSES (`●`). Those are two separate transcript rows with identical args,
 * distinguished only by the leading glyph + exit note. There is no explicit
 * "this passing re-run is the same command that failed above, now fixed" signal,
 * so confirming the fix worked means manually scroll-matching two identical
 * command strings.
 *
 * This detector links a PASSING command row back to an EARLIER FAILED row with
 * the identical command in the same session/transcript, so the renderer can
 * surface a dim inline note ("now passing · was ✕ above"). It complements — and
 * is distinct from — the `retriedFailureCount` affordance, which only folds
 * AUTOMATIC same-tool retries WITHIN one turn into "×N attempts failed"; it does
 * NOT link a passing run across USER-TURN boundaries to an earlier failed run.
 *
 * History source: the `lookups` object the renderer already receives.
 *   - `lookups.toolUseByToolUseID` is a Map of every tool_use in the session,
 *     keyed by id, in chronological insertion order (built by iterating the
 *     original `messages` array in `buildMessageLookups`). Iterating it yields
 *     the prior tool-use sequence.
 *   - `lookups.resolvedToolUseIDs` / `lookups.erroredToolUseIDs` give each
 *     prior tool-use's resolution/error state.
 *
 * Matching rules (kept minimal + robust):
 *   - Only command-bearing tool-uses participate: the input must carry a string
 *     `command` field. Write/Edit (file_path/content) never match, so there are
 *     no false positives from non-command tools.
 *   - Identity is `(tool name, trimmed command string)`. Two runs link only when
 *     both the tool name and the normalized command are identical.
 *   - "First success after a failure" scoping: we inspect the MOST RECENT prior
 *     RESOLVED occurrence of the same command. If that most recent resolved
 *     occurrence ERRORED, this passing row is the fix → annotate. If it
 *     SUCCEEDED (an intervening pass with no failure since), do NOT annotate, so
 *     only the first pass after a failure is linked, not every later pass.
 */

type CommandToolUse = {
  readonly id: string
  readonly name: string
  readonly command: string
}

/** Normalize a command string for cross-run identity (trim only — preserve
 * internal whitespace so genuinely different commands stay distinct). */
function normalizeCommand(command: string): string {
  return command.trim()
}

/** Extract the command-bearing identity of a tool-use, or null if it carries no
 * string `command` (e.g. Write/Edit/Read), so non-command tools never match. */
function asCommandToolUse(
  param: { id?: unknown; name?: unknown; input?: unknown } | undefined | null,
): CommandToolUse | null {
  if (!param || typeof param !== 'object') return null
  const id = (param as { id?: unknown }).id
  const name = (param as { name?: unknown }).name
  const input = (param as { input?: unknown }).input
  if (typeof id !== 'string' || typeof name !== 'string') return null
  if (!input || typeof input !== 'object') return null
  const command = (input as { command?: unknown }).command
  if (typeof command !== 'string') return null
  const normalized = normalizeCommand(command)
  if (normalized.length === 0) return null
  return { id, name, command: normalized }
}

/**
 * Returns true when `param` is a PASSING command row whose identical command
 * most-recently FAILED earlier in this session — i.e. the first passing re-run
 * after a failure of the same command. Returns false for the failing row
 * itself, when there is no earlier failure, when the most recent prior run of
 * the same command already passed, when commands differ, and for non-command
 * tools (Write/Edit).
 *
 * Caller must have already established that THIS row resolved successfully
 * (resolved && not errored); we still re-check the success precondition here so
 * the helper is safe to call standalone and never annotates a failing row.
 */
export function isFixedRerunSuccess(
  param: { id?: unknown; name?: unknown; input?: unknown },
  lookups: Pick<
    MessageLookups,
    'toolUseByToolUseID' | 'resolvedToolUseIDs' | 'erroredToolUseIDs'
  >,
): boolean {
  const current = asCommandToolUse(param)
  if (current === null) return false

  // The current row must itself be a SUCCESS (resolved + not errored). A failing
  // row is never annotated.
  if (!lookups.resolvedToolUseIDs.has(current.id)) return false
  if (lookups.erroredToolUseIDs.has(current.id)) return false

  const sequence = lookups.toolUseByToolUseID
  if (!sequence) return false

  // Walk the chronological tool-use sequence up to (but excluding) the current
  // row, tracking the resolution state of the MOST RECENT prior occurrence of
  // the same (name, command). Map iteration order is chronological insertion
  // order from buildMessageLookups.
  let mostRecentPriorErrored: boolean | undefined
  for (const prior of sequence.values()) {
    if (prior.id === current.id) break // reached current row; stop scanning forward
    const priorCmd = asCommandToolUse(prior)
    if (priorCmd === null) continue
    if (priorCmd.name !== current.name) continue
    if (priorCmd.command !== current.command) continue
    // Only RESOLVED prior runs count toward "most recent prior state"; an
    // unresolved (still-running/queued) prior run is ignored.
    if (!lookups.resolvedToolUseIDs.has(priorCmd.id)) continue
    mostRecentPriorErrored = lookups.erroredToolUseIDs.has(priorCmd.id)
  }

  // Annotate only when the most recent prior RESOLVED run of this exact command
  // ERRORED — i.e. this is the first success after a failure.
  return mostRecentPriorErrored === true
}
