import { describe, expect, it } from "vitest";

import {
  createTuiFrameMonitor,
  frameMonitorOptionsFromEnv,
} from "./frame-monitor.js";

describe("TUI frame monitor", () => {
  it("is disabled unless explicitly enabled by env", () => {
    expect(frameMonitorOptionsFromEnv({}).enabled).toBe(false);
    expect(
      frameMonitorOptionsFromEnv({ AGENC_TUI_FRAME_DEBUG: "true" }).enabled,
    ).toBe(true);
  });

  it("reports slow frames, flickers, and input latency when enabled", () => {
    let now = 0;
    const lines: string[] = [];
    const monitor = createTuiFrameMonitor({
      enabled: true,
      slowFrameMs: 10,
      inputLatencyMs: 5,
      reportEvery: 100,
      now: () => now,
      write: (line) => lines.push(line),
      memoryUsage: () =>
        ({
          rss: 128 * 1024 * 1024,
          heapTotal: 64 * 1024 * 1024,
          heapUsed: 32 * 1024 * 1024,
          external: 0,
          arrayBuffers: 0,
        }) as NodeJS.MemoryUsage,
    });

    expect(monitor).not.toBeNull();
    monitor?.noteInput();
    now = 7;
    monitor?.onFrame({
      durationMs: 3,
      phases: {
        renderer: 1,
        diff: 1,
        optimize: 0.5,
        write: 0.5,
        patches: 2,
        yoga: 0,
        commit: 0,
        yogaVisited: 0,
        yogaMeasured: 0,
        yogaCacheHits: 0,
        yogaLive: 0,
      },
      flickers: [],
    });
    monitor?.onFrame({
      durationMs: 11,
      flickers: [{ desiredHeight: 30, availableHeight: 20, reason: "resize" }],
    });

    expect(lines.join("")).toContain("slow-input");
    expect(lines.join("")).toContain("flicker");
    expect(lines.join("")).toContain("rss=128.0MiB");
    expect(lines.join("")).toContain("heap=32.0MiB");
    expect(lines.join("")).toContain("yogaLive=0");
  });

  it("returns null when disabled", () => {
    expect(
      createTuiFrameMonitor({
        enabled: false,
        slowFrameMs: 10,
        inputLatencyMs: 10,
        reportEvery: 1,
      }),
    ).toBeNull();
  });
});
