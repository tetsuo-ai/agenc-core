import { describe, expect, test } from "vitest";

import type { LLMToolCall } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import type { TurnState } from "../../src/session/turn-state.js";
import {
  appendRepeatToolAdvisory,
  observeRepeatToolCalls,
  REPEAT_TOOL_THRESHOLDS,
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
