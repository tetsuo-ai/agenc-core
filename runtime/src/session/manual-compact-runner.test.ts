import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trySessionMemoryCompaction: vi.fn(),
  microcompactMessages: vi.fn(),
  compactConversation: vi.fn(),
  runPostCompactCleanup: vi.fn(),
  buildCompactCacheSafeParams: vi.fn(),
  suppressCompactWarning: vi.fn(),
  setLastSummarizedMessageId: vi.fn(),
  clearUserContextCache: vi.fn(),
  notifyCompaction: vi.fn(),
  paths: {
    compact: new URL("../llm/compact/compact.js", import.meta.url).pathname,
    sessionMemoryCompact: new URL(
      "../llm/compact/session-memory-compact.js",
      import.meta.url,
    ).pathname,
    microCompact: new URL(
      "../llm/compact/micro-compact.js",
      import.meta.url,
    ).pathname,
    postCompactCleanup: new URL(
      "../llm/compact/post-compact-cleanup.js",
      import.meta.url,
    ).pathname,
    runtimeContext: new URL("./compact-runtime-context.js", import.meta.url)
      .pathname,
    systemPrompt: new URL("./_deps/system-prompt.js", import.meta.url).pathname,
    compactWarningState: new URL(
      "../llm/compact/compact-warning-state.js",
      import.meta.url,
    ).pathname,
    noOp: new URL("./_deps/no-op.js", import.meta.url).pathname,
    display: new URL("./_deps/display.js", import.meta.url).pathname,
    messages: new URL("./_deps/messages.js", import.meta.url).pathname,
    utils: new URL("./_deps/utils.js", import.meta.url).pathname,
  },
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("src/bootstrap/state.js", () => ({
  markPostCompaction: vi.fn(),
}));

vi.mock(mocks.paths.sessionMemoryCompact, () => ({
  trySessionMemoryCompaction: mocks.trySessionMemoryCompaction,
}));
vi.mock(mocks.paths.microCompact, () => ({
  microcompactMessages: mocks.microcompactMessages,
}));
vi.mock(mocks.paths.compact, () => ({
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES: "Not enough messages to compact.",
  ERROR_MESSAGE_INCOMPLETE_RESPONSE:
    "Compaction response was incomplete. Please try again.",
  compactConversation: mocks.compactConversation,
}));
vi.mock(mocks.paths.postCompactCleanup, () => ({
  runPostCompactCleanup: mocks.runPostCompactCleanup,
}));
vi.mock(mocks.paths.runtimeContext, () => ({
  buildCompactCacheSafeParams: mocks.buildCompactCacheSafeParams,
  createSessionBackedCompactContext: vi.fn(),
}));
vi.mock(mocks.paths.systemPrompt, () => ({
  getUserContext: Object.assign(async () => ({}), {
    cache: { clear: mocks.clearUserContextCache },
  }),
}));
vi.mock(mocks.paths.compactWarningState, () => ({
  suppressCompactWarning: mocks.suppressCompactWarning,
}));
vi.mock(mocks.paths.noOp, () => ({
  notifyCompaction: mocks.notifyCompaction,
  setLastSummarizedMessageId: mocks.setLastSummarizedMessageId,
}));
vi.mock(mocks.paths.display, () => ({
  getShortcutDisplay: () => "ctrl+o",
  getUpgradeMessage: () => undefined,
}));
vi.mock(mocks.paths.messages, () => ({
  getMessagesAfterCompactBoundary: (messages: unknown[]) => messages,
  createSyntheticUserCaveatMessage: () => ({
    type: "user",
    message: { role: "user", content: "caveat" },
  }),
  createUserMessage: (input: { content: unknown }) => ({
    type: "user",
    message: { role: "user", content: input.content },
  }),
  formatCommandInputTags: (commandName: string, args: string) =>
    `<${commandName}>${args}</${commandName}>`,
}));
vi.mock(mocks.paths.utils, () => ({
  hasExactErrorMessage: () => false,
  errorMessage: (err: unknown) => String(err),
  logError: vi.fn(),
}));

