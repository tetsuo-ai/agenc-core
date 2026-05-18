import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { agentListingDeltaProducer } from "./agent-listing-delta.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

interface FakeSession {
  agentDefinitions: { activeAgents: unknown[] };
}

function makeSession(activeAgents: unknown[]): FakeSession {
  return { agentDefinitions: { activeAgents } };
}

function makeOpts(
  sessionKey: object,
  subagentDepth = 0,
): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    discoveredToolNames: new Set(),
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-agent-listing-test",
    subagentDepth,
    signal: new AbortController().signal,
  };
}

describe("agentListingDeltaProducer", () => {
  test("first call with no agents seeds an empty baseline and returns []", async () => {
    const sessionKey = makeSession([]);
    const state = getAttachmentTrackingState(sessionKey);
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    expect(state.lastAgentListingSet).toBeDefined();
    expect(state.lastAgentListingSet?.size).toBe(0);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("first call with agents emits initial listing", async () => {
    const sessionKey = makeSession([
      { agentType: "explore", whenToUse: "for exploration" },
      { agentType: "build", whenToUse: "for building", tools: ["Read"] },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "agent_listing_delta",
        addedTypes: ["build", "explore"],
        addedLines: [
          "build: for building (Tools: Read)",
          "explore: for exploration",
        ],
        removedTypes: [],
        isInitial: true,
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("second call with no change returns []", async () => {
    const sessionKey = makeSession([
      { agentType: "explore", whenToUse: "for exploration" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    await agentListingDeltaProducer(makeOpts(sessionKey), state);
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("adding an agent emits a delta with isInitial: false", async () => {
    const sessionKey = makeSession([
      { agentType: "explore", whenToUse: "for exploration" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    await agentListingDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.agentDefinitions.activeAgents.push({
      agentType: "build",
      whenToUse: "for building",
    });
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "agent_listing_delta",
        addedTypes: ["build"],
        addedLines: ["build: for building"],
        removedTypes: [],
        isInitial: false,
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("removing an agent emits a delta with removedTypes", async () => {
    const sessionKey = makeSession([
      { agentType: "explore", whenToUse: "for exploration" },
      { agentType: "build", whenToUse: "for building" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    await agentListingDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.agentDefinitions.activeAgents = [
      { agentType: "explore", whenToUse: "for exploration" },
    ];
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "agent_listing_delta",
        addedTypes: [],
        addedLines: [],
        removedTypes: ["build"],
        isInitial: false,
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("simultaneous add + remove produces a combined delta", async () => {
    const sessionKey = makeSession([
      { agentType: "a", whenToUse: "ay" },
      { agentType: "b", whenToUse: "bee" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    await agentListingDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.agentDefinitions.activeAgents = [
      { agentType: "a", whenToUse: "ay" },
      { agentType: "c", whenToUse: "see" },
    ];
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "agent_listing_delta",
        addedTypes: ["c"],
        addedLines: ["c: see"],
        removedTypes: ["b"],
        isInitial: false,
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("subsequent stable call after a delta returns []", async () => {
    const sessionKey = makeSession([
      { agentType: "explore", whenToUse: "for exploration" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    await agentListingDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.agentDefinitions.activeAgents.push({
      agentType: "build",
      whenToUse: "for building",
    });
    const first = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(first).toHaveLength(1);
    const second = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(second).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("subagentDepth > 0 returns [] (main-thread-only gate)", async () => {
    const sessionKey = makeSession([
      { agentType: "explore", whenToUse: "for exploration" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    const out = await agentListingDeltaProducer(makeOpts(sessionKey, 1), state);
    expect(out).toEqual([]);
    expect(state.lastAgentListingSet).toBeUndefined();
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("malformed entries are filtered out defensively", async () => {
    const sessionKey = makeSession([
      { agentType: "good", whenToUse: "ok" },
      null,
      "string",
      { somethingElse: true },
      { agentType: "" },
    ]);
    const state = getAttachmentTrackingState(sessionKey);
    const out = await agentListingDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toHaveLength(1);
    const [attachment] = out;
    if (attachment?.kind !== "agent_listing_delta") {
      throw new Error("expected agent_listing_delta");
    }
    expect(attachment.addedTypes).toEqual(["good"]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
