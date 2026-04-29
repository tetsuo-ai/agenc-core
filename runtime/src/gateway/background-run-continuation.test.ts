import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../llm/types.js";
import {
  MAX_CONSECUTIVE_NUDGE_CYCLES,
  TASK_REMINDER_CYCLES_SINCE_WRITE,
  buildTaskStalenessReminder,
  buildZeroToolBlockingMessage,
  evaluateCycleContinuationInjections,
  type OpenTaskSummary,
} from "./background-run-continuation.js";

const RUNTIME_PREFIX = "[runtime] ";

function sampleOpenTasks(
  count: number,
  subjectPrefix = "task",
): readonly OpenTaskSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${index + 1}`,
    status: index % 2 === 0 ? "pending" : "in_progress",
    subject: `${subjectPrefix} ${index + 1}`,
  }));
}

describe("buildZeroToolBlockingMessage", () => {
  it("emits a plain user-turn message with the [runtime] prefix and no extra metadata", () => {
    const message = buildZeroToolBlockingMessage({
      cycleCount: 3,
      consecutiveNudgeCount: 1,
      openTaskCount: 0,
      openTaskSamples: [],
      remainingRequirements: [],
    });
    expect(message.role).toBe("user");
    expect(typeof message.content).toBe("string");
    expect(message.content).toContain(RUNTIME_PREFIX);
    expect(message.content).toContain("Cycle 3 ended with no tool calls");
    expect(message.content).toContain(
      "Keep working — do not summarize",
    );
    // No upstream-specific wrapper and no extra LLMMessage fields.
    expect(Object.keys(message).sort()).toEqual(["content", "role"]);
    expect(message.content).not.toContain("<system-reminder>");
  });

  it("includes an open-task summary when tasks exist", () => {
    const message = buildZeroToolBlockingMessage({
      cycleCount: 4,
      consecutiveNudgeCount: 1,
      openTaskCount: 3,
      openTaskSamples: ["lexer", "parser", "ast"],
      remainingRequirements: ["build", "tests"],
    });
    expect(message.content).toContain("Open tasks: 3");
    expect(message.content).toContain('Examples: "lexer", "parser", "ast"');
    expect(message.content).toContain("Remaining requirements: build, tests");
  });

  it("adds an exhaustion notice once the nudge budget is hit", () => {
    const message = buildZeroToolBlockingMessage({
      cycleCount: 5,
      consecutiveNudgeCount: MAX_CONSECUTIVE_NUDGE_CYCLES,
      openTaskCount: 0,
      openTaskSamples: [],
      remainingRequirements: [],
    });
    expect(message.content).toContain(
      `Nudge budget exhausted (${MAX_CONSECUTIVE_NUDGE_CYCLES}/${MAX_CONSECUTIVE_NUDGE_CYCLES})`,
    );
  });
});

describe("buildTaskStalenessReminder", () => {
  it("renders a bulleted list of open tasks with cadence context", () => {
    const message = buildTaskStalenessReminder({
      cyclesSinceTaskTool: TASK_REMINDER_CYCLES_SINCE_WRITE,
      openTasks: sampleOpenTasks(3),
    });
    expect(message.role).toBe("user");
    expect(message.content).toContain(RUNTIME_PREFIX);
    expect(message.content).toContain(
      `has not been called in ${TASK_REMINDER_CYCLES_SINCE_WRITE} cycles`,
    );
    expect(message.content).toContain("1. [pending] task 1");
    expect(message.content).toContain("2. [in_progress] task 2");
    expect(message.content).toContain("3. [pending] task 3");
    expect(message.content).not.toContain("<system-reminder>");
  });

  it("includes a '(showing first N of M)' suffix when the task list exceeds the sample cap", () => {
    const message = buildTaskStalenessReminder({
      cyclesSinceTaskTool: TASK_REMINDER_CYCLES_SINCE_WRITE * 2,
      openTasks: sampleOpenTasks(9),
    });
    expect(message.content).toContain("(showing first 5 of 9)");
  });

  it("reports 'No open tasks recorded.' when the list is empty", () => {
    const message = buildTaskStalenessReminder({
      cyclesSinceTaskTool: TASK_REMINDER_CYCLES_SINCE_WRITE,
      openTasks: [],
    });
    expect(message.content).toContain("No open tasks recorded.");
  });
});

describe("evaluateCycleContinuationInjections", () => {
  const baseHistory: readonly LLMMessage[] = [
    { role: "user", content: "prior user" },
    { role: "assistant", content: "prior assistant" },
  ];

  it("returns [] when no mechanism applies", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 2,
      consecutiveNudgeCycles: 0,
      cyclesSinceTaskTool: 1,
      lastToolEvidencePresent: true,
      remainingRequirements: [],
      history: baseHistory,
      openTasks: [],
    });
    expect(result).toEqual([]);
  });

  it("emits the zero-tool blocking message when the guard fired in the prior cycle", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 4,
      consecutiveNudgeCycles: 1,
      cyclesSinceTaskTool: 2,
      lastToolEvidencePresent: true,
      remainingRequirements: ["build", "tests"],
      history: baseHistory,
      openTasks: sampleOpenTasks(2),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain("Cycle 4 ended with no tool calls");
  });

  it("does not emit a zero-tool nudge when lastToolEvidence is missing (first-cycle path)", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 1,
      consecutiveNudgeCycles: 1,
      cyclesSinceTaskTool: 0,
      lastToolEvidencePresent: false,
      remainingRequirements: [],
      history: baseHistory,
      openTasks: [],
    });
    expect(result).toEqual([]);
  });

  it("emits the task-staleness reminder on the cadence boundary", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 7,
      consecutiveNudgeCycles: 0,
      cyclesSinceTaskTool: TASK_REMINDER_CYCLES_SINCE_WRITE,
      lastToolEvidencePresent: true,
      remainingRequirements: [],
      history: baseHistory,
      openTasks: sampleOpenTasks(2),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain("Open tasks:");
  });

  it("emits both messages when both mechanisms trigger", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 7,
      consecutiveNudgeCycles: 1,
      cyclesSinceTaskTool: TASK_REMINDER_CYCLES_SINCE_WRITE,
      lastToolEvidencePresent: true,
      remainingRequirements: [],
      history: baseHistory,
      openTasks: sampleOpenTasks(2),
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.content).toContain("Cycle 7");
    expect(result[1]?.content).toContain("Open tasks:");
  });

  it("skips the zero-tool nudge when the last history message is already user-role", () => {
    const userEndedHistory: readonly LLMMessage[] = [
      ...baseHistory,
      { role: "user", content: "hanging user turn" },
    ];
    const result = evaluateCycleContinuationInjections({
      cycleCount: 4,
      consecutiveNudgeCycles: 1,
      cyclesSinceTaskTool: 2,
      lastToolEvidencePresent: true,
      remainingRequirements: [],
      history: userEndedHistory,
      openTasks: [],
    });
    expect(result).toEqual([]);
  });

  it("stops emitting the zero-tool nudge once the nudge budget is exhausted", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 7,
      consecutiveNudgeCycles: MAX_CONSECUTIVE_NUDGE_CYCLES + 1,
      cyclesSinceTaskTool: 1,
      lastToolEvidencePresent: true,
      remainingRequirements: [],
      history: baseHistory,
      openTasks: [],
    });
    expect(result).toEqual([]);
  });

  it("still emits the task reminder even when the nudge budget is exhausted", () => {
    const result = evaluateCycleContinuationInjections({
      cycleCount: 12,
      consecutiveNudgeCycles: MAX_CONSECUTIVE_NUDGE_CYCLES + 1,
      cyclesSinceTaskTool: TASK_REMINDER_CYCLES_SINCE_WRITE * 2,
      lastToolEvidencePresent: true,
      remainingRequirements: [],
      history: baseHistory,
      openTasks: sampleOpenTasks(1),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain("Open tasks:");
  });
});
