/**
 * Lean stub for the optional tool-result content-replacement state
 * `turn-state.ts` provisions when a turn starts.
 *
 * The openclaude `provisionContentReplacementState` is gated behind a
 * growthbook flag and, when the flag is off, returns `undefined`. The
 * gut runtime does not own that flag/subsystem so this stub always
 * returns `undefined`, matching the disabled-path behavior. Call sites
 * already treat `undefined` as "feature off".
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function provisionContentReplacementState(..._args: any[]): undefined {
  return undefined;
}
