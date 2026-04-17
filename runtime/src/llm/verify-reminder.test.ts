import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import {
  VERIFY_REMINDER_EDIT_THRESHOLD,
  VERIFY_REMINDER_HEADER_PREFIX,
  VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS,
  buildVerifyReminderMessage,
  getMutatingEditsSinceLastVerifierSpawn,
  getTurnsSinceLastVerifyReminder,
  shouldInjectVerifyReminder,
} from "./verify-reminder.js";

function userText(content: string): LLMMessage {
  return { role: "user", content };
}

function assistantText(content: string): LLMMessage {
  return { role: "assistant", content };
}

function toolResult(content: string, toolCallId = "call-1"): LLMMessage {
  return { role: "tool", content, toolCallId };
}

function assistantMutation(toolName: string): LLMMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call-${toolName}-${Math.random()}`,
        name: toolName,
        arguments: "{}",
      },
    ],
  };
}

function assistantVerifierSpawn(
  obligations: readonly string[] = ["build passes"],
): LLMMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-ewa",
        name: "execute_with_agent",
        arguments: JSON.stringify({
          task: "verify the implementation",
          delegationAdmission: { verifierObligations: obligations },
        }),
      },
    ],
  };
}

describe("getMutatingEditsSinceLastVerifierSpawn", () => {
  it("returns 0 for empty history", () => {
    expect(getMutatingEditsSinceLastVerifierSpawn([])).toBe(0);
  });

  it("counts writeFile/editFile/appendFile/mkdir/move/delete", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.editFile"),
      assistantMutation("system.appendFile"),
      assistantMutation("system.mkdir"),
      assistantMutation("system.move"),
      assistantMutation("system.delete"),
    ];
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(6);
  });

  it("does NOT count task.*, readFile, listDir, bash, or non-mutating tools", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.readFile"),
      assistantMutation("system.listDir"),
      assistantMutation("system.bash"),
      assistantMutation("task.create"),
      assistantMutation("task.update"),
      assistantMutation("TodoWrite"),
    ];
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(0);
  });

  it("stops counting at the most recent execute_with_agent spawn with verifierObligations", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.editFile"),
      assistantVerifierSpawn(["build passes"]),
      assistantMutation("system.writeFile"),
    ];
    // Only the write after the spawn is counted.
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(1);
  });

  it("ignores execute_with_agent calls without verifierObligations", () => {
    const bareSpawn: LLMMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-ewa-bare",
          name: "execute_with_agent",
          arguments: JSON.stringify({ task: "do a thing" }),
        },
      ],
    };
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      bareSpawn,
      assistantMutation("system.writeFile"),
    ];
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(2);
  });

  it("stops counting at a tool-role message containing VERDICT: PASS", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.editFile"),
      toolResult("some output...\n\nVERDICT: PASS\n"),
      assistantMutation("system.writeFile"),
    ];
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(1);
  });

  it("recognizes FAIL and PARTIAL verdict markers too", () => {
    for (const verdict of ["VERDICT: FAIL", "VERDICT: PARTIAL"]) {
      const history: LLMMessage[] = [
        assistantMutation("system.writeFile"),
        toolResult(`output\n${verdict}\n`),
        assistantMutation("system.editFile"),
      ];
      expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(1);
    }
  });

  it("does NOT treat VERDICT text in assistant messages as a terminator", () => {
    // Gaming-resistance: only role === "tool" messages reset the counter.
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.editFile"),
      assistantText("I've done the work. VERDICT: PASS"),
      assistantMutation("system.writeFile"),
    ];
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(3);
  });

  it("does NOT treat VERDICT text in user messages as a terminator", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      userText("user wrote: VERDICT: PASS"),
      assistantMutation("system.editFile"),
    ];
    expect(getMutatingEditsSinceLastVerifierSpawn(history)).toBe(2);
  });
});

describe("getTurnsSinceLastVerifyReminder", () => {
  it("returns Infinity when no reminder has been injected", () => {
    expect(
      getTurnsSinceLastVerifyReminder([
        userText("u1"),
        assistantText("a1"),
      ]),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("detects a prior reminder via the header prefix", () => {
    const reminder: LLMMessage = {
      role: "user",
      content: `<system-reminder>\n${VERIFY_REMINDER_HEADER_PREFIX} ...\n</system-reminder>`,
    };
    const history: LLMMessage[] = [
      userText("other"),
      reminder,
      assistantText("a"),
      assistantText("b"),
    ];
    expect(getTurnsSinceLastVerifyReminder(history)).toBe(2);
  });
});

describe("shouldInjectVerifyReminder", () => {
  const activeTools = new Set<string>(["execute_with_agent"]);

  it("returns false when execute_with_agent is not in the toolset", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.writeFile"),
      assistantMutation("system.writeFile"),
    ];
    expect(
      shouldInjectVerifyReminder({
        history,
        activeToolNames: new Set<string>(),
      }),
    ).toBe(false);
  });

  it("returns false when under the edit threshold", () => {
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.writeFile"),
    ];
    expect(
      shouldInjectVerifyReminder({ history, activeToolNames: activeTools }),
    ).toBe(false);
  });

  it("returns true at exactly the edit threshold with no recent reminder", () => {
    const history: LLMMessage[] = Array.from(
      { length: VERIFY_REMINDER_EDIT_THRESHOLD },
      () => assistantMutation("system.writeFile"),
    );
    expect(
      shouldInjectVerifyReminder({ history, activeToolNames: activeTools }),
    ).toBe(true);
  });

  it("suppresses when a reminder was injected within the last 10 turns", () => {
    const reminder: LLMMessage = {
      role: "user",
      content: `<system-reminder>\n${VERIFY_REMINDER_HEADER_PREFIX}\n</system-reminder>`,
    };
    const history: LLMMessage[] = [
      assistantMutation("system.writeFile"),
      assistantMutation("system.editFile"),
      assistantMutation("system.writeFile"),
      reminder,
      ...Array.from(
        { length: VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS - 1 },
        (_, i) => assistantText(`x${i}`),
      ),
    ];
    expect(
      shouldInjectVerifyReminder({ history, activeToolNames: activeTools }),
    ).toBe(false);
  });

  it("resumes firing once the last reminder is past the 10-turn window", () => {
    const reminder: LLMMessage = {
      role: "user",
      content: `<system-reminder>\n${VERIFY_REMINDER_HEADER_PREFIX}\n</system-reminder>`,
    };
    const history: LLMMessage[] = [
      reminder,
      ...Array.from(
        { length: VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS + 1 },
        (_, i) => assistantText(`x${i}`),
      ),
      assistantMutation("system.writeFile"),
      assistantMutation("system.editFile"),
      assistantMutation("system.writeFile"),
    ];
    expect(
      shouldInjectVerifyReminder({ history, activeToolNames: activeTools }),
    ).toBe(true);
  });
});

describe("buildVerifyReminderMessage", () => {
  it("wraps the header in system-reminder tags", () => {
    const msg = buildVerifyReminderMessage();
    const content = msg.content as string;
    expect(content.startsWith("<system-reminder>\n")).toBe(true);
    expect(content.endsWith("\n</system-reminder>")).toBe(true);
    expect(content).toContain(VERIFY_REMINDER_HEADER_PREFIX);
  });

  it("includes the contract wording and cannot-self-assign-PARTIAL clause", () => {
    const msg = buildVerifyReminderMessage();
    const content = msg.content as string;
    expect(content).toContain("execute_with_agent");
    expect(content).toContain("delegationAdmission.verifierObligations");
    expect(content).toContain("cannot self-assign");
    expect(content).toContain("PARTIAL");
  });

  it("emits user role with runtime-only user_context merge boundary and anchorPreserve", () => {
    const msg = buildVerifyReminderMessage();
    expect(msg.role).toBe("user");
    expect(msg.runtimeOnly?.mergeBoundary).toBe("user_context");
    expect(msg.runtimeOnly?.anchorPreserve).toBe(true);
  });
});
