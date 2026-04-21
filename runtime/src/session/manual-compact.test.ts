import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLock } from "../utils/async-lock.js";
import { buildPostCompactMessages } from "../llm/compact/compact.js";
import { runSessionManualCompact } from "./manual-compact.js";
import type { Session } from "./session.js";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("src/bootstrap/state.js", () => ({
  markPostCompaction: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  trySessionMemoryCompaction: vi.fn(),
  microcompactMessages: vi.fn(() => {
    throw new Error("unexpected fallback to traditional compaction");
  }),
  compactConversation: vi.fn(),
  runPostCompactCleanup: vi.fn(),
  notifyCompaction: vi.fn(),
  buildCompactCacheSafeParams: vi.fn(() => ({
    toolUseContext: {
      options: {
        querySource: "compact",
      },
    },
  })),
  paths: {
    compact: new URL(
      "../llm/compact/compact.js",
      import.meta.url,
    ).pathname,
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
    runtimeContext: new URL(
      "./compact-runtime-context.js",
      import.meta.url,
    ).pathname,
    promptCacheBreakDetection: new URL(
      "../services/api/promptCacheBreakDetection.js",
      import.meta.url,
    ).pathname,
    shortcutFormat: new URL(
      "../keybindings/shortcutFormat.js",
      import.meta.url,
    ).pathname,
    upgradeCheck: new URL(
      "../utils/model/contextWindowUpgradeCheck.js",
      import.meta.url,
    ).pathname,
    messages: new URL("../utils/messages.js", import.meta.url).pathname,
    hooks: new URL("../utils/hooks.js", import.meta.url).pathname,
  },
}));

vi.mock(mocks.paths.sessionMemoryCompact, () => ({
  trySessionMemoryCompaction: mocks.trySessionMemoryCompaction,
}));
vi.mock(mocks.paths.microCompact, () => ({
  microcompactMessages: mocks.microcompactMessages,
}));
vi.mock(mocks.paths.compact, () => {
  const buildPostCompactMessages = (result: {
    boundaryMarker?: unknown;
    summaryMessages?: unknown[];
    messagesToKeep?: unknown[];
    attachments?: unknown[];
    hookResults?: unknown[];
  }) => [
    ...(result.boundaryMarker ? [result.boundaryMarker] : []),
    ...(result.summaryMessages ?? []),
    ...(result.messagesToKeep ?? []),
    ...(result.attachments ?? []),
    ...(result.hookResults ?? []),
  ];
  const toResponseItem = (message: any) => {
    if (message?.role && message?.content !== undefined) {
      return { role: message.role, content: message.content };
    }
    if (message?.type && message?.message?.content !== undefined) {
      return {
        role: message.type,
        content: message.message.content,
      };
    }
    return null;
  };
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
    buildPostCompactMessages,
    buildCompactedRolloutItem: (result: any) => ({
      message:
        result.summaryMessages?.[0]?.message?.content ??
        result.summaryMessages?.[0]?.content ??
        "(no summary available)",
      replacementHistory: buildPostCompactMessages(result)
        .map(toResponseItem)
        .filter(Boolean),
    }),
    compactConversation: mocks.compactConversation,
  };
});
vi.mock(mocks.paths.postCompactCleanup, () => ({
  runPostCompactCleanup: mocks.runPostCompactCleanup,
}));
vi.mock(mocks.paths.runtimeContext, () => ({
  createSessionBackedCompactContext: (session: Session, opts: any) => ({
    abortController: session.abortController ?? new AbortController(),
    agentId: undefined,
    options: {
      tools: [],
      mainLoopModel:
        (
          session.state.unsafePeek() as {
            sessionConfiguration?: { collaborationMode?: { model?: string } };
          }
        ).sessionConfiguration?.collaborationMode?.model ?? "unknown",
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      querySource: opts.querySource,
      verbose: opts.verbose ?? false,
      isNonInteractiveSession: opts.isNonInteractiveSession,
    },
    getAppState: () => ({
      toolPermissionContext:
        session.services.permissionModeRegistry.current(),
      agentDefinitions: { activeAgents: [] },
    }),
    readFileState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    setStreamMode: () => {},
    setResponseLength: () => {},
    onCompactProgress: () => {},
    setSDKStatus: () => {},
    addNotification: () => {},
  }),
  buildCompactCacheSafeParams: mocks.buildCompactCacheSafeParams,
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
  formatCommandInputTags: (commandName: string, args: string) =>
    `<command-name>/${commandName}</command-name><command-args>${args}</command-args>`,
  createUserMessage: ({
    content,
    isMeta,
    timestamp,
  }: {
    content: string;
    isMeta?: boolean;
    timestamp?: string;
  }) => ({
    type: "user",
    isMeta,
    timestamp: timestamp ?? new Date().toISOString(),
    message: {
      role: "user",
      content,
    },
  }),
  createSyntheticUserCaveatMessage: () => ({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content:
        "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
    },
  }),
}));
vi.mock(mocks.paths.hooks, () => ({
  executePreCompactHooks: vi.fn(),
}));

