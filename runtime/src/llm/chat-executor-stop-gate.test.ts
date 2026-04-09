import { describe, it, expect } from "vitest";

import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  __TESTING__,
  evaluateTurnEndStopGate,
} from "./chat-executor-stop-gate.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function bashFailure(params: {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr: string;
}): ToolCallRecord {
  const result = JSON.stringify({
    exitCode: params.exitCode ?? 1,
    stdout: params.stdout ?? "",
    stderr: params.stderr,
    timedOut: false,
    durationMs: 50,
    truncated: false,
  });
  return {
    name: "system.bash",
    args: { command: params.command },
    result,
    isError: true,
    durationMs: 50,
  };
}

function bashSuccess(command: string, stdout = ""): ToolCallRecord {
  return {
    name: "system.bash",
    args: { command },
    result: JSON.stringify({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      durationMs: 50,
      truncated: false,
    }),
    isError: false,
    durationMs: 50,
  };
}

function antiFabRefusal(path: string): ToolCallRecord {
  return {
    name: "system.writeFile",
    args: { path, content: "echo PASSED; exit 0\n" },
    result:
      `Refusing \`system.writeFile\` on verification harness ` +
      `\`${path}\`: a prior \`system.bash\` call in this turn failed ` +
      `while referencing \`${path.split("/").pop()}\`. Overwriting the ` +
      `harness instead of fixing the real failure would manufacture a ` +
      `fake pass. (anti_fabrication_harness_overwrite)`,
    isError: true,
    durationMs: 0,
  };
}

function readFile(path: string): ToolCallRecord {
  return {
    name: "system.readFile",
    args: { path },
    result: JSON.stringify({ path, size: 100, encoding: "utf-8", content: "..." }),
    isError: false,
    durationMs: 1,
  };
}

// ---------------------------------------------------------------------------
// pass cases — gate must NOT fire
// ---------------------------------------------------------------------------

