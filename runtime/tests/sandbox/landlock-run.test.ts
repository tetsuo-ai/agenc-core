import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import {
  classifyLandlockRunOutcome,
  landlockGrantArgs,
  LANDLOCK_RUN_FAILURE_EXIT,
  LANDLOCK_RUN_PARTIAL_NOTICE,
  probeLandlock,
  resolveLandlockRun,
} from "../../src/sandbox/landlock-run.js";

function hasTrustedCompiler(): boolean {
  return ["/usr/bin/cc", "/bin/cc"].some((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const canRunLive =
  process.platform === "linux" &&
  hasTrustedCompiler() &&
  probeLandlock() !== "unusable";

const work: string[] = [];
afterAll(() => {
  for (const dir of work) rmSync(dir, { recursive: true, force: true });
});

function mkWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "landlock-test-"));
  work.push(dir);
  return dir;
}

function runConfined(
  grants: Parameters<typeof landlockGrantArgs>[0],
  command: readonly string[],
) {
  const launcher = resolveLandlockRun();
  expect(launcher).toBeDefined();
  return spawnSync(
    launcher!,
    [...landlockGrantArgs(grants), "--", ...command],
    { encoding: "utf8", timeout: 15_000 },
  );
}

describe("landlockGrantArgs", () => {
  test("serializes grants in declaration order", () => {
    expect(
      landlockGrantArgs({ readOnly: ["/usr", "/lib"], readWrite: ["/tmp"] }),
    ).toEqual(["--ro", "/usr", "--ro", "/lib", "--rw", "/tmp"]);
    expect(landlockGrantArgs({})).toEqual([]);
  });
});

describe("classifyLandlockRunOutcome", () => {
  test("launcher failure requires status 125 AND a fatal line", () => {
    expect(
      classifyLandlockRunOutcome({
        status: LANDLOCK_RUN_FAILURE_EXIT,
        stderr: "landlock-run: cannot open rule path: /x: No such file or directory\n",
      }),
    ).toMatchObject({ kind: "launcher-failure" });
  });

  test("a child's own 125 without fatal evidence stays the command's outcome", () => {
    expect(
      classifyLandlockRunOutcome({ status: 125, stderr: "" }),
    ).toEqual({ kind: "command-outcome" });
  });

  test("the exact partial notice is informational, never fatal evidence", () => {
    // Upstream postmortem 0004: this notice plus ripgrep's no-match exit 1
    // was misread as sandbox failure. Status-gating alone is not enough --
    // the notice must also be excluded when a child exits 125 on its own.
    expect(
      classifyLandlockRunOutcome({
        status: 1,
        stderr: `${LANDLOCK_RUN_PARTIAL_NOTICE}\n`,
      }),
    ).toEqual({ kind: "command-outcome" });
    expect(
      classifyLandlockRunOutcome({
        status: 125,
        stderr: `${LANDLOCK_RUN_PARTIAL_NOTICE}\n`,
      }),
    ).toEqual({ kind: "command-outcome" });
  });

  test("notice plus a real fatal line is still launcher failure", () => {
    const outcome = classifyLandlockRunOutcome({
      status: 125,
      stderr:
        `${LANDLOCK_RUN_PARTIAL_NOTICE}\n` +
        "landlock-run: exec failed: No such file or directory\n",
    });
    expect(outcome).toMatchObject({
      kind: "launcher-failure",
      fatalLine: "landlock-run: exec failed: No such file or directory",
    });
  });

  test("non-125 statuses are never launcher failures", () => {
    for (const status of [0, 1, 2, 126, 127, null]) {
      expect(
        classifyLandlockRunOutcome({
          status,
          stderr: "landlock-run: fatal-looking line\n",
        }),
      ).toEqual({ kind: "command-outcome" });
    }
  });
});

describe.runIf(canRunLive)("agenc-landlock-run (live kernel)", () => {
  test("probe reports enforcement on this kernel", () => {
    expect(["full", "partial"]).toContain(probeLandlock());
  });

  test("read is denied outside grants and allowed inside them", () => {
    const denied = runConfined(
      { readOnly: ["/usr", "/lib", "/lib64"] },
      ["/usr/bin/cat", "/etc/hostname"],
    );
    expect(denied.status).not.toBe(0);
    expect(denied.status).not.toBe(LANDLOCK_RUN_FAILURE_EXIT);
    expect(
      classifyLandlockRunOutcome({ status: denied.status, stderr: denied.stderr }),
    ).toEqual({ kind: "command-outcome" });

    const allowed = runConfined(
      { readOnly: ["/usr", "/lib", "/lib64", "/etc"] },
      ["/usr/bin/cat", "/etc/hostname"],
    );
    expect(allowed.status).toBe(0);
    expect(allowed.stdout.length).toBeGreaterThan(0);
  });

  test("write is denied under --ro and allowed under --rw", () => {
    const dir = mkWorkDir();
    const target = join(dir, "probe.txt");
    const denied = runConfined({ readOnly: ["/"] }, [
      "/bin/sh",
      "-c",
      `echo confined > ${target}`,
    ]);
    expect(denied.status).not.toBe(0);
    expect(denied.status).not.toBe(LANDLOCK_RUN_FAILURE_EXIT);

    const allowed = runConfined({ readOnly: ["/"], readWrite: [dir] }, [
      "/bin/sh",
      "-c",
      `echo confined > ${target}`,
    ]);
    expect(allowed.status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("confined\n");
  });

  test("the ruleset is inherited by descendants", () => {
    const dir = mkWorkDir();
    const target = join(dir, "descendant.txt");
    // The child spawns a grandchild; the grandchild must be equally confined.
    const denied = runConfined({ readOnly: ["/"] }, [
      "/bin/sh",
      "-c",
      `/bin/sh -c 'echo escaped > ${target}'`,
    ]);
    expect(denied.status).not.toBe(0);
  });

  test("child exit codes pass through unchanged", () => {
    const seven = runConfined({ readOnly: ["/"] }, ["/bin/sh", "-c", "exit 7"]);
    expect(seven.status).toBe(7);
    const one = runConfined({ readOnly: ["/"] }, ["/bin/false"]);
    expect(one.status).toBe(1);
    expect(one.stderr).not.toContain("landlock-run:");
  });

  test("an unopenable grant root fails closed as a launcher failure", () => {
    const run = runConfined(
      { readOnly: ["/definitely-not-a-real-path-xyz"] },
      ["/bin/true"],
    );
    expect(run.status).toBe(LANDLOCK_RUN_FAILURE_EXIT);
    expect(
      classifyLandlockRunOutcome({ status: run.status, stderr: run.stderr }),
    ).toMatchObject({ kind: "launcher-failure" });
  });
});
