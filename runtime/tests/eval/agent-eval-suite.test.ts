import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const runnerScriptPath = resolve(runtimeRootPath, "scripts", "run-agent-eval.mjs");
const suitePath = resolve(runtimeRootPath, "eval", "tasks");
const SUITE_TASK_COUNT = 12;

interface TaskResult {
  id: string;
  status: string;
  tokens?: { input?: number; output?: number; total?: number };
  verifiers: { name: string; status: string }[];
  riskFlags?: string[];
}

interface EvalReport {
  schemaVersion: number;
  run: {
    benchmark: string;
    agent: { name: string; provider?: string; model?: string };
    environment?: {
      commit?: string;
      executor?: string;
      configFingerprint?: string;
    };
  };
  tasks: TaskResult[];
}

function runRunner(args: string[]) {
  return spawnSync(process.execPath, [runnerScriptPath, ...args], {
    cwd: runtimeRootPath,
    encoding: "utf8",
  });
}

function readReport(filePath: string): EvalReport {
  return JSON.parse(readFileSync(filePath, "utf8")) as EvalReport;
}

function sabotagedSuiteDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-eval-sabotage-"));
  cpSync(join(suitePath, "fix-off-by-one"), join(dir, "fix-off-by-one"), {
    recursive: true,
  });
  // Replace the scripted solution with a no-op: the checker must go red.
  writeFileSync(
    join(dir, "fix-off-by-one", "solution.sh"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"tokenUsage":{"input":1,"output":1}}\'\n',
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        benchmark: "sabotage-check",
        tasks: [
          {
            id: "fix-off-by-one",
            dir: "fix-off-by-one",
            fixture: "fixture",
            prompt: "noop",
            verifiers: [
              { name: "behavior", command: "node {taskDir}/verify.mjs" },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  return dir;
}

describe("agent eval suite (mock executor)", () => {
  test(
    "full suite passes with the scripted solutions",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "agenc-eval-suite-"));
      const outputPath = join(outDir, "report.json");
      const result = runRunner([
        "--suite",
        suitePath,
        "--executor",
        "mock",
        "--provider",
        "local",
        "--model",
        "scripted-mock",
        "--output",
        outputPath,
      ]);
      expect(result.status, result.stderr).toBe(0);

      const report = readReport(outputPath);
      expect(report.schemaVersion).toBe(1);
      expect(report.run.benchmark).toBe("agenc-local-coding-v1");
      expect(report.tasks).toHaveLength(SUITE_TASK_COUNT);
      for (const task of report.tasks) {
        expect(task.status, `task ${task.id} should pass`).toBe("passed");
        expect(task.verifiers.length).toBeGreaterThan(0);
        expect(
          (task.tokens?.input ?? 0) + (task.tokens?.output ?? 0),
          `task ${task.id} should report mock token usage`,
        ).toBeGreaterThan(0);
      }
      expect(report.run.environment?.commit).toBeTruthy();
      expect(report.run.environment?.executor).toBe("mock");
      expect(report.run.environment?.configFingerprint).toMatch(/^[0-9a-f]{16}$/u);
    },
    120_000,
  );

  test(
    "a no-op solution makes the task checker fail (checkers are revert-sensitive)",
    () => {
      const dir = sabotagedSuiteDir();
      const result = runRunner(["--suite", dir, "--executor", "mock"]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as EvalReport;
      expect(report.tasks).toHaveLength(1);
      expect(report.tasks[0].status).toBe("failed");
      expect(report.tasks[0].verifiers[0].status).toBe("failed");
      expect(report.tasks[0].riskFlags).toContain("verifier_failed");
    },
    60_000,
  );

  test(
    "config matrix writes one schema-valid report per entry",
    () => {
      const dir = sabotagedSuiteDir();
      // Un-sabotage: matrix runs use the real committed solution.
      cpSync(
        join(suitePath, "fix-off-by-one", "solution.sh"),
        join(dir, "fix-off-by-one", "solution.sh"),
      );
      const configPath = join(dir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          matrix: [
            { id: "mock-a", executor: "mock", provider: "local", model: "mock-a" },
            { id: "mock-b", executor: "mock", provider: "local", model: "mock-b" },
          ],
        }),
      );
      const outDir = join(dir, "reports");
      const result = runRunner([
        "--suite",
        dir,
        "--config",
        configPath,
        "--output-dir",
        outDir,
      ]);
      expect(result.status, result.stderr).toBe(0);

      const written = readdirSync(outDir).sort();
      expect(written).toEqual(["report-mock-a.json", "report-mock-b.json"]);
      for (const name of written) {
        const report = readReport(join(outDir, name));
        expect(report.tasks[0].status).toBe("passed");
        expect(report.run.environment?.executor).toBe("mock");
      }
      const first = readReport(join(outDir, written[0]));
      const second = readReport(join(outDir, written[1]));
      expect(first.run.agent.model).toBe("mock-a");
      expect(second.run.agent.model).toBe("mock-b");
      // Different model labels must yield different config fingerprints.
      expect(first.run.environment?.configFingerprint).not.toBe(
        second.run.environment?.configFingerprint,
      );
    },
    60_000,
  );

  test("matrix with multiple entries requires --output-dir", () => {
    const dir = sabotagedSuiteDir();
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        matrix: [{ id: "a", executor: "mock" }, { id: "b", executor: "mock" }],
      }),
    );
    const result = runRunner(["--suite", dir, "--config", configPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--output-dir is required");
  });
});
