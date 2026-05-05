import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function findProjectRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(resolve(current, "parity/agenc-tool-use-summary-parity.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Unable to find agenc-tool-use-summary parity matrix");
    }
    current = parent;
  }
}

const root = findProjectRoot(process.cwd());
const matrix = JSON.parse(
  readFileSync(resolve(root, "parity/agenc-tool-use-summary-parity.json"), "utf8"),
) as {
  readonly rows: Array<{
    readonly id: string;
    readonly sourceFiles?: readonly string[];
    readonly targetFiles?: readonly string[];
    readonly testFiles?: readonly string[];
  }>;
};

describe("tool-use summary contract", () => {
  it("tracks the source, target, and executable tests", () => {
    const row = matrix.rows.find(
      (entry) => entry.id === "tool-use-summary-generation",
    );
    expect(row).toBeDefined();
    expect(row?.sourceFiles).toEqual([
      "src/services/toolUseSummary/toolUseSummaryGenerator.ts",
    ]);
    expect(row?.targetFiles).toContain(
      "runtime/src/services/toolUseSummary/toolUseSummaryGenerator.ts",
    );
    expect(row?.testFiles).toEqual([
      "runtime/src/services/toolUseSummary/toolUseSummaryGenerator.test.ts",
      "runtime/src/services/toolUseSummary/toolUseSummary.contract.test.ts",
    ]);

    for (const target of row?.targetFiles ?? []) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }
    for (const testFile of row?.testFiles ?? []) {
      expect(existsSync(resolve(root, testFile))).toBe(true);
    }
  });

  it("keeps the fixed prompt, default model, and structured failure marker live", () => {
    const source = readFileSync(
      resolve(root, "runtime/src/services/toolUseSummary/toolUseSummaryGenerator.ts"),
      "utf8",
    );
    expect(source).toContain("Write a short summary label");
    expect(source).toContain("TOOL_USE_SUMMARY_DEFAULT_MODEL");
    expect(source).toContain("E_TOOL_USE_SUMMARY_GENERATION_FAILED");
    expect(source).toContain("tool_use_summary_generation");
  });
});
