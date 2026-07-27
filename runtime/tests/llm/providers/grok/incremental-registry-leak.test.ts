import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  IncrementalTracker,
  clearAllResponseIds,
  registerIncrementalTracker,
  registeredIncrementalTrackerCountForTest,
} from "../../../../src/llm/providers/grok/incremental.js";

// M-LLM-3 (core-todo.md): GrokProvider registered its IncrementalTracker in a
// module-global Set removed only by dispose(), which no production path calls (the
// auto-mode classifier / delegate build a fresh grok provider per call). The Set
// held STRONG references, so trackers accumulated unbounded. Fixed by making the
// registry WeakRef-backed so a dropped tracker is collectable.

describe("grok incremental tracker registry — M-LLM-3 leak", () => {
  it("clearAllResponseIds runs over live trackers and unregister removes them", () => {
    const tracker = new IncrementalTracker();
    const unregister = registerIncrementalTracker(tracker);
    expect(registeredIncrementalTrackerCountForTest()).toBeGreaterThanOrEqual(1);
    // clearAllResponseIds must still traverse and clear live trackers (behavior
    // preserved) without throwing.
    expect(() => clearAllResponseIds()).not.toThrow();
    unregister();
    expect(registeredIncrementalTrackerCountForTest()).toBe(0);
  });

  it("does not strongly retain trackers whose owner was dropped", () => {
    const created = 50;
    const moduleUrl = new URL(
      "../../../../src/llm/providers/grok/incremental.ts",
      import.meta.url,
    ).href;
    const childScript = `
      const {
        IncrementalTracker,
        registerIncrementalTracker,
        registeredIncrementalTrackerCountForTest,
      } = await import(${JSON.stringify(moduleUrl)});
      const created = ${created};
      function registerDroppedTrackers() {
        for (let i = 0; i < created; i += 1) {
          registerIncrementalTracker(new IncrementalTracker());
        }
      }
      registerDroppedTrackers();
      const before = registeredIncrementalTrackerCountForTest();
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 10; i += 1) {
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      const after = registeredIncrementalTrackerCountForTest();
      process.stdout.write(JSON.stringify({
        gcType: typeof globalThis.gc,
        created,
        before,
        after,
      }));
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childScript,
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        encoding: "utf8",
        // Preserve the hermetic runner's reviewed NODE_OPTIONS preload so its
        // network tripwire also governs this focused child.
        env: process.env,
        timeout: 15_000,
      },
    );
    const diagnostics = [
      `status=${String(child.status)}`,
      `signal=${String(child.signal)}`,
      `error=${child.error?.stack ?? "none"}`,
      `stdout=${JSON.stringify(child.stdout)}`,
      `stderr=${JSON.stringify(child.stderr)}`,
    ].join("\n");

    expect(child.error, diagnostics).toBeUndefined();
    expect(child.signal, diagnostics).toBeNull();
    expect(child.status, diagnostics).toBe(0);

    let evidence: {
      gcType: string;
      created: number;
      before: number;
      after: number;
    };
    try {
      evidence = JSON.parse(child.stdout) as typeof evidence;
    } catch (error) {
      throw new Error(
        `GC retention child did not return valid evidence: ${
          error instanceof Error ? error.message : String(error)
        }\n${diagnostics}`,
      );
    }

    expect(evidence.gcType).toBe("function");
    expect(evidence.created).toBe(created);
    expect(evidence.before).toBe(created);
    // Reverting the registry to a strong Set leaves all `created` trackers here.
    expect(evidence.after).toBe(0);
  });
});
