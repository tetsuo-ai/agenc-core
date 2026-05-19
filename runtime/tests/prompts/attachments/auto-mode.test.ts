/**
 * Tests for the auto-mode attachment producer.
 *
 * Pins the AgenC-equivalent behaviour at
 * `src/utils/attachments.ts:1276-1401`. AgenC maps AgenC's single
 * `auto` mode to the autonomous-execution family
 * (`auto`, `acceptEdits`, `bypassPermissions`); the producer fires
 * uniformly across that family.
 */
import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { _resetAttachmentTrackingStateForTest } from "../../session/attachment-state.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import {
  AUTO_MODE_ATTACHMENT_CONFIG,
  autoModeProducer,
} from "./auto-mode.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: { conversationId: "conv-auto-mode-test" },
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: {
      mode: "acceptEdits",
    } as ToolPermissionContext,
    cwd: "/tmp/agenc-auto-mode-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

function autoModeMarker(): LLMMessage {
  return {
    role: "user",
    content: "<system-reminder>\nAuto mode is active.\n</system-reminder>",
  };
}

function autoModeExitMarker(): LLMMessage {
  return {
    role: "user",
    content:
      "<system-reminder>\nYou have exited auto mode. Tool approvals are now requested per call.\n</system-reminder>",
  };
}

function humanTurn(text = "another step"): LLMMessage {
  return { role: "user", content: text };
}

describe("auto-mode attachment producer", () => {
  test("config matches AgenC AUTO_MODE_ATTACHMENT_CONFIG", () => {
    expect(AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS).toBe(5);
    expect(AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS).toBe(
      5,
    );
  });

  test("first auto-mode turn fires variant: full (acceptEdits)", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "acceptEdits" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("auto_mode");
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("first auto-mode turn fires variant: full (bypassPermissions)", async () => {
    const opts = makeOpts({
      permissionContext: {
        mode: "bypassPermissions",
      } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("first auto-mode turn fires variant: full (auto)", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "auto" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("turns 1-4 after a full reminder fire nothing", async () => {
    for (let extraHumanTurns = 1; extraHumanTurns <= 4; extraHumanTurns += 1) {
      const messages: LLMMessage[] = [autoModeMarker()];
      for (let i = 0; i < extraHumanTurns; i += 1) messages.push(humanTurn());
      const opts = makeOpts({ messages });
      const tracking = getAttachmentTrackingState(opts.sessionKey);
      const out = await autoModeProducer(opts, tracking);
      expect(out, `expected nothing after ${extraHumanTurns} human turns`).toEqual(
        [],
      );
      _resetAttachmentTrackingStateForTest(opts.sessionKey);
    }
  });

  test("turn 5 fires variant: sparse", async () => {
    const messages: LLMMessage[] = [autoModeMarker()];
    for (let i = 0; i < 5; i += 1) messages.push(humanTurn());
    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("auto_mode");
    expect((out[0] as { variant: string }).variant).toBe("sparse");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("after 5 prior attachments, the next fires variant: full again", async () => {
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 5; i += 1) messages.push(autoModeMarker());
    for (let i = 0; i < 5; i += 1) messages.push(humanTurn());
    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("mode === default fires nothing", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "default" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);
    expect(out).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("mode === plan fires nothing (plan-mode owns plan-mode pulses)", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "plan" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);
    expect(out).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("exit attachment fires once when needsAutoModeExitAttachment is true", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "default" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.needsAutoModeExitAttachment = true;

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("auto_mode_exit");
    expect(tracking.needsAutoModeExitAttachment).toBe(false);
    expect(tracking.hasExitedAutoModeInSession).toBe(true);

    const next = await autoModeProducer(opts, tracking);
    expect(next).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("exit flag is cleared silently when current mode is still auto-family", async () => {
    const opts = makeOpts({
      permissionContext: { mode: "acceptEdits" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.needsAutoModeExitAttachment = true;

    const out = await autoModeProducer(opts, tracking);

    expect(out.some((a) => a.kind === "auto_mode_exit")).toBe(false);
    expect(out.some((a) => a.kind === "auto_mode")).toBe(true);
    expect(tracking.needsAutoModeExitAttachment).toBe(false);
    expect(tracking.hasExitedAutoModeInSession).toBe(false);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("re-entry after exit fires variant: full (auto-mode has no separate reentry attachment)", async () => {
    // AgenC does NOT define an auto_mode_reentry attachment. The
    // exit just resets the cycle so the next entry fires `full` again.
    const exitOpts = makeOpts({
      permissionContext: { mode: "default" } as ToolPermissionContext,
    });
    const tracking = getAttachmentTrackingState(exitOpts.sessionKey);
    tracking.needsAutoModeExitAttachment = true;

    const exitOut = await autoModeProducer(exitOpts, tracking);
    expect(exitOut.map((a) => a.kind)).toEqual(["auto_mode_exit"]);

    // Re-entry: history has the exit marker. Producer should fire `full`.
    const reentryOpts = makeOpts({
      sessionKey: exitOpts.sessionKey,
      messages: [autoModeExitMarker()],
      permissionContext: { mode: "acceptEdits" } as ToolPermissionContext,
    });

    const reentryOut = await autoModeProducer(reentryOpts, tracking);
    expect(reentryOut).toHaveLength(1);
    expect(reentryOut[0]?.kind).toBe("auto_mode");
    expect((reentryOut[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(exitOpts.sessionKey);
  });

  test("exit marker in history resets the throttle", async () => {
    // Normally 5 prior auto_mode + 4 human turns would suppress the
    // emission. With an exit marker after them, the throttle resets and
    // the producer fires `full` (count starts fresh).
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 5; i += 1) messages.push(autoModeMarker());
    messages.push(autoModeExitMarker());
    for (let i = 0; i < 4; i += 1) messages.push(humanTurn());

    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("auto_mode");
    expect((out[0] as { variant: string }).variant).toBe("full");

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("tool result messages do not count as human turns", async () => {
    const messages: LLMMessage[] = [autoModeMarker()];
    messages.push({
      role: "user",
      content: "tool output",
      toolCallId: "call-1",
    });
    for (let i = 0; i < 4; i += 1) messages.push(humanTurn());

    const opts = makeOpts({ messages });
    const tracking = getAttachmentTrackingState(opts.sessionKey);

    const out = await autoModeProducer(opts, tracking);
    expect(out).toEqual([]);

    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });
});
