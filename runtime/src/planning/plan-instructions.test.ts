import { describe, expect, test } from "vitest";

import {
  buildPlanModeExitInstructions,
  buildPlanModeInstructions,
  buildPlanModeReentryInstructions,
} from "./plan-instructions.js";

describe("plan mode instructions", () => {
  test("builds OpenClaude-style interview guidance with AgenC naming", () => {
    const prompt = buildPlanModeInstructions({
      planFilePath: "/tmp/agenc/plans/session.md",
      planExists: false,
      workflow: "interview",
    });

    expect(prompt).toContain("Iterative Planning Workflow");
    expect(prompt).toContain("First Turn");
    expect(prompt).toContain("Asking Good Questions");
    expect(prompt).toContain("When to Converge");
    expect(prompt).toContain("system.readFile");
    expect(prompt).toContain("system.grep");
    expect(prompt).toContain("system.writeFile");
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain("ExitPlanMode");
    expect(prompt).toContain("AGENC.MD");
    expect(prompt).toContain("<AGENC_HOME>/plans");
    expect(prompt).not.toContain("CLAUDE.md");
    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).not.toContain("Claude");
  });

  test("builds the richer phased workflow when requested", () => {
    const prompt = buildPlanModeInstructions({
      planFilePath: "/tmp/agenc/plans/session.md",
      planExists: true,
      workflow: "phased",
    });

    expect(prompt).toContain("Phase 1: Initial Understanding");
    expect(prompt).toContain("Phase 2: Design");
    expect(prompt).toContain("Phase 3: Review");
    expect(prompt).toContain("Phase 4: Final Plan");
    expect(prompt).toContain("Phase 5: Call ExitPlanMode");
    expect(prompt).toContain("system.editFile");
  });

  test("sparse reminders preserve approval and question rules", () => {
    const prompt = buildPlanModeInstructions({
      planFilePath: "/tmp/agenc/plans/session.md",
      planExists: true,
      reminderType: "sparse",
    });

    expect(prompt).toContain("Plan mode still active");
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain("ExitPlanMode");
    expect(prompt).toContain("Never ask about plan approval via text");
  });

  test("re-entry guidance is available and prepended when requested", () => {
    const prompt = buildPlanModeInstructions({
      planFilePath: "/tmp/agenc/plans/session.md",
      planExists: true,
      includeReentryReminder: true,
    });

    expect(prompt).toContain("Re-entering Plan Mode");
    expect(prompt).toContain("Read the existing plan file");
    expect(prompt).toContain("Plan mode is active");
  });

  test("exit attachment guidance uses AgenC plan file references", () => {
    expect(
      buildPlanModeExitInstructions({
        planFilePath: "/tmp/agenc/plans/session.md",
        planExists: true,
      }),
    ).toContain("/tmp/agenc/plans/session.md");

    expect(buildPlanModeReentryInstructions("/tmp/agenc/plans/session.md"))
      .toContain("always edit the plan file");
  });

  test("sub-agent prompt overrides workflow regardless of phased/interview", () => {
    const phased = buildPlanModeInstructions({
      planFilePath: "/tmp/agenc/plans/session.md",
      planExists: false,
      workflow: "phased",
      isSubAgent: true,
    });
    const interview = buildPlanModeInstructions({
      planFilePath: "/tmp/agenc/plans/session.md",
      planExists: false,
      workflow: "interview",
      isSubAgent: true,
    });
    expect(phased).toBe(interview);
    expect(phased).not.toContain("Phase 1: Initial Understanding");
    expect(phased).not.toContain("Iterative Planning Workflow");
    expect(phased).toContain("AskUserQuestion");
  });
});
