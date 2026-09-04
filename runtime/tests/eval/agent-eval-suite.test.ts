import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const runnerScriptPath = resolve(runtimeRootPath, "scripts", "run-agent-eval.mjs");
const suitePath = resolve(runtimeRootPath, "eval", "tasks");
const SUITE_TASK_COUNT = 13;
const SESSION_TASK_ID = "asteroid-drift-15";
const SESSION_STEP_COUNT = 15;
const controlledTmpDir = mkdtempSync(join(tmpdir(), "agenc-eval-test-tmp-"));

// Prove copied fixtures do not inherit an unrelated module type from the host.
writeFileSync(
  join(controlledTmpDir, "package.json"),
  JSON.stringify({ private: true, type: "commonjs" }),
);

afterAll(() => rmSync(controlledTmpDir, { force: true, recursive: true }));

interface StepResult {
  id: string;
  status: string;
  durationMs: number;
  metrics?: Record<string, unknown>;
  verifiers: { name: string; status: string }[];
}

interface TaskResult {
  id: string;
  kind?: string;
  status: string;
  tokens?: { input?: number; output?: number; total?: number };
  verifiers: { name: string; status: string }[];
  steps?: StepResult[];
  metrics?: { steps?: number; toolCalls?: number };
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
    env: {
      ...process.env,
      TEMP: controlledTmpDir,
      TMP: controlledTmpDir,
      TMPDIR: controlledTmpDir,
    },
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

      const session = report.tasks.find((task) => task.id === SESSION_TASK_ID);
      expect(session, "the session task is part of the suite").toBeDefined();
      expect(session?.kind).toBe("session");
      expect(session?.steps).toHaveLength(SESSION_STEP_COUNT);
      for (const step of session?.steps ?? []) {
        expect(step.status, `step ${step.id} should pass`).toBe("passed");
        expect(step.verifiers.length, `step ${step.id} has verifiers`).toBeGreaterThan(0);
        expect(step.metrics, `step ${step.id} carries metrics`).toBeDefined();
      }
      expect(session?.metrics?.steps).toBe(SESSION_STEP_COUNT);
      // Every step's verifiers plus the task verifier ran against the same tree.
      expect(session?.verifiers.map((verifier) => verifier.status)).toEqual(["passed"]);
    },
    180_000,
  );

  test(
    "a session solution that skips the final step fails at the final verifier only",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "agenc-eval-session-sabotage-"));
      cpSync(join(suitePath, SESSION_TASK_ID), join(dir, SESSION_TASK_ID), {
        recursive: true,
      });
      // Prompt 15 asks for CHANGELOG.md; a solution without it must go red
      // there and nowhere else.
      rmSync(join(dir, SESSION_TASK_ID, "solution", "CHANGELOG.md"));
      const manifest = JSON.parse(
        readFileSync(join(suitePath, "manifest.json"), "utf8"),
      ) as { tasks: { id: string }[] };
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify(
          {
            benchmark: "session-sabotage",
            tasks: manifest.tasks.filter((task) => task.id === SESSION_TASK_ID),
          },
          null,
          2,
        ),
      );
      const result = runRunner(["--suite", dir, "--executor", "mock"]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as EvalReport;
      const [task] = report.tasks;
      expect(task.status).toBe("failed");
      const failedSteps = (task.steps ?? []).filter((step) => step.status !== "passed");
      expect(failedSteps.map((step) => step.id)).toEqual(["15-final"]);
      expect(task.verifiers[0]?.status).toBe("failed");
      expect(task.riskFlags).toContain("verifier_failed");
    },
    120_000,
  );

  test("a session task without steps is a manifest error", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-eval-session-invalid-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        benchmark: "invalid",
        tasks: [{ id: "no-steps", kind: "session", dir: "x" }],
      }),
    );
    const result = runRunner(["--suite", dir, "--executor", "mock"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs a non-empty steps array");
  });

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
