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

/**
 * Minimal `ContentReplacementState` shape — the upstream port carries
 * `seenIds` + `replacements` per conversation. The lean runtime does
 * not enforce the per-message budget, but tests still provision a
 * truthy value to flip the prepare-context "feature on" branch. This
 * stub returns the empty shape so call sites and tests can construct
 * one without dragging in the openclaude port.
 */
export interface ContentReplacementState {
  readonly seenIds: Set<string>;
  readonly replacements: Map<string, string>;
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}
