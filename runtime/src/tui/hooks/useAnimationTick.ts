/**
 * useAnimationTick — frame-synced tick source for TUI animations.
 *
 * Subscribes to the Ink-provided `ClockContext` via `useSyncExternalStore`
 * so consumers re-render once per frame without each component holding a
 * direct timer. The clock is driven by `ClockProvider` (ink/components/
 * ClockContext.tsx) and runs at `FRAME_INTERVAL_MS` while the terminal is
 * focused, slowing automatically when the terminal loses focus.
 *
 * Returned values:
 *   - `tick`: monotonically increasing counter, one step per frame the
 *     consumer receives.
 *   - `deltaMs`: wall-clock milliseconds between the previous tick and
 *     this one. Useful for ease-in animations that need to stay smooth
 *     across backgrounded terminals where the frame rate drops.
 *   - `isIdle`: true after the Ink interaction clock has been quiet long
 *     enough for low-priority animation consumers to back off.
 *
 * The `fpsTarget` argument is honored as a cap: when the clock ticks
 * faster than the target, we drop intermediate ticks. Consumers that
 * want every frame should pass `undefined` (or 60, the default).
 */

import { useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { ClockContext, type Clock } from "../ink/components/ClockContext.js";
import { getLastInteractionTime } from "../ink/vendored/state.js";

export interface AnimationTick {
  readonly tick: number;
  readonly deltaMs: number;
  readonly isIdle: boolean;
}

export interface UseAnimationTickOptions {
  /** Target frame rate cap. Defaults to 60. */
  readonly fpsTarget?: number;
}

const DEFAULT_FPS_TARGET = 60;
export const ANIMATION_IDLE_AFTER_MS = 2_000;

/**
 * Fallback snapshot emitted when no `ClockProvider` is mounted above the
 * consumer. The TUI root always provides one in production, but unit
 * tests that mount a component in isolation should still render without
 * crashing.
 */
const IDLE_SNAPSHOT: AnimationTick = Object.freeze({
  tick: 0,
  deltaMs: 0,
  isIdle: true,
});

export function useAnimationTick(
  fpsTarget: number = DEFAULT_FPS_TARGET,
): AnimationTick {
  const clock = useContext(ClockContext);

  // Per-consumer cadence state. Kept on a ref so the store's `subscribe`
  // callback can decide whether a given tick survives the fps cap without
  // relying on React state (which would itself schedule a render).
  const stateRef = useRef<{
    tick: number;
    lastNow: number;
    snapshot: AnimationTick;
  }>({
    tick: 0,
    lastNow: 0,
    snapshot: IDLE_SNAPSHOT,
  });

  const minDeltaMs = fpsTarget > 0 ? 1000 / fpsTarget : 0;

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!clock) return () => undefined;
      return clock.subscribe(() => {
        const now = clock.now();
        const state = stateRef.current;
        const delta = state.lastNow === 0 ? 0 : now - state.lastNow;
        // Honor the fps cap: if we ticked faster than requested, leave the
        // snapshot untouched so no re-render is triggered.
        if (delta > 0 && delta < minDeltaMs) {
          return;
        }
        state.lastNow = now;
        state.tick += 1;
        state.snapshot = Object.freeze({
          tick: state.tick,
          deltaMs: delta,
          isIdle: Date.now() - getLastInteractionTime() >= ANIMATION_IDLE_AFTER_MS,
        });
        onStoreChange();
      }, true /* keepAlive: we want the clock running while this hook is mounted */);
    },
    [clock, minDeltaMs],
  );

  const getSnapshot = useCallback((): AnimationTick => {
    return stateRef.current.snapshot;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Lightweight re-export so callers that want to read the raw clock value
 * (without subscribing to it) don't need to import from ink internals.
 */
export function useRawClock(): Clock | null {
  return useContext(ClockContext);
}
