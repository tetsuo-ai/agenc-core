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

// gaphunt3 #26 & #30 originally bounded the removed synchronous JavaScript
// regex fallback. Grep now fails closed when its packaged ripgrep is
// unavailable, so model-controlled patterns never reach V8 RegExp. These tests
// remain revert-sensitive: restoring the fallback either returns searched
// content or blocks on the catastrophic patterns instead of returning the
// pinned-runtime remediation.

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

function expectPinnedRuntimeFailure(result: ToolResult): void {
  expect(result.isError).toBe(true);
  expect(result.content).toContain("PINNED_RIPGREP_UNAVAILABLE");
  expect(result.content).toContain("reinstall");
}

describe("Grep pinned-runtime ReDoS isolation (gaphunt3 #26, #30)", () => {
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

  test("missing pinned runtime never evaluates a catastrophic content pattern", async () => {
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

    expectPinnedRuntimeFailure(result);
  });

  test("missing pinned runtime never searches normal short lines", async () => {
    await writeFile(join(root, "ok.txt"), "alpha\nneedle\ngamma\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expectPinnedRuntimeFailure(result);
    expect(result.content).not.toContain("alpha");
    expect(result.content).not.toContain("needle\ngamma");
  });

  test("missing pinned runtime returns promptly before an abort timer", async () => {
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
      expectPinnedRuntimeFailure(result);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  test("missing pinned runtime never evaluates a catastrophic file-list pattern", async () => {
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

    expectPinnedRuntimeFailure(result);
  });
});
