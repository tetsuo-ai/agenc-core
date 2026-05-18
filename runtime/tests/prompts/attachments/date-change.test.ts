import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { dateChangeProducer } from "./date-change.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

function makeOpts(sessionKey: object): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-date-change-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("dateChangeProducer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("first call seeds lastEmittedDate and returns []", async () => {
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const out = await dateChangeProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    expect(state.lastEmittedDate).toBe("2026-04-25");
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("same-day repeat returns []", async () => {
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    await dateChangeProducer(makeOpts(sessionKey), state);
    vi.setSystemTime(new Date("2026-04-25T23:30:00Z"));
    const out = await dateChangeProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    expect(state.lastEmittedDate).toBe("2026-04-25");
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("different-day call emits a date_change attachment with the new date", async () => {
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    await dateChangeProducer(makeOpts(sessionKey), state);

    vi.setSystemTime(new Date("2026-04-26T08:15:00Z"));
    const out = await dateChangeProducer(makeOpts(sessionKey), state);

    expect(out).toEqual([{ kind: "date_change", newDate: "2026-04-26" }]);
    expect(state.lastEmittedDate).toBe("2026-04-26");
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("emission updates the tracking state across multiple boundaries", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);

    vi.setSystemTime(new Date("2026-04-25T00:00:00Z"));
    await dateChangeProducer(makeOpts(sessionKey), state);
    expect(state.lastEmittedDate).toBe("2026-04-25");

    vi.setSystemTime(new Date("2026-04-26T00:00:00Z"));
    const first = await dateChangeProducer(makeOpts(sessionKey), state);
    expect(first).toEqual([{ kind: "date_change", newDate: "2026-04-26" }]);
    expect(state.lastEmittedDate).toBe("2026-04-26");

    vi.setSystemTime(new Date("2026-04-28T00:00:00Z"));
    const second = await dateChangeProducer(makeOpts(sessionKey), state);
    expect(second).toEqual([{ kind: "date_change", newDate: "2026-04-28" }]);
    expect(state.lastEmittedDate).toBe("2026-04-28");

    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
