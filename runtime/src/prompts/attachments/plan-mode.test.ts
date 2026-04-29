/**
 * Tests for the plan-mode attachment producer.
 *
 * Pins the AgenC-equivalent behaviour at
 * `src/utils/attachments.ts:1132-1274`:
 *
 *   - First plan-mode turn fires a `full` reminder.
 *   - Throttled at one attachment per `TURNS_BETWEEN_ATTACHMENTS` (5)
 *     human turns; intervening turns fire nothing.
 *   - Every `FULL_REMINDER_EVERY_N_ATTACHMENTS` (5) attachments the cycle
 *     re-fires `full`; otherwise `sparse`.
 *   - `default` (and any non-plan) mode fires no per-turn pulse.
 *   - `plan_mode_exit` fires once when the tracking flag is set, then
 *     clears it. Sets `hasExitedPlanModeInSession`.
 *   - Re-entry after a prior exit fires `plan_mode_reentry` paired with
 *     a `plan_mode` (full) on the same turn — matches AgenC
 *     :1217-1240 which emits both attachments together.
 *
 * The producer scans `opts.messages` for marker substrings to detect
 * prior attachments (since the rendered messages live in history). Tests
 * synthesise prior pulses by injecting LLMMessage entries containing the
 * marker phrases.
 */
import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { _resetAttachmentTrackingStateForTest } from "../../session/attachment-state.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import {
  PLAN_MODE_ATTACHMENT_CONFIG,
  planModeProducer,
} from "./plan-mode.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: { conversationId: "conv-plan-mode-test" },
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: {
      mode: "plan",
    } as ToolPermissionContext,
    cwd: "/tmp/agenc-plan-mode-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

/** A user-channel marker message — simulates a prior plan_mode attachment. */
function planModeMarker(): LLMMessage {
  return {
    role: "user",
    content:
      "<system-reminder>\nPlan mode is active. Read-only tools only;\n</system-reminder>",
  };
}

function planModeReentryMarker(): LLMMessage {
  return {
    role: "user",
    content: "<system-reminder>\n## Re-entering plan mode\n</system-reminder>",
  };
}

function planModeExitMarker(): LLMMessage {
  return {
    role: "user",
    content: "<system-reminder>\n## Exited plan mode\n</system-reminder>",
  };
}

function humanTurn(text = "next thing please"): LLMMessage {
  return { role: "user", content: text };
}

