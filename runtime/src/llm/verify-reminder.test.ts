import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import {
  VERIFY_REMINDER_EDIT_THRESHOLD,
  VERIFY_REMINDER_HEADER_PREFIX,
  VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS,
  buildVerifyReminderMessage,
  containsVerdictMarkerInToolResult,
  isMutatingTool,
  isVerifierSpawnFromRecord,
  messageContainsVerifyReminderPrefix,
  shouldInjectVerifyReminder,
} from "./verify-reminder.js";

describe("isMutatingTool", () => {
  it("identifies structured file-modification tools", () => {
    for (const name of [
      "system.writeFile",
      "system.editFile",
      "system.appendFile",
      "system.mkdir",
      "system.move",
      "system.delete",
    ]) {
      expect(isMutatingTool(name)).toBe(true);
    }
  });

  it("does NOT count read-only or shell tools", () => {
    for (const name of [
      "system.readFile",
      "system.listDir",
      "system.stat",
      "system.grep",
      "system.bash",
      "task.create",
      "task.update",
      "TodoWrite",
      "execute_with_agent",
    ]) {
      expect(isMutatingTool(name)).toBe(false);
    }
  });
});

describe("isVerifierSpawnFromRecord", () => {
  const args = (payload: Record<string, unknown>) => payload;

  it("returns true for execute_with_agent with non-empty verifierObligations", () => {
    expect(
      isVerifierSpawnFromRecord({
        name: "execute_with_agent",
        args: args({
          task: "verify",
          delegationAdmission: { verifierObligations: ["build passes"] },
        }),
      }),
    ).toBe(true);
  });

  it("returns false for execute_with_agent without verifierObligations", () => {
    expect(
      isVerifierSpawnFromRecord({
        name: "execute_with_agent",
        args: args({ task: "something" }),
      }),
    ).toBe(false);
  });

  it("returns false for execute_with_agent with empty verifierObligations array", () => {
    expect(
      isVerifierSpawnFromRecord({
        name: "execute_with_agent",
        args: args({ delegationAdmission: { verifierObligations: [] } }),
      }),
    ).toBe(false);
  });

  it("returns false for non execute_with_agent tools even with the field", () => {
    expect(
      isVerifierSpawnFromRecord({
        name: "task.create",
        args: args({
          delegationAdmission: { verifierObligations: ["x"] },
        }),
      }),
    ).toBe(false);
  });
});

describe("containsVerdictMarkerInToolResult", () => {
  it("matches VERDICT: PASS|FAIL|PARTIAL only in execute_with_agent results", () => {
    for (const verdict of ["VERDICT: PASS", "VERDICT: FAIL", "VERDICT: PARTIAL"]) {
      expect(
        containsVerdictMarkerInToolResult({
          name: "execute_with_agent",
          result: `some output\n${verdict}\n`,
        }),
      ).toBe(true);
    }
  });

  it("does NOT match VERDICT strings in unrelated tool results (scoping)", () => {
    for (const toolName of ["system.bash", "system.grep", "system.readFile"]) {
      expect(
        containsVerdictMarkerInToolResult({
          name: toolName,
          result: "here is some grep output containing VERDICT: PASS",
        }),
      ).toBe(false);
    }
  });

  it("returns false when execute_with_agent result has no marker", () => {
    expect(
      containsVerdictMarkerInToolResult({
        name: "execute_with_agent",
        result: "subagent completed; no verdict line",
      }),
    ).toBe(false);
  });
});

describe("messageContainsVerifyReminderPrefix", () => {
  it("matches the header prefix in string content", () => {
    const msg: LLMMessage = {
      role: "user",
      content: `<system-reminder>\n${VERIFY_REMINDER_HEADER_PREFIX} More text\n</system-reminder>`,
    };
    expect(messageContainsVerifyReminderPrefix(msg)).toBe(true);
  });

  it("matches the header prefix in content parts", () => {
    const msg: LLMMessage = {
      role: "user",
      content: [
        { type: "text", text: "before" },
        {
          type: "text",
          text: `<system-reminder>\n${VERIFY_REMINDER_HEADER_PREFIX} …\n</system-reminder>`,
        },
      ],
    };
    expect(messageContainsVerifyReminderPrefix(msg)).toBe(true);
  });

  it("returns false when the prefix is not present", () => {
    expect(
      messageContainsVerifyReminderPrefix({
        role: "user",
        content: "ordinary user message",
      }),
    ).toBe(false);
  });
});

describe("shouldInjectVerifyReminder", () => {
  const active = new Set<string>(["execute_with_agent"]);

  it("returns false when execute_with_agent is not advertised", () => {
    expect(
      shouldInjectVerifyReminder({
        activeToolNames: new Set<string>(),
        mutatingEditsSinceLastVerifierSpawn: 999,
        assistantTurnsSinceLastVerifyReminder: 999,
      }),
    ).toBe(false);
  });

  it("returns false when the edit counter is undefined (interactive surface)", () => {
    expect(
      shouldInjectVerifyReminder({
        activeToolNames: active,
        mutatingEditsSinceLastVerifierSpawn: undefined,
        assistantTurnsSinceLastVerifyReminder: 999,
      }),
    ).toBe(false);
  });

  it("returns false when edit counter is below the threshold", () => {
    expect(
      shouldInjectVerifyReminder({
        activeToolNames: active,
        mutatingEditsSinceLastVerifierSpawn: VERIFY_REMINDER_EDIT_THRESHOLD - 1,
        assistantTurnsSinceLastVerifyReminder: 999,
      }),
    ).toBe(false);
  });

  it("returns false when turn counter is below the between-reminders cadence", () => {
    expect(
      shouldInjectVerifyReminder({
        activeToolNames: active,
        mutatingEditsSinceLastVerifierSpawn: VERIFY_REMINDER_EDIT_THRESHOLD,
        assistantTurnsSinceLastVerifyReminder:
          VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS - 1,
      }),
    ).toBe(false);
  });

  it("returns true at exactly threshold edits and threshold turns", () => {
    expect(
      shouldInjectVerifyReminder({
        activeToolNames: active,
        mutatingEditsSinceLastVerifierSpawn: VERIFY_REMINDER_EDIT_THRESHOLD,
        assistantTurnsSinceLastVerifyReminder:
          VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS,
      }),
    ).toBe(true);
  });

  it("treats undefined turn counter as infinity (first-emission eligibility)", () => {
    expect(
      shouldInjectVerifyReminder({
        activeToolNames: active,
        mutatingEditsSinceLastVerifierSpawn: VERIFY_REMINDER_EDIT_THRESHOLD,
        assistantTurnsSinceLastVerifyReminder: undefined,
      }),
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
