import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, test } from "vitest";
import { runtimeRootPath, sourcePath } from "../helpers/source-path.ts";

const scriptPath = resolve(
  runtimeRootPath,
  "scripts",
  "check-agent-eval-report.mjs",
);
const schemaPath = sourcePath("eval", "agent-eval-report.schema.json");

function writeTempReport(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-eval-report-"));
  const reportPath = join(dir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function validReport() {
  return {
    schemaVersion: 1,
    run: {
      id: "local-2026-06-14",
      benchmark: "swe-style-local-smoke",
      startedAt: "2026-06-14T12:00:00Z",
      finishedAt: "2026-06-14T12:05:00Z",
      agent: {
        name: "agenc",
        version: "0.2.0",
        provider: "local",
        model: "vllm-compatible",
      },
      environment: {
        repo: "tetsuo-ai/agenc-core",
        commit: "abc123",
        branch: "main",
        runner: "local",
        sandbox: "workspace",
        localOnly: true,
      },
    },
    tasks: [
      {
        id: "task-pass",
        source: "local",
        title: "passing task",
        status: "passed",
        durationMs: 1000,
        tokens: {
          input: 100,
          output: 50,
        },
        commands: [
          {
            command: "npm test",
            exitCode: 0,
            durationMs: 500,
          },
        ],
        verifiers: [
          {
            name: "unit",
            status: "passed",
            command: "npm test",
          },
        ],
        patch: {
          changedFiles: 1,
          additions: 10,
          deletions: 2,
        },
      },
      {
        id: "task-fail",
        status: "failed",
        durationMs: 2000,
        tokens: {
          total: 20,
        },
        commands: [
          {
            command: "npm run typecheck",
            exitCode: 1,
          },
        ],
        verifiers: [
          {
            name: "typecheck",
            status: "failed",
            details: "type error remained",
          },
          {
            name: "manual-review",
            status: "skipped",
          },
        ],
        riskFlags: ["verifier_failed"],
      },
      {
        id: "task-skipped",
        status: "skipped",
        durationMs: 0,
        verifiers: [],
      },
    ],
  };
}

describe("agent eval report schema", () => {
  test("validates the documented report shape", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    expect(validate(validReport()), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("check-agent-eval-report script", () => {
  test("prints a markdown summary for a valid report", () => {
    const reportPath = writeTempReport(validReport());
    const result = spawnSync(process.execPath, [scriptPath, reportPath], {
      cwd: runtimeRootPath,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Agent Eval Report");
    expect(result.stdout).toContain("Run: local-2026-06-14");
    expect(result.stdout).toContain("Fix rate: 50.00%");
    expect(result.stdout).toContain("Verifier pass rate: 50.00%");
    expect(result.stdout).toContain("Tokens: 170");
    expect(result.stdout).toContain("Commands: 2 total, 1 failed");
    expect(result.stdout).toContain("Risk flags: verifier_failed=1");
  });

  test("prints a machine-readable summary with --json", () => {
    const reportPath = writeTempReport(validReport());
    const result = spawnSync(
      process.execPath,
      [scriptPath, reportPath, "--json"],
      {
        cwd: runtimeRootPath,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.tasks).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      attempted: 2,
      fixRate: 50,
    });
    expect(summary.verifiers).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      attempted: 2,
      passRate: 50,
    });
    expect(summary.tokens.total).toBe(170);
  });

  test("rejects invalid task status values", () => {
    const report = validReport();
    report.tasks[0]!.status = "flaky";
    const reportPath = writeTempReport(report);
    const result = spawnSync(process.execPath, [scriptPath, reportPath], {
      cwd: runtimeRootPath,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("agent eval report validation failed");
    expect(result.stderr).toContain("/tasks/0/status");
    expect(result.stderr).toContain("must be equal to one of the allowed values");
  });

  test("reports usage errors without a report path", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: runtimeRootPath,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("expected exactly one report path");
    expect(result.stderr).toContain("Usage:");
  });
});
