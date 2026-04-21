import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trySessionMemoryCompaction: vi.fn(),
  microcompactMessages: vi.fn(() => {
    throw new Error("unexpected fallback to traditional compaction");
  }),
  compactConversation: vi.fn(),
  runPostCompactCleanup: vi.fn(),
  buildCompactCacheSafeParams: vi.fn(),
  executePreCompactHooks: vi.fn(),
  reactiveCompactOnPromptTooLong: vi.fn(),
  suppressCompactWarning: vi.fn(),
  setLastSummarizedMessageId: vi.fn(),
  clearUserContextCache: vi.fn(),
  notifyCompaction: vi.fn(),
  paths: {
    compact: new URL("./compact.js", import.meta.url).pathname,
    sessionMemoryCompact: new URL(
      "./session-memory-compact.js",
      import.meta.url,
    ).pathname,
    microCompact: new URL("./micro-compact.js", import.meta.url).pathname,
    postCompactCleanup: new URL(
      "./post-compact-cleanup.js",
      import.meta.url,
    ).pathname,
    runtimeContext: new URL("./runtime-context.js", import.meta.url).pathname,
    hooks: new URL("../../utils/hooks.js", import.meta.url).pathname,
    context: new URL("../../context.js", import.meta.url).pathname,
    compactWarningState: new URL(
      "./compact-warning-state.js",
      import.meta.url,
    ).pathname,
    sessionMemoryUtils: new URL(
      "../../services/SessionMemory/sessionMemoryUtils.js",
      import.meta.url,
    ).pathname,
    reactiveCompact: new URL(
      "../../services/compact/reactiveCompact.js",
      import.meta.url,
    ).pathname,
    promptCacheBreakDetection: new URL(
      "../../services/api/promptCacheBreakDetection.js",
      import.meta.url,
    ).pathname,
    shortcutFormat: new URL(
      "../../keybindings/shortcutFormat.js",
      import.meta.url,
    ).pathname,
    upgradeCheck: new URL(
      "../../utils/model/contextWindowUpgradeCheck.js",
      import.meta.url,
    ).pathname,
    messages: new URL("../../utils/messages.js", import.meta.url).pathname,
    log: new URL("../../utils/log.js", import.meta.url).pathname,
  },
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => name === "REACTIVE_COMPACT",
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
vi.mock(mocks.paths.compact, () => {
  return {
    ERROR_MESSAGE_NOT_ENOUGH_MESSAGES: "Not enough messages to compact.",
    ERROR_MESSAGE_INCOMPLETE_RESPONSE:
      "Compaction response was incomplete. Please try again.",
    ERROR_MESSAGE_USER_ABORT: "Request was aborted.",
    mergeHookInstructions: (
      userInstructions?: string,
      hookInstructions?: string,
    ) =>
      hookInstructions
        ? userInstructions
          ? `${userInstructions}\n\n${hookInstructions}`
          : hookInstructions
        : userInstructions,
    compactConversation: mocks.compactConversation,
  };
});
vi.mock(mocks.paths.postCompactCleanup, () => ({
  runPostCompactCleanup: mocks.runPostCompactCleanup,
}));
vi.mock(mocks.paths.runtimeContext, () => ({
  buildCompactCacheSafeParams: mocks.buildCompactCacheSafeParams,
}));
vi.mock(mocks.paths.hooks, () => ({
  executePreCompactHooks: mocks.executePreCompactHooks,
}));
vi.mock(mocks.paths.context, () => ({
  getUserContext: Object.assign(async () => ({}), {
    cache: { clear: mocks.clearUserContextCache },
  }),
}));
vi.mock(mocks.paths.compactWarningState, () => ({
  suppressCompactWarning: mocks.suppressCompactWarning,
}));
vi.mock(mocks.paths.sessionMemoryUtils, () => ({
  setLastSummarizedMessageId: mocks.setLastSummarizedMessageId,
}));
vi.mock(mocks.paths.reactiveCompact, () => ({
  isReactiveOnlyMode: vi.fn(() => true),
  reactiveCompactOnPromptTooLong: mocks.reactiveCompactOnPromptTooLong,
}));
vi.mock(mocks.paths.promptCacheBreakDetection, () => ({
  notifyCompaction: mocks.notifyCompaction,
}));
vi.mock(mocks.paths.shortcutFormat, () => ({
  getShortcutDisplay: () => "ctrl+o",
}));
vi.mock(mocks.paths.upgradeCheck, () => ({
  getUpgradeMessage: () => undefined,
}));
vi.mock(mocks.paths.messages, () => ({
  getMessagesAfterCompactBoundary: (messages: unknown[]) => messages,
}));
vi.mock(mocks.paths.log, () => ({
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
    mocks.executePreCompactHooks.mockResolvedValue({
      newCustomInstructions: "hook guidance",
      userDisplayMessage: "pre-hook note",
    });
    mocks.buildCompactCacheSafeParams.mockResolvedValue({
      cacheKey: "compact-cache",
    });
  });

  it("routes manual /compact through reactive compaction in reactive-only mode after a session-memory miss", async () => {
    const context = createContext();
    const reactiveResult = {
      boundaryMarker: { role: "system", content: "boundary" },
      summaryMessages: [{ role: "user", content: "summary" }],
      attachments: [],
      hookResults: [],
      messagesToKeep: [{ role: "assistant", content: "kept tail" }],
      userDisplayMessage: "reactive note",
    };
    mocks.reactiveCompactOnPromptTooLong.mockResolvedValueOnce({
      ok: true,
      result: reactiveResult,
    });

    const result = await runManualCompact("", context as never);

    expect(mocks.trySessionMemoryCompaction).toHaveBeenCalledWith(
      context.messages,
      "agent-1",
    );
    expect(mocks.executePreCompactHooks).toHaveBeenCalledWith(
      {
        trigger: "manual",
        customInstructions: null,
      },
      context.abortController.signal,
    );
    expect(mocks.buildCompactCacheSafeParams).toHaveBeenCalledWith(
      context,
      context.messages,
    );
    expect(mocks.reactiveCompactOnPromptTooLong).toHaveBeenCalledWith(
      context.messages,
      { cacheKey: "compact-cache" },
      {
        customInstructions: "hook guidance",
        trigger: "manual",
      },
    );
    expect(mocks.microcompactMessages).not.toHaveBeenCalled();
    expect(mocks.compactConversation).not.toHaveBeenCalled();
    expect(result.compactionResult.userDisplayMessage).toBe(
      "pre-hook note\nreactive note",
    );
    expect(result.displayText).toContain("pre-hook note");
    expect(result.displayText).toContain("reactive note");
    expect(mocks.setLastSummarizedMessageId).toHaveBeenCalledWith(undefined);
    expect(mocks.runPostCompactCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.suppressCompactWarning).toHaveBeenCalledTimes(1);
    expect(mocks.clearUserContextCache).toHaveBeenCalledTimes(1);
  });
});
