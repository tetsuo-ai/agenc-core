import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { criticalReminderProducer } from "./critical-reminder.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

function makeOpts(sessionKey: object): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-critical-reminder-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("criticalReminderProducer", () => {
  test("returns [] when pendingCriticalReminder is undefined", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const out = await criticalReminderProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("returns [] when pendingCriticalReminder is the empty string", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    state.pendingCriticalReminder = "";
    const out = await criticalReminderProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("emits critical_system_reminder with the pending content and clears it", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    state.pendingCriticalReminder = "Network outage detected — falling back to cache.";

    const out = await criticalReminderProducer(makeOpts(sessionKey), state);

    expect(out).toEqual([
      {
        kind: "critical_system_reminder",
        content: "Network outage detected — falling back to cache.",
      },
    ]);
    expect(state.pendingCriticalReminder).toBeUndefined();
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("re-firing requires re-setting pendingCriticalReminder", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    state.pendingCriticalReminder = "first";

    const first = await criticalReminderProducer(makeOpts(sessionKey), state);
    expect(first).toEqual([
      { kind: "critical_system_reminder", content: "first" },
    ]);

    const drained = await criticalReminderProducer(makeOpts(sessionKey), state);
    expect(drained).toEqual([]);

    state.pendingCriticalReminder = "second";
    const second = await criticalReminderProducer(makeOpts(sessionKey), state);
    expect(second).toEqual([
      { kind: "critical_system_reminder", content: "second" },
    ]);
    expect(state.pendingCriticalReminder).toBeUndefined();

    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
