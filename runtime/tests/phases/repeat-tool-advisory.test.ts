import { describe, expect, test } from "vitest";

import type { LLMToolCall } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import type { TurnState } from "../../src/session/turn-state.js";
import type { CompletedToolResultRecord } from "../../src/session/turn-state.js";
import {
  appendRepeatToolAdvisory,
  blockRepeatedFailingCall,
  identicalFailureRun,
  observeRepeatToolCalls,
  REPEAT_TOOL_THRESHOLDS,
  REPEATED_FAILURE_BLOCK_THRESHOLD,
  REPEATED_FAILURE_BLOCKED_METADATA_KEY,
  repeatedFailingCallStopExplanation,
  failureSignature,
} from "../../src/phases/repeat-tool-advisory.js";

function call(name: string, args: unknown, id = "c"): LLMToolCall {
  return {
    id,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

describe("observeRepeatToolCalls", () => {
  test("stays silent below the first threshold and fires exactly at it", () => {
    const session = {};
    const repeated = call("Bash", { command: "ls" });
    expect(observeRepeatToolCalls(session, [repeated])).toBeUndefined();
    expect(observeRepeatToolCalls(session, [repeated])).toBeUndefined();
    const advisory = observeRepeatToolCalls(session, [repeated]);
    expect(advisory).toContain('"Bash" 3 times in a row');
    expect(advisory).toContain("polling");
  });

  test("escalates at each configured threshold and then goes quiet", () => {
    const session = {};
    const repeated = call("Grep", { pattern: "x" });
    const fired: number[] = [];
    for (let count = 1; count <= 12; count += 1) {
      const advisory = observeRepeatToolCalls(session, [repeated]);
      if (advisory !== undefined) fired.push(count);
    }
    expect(fired).toEqual([...REPEAT_TOOL_THRESHOLDS]);
  });

  test("uses distinct escalation text per tier", () => {
    const session = {};
    const repeated = call("Read", { file_path: "/tmp/a" });
    const texts: string[] = [];
    for (let count = 1; count <= 8; count += 1) {
      const advisory = observeRepeatToolCalls(session, [repeated]);
      if (advisory !== undefined) texts.push(advisory);
    }
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("If that was intentional");
    expect(texts[1]).toContain("not going to change on its own");
    expect(texts[2]).toContain("Stop, state in one or two sentences");
  });

  test("a different call resets the run", () => {
    const session = {};
    const first = call("Bash", { command: "ls" });
    const other = call("Bash", { command: "pwd" });
    observeRepeatToolCalls(session, [first, first]);
    observeRepeatToolCalls(session, [other]);
    // Two more of the original stay below the threshold: the run restarted.
    expect(observeRepeatToolCalls(session, [first, first])).toBeUndefined();
    expect(observeRepeatToolCalls(session, [first])).not.toBeUndefined();
  });

  test("argument key order does not split a run", () => {
    const session = {};
    const ab = call("Edit", '{"a":1,"b":2}');
    const ba = call("Edit", '{"b":2,"a":1}');
    observeRepeatToolCalls(session, [ab]);
    observeRepeatToolCalls(session, [ba]);
    expect(observeRepeatToolCalls(session, [ab])).toContain("3 times");
  });

  test("byte-identical unparseable arguments still count as a run", () => {
    const session = {};
    const malformed = call("Bash", "{not json");
    observeRepeatToolCalls(session, [malformed]);
    observeRepeatToolCalls(session, [malformed]);
    expect(observeRepeatToolCalls(session, [malformed])).toContain("3 times");
  });

  test("transparent tools neither extend nor reset the run", () => {
    const session = {};
    const repeated = call("Bash", { command: "ls" });
    const transparent = call("TaskList", {});
    observeRepeatToolCalls(session, [repeated, transparent, repeated]);
    // TaskList in between did not reset: this is the third consecutive Bash.
    expect(observeRepeatToolCalls(session, [repeated])).toContain("3 times");
    // And an all-transparent run of its own never fires.
    const other = {};
    for (let i = 0; i < 10; i += 1) {
      expect(observeRepeatToolCalls(other, [transparent])).toBeUndefined();
    }
  });

  test("a burst crossing several thresholds produces one highest reminder", () => {
    const session = {};
    const repeated = call("Glob", { pattern: "*" });
    const batch = Array.from({ length: 9 }, () => repeated);
    const advisory = observeRepeatToolCalls(session, batch);
    expect(advisory).toContain("8 times");
    expect(advisory).toContain("Stop, state in one or two sentences");
  });

  test("runs are isolated per session", () => {
    const a = {};
    const b = {};
    const repeated = call("Bash", { command: "ls" });
    observeRepeatToolCalls(a, [repeated, repeated]);
    // Session b starts from zero even though a is one call from the threshold.
    expect(observeRepeatToolCalls(b, [repeated])).toBeUndefined();
    expect(observeRepeatToolCalls(a, [repeated])).toContain("3 times");
  });

  test("bounds the quoted argument preview", () => {
    const session = {};
    const huge = call("Write", { content: "x".repeat(2_000) });
    observeRepeatToolCalls(session, [huge, huge]);
    const advisory = observeRepeatToolCalls(session, [huge]);
    expect(advisory).toBeDefined();
    const quoted = advisory!.slice(advisory!.indexOf("arguments: ") + 11);
    const previewLine = quoted.split("\n", 1)[0]!;
    expect(previewLine.length).toBeLessThanOrEqual(502);
    expect(previewLine.endsWith("…")).toBe(true);
  });
});

describe("appendRepeatToolAdvisory", () => {
  function mkSessionStub(): {
    session: Session;
    warnings: Array<{ cause: string; message: string }>;
  } {
    const warnings: Array<{ cause: string; message: string }> = [];
    let i = 0;
    const session = {
      eventLog: {
        emit(event: {
          id: string;
          msg: { type: string; payload?: { cause: string; message: string } };
        }) {
          if (event.msg.type === "warning" && event.msg.payload) {
            warnings.push(event.msg.payload);
          }
          return event;
        },
      },
      nextInternalSubId: () => `sub-${(i += 1)}`,
    } as unknown as Session;
    return { session, warnings };
  }

  function mkStateStub(): TurnState {
    return {
      messages: [],
      toolResults: [],
    } as unknown as TurnState;
  }

  test("below the threshold it appends nothing at all", () => {
    const { session, warnings } = mkSessionStub();
    const state = mkStateStub();
    appendRepeatToolAdvisory(state, session, [call("Bash", { command: "ls" })]);
    expect(state.messages).toHaveLength(0);
    expect(state.toolResults).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test("at the threshold it appends one reminder through the user-context channel", () => {
    const { session, warnings } = mkSessionStub();
    const state = mkStateStub();
    const repeated = call("Bash", { command: "ls" });
    appendRepeatToolAdvisory(state, session, [repeated]);
    appendRepeatToolAdvisory(state, session, [repeated]);
    appendRepeatToolAdvisory(state, session, [repeated]);

    expect(state.messages).toHaveLength(1);
    const message = state.messages[0]! as {
      role: string;
      content: string;
      runtimeOnly?: {
        mergeBoundary?: string;
        excludeFromDurableHistory?: boolean;
      };
    };
    expect(message.role).toBe("user");
    expect(message.content).toContain("<system-reminder>");
    expect(message.content).toContain('"Bash" 3 times in a row');
    // Heuristic-driven synthetic context stays out of the durable rollout,
    // mirroring the continuation nudge (gaphunt3 #34).
    expect(message.runtimeOnly?.excludeFromDurableHistory).toBe(true);
    expect(message.runtimeOnly?.mergeBoundary).toBe("user_context");

    expect(state.toolResults).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.cause).toBe("repeat_tool_advisory");
  });
});

describe("blockRepeatedFailingCall", () => {
  const DENIAL =
    '{"error":"file_path is outside allowed directories: /root/memory/style.md"}';

  function mkSessionStub(): {
    session: Session;
    warnings: Array<{ cause: string; message: string }>;
  } {
    const warnings: Array<{ cause: string; message: string }> = [];
    let i = 0;
    const session = {
      eventLog: {
        emit(event: {
          id: string;
          msg: { type: string; payload?: { cause: string; message: string } };
        }) {
          if (event.msg.type === "warning" && event.msg.payload) {
            warnings.push(event.msg.payload);
          }
          return event;
        },
      },
      nextInternalSubId: () => `sub-${(i += 1)}`,
    } as unknown as Session;
    return { session, warnings };
  }

  function completed(
    toolCall: LLMToolCall,
    content: string,
    isError: boolean,
    metadata?: Record<string, unknown>,
  ): CompletedToolResultRecord {
    return {
      callId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      content,
      isError,
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  function mkState(records: readonly CompletedToolResultRecord[]): TurnState {
    return { completedToolResults: [...records] } as unknown as TurnState;
  }

  const write = call("Write", { file_path: "/root/memory/style.md", content: "x" });

  test("three identical failures block the fourth attempt with a plain message", () => {
    const { session, warnings } = mkSessionStub();
    const failures = Array.from({ length: REPEATED_FAILURE_BLOCK_THRESHOLD }, (_, i) =>
      completed(call(write.name, write.arguments, `w-${i}`), DENIAL, true),
    );
    const state = mkState(failures.slice(0, 2));
    // Two failures: the call may still run.
    expect(blockRepeatedFailingCall(state, session, write)).toBeNull();
    expect(warnings).toHaveLength(0);

    const blocked = blockRepeatedFailingCall(mkState(failures), session, write);
    expect(blocked).not.toBeNull();
    expect(blocked?.isError).toBe(true);
    expect(blocked?.preventContinuation).toBe(true);
    expect(blocked?.metadata).toMatchObject({
      [REPEATED_FAILURE_BLOCKED_METADATA_KEY]: true,
      repeatedFailures: 3,
    });
    expect(JSON.parse(blocked!.content).error).toBe(
      "This exact Write call already failed 3 times with the same error in this turn and will not run again. The error is not going to change; stop retrying, and if you cannot proceed without it, tell the user. Last error: " +
        DENIAL,
    );
    expect(warnings).toEqual([
      {
        cause: "repeated_failing_call_blocked",
        message:
          "Write refused: identical call failed 3 times with the same error in this turn",
      },
    ]);
  });

  // Live incident (session conv-mtjdmlfc, 2026-09-02): one `npm start` was
  // denied by the sandbox 21 times over 412 s and the guard never fired.
  // Two independent reasons, both reproduced here.
  describe("the live sandbox-denial loop", () => {
    const EPERM_BODY = (wallTime: string) =>
      "\n> start\n> node server.js\n\nError: listen EPERM: operation not permitted 0.0.0.0:8080\n" +
      `\n[exec exit_code=1 wall_time=${wallTime}s tokens=212]`;

    const npmStart = (overrides: Record<string, unknown> = {}) => ({
      cmd: "npm start",
      workdir: "/w/arcade15",
      timeoutMs: 15_000,
      yield_time_ms: 4_000,
      ...overrides,
    });

    test("a reworded justification and a nudged timeout do not split the failure run", () => {
      const { session } = mkSessionStub();
      const failures = [
        completed(
          call("exec_command", npmStart({ justification: "May I bind the port?" }), "e-0"),
          EPERM_BODY("0.2630"),
          true,
        ),
        completed(
          call("exec_command", npmStart({ justification: "Do you want to allow the server?", timeoutMs: 20_000 }), "e-1"),
          EPERM_BODY("0.2630"),
          true,
        ),
        completed(
          call("exec_command", npmStart({ prefix_rule: ["npm", "start"], yield_time_ms: 3_000 }), "e-2"),
          EPERM_BODY("0.2630"),
          true,
        ),
      ];
      const retry = call("exec_command", npmStart({ justification: "One more time?" }), "e-3");
      const blocked = blockRepeatedFailingCall(mkState(failures), session, retry);
      expect(blocked).not.toBeNull();
      expect(blocked?.metadata).toMatchObject({ repeatedFailures: 3 });
    });

    test("a volatile wall time in the result does not reset the failure run", () => {
      const { session } = mkSessionStub();
      // 13 of the incident's 14 bodies were distinct; only the wall time moved.
      const failures = ["0.2630", "0.1990", "0.3120"].map((wallTime, i) =>
        completed(call("exec_command", npmStart(), `e-${i}`), EPERM_BODY(wallTime), true),
      );
      const blocked = blockRepeatedFailingCall(
        mkState(failures),
        session,
        call("exec_command", npmStart(), "e-3"),
      );
      expect(blocked).not.toBeNull();
      expect(blocked?.metadata).toMatchObject({ repeatedFailures: 3 });
      // The model still sees the raw last error, wall time included.
      expect(JSON.parse(blocked!.content).error).toContain("wall_time=0.3120s");
    });

    test("a session id in the result does not reset the failure run", () => {
      const { session } = mkSessionStub();
      const failures = [10, 11, 12].map((sessionId, i) =>
        completed(
          call("exec_command", npmStart(), `e-${i}`),
          `blocked\n\n[exec exit_code=1 wall_time=0.1000s tokens=4 session_id=${sessionId}]`,
          true,
        ),
      );
      expect(
        blockRepeatedFailingCall(mkState(failures), session, call("exec_command", npmStart(), "e-3")),
      ).not.toBeNull();
    });

    test("a genuinely different error still resets the run", () => {
      const { session } = mkSessionStub();
      const failures = [
        completed(call("exec_command", npmStart(), "e-0"), EPERM_BODY("0.2630"), true),
        completed(call("exec_command", npmStart(), "e-1"), EPERM_BODY("0.1990"), true),
        completed(
          call("exec_command", npmStart(), "e-2"),
          "\nError: Cannot find module './server.js'\n\n[exec exit_code=1 wall_time=0.1120s tokens=9]",
          true,
        ),
      ];
      expect(
        blockRepeatedFailingCall(mkState(failures), session, call("exec_command", npmStart(), "e-3")),
      ).toBeNull();
    });

    test("a different command still starts its own count", () => {
      const { session } = mkSessionStub();
      const failures = Array.from({ length: 3 }, (_, i) =>
        completed(call("exec_command", npmStart(), `e-${i}`), EPERM_BODY("0.2630"), true),
      );
      expect(
        blockRepeatedFailingCall(
          mkState(failures),
          session,
          call("exec_command", npmStart({ cmd: "npm test" }), "e-3"),
        ),
      ).toBeNull();
    });

    test("failureSignature elides only the volatile runtime values", () => {
      expect(failureSignature(EPERM_BODY("0.2630"))).toBe(failureSignature(EPERM_BODY("9.9999")));
      expect(failureSignature(EPERM_BODY("0.2630"))).toContain("listen EPERM");
      expect(failureSignature(EPERM_BODY("0.2630"))).toContain("exit_code=1");
      expect(failureSignature(EPERM_BODY("0.2630"))).toContain("tokens=212");
    });
  });

  test("the refusal's turn stop is worded like the behavioral backstop", () => {
    const { session } = mkSessionStub();
    const failures = Array.from({ length: 5 }, (_, i) =>
      completed(call(write.name, write.arguments, `w-${i}`), DENIAL, true),
    );
    const blocked = blockRepeatedFailingCall(mkState(failures), session, write);
    expect(repeatedFailingCallStopExplanation(write, blocked!)).toBe(
      "Turn stopped by the no-progress backstop: the exact Write call failed 5 " +
        "times with the same error and was refused (count=5). No further progress " +
        "was being made. No task was completed.",
    );
    // Without the recorded count the threshold is the honest lower bound.
    expect(
      repeatedFailingCallStopExplanation(write, { content: "", isError: true }),
    ).toContain(`failed ${REPEATED_FAILURE_BLOCK_THRESHOLD} times`);
  });

  test("identical successes are never blocked", () => {
    const { session, warnings } = mkSessionStub();
    const read = call("FileRead", { file_path: "src/app.ts" });
    const state = mkState(
      Array.from({ length: 10 }, (_, i) =>
        completed(call(read.name, read.arguments, `r-${i}`), "1\tconst a = 1;", false),
      ),
    );
    expect(identicalFailureRun(state, read)).toEqual({ count: 0, lastError: "" });
    expect(blockRepeatedFailingCall(state, session, read)).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  test("a different argument starts its own count", () => {
    const { session } = mkSessionStub();
    const other = call("Write", { file_path: "/root/memory/other.md", content: "x" });
    const state = mkState([
      completed(call(write.name, write.arguments, "w-0"), DENIAL, true),
      completed(call(write.name, write.arguments, "w-1"), DENIAL, true),
      completed(call(write.name, write.arguments, "w-2"), DENIAL, true),
      completed(call(other.name, other.arguments, "o-0"), DENIAL, true),
    ]);
    expect(identicalFailureRun(state, write).count).toBe(3);
    expect(identicalFailureRun(state, other).count).toBe(1);
    expect(blockRepeatedFailingCall(state, session, other)).toBeNull();
  });

  test("a success or a different error for the same call resets the run", () => {
    const { session } = mkSessionStub();
    const afterSuccess = mkState([
      completed(call(write.name, write.arguments, "w-0"), DENIAL, true),
      completed(call(write.name, write.arguments, "w-1"), DENIAL, true),
      completed(call(write.name, write.arguments, "w-2"), "File created successfully", false),
      completed(call(write.name, write.arguments, "w-3"), DENIAL, true),
    ]);
    expect(identicalFailureRun(afterSuccess, write).count).toBe(1);
    expect(blockRepeatedFailingCall(afterSuccess, session, write)).toBeNull();

    const differentError = mkState([
      completed(call(write.name, write.arguments, "w-0"), DENIAL, true),
      completed(call(write.name, write.arguments, "w-1"), DENIAL, true),
      completed(call(write.name, write.arguments, "w-2"), '{"error":"disk full"}', true),
    ]);
    expect(identicalFailureRun(differentError, write)).toEqual({
      count: 1,
      lastError: '{"error":"disk full"}',
    });
    expect(blockRepeatedFailingCall(differentError, session, write)).toBeNull();
  });

  test("its own refusal never masks the original error", () => {
    const { session } = mkSessionStub();
    const failures = Array.from({ length: 3 }, (_, i) =>
      completed(call(write.name, write.arguments, `w-${i}`), DENIAL, true),
    );
    const state = mkState(failures);
    const blocked = blockRepeatedFailingCall(state, session, write)!;
    state.completedToolResults.push(
      completed(call(write.name, write.arguments, "w-3"), blocked.content, true, blocked.metadata),
    );
    // The fifth attempt is still refused with the original error quoted.
    const again = blockRepeatedFailingCall(state, session, write);
    expect(again).not.toBeNull();
    expect(JSON.parse(again!.content).error).toContain(DENIAL);
    expect(identicalFailureRun(state, write).count).toBe(3);
  });

  test("argument key order does not split the failure run", () => {
    const { session } = mkSessionStub();
    const ab = call("Edit", '{"a":1,"b":2}');
    const ba = call("Edit", '{"b":2,"a":1}');
    const state = mkState([
      completed(call(ab.name, ab.arguments, "e-0"), "String to replace not found", true),
      completed(call(ba.name, ba.arguments, "e-1"), "String to replace not found", true),
      completed(call(ab.name, ab.arguments, "e-2"), "String to replace not found", true),
    ]);
    expect(blockRepeatedFailingCall(state, session, ba)).not.toBeNull();
  });
});
