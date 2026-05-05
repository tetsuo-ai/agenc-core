import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

type ParityMatrix = {
  readonly contractName: string;
  readonly sourceCommit: string;
  readonly sourceFiles: readonly string[];
  readonly targetFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly rows: readonly {
    readonly id: string;
    readonly targetFiles: readonly string[];
    readonly requiredBehaviors: readonly string[];
    readonly edgeCases: readonly string[];
    readonly testFiles: readonly string[];
  }[];
};

function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "runtime", "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`repo root not found from ${start}`);
}

const repoRoot = findRepoRoot(process.cwd());
const matrixPath = join(repoRoot, "parity", "agenc-service-utilities-parity.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as ParityMatrix;

describe("S-14 service utility parity matrix", () => {
  test("tracks all donor and target files", () => {
    expect(matrix.contractName).toBe("agenc-service-utilities-parity");
    expect(matrix.sourceCommit).toBe("0ca43335375beec6e58711b797d5b0c4bb5019b8");
    expect(matrix.sourceFiles).toEqual([
      "src/services/notifier.ts",
      "src/services/preventSleep.ts",
      "src/services/tokenEstimation.ts",
    ]);
    for (const file of [...matrix.targetFiles, ...matrix.testFiles]) {
      expect(existsSync(resolve(repoRoot, file))).toBe(true);
    }
  });

  test("locks notifier, prevent-sleep, and token-count behavior rows", () => {
    expect(matrix.rows.map((row) => row.id)).toEqual([
      "notifier",
      "prevent-sleep",
      "token-estimation",
    ]);
    for (const row of matrix.rows) {
      expect(row.requiredBehaviors.length).toBeGreaterThan(2);
      expect(row.edgeCases.length).toBeGreaterThan(0);
      expect(row.testFiles).toContain(
        "runtime/src/services/service-utilities.test.ts",
      );
    }
  });

  test("target sources expose the required operational anchors", () => {
    const notifier = readFileSync(
      join(repoRoot, "runtime/src/services/notifier.ts"),
      "utf8",
    );
    const preventSleep = readFileSync(
      join(repoRoot, "runtime/src/services/preventSleep.ts"),
      "utf8",
    );
    const tokenEstimation = readFileSync(
      join(repoRoot, "runtime/src/services/tokenEstimation.ts"),
      "utf8",
    );

    expect(notifier).toContain("sendNotification");
    expect(notifier).toContain("executeNotificationHooks");
    expect(notifier).toContain("agenc_notification_method_used");
    expect(preventSleep).toContain("caffeinate");
    expect(preventSleep).toContain("RESTART_INTERVAL_MS");
    expect(preventSleep).toContain("registerAgenCCleanup");
    expect(tokenEstimation).toContain("countMessagesTokensWithAPI");
    expect(tokenEstimation).toContain("VERTEX_COUNT_TOKENS_ALLOWED_BETAS");
    expect(tokenEstimation).toContain("CountTokensCommand");

    const verify = readFileSync(join(repoRoot, "scripts/goal/verify.mjs"), "utf8");
    expect(verify).toContain("S-14 targeted service utility tests failed");
    expect(verify).toContain("src/services/service-utilities.test.ts");
    expect(verify).toContain("src/services/service-utilities.contract.test.ts");
  });
});
