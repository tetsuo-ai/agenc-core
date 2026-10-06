import { describe, expect, test } from "vitest";

import {
  compactExecExitFooter,
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

test("Light trims only routine successful exec footers", () => {
  expect(formatUnifiedExecToolContent(output({}), true)).toBe("hello\n\n[exec exit_code=0]");
  expect(formatUnifiedExecToolContent(output({}))).toBe("hello\n\n[exec exit_code=0 wall_time=0.0120s tokens=1]");
  for (const details of [
    { exitCode: 1 }, { truncated: true }, { timedOut: true },
    { process_id: 7 }, { session_id: 8 }, { detached: true },
    { residual_processes_terminated: true }, { exitCode: null },
  ]) {
    const value = output(details);
    const compact = formatUnifiedExecToolContent(value, true);
    expect(compact).toBe(formatUnifiedExecToolContent(value).replace(
      "tokens=1", `tokens=1${value.truncated ? " truncated=true" : ""}`,
    ));
    expect(unifiedExecCodeModeResult(value)).toHaveProperty("wall_time_seconds", 0.012);
  }
});

describe("compactExecExitFooter", () => {
  test.each([
    {}, { exitCode: 1 }, { exitCode: -1 }, { truncated: true },
    { timedOut: true }, { process_id: 7 }, { session_id: 8 },
    { detached: true, log_path: "/service.log" },
    { residual_processes_terminated: true },
  ])("aliases only the numeric exit label and preserves all other facts: %j", details => {
    const value = output(details);
    const before = structuredClone(value);
    const canonical = formatUnifiedExecToolContent(value, true);
    const structured = unifiedExecCodeModeResult(value);
    const compact = compactExecExitFooter(canonical);
    expect(compact).toBe(canonical.replace("[exec exit_code=", "[exit "));
    expect(compact.replace("[exit ", "[exec exit_code=")).toBe(canonical);
    expect(compactExecExitFooter(compact)).toBe(compact);
    expect(formatUnifiedExecToolContent(value, true)).toBe(canonical);
    expect(unifiedExecCodeModeResult(value)).toEqual(structured);
    expect(value).toEqual(before);
  });

  test.each([
    { exitCode: null, process_id: 7, timedOut: true },
    { exitCode: null, detached: true, pid: 7, log_path: "/service.log" },
    { exitCode: null, timedOut: true },
    { exitCode: null },
  ])("keeps running, timeout and signal-only results unchanged: %j", details => {
    const canonical = formatUnifiedExecToolContent(output(details), true);
    expect(compactExecExitFooter(canonical)).toBe(canonical);
  });

  test.each([
    "inline [exec exit_code=0]", "[exec exit_code=0]\nmore stdout",
    "[exec exit_code=no]", "[exec exit_code=1oops]", "[exec exit_code=0",
    "[exec exit_code=1]\n[sandbox denial: approval unavailable]",
    "[exec exit_code=0]\n[note: this command left processes running bogus]",
  ])("leaves unrecognized or nonterminal footers unchanged: %s", content => {
    expect(compactExecExitFooter(content)).toBe(content);
  });

  test("preserves footer-shaped stdout and the exact residual-process note", () => {
    const stdout = "[exec exit_code=99]\n\n[exit 123]\nAGENC_DATA";
    const canonical = formatUnifiedExecToolContent(output({
      output: stdout, residual_processes_terminated: true,
    }), true);
    expect(compactExecExitFooter(canonical)).toBe(
      `${stdout}\n\n[exit 0 wall_time=0.0120s tokens=1]\n${RESIDUAL_PROCESSES_NOTE}`,
    );
  });
});


test("authenticated residue is an observation and ordinary clean success remains compact", () => {
  const result = output({ residual_processes_observed: true });
  expect(formatUnifiedExecToolContent(result, true)).toContain("Cleanup is complete; those processes are no longer running.");
  expect(formatUnifiedExecToolContent(result, true)).not.toContain("AgenC stopped");
  expect(unifiedExecCodeModeResult(result)).toMatchObject({ exit_code: 0, residual_processes_observed: true });
  expect(unifiedExecCodeModeResult(result)).not.toHaveProperty("residual_processes_terminated");
  expect(formatUnifiedExecToolContent(output({}), true)).toBe("hello\n\n[exec exit_code=0]");
});

test.each(["aborted", "unavailable"] as const)("%s is neither normal exit nor running nor a false residual claim", command_outcome => {
  const result = output({ exitCode: null, exit_code: null, command_outcome });
  const text = formatUnifiedExecToolContent(result, true);
  expect(text).toContain(`command_outcome=${command_outcome} cleanup_complete=true`);
  expect(text).not.toMatch(/exit_code=|running=true|yielded=true|signal_terminated|left processes/);
  const structured = unifiedExecCodeModeResult(result);
  expect(structured).toMatchObject({ command_outcome, cleanup_complete: true });
  for (const key of ["exit_code", "running", "yielded", "signal_terminated", "residual_processes_terminated", "residual_processes_observed"]) {
    expect(structured).not.toHaveProperty(key);
  }
});
