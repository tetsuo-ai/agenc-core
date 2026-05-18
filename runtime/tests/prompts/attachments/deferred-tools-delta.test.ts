import { describe, expect, test } from "vitest";

import type { LLMTool } from "../../llm/types.js";
import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { deferredToolsDeltaProducer } from "./deferred-tools-delta.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

function tool(name: string, description = `desc for ${name}`): LLMTool {
  return {
    type: "function",
    function: { name, description, parameters: {} },
  };
}

function makeOpts(
  sessionKey: object,
  loadedTools: readonly LLMTool[],
  discoveredToolNames: ReadonlySet<string>,
): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools,
    discoveredToolNames,
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-deferred-tools-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("deferredToolsDeltaProducer", () => {
  test("first call seeds tracking state and returns []", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const tools = [tool("foo"), tool("bar")];
    const out = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo"])),
      state,
    );
    expect(out).toEqual([]);
    expect([...(state.lastDeferredToolsSet ?? [])]).toEqual(["foo"]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("second call with no change returns []", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const tools = [tool("foo"), tool("bar")];
    const discovered = new Set(["foo"]);
    await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, discovered),
      state,
    );
    const out = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, discovered),
      state,
    );
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("adding a discovered tool emits a delta with addedNames + addedLines", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const tools = [tool("foo"), tool("bar"), tool("baz", "the baz tool")];
    await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo"])),
      state,
    );
    const out = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo", "baz"])),
      state,
    );
    expect(out).toEqual([
      {
        kind: "deferred_tools_delta",
        addedNames: ["baz"],
        addedLines: ["baz: the baz tool"],
        removedNames: [],
      },
    ]);
    expect([...(state.lastDeferredToolsSet ?? [])].sort()).toEqual([
      "baz",
      "foo",
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("removing a discovered tool emits a delta with removedNames", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const tools = [tool("foo"), tool("bar")];
    await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo", "bar"])),
      state,
    );
    const out = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, [tool("foo")], new Set(["foo"])),
      state,
    );
    expect(out).toEqual([
      {
        kind: "deferred_tools_delta",
        addedNames: [],
        addedLines: [],
        removedNames: ["bar"],
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("simultaneous add + remove produces a combined delta", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    await deferredToolsDeltaProducer(
      makeOpts(sessionKey, [tool("a"), tool("b")], new Set(["a", "b"])),
      state,
    );
    const out = await deferredToolsDeltaProducer(
      makeOpts(
        sessionKey,
        [tool("a"), tool("c", "c tool")],
        new Set(["a", "c"]),
      ),
      state,
    );
    expect(out).toEqual([
      {
        kind: "deferred_tools_delta",
        addedNames: ["c"],
        addedLines: ["c: c tool"],
        removedNames: ["b"],
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("subsequent stable call after a delta returns []", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const tools = [tool("foo"), tool("bar")];
    await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo"])),
      state,
    );
    const first = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo", "bar"])),
      state,
    );
    expect(first).toHaveLength(1);
    const second = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, tools, new Set(["foo", "bar"])),
      state,
    );
    expect(second).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("missing discoveredToolNames defaults to empty set", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const opts: GetAttachmentsOptions = {
      sessionKey,
      userInput: null,
      loadedTools: [tool("foo")],
      messages: [],
      permissionContext: { mode: "default" } as never,
      cwd: "/tmp",
      subagentDepth: 0,
      signal: new AbortController().signal,
    };
    const out = await deferredToolsDeltaProducer(opts, state);
    expect(out).toEqual([]);
    expect(state.lastDeferredToolsSet).toBeDefined();
    expect([...(state.lastDeferredToolsSet ?? [])]).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("tools without discovery flag stay out of the deferred set", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    // foo is in the visible catalog but not in discoveredToolNames →
    // treated as a default-visible tool and excluded from the delta set.
    await deferredToolsDeltaProducer(
      makeOpts(sessionKey, [tool("foo"), tool("bar")], new Set(["bar"])),
      state,
    );
    const out = await deferredToolsDeltaProducer(
      makeOpts(sessionKey, [tool("foo"), tool("bar")], new Set(["bar"])),
      state,
    );
    expect(out).toEqual([]);
    expect([...(state.lastDeferredToolsSet ?? [])]).toEqual(["bar"]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
