import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { outputStyleProducer } from "./output-style.js";

function makeOpts(sessionKey: object): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-output-style-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("outputStyleProducer", () => {
  // The producer is currently a noop while the active output-style preset
  // name is not yet threaded through `GetAttachmentsOptions`. These tests
  // pin the noop contract so the renderer wiring stays exercised once the
  // option is plumbed and the producer lights up.

  test("returns [] when invoked with default options (noop path)", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const out = await outputStyleProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("returns [] regardless of repeated invocations on the same session", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    expect(await outputStyleProducer(makeOpts(sessionKey), state)).toEqual([]);
    expect(await outputStyleProducer(makeOpts(sessionKey), state)).toEqual([]);
    expect(await outputStyleProducer(makeOpts(sessionKey), state)).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("does not mutate the tracking state", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const before = { ...state };
    await outputStyleProducer(makeOpts(sessionKey), state);
    expect({ ...state }).toEqual(before);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
