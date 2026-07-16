import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetRipgrepProbeForTests,
  __setRipgrepAvailabilityForTests,
  createGrepTool as createUnboundGrepTool,
} from "src/tools/system/grep";
import type { ToolResult } from "src/tools/types";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";

const createGrepTool = (
  ...args: Parameters<typeof createUnboundGrepTool>
) => bindExplicitDangerBoundary(createUnboundGrepTool(...args));

// gaphunt3 #26 & #30: the pure-JS Grep fallback runs a model-controlled,
// backtracking V8 RegExp per line over up-to-2MB file content with no ReDoS
// guard. A catastrophic pattern (e.g. `(a+)+$`) against a long non-matching
// line backtracks exponentially and pins the single-threaded event loop, and
// abort was only polled between files (never between lines / during a match).
//
// The fix clamps each tested line to MAX_FALLBACK_LINE_CHARS (4096) before the
// regex test — a bounded probe defuses the exponential blowup — and polls the
// abort signal + a wall-clock deadline BETWEEN lines so an expensive scan
// terminates promptly instead of hanging for the full tool timeout.
//
// Revert sensitivity: with the fix reverted, the regex test on the long line
// hangs synchronously for many seconds/minutes, so `execute()` never resolves
// within the bound (and the timer-based abort can never even fire because the
// event loop is blocked). Each test wins a Promise.race against a short
// wall-clock guard ONLY when the clamp/deadline is present.

/**
 * Resolve `promise` if it settles before `boundMs`; otherwise reject with a
 * timeout marker. The guard timer is `unref`'d so a wedged regex (fix
 * reverted) cannot keep the test process alive — the race simply rejects.
 */
function withWallClockBound<T>(
  promise: Promise<T>,
  boundMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`exceeded wall-clock bound of ${boundMs}ms`));
    }, boundMs);
    // Do not pin the event loop on the guard timer.
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

describe("Grep fallback ReDoS guard (gaphunt3 #26, #30)", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-grep-redos-"));
    __resetRipgrepProbeForTests();
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    __resetRipgrepProbeForTests();
  });

  // gaphunt3 #26: a 200KB single line with a non-matching trailing char and a
  // catastrophic pattern must NOT pin the event loop. Without the per-line
  // clamp, `(a+)+$` over the 200KB line backtracks exponentially and never
  // returns; with the clamp the bounded probe resolves in microseconds.
  test("fallback content mode does not hang on a catastrophic pattern over a long line", async () => {
    const evilLine = `${"a".repeat(200 * 1024)}b`;
    await writeFile(join(root, "evil.txt"), `${evilLine}\n`, "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await withWallClockBound<ToolResult>(
      tool.execute({
        pattern: "(a+)+$",
        path: root,
        output_mode: "content",
      }),
      2_000,
    );

    // The call returned within the bound (it would hang without the clamp).
    expect(result).toBeDefined();
    expect(typeof result.content).toBe("string");
  });

  // gaphunt3 #26: the clamp must not corrupt matching for normal-length lines.
  test("fallback content mode still matches normal short lines after the clamp", async () => {
    await writeFile(join(root, "ok.txt"), "alpha\nneedle\ngamma\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("needle");
  });

  // gaphunt3 #30: with an AbortSignal that fires shortly after the call starts,
  // the fallback must return promptly. Without the fix the synchronous regex on
  // the 100k-char line blocks the event loop, so the abort timer can never
  // fire and the call never resolves; the wall-clock guard then rejects.
  test("fallback content mode returns promptly under an abort signal on a catastrophic line", async () => {
    const evilLine = `${"a".repeat(100_000)}b`;
    await writeFile(join(root, "evil.txt"), `${evilLine}\n`, "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 200);
    (abortTimer as { unref?: () => void }).unref?.();

    try {
      const result = await withWallClockBound<ToolResult>(
        tool.execute({
          pattern: "(a+)+$",
          path: root,
          output_mode: "content",
          __abortSignal: controller.signal,
        }),
        2_000,
      );
      expect(result).toBeDefined();
      expect(typeof result.content).toBe("string");
    } finally {
      clearTimeout(abortTimer);
    }
  });

  // gaphunt3 #30: files_with_matches mode is the default output mode and shares
  // the same per-line scan; it must also be bounded against the catastrophic
  // pattern over a long line.
  test("fallback files_with_matches mode does not hang on a catastrophic long line", async () => {
    const evilLine = `${"a".repeat(150 * 1024)}b`;
    await writeFile(join(root, "evil.txt"), `${evilLine}\n`, "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await withWallClockBound<ToolResult>(
      tool.execute({
        pattern: "(a+)+$",
        path: root,
        output_mode: "files_with_matches",
      }),
      2_000,
    );

    expect(result).toBeDefined();
    expect(typeof result.content).toBe("string");
  });
});
