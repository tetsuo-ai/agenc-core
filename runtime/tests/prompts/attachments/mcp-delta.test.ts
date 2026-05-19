import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { mcpInstructionsDeltaProducer } from "./mcp-delta.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

interface FakeManager {
  servers: Map<string, string | undefined>;
  getConnectedServers(): string[];
  getServerInstructions(name: string): string | undefined;
}

interface FakeSession {
  services: { mcpManager: FakeManager };
}

function makeManager(servers: Map<string, string | undefined>): FakeManager {
  return {
    servers,
    getConnectedServers() {
      return [...servers.keys()];
    },
    getServerInstructions(name: string) {
      return servers.get(name);
    },
  };
}

function makeSession(servers: Map<string, string | undefined>): FakeSession {
  return { services: { mcpManager: makeManager(servers) } };
}

function makeOpts(sessionKey: object): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    discoveredToolNames: new Set(),
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-mcp-delta-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("mcpInstructionsDeltaProducer", () => {
  test("first call seeds tracking state and returns []", async () => {
    const sessionKey = makeSession(new Map([["fs", "use the fs server"]]));
    const state = getAttachmentTrackingState(sessionKey);
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    expect(state.lastMcpInstructionsMap?.get("fs")).toBe("use the fs server");
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("second call with no change returns []", async () => {
    const sessionKey = makeSession(new Map([["fs", "use the fs server"]]));
    const state = getAttachmentTrackingState(sessionKey);
    await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("two new servers connect at once → both in addedNames", async () => {
    const sessionKey = makeSession(new Map());
    const state = getAttachmentTrackingState(sessionKey);
    await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.services.mcpManager.servers.set("fs", "fs instructions");
    sessionKey.services.mcpManager.servers.set("git", "git instructions");
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "mcp_instructions_delta",
        addedNames: ["fs", "git"],
        addedBlocks: ["fs instructions", "git instructions"],
        removedNames: [],
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("server disconnects → removedNames", async () => {
    const sessionKey = makeSession(
      new Map([
        ["fs", "fs instructions"],
        ["git", "git instructions"],
      ]),
    );
    const state = getAttachmentTrackingState(sessionKey);
    await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.services.mcpManager.servers.delete("git");
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "mcp_instructions_delta",
        addedNames: [],
        addedBlocks: [],
        removedNames: ["git"],
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("simultaneous add + remove produces a combined delta", async () => {
    const sessionKey = makeSession(
      new Map([
        ["fs", "fs instructions"],
        ["git", "git instructions"],
      ]),
    );
    const state = getAttachmentTrackingState(sessionKey);
    await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.services.mcpManager.servers.delete("git");
    sessionKey.services.mcpManager.servers.set("docs", "docs instructions");
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([
      {
        kind: "mcp_instructions_delta",
        addedNames: ["docs"],
        addedBlocks: ["docs instructions"],
        removedNames: ["git"],
      },
    ]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("subsequent stable call after a delta returns []", async () => {
    const sessionKey = makeSession(new Map());
    const state = getAttachmentTrackingState(sessionKey);
    await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    sessionKey.services.mcpManager.servers.set("fs", "fs instructions");
    const first = await mcpInstructionsDeltaProducer(
      makeOpts(sessionKey),
      state,
    );
    expect(first).toHaveLength(1);
    const second = await mcpInstructionsDeltaProducer(
      makeOpts(sessionKey),
      state,
    );
    expect(second).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("server with empty/undefined instructions is ignored", async () => {
    const sessionKey = makeSession(
      new Map<string, string | undefined>([
        ["fs", "real instructions"],
        ["empty", ""],
        ["nope", undefined],
      ]),
    );
    const state = getAttachmentTrackingState(sessionKey);
    await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(state.lastMcpInstructionsMap?.size).toBe(1);
    expect(state.lastMcpInstructionsMap?.has("fs")).toBe(true);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("missing mcpManager surface no-ops cleanly", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    expect(state.lastMcpInstructionsMap?.size).toBe(0);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("manager without getServerInstructions surface no-ops cleanly", async () => {
    const sessionKey = {
      services: {
        mcpManager: {
          getConnectedServers: () => ["fs", "git"],
        },
      },
    };
    const state = getAttachmentTrackingState(sessionKey);
    const out = await mcpInstructionsDeltaProducer(makeOpts(sessionKey), state);
    expect(out).toEqual([]);
    expect(state.lastMcpInstructionsMap?.size).toBe(0);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
