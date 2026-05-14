import { describe, expect, test, vi } from "vitest";

import { formatRenderHealthWarning } from "./App.js";
import {
  formatTuiBackpressureWarning,
  getTuiBackpressureSnapshot,
  recordTuiBackpressure,
  resetTuiBackpressureForTesting,
  subscribeTuiBackpressure,
} from "../backpressure.js";
import { FpsTracker } from "../../utils/fpsTracker.js";

describe("FpsTracker", () => {
  test("computes average and 1% low from the same render-duration window", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0);
    now.mockReturnValueOnce(10_000);

    try {
      const tracker = new FpsTracker();
      tracker.record(6.25);
      tracker.record(6.25);

      expect(tracker.getMetrics()).toEqual({
        averageFps: 160,
        low1PctFps: 160,
        sampleCount: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  test("never reports one-percent-low FPS above average FPS", () => {
    const tracker = new FpsTracker();
    for (let i = 0; i < 99; i += 1) {
      tracker.record(5);
    }
    tracker.record(100);

    const metrics = tracker.getMetrics();

    expect(metrics?.averageFps).toBeCloseTo(168.07, 2);
    expect(metrics?.low1PctFps).toBe(10);
    expect(metrics?.low1PctFps).toBeLessThanOrEqual(metrics?.averageFps ?? 0);
    expect(metrics?.sampleCount).toBe(100);
  });

  test("ignores invalid render duration samples", () => {
    const tracker = new FpsTracker();
    tracker.record(0);
    tracker.record(Number.NaN);
    tracker.record(10);

    expect(tracker.getMetrics()).toEqual({
      averageFps: 100,
      low1PctFps: 100,
      sampleCount: 1,
    });
  });
});

describe("TUI render health warning", () => {
  test("renders nothing when metrics are absent or healthy", () => {
    expect(formatRenderHealthWarning(undefined)).toBeNull();
    expect(formatRenderHealthWarning({ averageFps: 30, low1PctFps: 20 })).toBeNull();
  });

  test("warns when average FPS or one-percent-low FPS crosses the threshold", () => {
    expect(formatRenderHealthWarning({ averageFps: 19.8, low1PctFps: 20, sampleCount: 20 })).toContain(
      "average 19.8 FPS",
    );
    expect(formatRenderHealthWarning({ averageFps: 30, low1PctFps: 11.5, sampleCount: 20 })).toContain(
      "1% low 11.5 FPS",
    );
  });

  test("does not render impossible one-percent-low FPS above average FPS", () => {
    expect(formatRenderHealthWarning({ averageFps: 3.8, low1PctFps: 160.2, sampleCount: 20 })).toBe(
      "Render health: average 3.8 FPS, 1% low 3.8 FPS",
    );
  });

  test("suppresses warnings until the sample window is large enough", () => {
    expect(formatRenderHealthWarning({ averageFps: 3.8, low1PctFps: 2.5, sampleCount: 2 })).toBeNull();
  });
});

describe("TUI input backpressure warning", () => {
  test("formats visible input and render backpressure states", () => {
    expect(
      formatTuiBackpressureWarning({
        active: true,
        source: "input",
        durationMs: 1250,
        startedAtMs: 10,
        expiresAtMs: 20,
      }),
    ).toBe("Input is catching up after 1.3s of blocked key processing");
    expect(
      formatTuiBackpressureWarning({
        active: true,
        source: "render",
        durationMs: 750,
        startedAtMs: 10,
        expiresAtMs: 20,
      }),
    ).toBe("Rendering is catching up after a 750ms frame");
  });

  test("publishes and clears the visible backpressure snapshot", () => {
    resetTuiBackpressureForTesting();
    const listener = vi.fn();
    const unsubscribe = subscribeTuiBackpressure(listener);

    recordTuiBackpressure({
      source: "render",
      durationMs: 1500,
      nowMs: Date.now(),
      visibleMs: 50_000,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTuiBackpressureSnapshot()).toMatchObject({
      active: true,
      source: "render",
      durationMs: 1500,
    });

    unsubscribe();
    resetTuiBackpressureForTesting();
  });
});
