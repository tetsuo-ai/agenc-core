import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLock } from "../utils/async-lock.js";
import { buildPostCompactMessages } from "../llm/compact/compact.js";
import { runSessionManualCompact } from "./manual-compact.js";
import type { Session } from "./session.js";

const mocks = vi.hoisted(() => ({
  trySessionMemoryCompaction: vi.fn(),
  microcompactMessages: vi.fn(() => {
    throw new Error("unexpected fallback to traditional compaction");
  }),
  compactConversation: vi.fn(),
  runPostCompactCleanup: vi.fn(),
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
  },
}));

vi.mock(mocks.paths.sessionMemoryCompact, () => ({
  trySessionMemoryCompaction: mocks.trySessionMemoryCompaction,
}));
vi.mock(mocks.paths.microCompact, () => ({
  microcompactMessages: mocks.microcompactMessages,
}));
vi.mock(mocks.paths.compact, async () => {
  const actual = await vi.importActual<typeof import("../llm/compact/compact.js")>(
    mocks.paths.compact,
  );
  return {
    ...actual,
    compactConversation: mocks.compactConversation,
  };
});
vi.mock(mocks.paths.postCompactCleanup, () => ({
  runPostCompactCleanup: mocks.runPostCompactCleanup,
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
    expect(updatedState.history).toEqual(
      buildPostCompactMessages(compactionResult as never),
    );
    expect(appendRollout).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compacted",
        payload: expect.objectContaining({
          message: "summary",
        }),
      }),
      { durable: true },
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
    expect(mocks.compactConversation).toHaveBeenCalledWith(
      initialHistory,
      expect.objectContaining({
        options: expect.objectContaining({
          querySource: "compact",
          mainLoopModel: "gpt-5",
        }),
        getAppState: expect.any(Function),
      }),
      expect.objectContaining({
        toolUseContext: expect.objectContaining({
          options: expect.objectContaining({
            querySource: "compact",
          }),
        }),
      }),
      false,
      "keep the last answer",
      false,
    );
  });
});