import { runManualCompact } from "./manual-compact.js";

function createContext() {
  return {
    abortController: new AbortController(),
    agentId: "agent-1",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ],
    options: {
      querySource: "compact",
      verbose: false,
      mainLoopModel: "gpt-5",
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
    },
    getAppState: () => ({
      toolPermissionContext: { additionalWorkingDirectories: new Map() },
      agentDefinitions: { activeAgents: [] },
    }),
    readFileState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    setStreamMode: vi.fn(),
    setResponseLength: vi.fn(),
    onCompactProgress: vi.fn(),
    setSDKStatus: vi.fn(),
    addNotification: vi.fn(),
  };
}

describe("runManualCompact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trySessionMemoryCompaction.mockResolvedValue(null);
    mocks.microcompactMessages.mockImplementation(async (messages) => ({
      messages,
    }));
    mocks.buildCompactCacheSafeParams.mockResolvedValue({
      cacheKey: "compact-cache",
    });
  });

  it("returns the session-memory result before traditional compaction when no instructions are provided", async () => {
    const context = createContext();
    const sessionMemoryResult = {
      boundaryMarker: { role: "system", content: "boundary" },
      summaryMessages: [{ role: "user", content: "summary" }],
      attachments: [],
      hookResults: [],
      messagesToKeep: [{ role: "assistant", content: "tail" }],
      userDisplayMessage: "session memory note",
    };
    mocks.trySessionMemoryCompaction.mockResolvedValueOnce(sessionMemoryResult);

    const result = await runManualCompact("", context as never);

    expect(mocks.trySessionMemoryCompaction).toHaveBeenCalledWith(
      context.messages,
      "agent-1",
    );
    expect(mocks.microcompactMessages).not.toHaveBeenCalled();
    expect(mocks.compactConversation).not.toHaveBeenCalled();
    expect(result.compactionResult).toBe(sessionMemoryResult);
    expect(result.displayText).toContain("Compacted");
    expect(mocks.runPostCompactCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.runPostCompactCleanup).toHaveBeenCalledWith(
      "compact",
      context,
    );
    expect(mocks.notifyCompaction).not.toHaveBeenCalled();
    expect(mocks.suppressCompactWarning).toHaveBeenCalledTimes(1);
    expect(mocks.clearUserContextCache).toHaveBeenCalledTimes(1);
  });

  it("falls back to the llm compact path after a session-memory miss", async () => {
    const context = createContext();
    const microcompactedMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
      { role: "assistant", content: "trimmed" },
    ];
    const compactResult = {
      boundaryMarker: { role: "system", content: "boundary" },
      summaryMessages: [{ role: "user", content: "summary" }],
      attachments: [],
      hookResults: [],
      messagesToKeep: [{ role: "assistant", content: "kept tail" }],
      userDisplayMessage: "compact note",
    };
    mocks.microcompactMessages.mockResolvedValueOnce({
      messages: microcompactedMessages,
    });
    mocks.compactConversation.mockResolvedValueOnce(compactResult);

    const result = await runManualCompact("", context as never);

    expect(mocks.trySessionMemoryCompaction).toHaveBeenCalledWith(
      context.messages,
      "agent-1",
    );
    expect(mocks.microcompactMessages).toHaveBeenCalledWith(
      context.messages,
      context,
    );
    expect(mocks.buildCompactCacheSafeParams).toHaveBeenCalledWith(
      context,
      microcompactedMessages,
    );
    expect(mocks.compactConversation).toHaveBeenCalledWith(
      microcompactedMessages,
      context,
      { cacheKey: "compact-cache" },
      false,
      "",
      false,
    );
    expect(result.compactionResult).toBe(compactResult);
    expect(result.displayText).toContain("compact note");
    expect(mocks.setLastSummarizedMessageId).toHaveBeenCalledWith(undefined);
    expect(mocks.runPostCompactCleanup).toHaveBeenCalledWith(
      "compact",
      context,
    );
  });
});