function createSession(
  history: unknown[] = [],
  activeTurn: unknown = null,
): {
  session: Session;
  emit: ReturnType<typeof vi.fn>;
  appendRollout: ReturnType<typeof vi.fn>;
  reAppendSessionMetadata: ReturnType<typeof vi.fn>;
} {
  const state = new AsyncLock({
    history,
    sessionConfiguration: {
      cwd: "/ws",
      collaborationMode: { model: "gpt-5" },
    },
  });
  const emit = vi.fn();
  const appendRollout = vi.fn();
  const reAppendSessionMetadata = vi.fn();

  return {
    session: {
      activeTurn: { unsafePeek: () => activeTurn },
      abortController: new AbortController(),
      emit,
      nextInternalSubId: vi.fn(() => "sub-1"),
      rolloutStore: {
        appendRollout,
        store: {
          reAppendSessionMetadata,
        },
      },
      services: {
        registry: {
          toLLMTools: () => [],
        },
        permissionModeRegistry: {
          current: () => ({
            mode: "plan",
            additionalWorkingDirectories: new Map([
              ["/extra", { path: "/extra", source: "session" }],
            ]),
            alwaysAllowRules: {},
            alwaysDenyRules: {},
            alwaysAskRules: {},
            isBypassPermissionsModeAvailable: false,
          }),
        },
      },
      state,
    } as unknown as Session,
    emit,
    appendRollout,
    reAppendSessionMetadata,
  };
}

describe("runSessionManualCompact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owns the live session-memory compact path and reapplies the result to session state", async () => {
    const initialHistory = [
      { type: "user", message: { content: "first" } },
      { type: "assistant", message: { content: "second" } },
    ];
    const { session, emit, appendRollout, reAppendSessionMetadata } = createSession(
      initialHistory,
    );
    const compactionResult = {
      boundaryMarker: { type: "system", message: { content: "boundary" } },
      summaryMessages: [
        { type: "user", message: { content: "summary" } },
      ],
      attachments: [],
      hookResults: [],
      messagesToKeep: [{ type: "user", message: { content: "kept" } }],
      userDisplayMessage: "shortened",
    } as const;

    mocks.trySessionMemoryCompaction.mockResolvedValueOnce(compactionResult);

    const outcome = await runSessionManualCompact(session, "");
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") {
      throw new Error("expected compaction to run");
    }
    expect(outcome.text).toContain("Compacted");
    expect(mocks.trySessionMemoryCompaction).toHaveBeenCalledWith(
      initialHistory,
      undefined,
    );
    expect(mocks.runPostCompactCleanup).toHaveBeenCalledTimes(1);

    const updatedState = session.state.unsafePeek() as { history: unknown[] };
    const baseMessages = buildPostCompactMessages(compactionResult as never);
    expect(updatedState.history.slice(0, baseMessages.length)).toEqual(
      baseMessages,
    );
    const retainedTail = updatedState.history.slice(baseMessages.length) as Array<{
      type?: string;
      isMeta?: boolean;
      message?: { content?: string };
    }>;
    expect(retainedTail).toHaveLength(3);
    expect(retainedTail[0]).toMatchObject({
      type: "user",
      isMeta: true,
    });
    expect(retainedTail[1]?.message?.content).toContain(
      "<command-name>/compact</command-name>",
    );
    expect(retainedTail[2]?.message?.content).toContain(
      "<local-command-stdout>",
    );
    expect(retainedTail[2]?.message?.content).toContain("Compacted");
    expect(appendRollout).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compacted",
        payload: expect.objectContaining({
          message: "summary",
        }),
      }),
      { durable: true },
    );
    const rolloutPayload = appendRollout.mock.calls[0]?.[0]?.payload as {
      replacementHistory?: Array<{ role?: string; content?: string }>;
    };
    expect(rolloutPayload.replacementHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("<command-name>/compact</command-name>"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("<local-command-stdout>"),
        }),
      ]),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.objectContaining({ type: "context_compacted" }),
      }),
    );
    expect(reAppendSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("still blocks if a turn is currently active", async () => {
    const { session } = createSession([], { turnId: "t1" });

    const outcome = await runSessionManualCompact(session, "");

    expect(outcome).toEqual(
      expect.objectContaining({
        kind: "blocked",
      }),
    );
    expect(mocks.trySessionMemoryCompaction).not.toHaveBeenCalled();
  });

  it("builds the traditional compact path from live session permission state", async () => {
    const initialHistory = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ];
    const { session } = createSession(initialHistory);
    const compactionResult = {
      boundaryMarker: { role: "system", content: "boundary" },
      summaryMessages: [{ role: "user", content: "summary" }],
      attachments: [],
      hookResults: [],
      messagesToKeep: [{ role: "assistant", content: "kept" }],
      userDisplayMessage: "shortened",
    };

    mocks.trySessionMemoryCompaction.mockResolvedValueOnce(null);
    mocks.microcompactMessages.mockImplementationOnce(
      async (_messages, context) => {
        expect(context.options.querySource).toBe("compact");
        expect(context.options.mainLoopModel).toBe("gpt-5");
        expect(context.getAppState().toolPermissionContext.mode).toBe("plan");
        expect(
          context.getAppState().toolPermissionContext.additionalWorkingDirectories.has(
            "/extra",
          ),
        ).toBe(true);
        return { messages: initialHistory };
      },
    );
    mocks.compactConversation.mockResolvedValueOnce(compactionResult);

    const outcome = await runSessionManualCompact(
      session,
      "keep the last answer",
    );
    expect(outcome.kind).toBe("ran");
    const [
      messagesArg,
      compactContext,
      cacheSafeParams,
      suppressQuestions,
      instructionsArg,
      isAutoCompact,
    ] = mocks.compactConversation.mock.calls[0] ?? [];
    expect(messagesArg).toEqual(initialHistory);
    expect(compactContext.options.querySource).toBe("compact");
    expect(compactContext.options.mainLoopModel).toBe("gpt-5");
    expect(compactContext.options.isNonInteractiveSession).toBe(true);
    expect(compactContext.messages).toEqual(initialHistory);
    expect(typeof compactContext.getAppState).toBe("function");
    expect(cacheSafeParams.toolUseContext.options.querySource).toBe("compact");
    expect(suppressQuestions).toBe(false);
    expect(instructionsArg).toBe("keep the last answer");
    expect(isAutoCompact).toBe(false);
  });
});
