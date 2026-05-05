import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

type Matrix = {
  readonly item: string;
  readonly status: string;
  readonly targetTestFiles: readonly string[];
  readonly selectedCases: readonly {
    readonly id: string;
    readonly sourceFile: string;
    readonly requiredBehavior: string;
    readonly targetTests: readonly string[];
  }[];
  readonly applyPatchFixtureCoverage: {
    readonly expectedScenarioDirectories: readonly string[];
  };
};

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", "..", "..");
const MATRIX_PATH = join(REPO_ROOT, "parity", "ZC-36-parity.json");
const APPLY_PATCH_SCENARIOS_ROOT = join(
  REPO_ROOT,
  "runtime",
  "src",
  "tools",
  "apply-patch",
  "__fixtures__",
  "scenarios",
);

async function readMatrix(): Promise<Matrix> {
  return JSON.parse(await readFile(MATRIX_PATH, "utf8")) as Matrix;
}

async function existingScenarioDirectories(): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(APPLY_PATCH_SCENARIOS_ROOT, {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

describe("ZC-36 representative suite parity lock", () => {
  test("selects at least 20 source-suite behaviors and maps every row to a target test", async () => {
    const matrix = await readMatrix();
    expect(matrix.item).toBe("ZC-36");
    expect(matrix.status).toBe("representative-subset");
    expect(matrix.selectedCases.length).toBeGreaterThanOrEqual(20);

    const targetTestSet = new Set(matrix.targetTestFiles);
    for (const selected of matrix.selectedCases) {
      expect(selected.id).toMatch(/^[a-z0-9-]+$/);
      expect(selected.sourceFile).toMatch(/^(?:core|app-server|apply-patch)\//);
      expect(selected.requiredBehavior.length).toBeGreaterThan(24);
      expect(selected.targetTests.length).toBeGreaterThan(0);
      for (const target of selected.targetTests) {
        expect(targetTestSet.has(target), `${selected.id} target ${target}`).toBe(
          true,
        );
      }
    }
  });

  test("all mapped AgenC target tests exist on disk", async () => {
    const matrix = await readMatrix();
    for (const target of matrix.targetTestFiles) {
      const metadata = await stat(join(REPO_ROOT, target));
      expect(metadata.isFile(), target).toBe(true);
    }
  });

  test("full apply-patch scenario fixture corpus is present", async () => {
    const matrix = await readMatrix();
    const actual = await existingScenarioDirectories();
    expect(actual).toEqual([
      ...matrix.applyPatchFixtureCoverage.expectedScenarioDirectories,
    ].sort());
  });
});
