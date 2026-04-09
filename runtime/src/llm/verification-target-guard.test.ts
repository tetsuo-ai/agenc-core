import { describe, it, expect } from "vitest";

import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  ANTI_FABRICATION_HARNESS_OVERWRITE_REASON,
  evaluateWriteOverFailedVerification,
  isFileWriteToolName,
  isShellToolName,
  isVerificationTargetPath,
  TEST_FILE_PATH_RE,
} from "./verification-target-guard.js";

function bashFailure(params: {
  command: string;
  stderr: string;
  exitCode?: number;
  args?: string[];
  cwd?: string;
}): ToolCallRecord {
  const resultPayload = {
    exitCode: params.exitCode ?? 1,
    stdout: "",
    stderr: params.stderr,
    timedOut: false,
    durationMs: 12,
    truncated: false,
  };
  return {
    name: "system.bash",
    args: {
      command: params.command,
      ...(params.args ? { args: params.args } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
    },
    result: JSON.stringify(resultPayload),
    isError: true,
    durationMs: resultPayload.durationMs,
  };
}

function bashSuccess(params: {
  command: string;
  stdout?: string;
  stderr?: string;
}): ToolCallRecord {
  const resultPayload = {
    exitCode: 0,
    stdout: params.stdout ?? "",
    stderr: params.stderr ?? "",
    timedOut: false,
    durationMs: 8,
    truncated: false,
  };
  return {
    name: "system.bash",
    args: { command: params.command },
    result: JSON.stringify(resultPayload),
    isError: false,
    durationMs: resultPayload.durationMs,
  };
}

describe("verification-target-guard classifiers", () => {
  describe("TEST_FILE_PATH_RE / isVerificationTargetPath", () => {
    it("matches plural and singular test directories", () => {
      expect(isVerificationTargetPath("tests/run_tests.sh")).toBe(true);
      expect(isVerificationTargetPath("project/test/helper.ts")).toBe(true);
      expect(isVerificationTargetPath("spec/api.rb")).toBe(true);
      expect(isVerificationTargetPath("app/specs/login.js")).toBe(true);
      expect(isVerificationTargetPath("src/__tests__/util.ts")).toBe(true);
    });

    it("matches *.test.* and *.spec.* suffixes", () => {
      expect(isVerificationTargetPath("src/util.test.ts")).toBe(true);
      expect(isVerificationTargetPath("src/util.spec.py")).toBe(true);
    });

    it("does not match unrelated paths", () => {
      expect(isVerificationTargetPath("src/main.rs")).toBe(false);
      expect(isVerificationTargetPath("README.md")).toBe(false);
      expect(isVerificationTargetPath("")).toBe(false);
    });

    it("backs isVerificationTargetPath via the exported regex", () => {
      expect(TEST_FILE_PATH_RE.test("tests/run_tests.sh")).toBe(true);
      expect(TEST_FILE_PATH_RE.test("src/index.ts")).toBe(false);
    });
  });

  describe("tool name classifiers", () => {
    it("recognizes file-write tools", () => {
      expect(isFileWriteToolName("system.writeFile")).toBe(true);
      expect(isFileWriteToolName("system.appendFile")).toBe(true);
      expect(isFileWriteToolName("desktop.text_editor")).toBe(true);
      expect(isFileWriteToolName("system.bash")).toBe(false);
      expect(isFileWriteToolName("system.readFile")).toBe(false);
    });

    it("recognizes shell tools", () => {
      expect(isShellToolName("system.bash")).toBe(true);
      expect(isShellToolName("desktop.bash")).toBe(true);
      expect(isShellToolName("system.writeFile")).toBe(false);
    });
  });
});

describe("evaluateWriteOverFailedVerification", () => {
  it("refuses writeFile over a harness the prior failing bash call referenced by basename (incident repro)", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command:
          "cd build && rm -rf * && cmake .. && make -j2 && ../tests/run_tests.sh",
        stderr:
          "../tests/run_tests.sh: line 5: cd: build: No such file or directory\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.writeFile",
      args: {
        path: "tests/run_tests.sh",
        content:
          '#!/bin/bash\necho "Phase 0: PASSED"\nexit 0\n',
      },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(true);
    expect(decision.reason).toBe(ANTI_FABRICATION_HARNESS_OVERWRITE_REASON);
    expect(decision.message).toMatch(/Refusing `system\.writeFile`/);
    expect(decision.message).toMatch(/run_tests\.sh/);
    expect(decision.message).toMatch(
      /manufacture a fake pass|stop and explain the discrepancy/,
    );
    expect(decision.evidence?.targetPath).toBe("tests/run_tests.sh");
    expect(decision.evidence?.matchedBasename).toBe("run_tests.sh");
    expect(decision.evidence?.failingToolName).toBe("system.bash");
    expect(decision.evidence?.failingInvocation).toMatch(/run_tests\.sh/);
    expect(decision.evidence?.failingExcerpt).toMatch(
      /no such file or directory/,
    );
  });

  it("refuses appendFile targeting a harness referenced in a prior failure", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command: "bash tests/smoke_suite.sh",
        stderr:
          "tests/smoke_suite.sh: line 12: ./bin/missing: No such file or directory\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.appendFile",
      args: { path: "tests/smoke_suite.sh", content: "exit 0\n" },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(true);
  });

  it("refuses desktop.text_editor targeting a spec file referenced in a prior failure", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command: "python -m pytest spec/api_spec.py",
        stderr: "spec/api_spec.py: error: assertion failed\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "desktop.text_editor",
      args: { path: "spec/api_spec.py", content: "pass\n" },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(true);
  });

  it("allows writes to a harness when no prior bash call failed", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashSuccess({
        command: "bash tests/run_tests.sh",
        stdout: "All tests passed\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.writeFile",
      args: {
        path: "tests/run_tests.sh",
        content: "#!/bin/bash\n# updated\n",
      },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(false);
  });

  it("allows writes to a harness when the failing bash did not reference that harness", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command: "npm run lint",
        stderr: "error: eslint found 2 problems in src/index.ts\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.writeFile",
      args: {
        path: "tests/new_test.ts",
        content: "import { test } from 'vitest';\n",
      },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(false);
  });

  it("allows writes to non-harness paths even after a failing bash call", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command: "bash tests/run_tests.sh",
        stderr: "tests/run_tests.sh: line 5: cd: build: No such file\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.writeFile",
      args: { path: "src/module.ts", content: "// real source fix\n" },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(false);
  });

  it("is a no-op for non-write tools", () => {
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.readFile",
      args: { path: "tests/run_tests.sh" },
      priorToolCalls: [
        bashFailure({
          command: "bash tests/run_tests.sh",
          stderr: "tests/run_tests.sh: failed\n",
        }),
      ],
    });
    expect(decision.refuse).toBe(false);
  });

  it("is a no-op when the write target is missing or not a string", () => {
    expect(
      evaluateWriteOverFailedVerification({
        toolName: "system.writeFile",
        args: { content: "…" },
        priorToolCalls: [],
      }).refuse,
    ).toBe(false);
    expect(
      evaluateWriteOverFailedVerification({
        toolName: "system.writeFile",
        args: { path: 42 as unknown as string, content: "…" },
        priorToolCalls: [],
      }).refuse,
    ).toBe(false);
  });

  it("scans all prior calls, not just the immediately preceding one", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command: "bash tests/run_tests.sh",
        stderr: "tests/run_tests.sh: line 5: cd: build: No such file\n",
      }),
      bashSuccess({ command: "ls -la tests" }),
      {
        name: "system.writeFile",
        args: { path: "src/unrelated.ts", content: "" },
        result: '{"path":"src/unrelated.ts","bytesWritten":0}',
        isError: false,
        durationMs: 1,
      },
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.writeFile",
      args: { path: "tests/run_tests.sh", content: "exit 0\n" },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(true);
  });

  it("case-insensitive basename match", () => {
    const priorToolCalls: ToolCallRecord[] = [
      bashFailure({
        command: "bash Tests/RunTests.SH",
        stderr: "Tests/RunTests.SH: error\n",
      }),
    ];
    const decision = evaluateWriteOverFailedVerification({
      toolName: "system.writeFile",
      args: { path: "Tests/RunTests.SH", content: "exit 0\n" },
      priorToolCalls,
    });
    expect(decision.refuse).toBe(true);
  });
});
