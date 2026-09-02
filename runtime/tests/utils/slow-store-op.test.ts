import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SLOW_STORE_OP_THRESHOLD_MS,
  setSlowStoreOpReporter,
  timed,
  type SlowStoreOpWarning,
} from "../../src/utils/slow-store-op.js";

afterEach(() => {
  setSlowStoreOpReporter(undefined);
  vi.restoreAllMocks();
});

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // busy wait: the guard measures synchronous work on the event loop
  }
}

describe("timed", () => {
  it("returns the operation's result and stays silent under the threshold", () => {
    const report = vi.fn();
    expect(timed("fast_op", () => 42, report)).toBe(42);
    expect(report).not.toHaveBeenCalled();
    expect(SLOW_STORE_OP_THRESHOLD_MS).toBe(50);
  });

  it("reports a slow_store_op warning with the label and duration", () => {
    const warnings: SlowStoreOpWarning[] = [];
    const result = timed(
      "session_snapshot_write",
      () => {
        spin(5);
        return "written";
      },
      (warning) => warnings.push(warning),
      1,
    );
    expect(result).toBe("written");
    expect(warnings).toEqual([
      expect.objectContaining({
        cause: "slow_store_op",
        label: "session_snapshot_write",
      }),
    ]);
    expect(warnings[0]?.ms).toBeGreaterThanOrEqual(4);
  });

  it("still reports when the slow operation throws, and rethrows", () => {
    const report = vi.fn();
    expect(() =>
      timed(
        "canonical_rollout_scan",
        () => {
          spin(3);
          throw new Error("scan failed");
        },
        report,
        1,
      ),
    ).toThrow("scan failed");
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("never lets a failing reporter mask the operation", () => {
    expect(
      timed(
        "thread_archive",
        () => {
          spin(3);
          return "ok";
        },
        () => {
          throw new Error("reporter broke");
        },
        1,
      ),
    ).toBe("ok");
  });

  it("uses the process-wide reporter by default and prints one console line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    timed("default_sink", () => spin(3), undefined, 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^agenc: slow_store_op \{"label":"default_sink","ms":\d+\}$/,
    );

    const custom = vi.fn();
    setSlowStoreOpReporter(custom);
    timed("custom_sink", () => spin(3), undefined, 1);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
