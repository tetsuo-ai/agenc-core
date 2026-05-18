/**
 * Tests for the verified-plan reminder producer.
 */
import { afterEach, describe, expect, test } from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import {
  getVerifyPlanReminderTurnCount,
  VERIFY_PLAN_REMINDER_CONFIG,
  verifyPlanReminderProducer,
} from "./verify-plan-reminder.js";

const originalVerifyPlanEnv = process.env.AGENC_VERIFY_PLAN;

afterEach(() => {
  if (originalVerifyPlanEnv === undefined) {
    delete process.env.AGENC_VERIFY_PLAN;
  } else {
    process.env.AGENC_VERIFY_PLAN = originalVerifyPlanEnv;
  }
});

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as ToolPermissionContext,
    cwd: "/tmp/agenc-verify-plan-reminder-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

function planModeExitMarker(): LLMMessage {
  return {
    role: "user",
    content: "<system-reminder>\n## Exited plan mode\n</system-reminder>",
    runtimeOnly: { mergeBoundary: "user_context" },
  };
}

function humanTurn(text = "continue"): LLMMessage {
  return { role: "user", content: text };
}

function toolResultTurn(): LLMMessage {
  return {
    role: "user",
    content: "tool output",
    toolCallId: "tool-1",
  };
}

function userContextTurn(): LLMMessage {
  return {
    role: "user",
    content: "<system-reminder>\nThe date changed.\n</system-reminder>",
    runtimeOnly: { mergeBoundary: "user_context" },
  };
}

function humanTurns(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => humanTurn(`turn ${i + 1}`));
}

describe("verify-plan reminder producer", () => {
  test("config matches upstream reminder cadence", () => {
    expect(VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS).toBe(10);
  });

  test("counts human turns since the most recent plan-mode exit marker", () => {
    const messages: LLMMessage[] = [
      humanTurn("before plan exit"),
      planModeExitMarker(),
      toolResultTurn(),
      userContextTurn(),
      ...humanTurns(3),
    ];

    expect(getVerifyPlanReminderTurnCount(messages)).toBe(3);
  });

  test("returns 0 when no plan-mode exit marker is visible", () => {
    expect(getVerifyPlanReminderTurnCount(humanTurns(12))).toBe(0);
  });

  test("fires exactly every tenth human turn after plan-mode exit", async () => {
    const opts = makeOpts({
      messages: [planModeExitMarker(), ...humanTurns(10)],
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await verifyPlanReminderProducer(opts, tracking);

    expect(out).toEqual([{ kind: "verify_plan_reminder" }]);
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("suppresses before and after the tenth-turn boundary", async () => {
    for (const count of [9, 11]) {
      const opts = makeOpts({
        messages: [planModeExitMarker(), ...humanTurns(count)],
      });
      const tracking = getAttachmentTrackingState(opts.sessionKey);

      const out = await verifyPlanReminderProducer(opts, tracking);

      expect(out, `expected no reminder after ${count} turns`).toEqual([]);
      _resetAttachmentTrackingStateForTest(opts.sessionKey);
    }
  });

  test("does not fire in plan mode or subagent threads", async () => {
    const messages = [planModeExitMarker(), ...humanTurns(10)];
    const planOpts = makeOpts({
      messages,
      permissionContext: { mode: "plan" } as ToolPermissionContext,
    });
    const subagentOpts = makeOpts({
      messages,
      subagentDepth: 1,
    });

    expect(
      await verifyPlanReminderProducer(
        planOpts,
        getAttachmentTrackingState(planOpts.sessionKey),
      ),
    ).toEqual([]);
    expect(
      await verifyPlanReminderProducer(
        subagentOpts,
        getAttachmentTrackingState(subagentOpts.sessionKey),
      ),
    ).toEqual([]);

    _resetAttachmentTrackingStateForTest(planOpts.sessionKey);
    _resetAttachmentTrackingStateForTest(subagentOpts.sessionKey);
  });

  test("AGENC_VERIFY_PLAN=0 disables the reminder", async () => {
    process.env.AGENC_VERIFY_PLAN = "0";
    const opts = makeOpts({
      messages: [planModeExitMarker(), ...humanTurns(10)],
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await verifyPlanReminderProducer(opts, tracking);

    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });
});
