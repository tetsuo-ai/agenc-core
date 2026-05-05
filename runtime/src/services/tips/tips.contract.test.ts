import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function findProjectRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(resolve(current, "parity/agenc-tips-service-parity.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Unable to find agenc-tips-service parity matrix");
    }
    current = parent;
  }
}

const root = findProjectRoot(process.cwd());
const matrix = JSON.parse(
  readFileSync(resolve(root, "parity/agenc-tips-service-parity.json"), "utf8"),
) as {
  readonly rows: Array<{
    readonly id: string;
    readonly sourceFiles?: readonly string[];
    readonly targetFiles?: readonly string[];
    readonly testFiles?: readonly string[];
  }>;
};

describe("tips service contract", () => {
  it("tracks the donor anchors, AgenC targets, and executable tests", () => {
    const rowIds = matrix.rows.map((row) => row.id);
    expect(rowIds).toEqual(["tips-history", "tips-registry-and-scheduler"]);

    for (const row of matrix.rows) {
      for (const target of row.targetFiles ?? []) {
        expect(existsSync(resolve(root, target))).toBe(true);
      }
      for (const testFile of row.testFiles ?? []) {
        expect(existsSync(resolve(root, testFile))).toBe(true);
      }
    }
  });

  it("keeps the scheduler, history, registry, settings, and analytics surfaces live", () => {
    const scheduler = readFileSync(
      resolve(root, "runtime/src/services/tips/tipScheduler.ts"),
      "utf8",
    );
    const registry = readFileSync(
      resolve(root, "runtime/src/services/tips/tipRegistry.ts"),
      "utf8",
    );
    const history = readFileSync(
      resolve(root, "runtime/src/services/tips/tipHistory.ts"),
      "utf8",
    );

    expect(scheduler).toContain("selectTipWithLongestTimeSinceShown");
    expect(scheduler).toContain("spinnerTipsEnabled");
    expect(scheduler).toContain("agenc_tip_shown");
    expect(registry).toContain("spinnerTipsOverride");
    expect(registry).toContain("getSessionsSinceLastShown");
    expect(registry).toContain("mobile-app");
    expect(history).toContain("resolveAgenCConfigHomeDir");
    expect(history).toContain("tipsHistory");
  });
});
