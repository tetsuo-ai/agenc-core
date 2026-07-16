import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runAutoFixCheck,
  type AutoFixCheckOptions,
} from "./autoFixRunner.js";
import { explicitDangerBroker } from "../../helpers/explicit-danger-boundary.js";

const TEST_CWD = process.cwd();

function runAutoFixCheckWithBoundary(options: AutoFixCheckOptions) {
  return runAutoFixCheck({
    ...options,
    sandboxExecutionBroker: explicitDangerBroker,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runAutoFixCheck", () => {
  test("fails closed before spawn when no sandbox boundary is supplied", async () => {
    await expect(
      runAutoFixCheck({
        lint: 'node -e "process.stdout.write(\"must-not-run\")"',
        timeout: 5_000,
        cwd: TEST_CWD,
      }),
    ).rejects.toMatchObject({ code: "sandbox_surface_uncovered" });
  });
  test("returns success when lint command exits 0", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "console.log(\\"all clean\\")"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(false);
    expect(result.lintOutput).toContain("all clean");
    expect(result.testOutput).toBeUndefined();
  });

  test("returns errors when lint command exits non-zero", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "console.log(\\"error: unused var\\"); process.exit(1)"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(true);
    expect(result.lintOutput).toContain("unused var");
    expect(result.lintExitCode).toBe(1);
  });

  test("returns errors when test command exits non-zero", async () => {
    const result = await runAutoFixCheckWithBoundary({
      test: 'node -e "console.log(\\"FAIL test_foo\\"); process.exit(1)"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(true);
    expect(result.testOutput).toContain("FAIL test_foo");
    expect(result.testExitCode).toBe(1);
  });

  test("runs both lint and test commands", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "console.log(\\"lint ok\\")"',
      test: 'node -e "console.log(\\"test ok\\")"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(false);
    expect(result.lintOutput).toContain("lint ok");
    expect(result.testOutput).toContain("test ok");
  });

  test("skips test if lint fails", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "console.log(\\"lint error\\"); process.exit(1)"',
      test: 'node -e "console.log(\\"should not run\\")"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(true);
    expect(result.lintOutput).toContain("lint error");
    expect(result.testOutput).toBeUndefined();
  });

  test("handles timeout gracefully", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "setTimeout(() => {}, 10000)"',
      timeout: 100,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(true);
    expect(result.timedOut).toBe(true);
  });

  test("resolves timeout even when command ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-auto-fix-"));
    const pidFile = join(dir, "pid");
    const started = Date.now();
    const script = [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    try {
      const result = await runAutoFixCheckWithBoundary({
        lint: `node -e '${script}'`,
        timeout: 100,
        cwd: TEST_CWD,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.hasErrors).toBe(true);
      expect(result.timedOut).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 400));
      const childPid = Number(readFileSync(pidFile, "utf8"));
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caps command output while reading", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint:
        "node -e 'process.stdout.write(\"x\".repeat(20000)); process.stderr.write(\"y\".repeat(20000))'",
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(false);
    expect(
      Buffer.byteLength(result.lintOutput ?? "", "utf8"),
    ).toBeLessThanOrEqual(10_000);
  });

  test("caps multibyte command output by utf8 bytes", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: "node -e 'process.stdout.write(\"雪\".repeat(5000))'",
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(false);
    expect(
      Buffer.byteLength(result.lintOutput ?? "", "utf8"),
    ).toBeLessThanOrEqual(10_000);
  });

  test("does not corrupt a multibyte char split across stdout chunks", async () => {
    // Regression: decoding each Buffer chunk independently emitted U+FFFD when a
    // multibyte UTF-8 sequence straddled two 'data' events. '✓' is E2 9C 93;
    // emit [E2 9C] then [93] as separate writes to force the split.
    const result = await runAutoFixCheckWithBoundary({
      lint:
        'node -e "process.stdout.write(Buffer.from([0xe2,0x9c])); setTimeout(() => process.stdout.write(Buffer.from([0x93])), 30)"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(false);
    expect(result.lintOutput).toContain("✓");
    expect(result.lintOutput).not.toContain("�");
  });

  test("aborts a running command promptly", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("test"), 50);
    const started = Date.now();
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "setTimeout(() => {}, 10000)"',
      timeout: 5_000,
      cwd: TEST_CWD,
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.hasErrors).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.lintOutput).toContain("Aborted");
  });

  test("returns success with no commands configured", async () => {
    const result = await runAutoFixCheckWithBoundary({
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(false);
  });

  test("returns success when already aborted before command start", async () => {
    const controller = new AbortController();
    controller.abort("test");
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "process.exit(1)"',
      timeout: 5_000,
      cwd: TEST_CWD,
      signal: controller.signal,
    });
    expect(result.hasErrors).toBe(false);
  });

  test("formats error summary for assistant consumption", async () => {
    const result = await runAutoFixCheckWithBoundary({
      lint: 'node -e "console.log(\\"src/foo.ts:10:5 error no-unused-vars\\"); process.exit(1)"',
      timeout: 5_000,
      cwd: TEST_CWD,
    });
    expect(result.hasErrors).toBe(true);
    expect(result.errorSummary).toContain("Lint errors");
    expect(result.errorSummary).toContain("no-unused-vars");
  });
});
