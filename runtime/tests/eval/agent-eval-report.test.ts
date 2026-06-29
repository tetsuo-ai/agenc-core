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
const runnerScriptPath = resolve(
  runtimeRootPath,
  "scripts",
  "run-agent-eval.mjs",
);
const schemaPath = sourcePath("eval", "agent-eval-report.schema.json");

function writeTempReport(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-eval-report-"));
  const reportPath = join(dir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function quoteArg(value: string): string {
  return JSON.stringify(value);
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

describe("run-agent-eval script", () => {
  test("runs a local manifest and writes a schema-valid eval report", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-eval-runner-"));
    const agentPassPath = join(dir, "agent-pass.mjs");
    const agentFailPath = join(dir, "agent-fail.mjs");
    const verifierPassPath = join(dir, "verifier-pass.mjs");
    const verifierFailPath = join(dir, "verifier-fail.mjs");
    const manifestPath = join(dir, "tasks.json");
    const reportPath = join(dir, "report.json");

    writeFileSync(
      agentPassPath,
      "console.log(JSON.stringify({ tokenUsage: { input: 3, output: 2, total: 5 } }));\n",
    );
    writeFileSync(agentFailPath, "process.exit(2);\n");
    writeFileSync(verifierPassPath, "process.exit(0);\n");
    writeFileSync(
      verifierFailPath,
      "console.error('assertion failed'); process.exit(1);\n",
    );

    const node = quoteArg(process.execPath);
    const manifest = {
      benchmark: "runner-smoke",
      agentCommand: `${node} ${quoteArg(agentPassPath)}`,
      tasks: [
        {
          id: "pass",
          prompt: "pass",
          verifiers: [
            {
              name: "unit",
              command: `${node} ${quoteArg(verifierPassPath)}`,
            },
          ],
        },
        {
          id: "verifier-fail",
          prompt: "fail verifier",
          verifiers: [
            {
              name: "unit",
              command: `${node} ${quoteArg(verifierFailPath)}`,
            },
          ],
        },
        {
          id: "agent-error",
          prompt: "agent fails",
          agentCommand: `${node} ${quoteArg(agentFailPath)}`,
          verifiers: [
            {
              name: "unit",
              command: `${node} ${quoteArg(verifierPassPath)}`,
            },
          ],
        },
        {
          id: "skip",
          skip: true,
          prompt: "skip",
          verifiers: [
            {
              name: "unit",
              command: `${node} ${quoteArg(verifierPassPath)}`,
            },
          ],
        },
      ],
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [
        runnerScriptPath,
        "--tasks",
        manifestPath,
        "--output",
        reportPath,
        "--run-id",
        "runner-test",
        "--agent-name",
        "agenc-test",
        "--provider",
        "local",
        "--model",
        "mock",
      ],
      {
        cwd: runtimeRootPath,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Wrote eval report:");

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);

    expect(report.run).toMatchObject({
      id: "runner-test",
      benchmark: "runner-smoke",
      agent: {
        name: "agenc-test",
        provider: "local",
        model: "mock",
      },
    });
    expect(report.tasks.map((task: { status: string }) => task.status)).toEqual([
      "passed",
      "failed",
      "error",
      "skipped",
    ]);
    expect(report.tasks[0].tokens).toEqual({ input: 3, output: 2, total: 5 });
    expect(report.tasks[1].riskFlags).toContain("verifier_failed");
    expect(report.tasks[2].riskFlags).toContain("agent_command_failed");
    expect(report.tasks[3].verifiers).toEqual([]);
  });
});
