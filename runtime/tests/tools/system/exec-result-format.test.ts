import { describe, expect, test } from "vitest";

import {
  formatUnifiedExecToolContent,
  RESIDUAL_PROCESSES_NOTE,
  unifiedExecCodeModeResult,
} from "../../../src/tools/system/exec-result-format.js";
import type { ExecCommandToolOutput } from "../../../src/unified-exec/types.js";

function output(overrides: Partial<ExecCommandToolOutput>): ExecCommandToolOutput {
  return {
    output: "hello",
    stdout: "hello",
    stderr: "",
    exitCode: 0,
    exit_code: 0,
    durationMs: 12,
    wall_time_seconds: 0.012,
    timedOut: false,
    truncated: false,
    original_token_count: 1,
    ...overrides,
  };
}

describe("formatUnifiedExecToolContent", () => {
  test("a detached service still running shows its pid and log instead of a session id", () => {
    const content = formatUnifiedExecToolContent(
      output({
        exitCode: null,
        exit_code: null,
        detached: true,
        pid: 4242,
        log_path: "/srv/session/detached/service.log",
      }),
    );

    expect(content).toContain("running=true pid=4242");
    expect(content).toContain("detached=true log=/srv/session/detached/service.log");
    expect(content).not.toContain("yielded");
    expect(content).not.toContain("signal_terminated");
    expect(content).not.toContain("session_id");
  });

  test("a detached command that exited keeps its exit code and the detached marker", () => {
    const content = formatUnifiedExecToolContent(
      output({ exitCode: 3, exit_code: 3, detached: true, log_path: "/srv/session/detached/x.log" }),
    );

    expect(content).toContain("exit_code=3");
    expect(content).toContain("detached=true");
    expect(content).not.toContain("running=true");
  });

  test("the residue note is appended after the footer and points at detach", () => {
    const content = formatUnifiedExecToolContent(
      output({ residual_processes_terminated: true }),
    );

    const lines = content.split("\n");
    expect(lines.at(-2)).toMatch(/^\[exec exit_code=0 /);
    expect(lines.at(-1)).toBe(RESIDUAL_PROCESSES_NOTE);
    expect(RESIDUAL_PROCESSES_NOTE).toContain("detach: true");
  });

  test("an ordinary exit has neither marker", () => {
    const content = formatUnifiedExecToolContent(output({}));

    expect(content).not.toContain("detached");
    expect(content).not.toContain("[note:");
  });
});

describe("unifiedExecCodeModeResult", () => {
  test("mirrors the detached and residue fields", () => {
    expect(
      unifiedExecCodeModeResult(
        output({ exitCode: null, exit_code: null, detached: true, pid: 7, log_path: "/l.log" }),
      ),
    ).toMatchObject({ running: true, detached: true, pid: 7, log_path: "/l.log" });
    expect(
      unifiedExecCodeModeResult(output({ residual_processes_terminated: true })),
    ).toMatchObject({ exit_code: 0, residual_processes_terminated: true });
    expect(unifiedExecCodeModeResult(output({}))).not.toHaveProperty("detached");
  });
});
