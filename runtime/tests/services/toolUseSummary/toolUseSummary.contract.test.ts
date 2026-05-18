import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");

describe("tool-use summary contract", () => {
  it("keeps the generator, tests, prompt, model, and failure marker live", () => {
    for (const rel of [
      "runtime/src/services/toolUseSummary/toolUseSummaryGenerator.ts",
      "runtime/tests/services/toolUseSummary/toolUseSummaryGenerator.test.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }

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
