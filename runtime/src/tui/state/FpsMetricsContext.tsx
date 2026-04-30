/**
 * React-side view of TUI FPS metrics.
 *
 * The actual frame timing is collected outside React by an
 * {@link FpsTracker} living next to the ink instance — see
 * `runtime/src/tui/diagnostics/frame-monitor.ts`. The tracker owns the
 * raw frame durations and computes `averageFps`/`low1PctFps` on demand.
 *
 * This context only stores a stable getter so renderers can pull a
 * fresh snapshot when they want one (typically once per second from a
 * status surface). We deliberately do NOT subscribe to every frame
 * here — that would re-render every consumer 60+ times a second, which
 * is the exact cost we are trying to measure.
 *
 * Wiring (from upstream's pattern):
 *
 * ```ts
 * const tracker = createFpsTracker()
 * const ink = createInkInstance({
 *   onFrame: (e) => { tracker.record(e.durationMs); ... },
 *   ...
 * })
 *
 * <FpsMetricsProvider getFpsMetrics={tracker.getMetrics}>
 *   <App />
 * </FpsMetricsProvider>
 * ```
 *
 * Consumers call `useFpsMetrics()` and either render the snapshot
 * directly or pair the getter with their own `setInterval` for a
 * cadenced refresh.
 */

import React, {
  createContext,
  useContext,
  type ReactNode,
} from "react";

// Local FpsMetrics shape (was previously imported from
// diagnostics/frame-monitor.ts; that AgenC-only file was deleted as
// part of the openclaude diagnostics wholesale-port). The context now
// declares its own shape and downstream consumers continue to read it.
export interface FpsMetrics {
  readonly fps: number;
  readonly p95FrameMs: number;
  readonly droppedFrames: number;
  readonly sampleWindowMs: number;
  readonly samplesInWindow: number;
}

type FpsMetricsGetter = () => FpsMetrics | undefined;

const FpsMetricsContext = createContext<FpsMetricsGetter | undefined>(
  undefined,
);

export interface FpsMetricsProviderProps {
  /**
   * Stable getter that returns the current aggregate metrics, or
   * `undefined` if no frames have landed yet. Typically the
   * `getMetrics` returned by `createFpsTracker()`.
   */
  readonly getFpsMetrics: FpsMetricsGetter;
  readonly children: ReactNode;
}

export function FpsMetricsProvider({
  getFpsMetrics,
  children,
}: FpsMetricsProviderProps): React.ReactElement {
  return (
    <FpsMetricsContext.Provider value={getFpsMetrics}>
      {children}
    </FpsMetricsContext.Provider>
  );
}

/**
 * Get a stable getter for the current FPS metrics snapshot. Returns
 * `undefined` when called outside an {@link FpsMetricsProvider} — used
 * by status surfaces that may render before the provider is mounted.
 */
export function useFpsMetrics(): FpsMetricsGetter | undefined {
  return useContext(FpsMetricsContext);
}