describe("plan-mode attachment producer", () => {
  test("config matches AgenC PLAN_MODE_ATTACHMENT_CONFIG", () => {
    expect(PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS).toBe(5);
    expect(PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS).toBe(
      5,
    );
  });

  test("first plan-mode turn fires variant: full", async () => {
    const opts = makeOpts();
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await planModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("plan_mode");
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("turns 1-4 after a full reminder fire nothing", async () => {
    for (let extraHumanTurns = 1; extraHumanTurns <= 4; extraHumanTurns += 1) {
      const messages: LLMMessage[] = [planModeMarker()];
      for (let i = 0; i < extraHumanTurns; i += 1) {
        messages.push(humanTurn());
      }
      const opts = makeOpts({ messages });
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      const out = await planModeProducer(opts, tracking);
      expect(
        out,
        `expected no emission after ${extraHumanTurns} human turn(s)`,
      ).toEqual([]);
      _resetAttachmentTrackingStateForTest(opts.sessionKey);
    }
  });

  test("turn 5 after a full reminder fires variant: sparse", async () => {
    const messages: LLMMessage[] = [planModeMarker()];
    for (let i = 0; i < 5; i += 1) messages.push(humanTurn());
    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await planModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("plan_mode");
    expect((out[0] as { variant: string }).variant).toBe("sparse");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("after 5 prior attachments, the next fires variant: full again", async () => {
    // Five prior plan_mode markers + 5 human turns ⇒ this becomes the
    // 6th attachment. 6 % 5 === 1 → full.
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 5; i += 1) messages.push(planModeMarker());
    for (let i = 0; i < 5; i += 1) messages.push(humanTurn());
    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await planModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("mode === default fires nothing", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "default" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await planModeProducer(opts, tracking);
    expect(out).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("exit attachment fires once when needsPlanModeExitAttachment is true", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "default" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.needsPlanModeExitAttachment = true;

    const out = await planModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("plan_mode_exit");
    expect(tracking.needsPlanModeExitAttachment).toBe(false);
    expect(tracking.hasExitedPlanModeInSession).toBe(true);

    // Second call (still default mode, flag now clear) emits nothing.
    const next = await planModeProducer(opts, tracking);
    expect(next).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("exit flag is cleared silently when current mode is still plan", async () => {
    // Mirrors AgenC :1258-1261 — a quick toggle out and back in must
    // not surface an exit reminder for an exit the model never saw. The
    // flag is cleared, but no exit reminder fires AND the
    // hasExitedPlanModeInSession flag is NOT set.
    const opts = makeOpts({
      permissionContext: { mode: "plan" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.needsPlanModeExitAttachment = true;

    const out = await planModeProducer(opts, tracking);

    // The plan_mode (full) pulse still fires — but no plan_mode_exit.
    expect(out.some((a) => a.kind === "plan_mode_exit")).toBe(false);
    expect(out.some((a) => a.kind === "plan_mode")).toBe(true);
    expect(tracking.needsPlanModeExitAttachment).toBe(false);
    expect(tracking.hasExitedPlanModeInSession).toBe(false);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("re-entry after a prior exit fires plan_mode_reentry alongside plan_mode", async () => {
    const opts = makeOpts();
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.hasExitedPlanModeInSession = true;

    const out = await planModeProducer(opts, tracking);

    // AgenC :1217-1240 emits BOTH the reentry AND the regular
    // plan_mode in the same response.
    expect(out.map((a) => a.kind)).toEqual(["plan_mode_reentry", "plan_mode"]);
    // The reentry guidance is one-shot — flag should be cleared.
    expect(tracking.hasExitedPlanModeInSession).toBe(false);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("re-entry detection requires no prior plan_mode marker since last exit", async () => {
    // History: prior plan_mode pulse (this re-entry is past its first emission)
    // ⇒ no reentry attachment, even with hasExitedPlanModeInSession set.
    const messages: LLMMessage[] = [planModeMarker()];
    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.hasExitedPlanModeInSession = true;

    const out = await planModeProducer(opts, tracking);

    expect(out.some((a) => a.kind === "plan_mode_reentry")).toBe(false);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("exit + re-entry sequence: exit on turn N, re-entry on turn N+1", async () => {
    // Turn N: in default mode, exit flag set ⇒ plan_mode_exit fires.
    const exitOpts = makeOpts({
      permissionContext: { mode: "default" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(exitOpts.sessionKey);
    tracking.needsPlanModeExitAttachment = true;

    const exitOut = await planModeProducer(exitOpts, tracking);
    expect(exitOut.map((a) => a.kind)).toEqual(["plan_mode_exit"]);
    expect(tracking.hasExitedPlanModeInSession).toBe(true);

    // Turn N+1: user flips back to plan mode. History now contains the
    // exit marker (and zero plan_mode markers since the exit). Producer
    // should emit reentry + full plan_mode.
    const reentryOpts = makeOpts({
      sessionKey: exitOpts.sessionKey,
      messages: [planModeExitMarker()],
      permissionContext: { mode: "plan" } as ToolPermissionContext,
    });

    const reentryOut = await planModeProducer(reentryOpts, tracking);
    expect(reentryOut.map((a) => a.kind)).toEqual([
      "plan_mode_reentry",
      "plan_mode",
    ]);

    _resetAttachmentTrackingStateForTest(exitOpts.sessionKey);
  });

  test("countPlanModeAttachmentsSinceLastExit resets cycle on re-entry", async () => {
    // History: 4 plan_mode markers, then an exit, then a reentry marker.
    // The next emission should be the *first* of a new cycle ⇒ throttle
    // doesn't apply (no plan-mode marker after the exit), and the count
    // for full/sparse cycle is 1 (reentry) + 1 (current) = 2 → sparse.
    // We're verifying the per-cycle counter resets.
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 4; i += 1) messages.push(planModeMarker());
    messages.push(planModeExitMarker());
    messages.push(planModeReentryMarker());
    for (let i = 0; i < 5; i += 1) messages.push(humanTurn());

    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await planModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("plan_mode");
    // 1 reentry post-exit + 1 (current) = 2 → 2 % 5 != 1 → sparse.
    expect((out[0] as { variant: string }).variant).toBe("sparse");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("tool result messages do not count as human turns", async () => {
    const messages: LLMMessage[] = [planModeMarker()];
    // Add a tool-result entry (toolCallId set) and then the equivalent
    // of 4 human turns. Only the human turns should be counted; total
    // human turn count = 4 ⇒ throttle blocks emission.
    messages.push({
      role: "user",
      content: "tool output here",
      toolCallId: "tool-1",
    });
    for (let i = 0; i < 4; i += 1) messages.push(humanTurn());

    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await planModeProducer(opts, tracking);

    expect(out).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });
});