describe("evaluateTurnEndStopGate (pass cases)", () => {
  it("returns shouldIntervene=false when there is no final content", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent: "",
      allToolCalls: [bashFailure({ command: "make", stderr: "boom" })],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("returns shouldIntervene=false on a normal text response with no success claim", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Here's the structure of the file. Each line corresponds to a token.",
      allToolCalls: [readFile("/tmp/foo.txt")],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("returns shouldIntervene=false on a success claim with no failed tool calls and no refusals", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap complete. The build succeeded and the test " +
        "suite passed. Binary is ready at /home/tetsuo/build/agenc-shell.",
      allToolCalls: [
        bashSuccess("cmake .. && make", "build success"),
        bashSuccess("./tests/run_tests.sh", "all passed"),
      ],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("returns shouldIntervene=false on an HONEST partial-success report (acknowledges failures)", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap is partially complete. The build succeeded for " +
        "the lexer module, but the parser test FAILED with a syntax error " +
        "on line 12. Unfortunately I could not get the integration tests " +
        "to pass. Here's what I tried...",
      allToolCalls: [
        bashSuccess("cmake .. && make lexer"),
        bashFailure({ command: "make parser", stderr: "syntax error line 12" }),
      ],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("returns shouldIntervene=false when failed tool calls are not shell-like (e.g. failed readFile)", () => {
    // The detector excludes non-shell tool failures because they're often
    // legitimate "checked, doesn't exist" patterns that aren't bugs. The
    // text is intentionally long enough to bypass the truncated-success
    // detector — we're testing the shell-only filter on detector 3.
    const failedRead: ToolCallRecord = {
      name: "system.readFile",
      args: { path: "/missing.txt" },
      result: JSON.stringify({ error: "ENOENT" }),
      isError: true,
      durationMs: 1,
    };
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "I checked /missing.txt with system.readFile and it doesn't exist " +
        "on disk; that's expected because no prior step created it. Since " +
        "the file is genuinely absent rather than missing due to an " +
        "error, the build does not need it. Phase 0 bootstrap complete.",
      allToolCalls: [failedRead],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("returns shouldIntervene=false on a long detailed success message even if final length > threshold", () => {
    const longMessage =
      "Phase 0 bootstrap complete. " + "All tests passed. ".repeat(20);
    const decision = evaluateTurnEndStopGate({
      finalContent: longMessage,
      allToolCalls: [bashSuccess("cmake .."), bashSuccess("make")],
    });
    expect(decision.shouldIntervene).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detector 1: anti-fab refusal + success claim
// ---------------------------------------------------------------------------

describe("evaluateTurnEndStopGate — false_success_after_anti_fab_refusal", () => {
  it("fires when an anti-fab refusal is in the ledger and the final text claims success", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent: "Phase 0 bootstrap complete. All tests pass.",
      allToolCalls: [
        bashFailure({
          command: "bash tests/run_tests.sh",
          stderr: "tests/run_tests.sh: line 5: cd: build: No such file",
        }),
        antiFabRefusal("tests/run_tests.sh"),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("false_success_after_anti_fab_refusal");
    expect(decision.blockingMessage).toMatch(/anti-fabrication gate REFUSED/);
    expect(decision.blockingMessage).toMatch(/Runtime-refused tool calls/);
    expect(decision.evidence.refusedToolCallCount).toBe(1);
  });

  it("does NOT fire if the model honestly acknowledges the refusal", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap complete, but the runtime refused my attempt " +
        "to overwrite the failing test script. I could not get past the " +
        "test failure. The underlying issue is that the build directory " +
        "doesn't exist when the script tries to cd into it.",
      allToolCalls: [
        bashFailure({ command: "bash tests/run_tests.sh", stderr: "no such file" }),
        antiFabRefusal("tests/run_tests.sh"),
      ],
    });
    expect(decision.shouldIntervene).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detector 2: truncated success claim — the exact 2026-04-09 incident
// ---------------------------------------------------------------------------

describe("evaluateTurnEndStopGate — truncated_success_claim", () => {
  it("fires on the exact 14-token truncation pattern from the live trace", () => {
    // From the actual 2026-04-09 trace artifact: Grok emitted exactly
    // these characters as the final message of a 35-tool-call turn with
    // 10 cmake failures.
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "**Phase 0 bootstrap complete. Build succeeded, binary exists at `",
      allToolCalls: [
        bashFailure({
          command: "cd build && cmake ..",
          stderr:
            "Package 'readline', required by 'virtual:world', not found\n" +
            "-- Configuring incomplete, errors occurred!",
        }),
        bashSuccess("ls /home/tetsuo/git/stream-test/agenc-shell"),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("truncated_success_claim");
    expect(decision.blockingMessage).toMatch(/suspiciously short and looks truncated/);
    expect(decision.evidence.finalContentLength).toBeLessThan(
      __TESTING__.TRUNCATED_SUCCESS_MAX_CHARS,
    );
  });

  it("fires on a short success claim with at least one tool call", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent: "Phase 0 complete. Binary built at /tmp/foo.",
      allToolCalls: [bashSuccess("ls -la")],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("truncated_success_claim");
  });

  it("does NOT fire on a short success claim when no tool calls happened (greeting / chat)", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent: "Phase 0 complete!",
      allToolCalls: [],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("does NOT fire on a short message with no success claim", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent: "I read the file. It contains 100 lines.",
      allToolCalls: [readFile("/tmp/foo.txt")],
    });
    expect(decision.shouldIntervene).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detector 3: failed bash + success claim
// ---------------------------------------------------------------------------

describe("evaluateTurnEndStopGate — false_success_after_failed_bash", () => {
  it("fires when bash failed and the final text claims success", () => {
    const longSuccessMessage =
      "Phase 0 bootstrap complete. The build succeeded for all source " +
      "files. The binary is ready at build/agenc-shell. All tests pass " +
      "with strict assertions. Lexer, parser, and executor are all " +
      "implemented per PLAN.md. Ready for Phase 1.";
    const decision = evaluateTurnEndStopGate({
      finalContent: longSuccessMessage,
      allToolCalls: [
        bashFailure({
          command: "cmake .. && make",
          stderr: "CMake Error: Could not find package readline",
        }),
        bashFailure({
          command: "make -j2",
          stderr: "ninja: build stopped: subcommand failed",
        }),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("false_success_after_failed_bash");
    expect(decision.evidence.failedShellCallCount).toBe(2);
    expect(decision.blockingMessage).toMatch(/Failing shell commands/);
    expect(decision.blockingMessage).toMatch(/cmake/);
  });

  it("fires on 'all tests pass' phrasing", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "I have completed the task. All tests pass and the build is " +
        "ready. The implementation follows the spec exactly. " +
        "Documentation has been updated. Ready for review.",
      allToolCalls: [
        bashFailure({
          command: "npm test",
          stderr: "Test Suites: 3 failed, 5 passed, 8 total",
        }),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("false_success_after_failed_bash");
  });

  it("fires on 'binary exists' phrasing", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "The build is now successful. Binary exists at /tmp/foo. " +
        "I verified the build with `ls /tmp/foo` and confirmed the " +
        "binary is in place. Everything looks good.",
      allToolCalls: [
        bashFailure({
          command: "make",
          stderr: "fatal error: missing-header.h: No such file",
        }),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("false_success_after_failed_bash");
  });

  it("does NOT fire when the model honestly acknowledges the failure", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "I attempted the build but it failed because the system is " +
        "missing libreadline-dev. I could not complete Phase 0. The " +
        "fix is to install libreadline-dev.",
      allToolCalls: [
        bashFailure({
          command: "cmake ..",
          stderr: "Package 'readline' not found",
        }),
      ],
    });
    expect(decision.shouldIntervene).toBe(false);
  });

  it("does NOT fire when failures are present but the model is reporting them, not claiming success", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Here's what I found: the build script has 3 errors. The first " +
        "is a missing semicolon on line 42. The second is an undefined " +
        "function. The third is a circular include. None of these are " +
        "simple to fix without more context.",
      allToolCalls: [
        bashFailure({ command: "make", stderr: "syntax error" }),
      ],
    });
    expect(decision.shouldIntervene).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detector priority (multiple detectors could match — first wins)
// ---------------------------------------------------------------------------

describe("evaluateTurnEndStopGate — detector priority", () => {
  it("anti-fab refusal beats failed-bash when both are present", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap complete. The build succeeded for all source " +
        "files. The binary is ready at build/agenc-shell. All tests pass " +
        "with strict assertions. Lexer, parser, and executor are all " +
        "implemented per PLAN.md. Ready for Phase 1.",
      allToolCalls: [
        bashFailure({ command: "make", stderr: "boom" }),
        antiFabRefusal("tests/run_tests.sh"),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("false_success_after_anti_fab_refusal");
  });

  it("truncated success beats failed-bash when both are present", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent: "Phase 0 complete. Binary built.",
      allToolCalls: [
        bashFailure({ command: "make", stderr: "boom" }),
      ],
    });
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason).toBe("truncated_success_claim");
  });
});

// ---------------------------------------------------------------------------
// blocking message structure
// ---------------------------------------------------------------------------

describe("evaluateTurnEndStopGate — blocking message contents", () => {
  it("includes 'ONE recovery turn' instruction", () => {
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap complete. The build succeeded for all source " +
        "files. The binary is ready at build/agenc-shell. All tests pass " +
        "with strict assertions. Lexer, parser, and executor are all " +
        "implemented per PLAN.md.",
      allToolCalls: [
        bashFailure({ command: "make", stderr: "boom" }),
      ],
    });
    expect(decision.blockingMessage).toMatch(/ONE recovery turn/);
    expect(decision.blockingMessage).toMatch(/\(a\) Make tool calls/);
    expect(decision.blockingMessage).toMatch(/\(b\) Retract the success claim/);
    expect(decision.blockingMessage).toMatch(/Do NOT repeat the success claim/);
  });

  it("evidence carries failure excerpts truncated to 200 chars", () => {
    const longErr = "x".repeat(500);
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap complete. The build succeeded for all source " +
        "files. The binary is ready at build/agenc-shell. All tests pass " +
        "with strict assertions.",
      allToolCalls: [bashFailure({ command: "make", stderr: longErr })],
    });
    expect(decision.evidence.failureExcerpts).toHaveLength(1);
    expect(decision.evidence.failureExcerpts[0]?.length).toBeLessThanOrEqual(
      210,
    );
  });

  it("evidence caps shown failures at 3 even when many are present", () => {
    const calls: ToolCallRecord[] = [];
    for (let i = 0; i < 10; i++) {
      calls.push(
        bashFailure({ command: `make target_${i}`, stderr: `err ${i}` }),
      );
    }
    const decision = evaluateTurnEndStopGate({
      finalContent:
        "Phase 0 bootstrap complete. The build succeeded for all source " +
        "files. The binary is ready at build/agenc-shell. All tests pass " +
        "with strict assertions.",
      allToolCalls: calls,
    });
    expect(decision.evidence.failedShellCallCount).toBe(10);
    expect(decision.evidence.failureExcerpts).toHaveLength(3);
    // The blocking message lists at most 3 commands, not 10.
    const matchCount = (
      decision.blockingMessage?.match(/make target_/g) ?? []
    ).length;
    expect(matchCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// regex unit tests
// ---------------------------------------------------------------------------

describe("FALSE_SUCCESS_RE", () => {
  const re = __TESTING__.FALSE_SUCCESS_RE;

  for (const phrase of [
    "Build succeeded",
    "the build is successful",
    "Phase 0 complete",
    "Phase 5 done",
    "Phase 11 implemented",
    "All tests pass",
    "all tests passed",
    "Tests passed",
    "binary exists",
    "binary is ready",
    "binary built",
    "All phases complete",
    "task complete",
    "implementation complete",
    "successfully built",
    "successfully implemented",
    "v11.0 complete",
    "ready to ship",
    "Done with phase 1",
  ]) {
    it(`matches: "${phrase}"`, () => {
      expect(re.test(phrase)).toBe(true);
    });
  }
});

describe("FAILURE_ACKNOWLEDGMENT_RE", () => {
  const re = __TESTING__.FAILURE_ACKNOWLEDGMENT_RE;

  for (const phrase of [
    "but failed",
    "however the build failed",
    "did not work",
    "couldn't compile",
    "cannot continue",
    "partially complete",
    "except for the parser test",
    "unfortunately the test failed",
    "encountered errors",
    "errors occurred during compile",
    "missing dependency",
    "missing library libreadline",
    "incomplete",
  ]) {
    it(`matches: "${phrase}"`, () => {
      expect(re.test(phrase)).toBe(true);
    });
  }
});
