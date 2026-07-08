import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const scriptPath = resolve(
  runtimeRootPath,
  "scripts",
  "check-eval-regression.mjs",
);

interface TaskRow {
  id: string;
  status: "passed" | "failed" | "error" | "skipped";
  durationMs: number;
  tokens?: { input: number; output: number };
}

function buildReport(options: {
  tasks: TaskRow[];
  benchmark?: string;
  fingerprint?: string;
}) {
  return {
    schemaVersion: 1,
    run: {
      id: "synthetic-run",
      benchmark: options.benchmark ?? "agenc-local-coding-v1",
      startedAt: "2026-07-08T12:00:00Z",
      finishedAt: "2026-07-08T12:05:00Z",
      agent: { name: "agenc" },
      environment: {
        runner: "local",
        localOnly: true,
        ...(options.fingerprint
          ? { configFingerprint: options.fingerprint }
          : {}),
      },
    },
    tasks: options.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      durationMs: task.durationMs,
      ...(task.tokens ? { tokens: task.tokens } : {}),
      verifiers: [],
    })),
  };
}

function passingTasks(count: number, durationMs = 1000, tokens = 500): TaskRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    status: "passed" as const,
    durationMs,
    tokens: { input: tokens, output: 0 },
  }));
}

function writeReport(dir: string, name: string, report: unknown): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
}

function runCheck(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: runtimeRootPath,
    encoding: "utf8",
  });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agenc-eval-regression-"));
}

describe("check-eval-regression", () => {
  test("equal report exits zero", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(4) }));
    const candidate = writeReport(dir, "candidate.json", buildReport({ tasks: passingTasks(4) }));
    const result = runCheck([candidate, "--baseline", baseline]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No regressions beyond thresholds.");
  });

  test("better report (faster, cheaper) exits zero", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(4, 2000, 800) }));
    const candidate = writeReport(dir, "candidate.json", buildReport({ tasks: passingTasks(4, 500, 300) }));
    const result = runCheck([candidate, "--baseline", baseline]);
    expect(result.status).toBe(0);
  });

  test("pass-rate drop exits nonzero", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(4) }));
    const worse = passingTasks(4);
    worse[0] = { ...worse[0], status: "failed" };
    const candidate = writeReport(dir, "candidate.json", buildReport({ tasks: worse }));
    const result = runCheck([candidate, "--baseline", baseline]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("pass rate dropped");
  });

  test("errored task counts against the pass rate", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(4) }));
    const worse = passingTasks(4);
    worse[1] = { ...worse[1], status: "error" };
    const candidate = writeReport(dir, "candidate.json", buildReport({ tasks: worse }));
    const result = runCheck([candidate, "--baseline", baseline]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("pass rate dropped");
  });

  test("token increase beyond default 20% exits nonzero, override passes", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(4, 1000, 500) }));
    const candidate = writeReport(dir, "candidate.json", buildReport({ tasks: passingTasks(4, 1000, 750) }));

    const strict = runCheck([candidate, "--baseline", baseline]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("avg tokens per task rose");

    const relaxed = runCheck([
      candidate,
      "--baseline",
      baseline,
      "--max-token-increase-pct",
      "100",
    ]);
    expect(relaxed.status).toBe(0);
  });

  test("latency increase beyond default 50% exits nonzero, override passes", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(4, 1000, 500) }));
    const candidate = writeReport(dir, "candidate.json", buildReport({ tasks: passingTasks(4, 2000, 500) }));

    const strict = runCheck([candidate, "--baseline", baseline]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("avg latency per task rose");

    const relaxed = runCheck([
      candidate,
      "--baseline",
      baseline,
      "--max-latency-increase-pct",
      "150",
    ]);
    expect(relaxed.status).toBe(0);
  });

  test("config fingerprint mismatch warns by default, fails with --require-same-config", () => {
    const dir = tempDir();
    const baseline = writeReport(
      dir,
      "baseline.json",
      buildReport({ tasks: passingTasks(4), fingerprint: "aaaa" }),
    );
    const candidate = writeReport(
      dir,
      "candidate.json",
      buildReport({ tasks: passingTasks(4), fingerprint: "bbbb" }),
    );

    const lenient = runCheck([candidate, "--baseline", baseline]);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("config fingerprint mismatch");

    const strict = runCheck([
      candidate,
      "--baseline",
      baseline,
      "--require-same-config",
    ]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("config fingerprint mismatch");
  });

  test("candidate with zero attempted tasks exits nonzero", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(2) }));
    const candidate = writeReport(
      dir,
      "candidate.json",
      buildReport({
        tasks: [
          { id: "task-1", status: "skipped", durationMs: 0 },
          { id: "task-2", status: "skipped", durationMs: 0 },
        ],
      }),
    );
    const result = runCheck([candidate, "--baseline", baseline]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("attempted zero tasks");
  });

  test("schema-invalid candidate exits nonzero", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(2) }));
    const invalid = buildReport({ tasks: passingTasks(2) }) as { schemaVersion: number };
    invalid.schemaVersion = 2;
    const candidate = writeReport(dir, "candidate.json", invalid);
    const result = runCheck([candidate, "--baseline", baseline]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed schema validation");
  });

  test("unknown option exits with usage error", () => {
    const result = runCheck(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  test("picks the newest report from --reports-dir when no path is given", () => {
    const dir = tempDir();
    const baseline = writeReport(dir, "baseline.json", buildReport({ tasks: passingTasks(3) }));
    const reportsDir = join(dir, "reports");
    mkdirSync(reportsDir);

    const worse = passingTasks(3);
    worse[0] = { ...worse[0], status: "failed" };
    const oldPath = writeReport(reportsDir, "old.json", buildReport({ tasks: worse }));
    writeReport(reportsDir, "new.json", buildReport({ tasks: passingTasks(3) }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldPath, past, past);

    const result = runCheck([
      "--baseline",
      baseline,
      "--reports-dir",
      reportsDir,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("new.json");
  });
});
