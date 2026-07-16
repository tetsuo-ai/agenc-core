import { describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLock } from "../utils/async-lock.js";
import type { LLMContentPart } from "../llm/types.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { Session, SessionState } from "../session/session.js";
import { SessionStartupPrewarmStore } from "../session/startup-prewarm.js";
import { AgentControl, type LiveAgent } from "../agents/control.js";
import { AgenCThread } from "../agents/thread-manager.js";
import { Mailbox } from "../agents/mailbox.js";
import { AgentRegistry, type AgentMetadata } from "../agents/registry.js";
import {
  createAgentRoleWorkspace,
  resolveAgentRole,
} from "../agents/role.js";
import { AgentStatusTracker } from "../agents/status.js";
import { ConversationThreadManager } from "./thread-manager.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

function makeSession(conversationId = "root-thread") {
  const state = new AsyncLock<SessionState>({
    sessionConfiguration: {
      cwd: ROLE_WORKSPACE.cwd,
    } as SessionState["sessionConfiguration"],
    history: [],
  });
  let rolloutPersistenceSuspendDepth = 0;
  return {
    conversationId,
    roleWorkspace: ROLE_WORKSPACE,
    state,
    agentStatus: {
      value: { status: "pending_init" },
      subscribe: vi.fn(() => vi.fn()),
    },
    submit: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTerminal: vi.fn(),
    mailbox: { send: vi.fn(() => 1) },
    services: {
      mcpManager: { refreshFromConfig: vi.fn(async () => {}) },
      provider: { name: "stub" },
    },
    emit: vi.fn(),
    nextInternalSubId: vi.fn(() => "sub-root-thread-1"),
    newDefaultTurn: vi.fn(() => ({ subId: "sub-root-thread-0" })),
    newDefaultTurnWithSubId: vi.fn((subId: string) => ({ subId })),
    isRolloutPersistenceSuspended: vi.fn(
      () => rolloutPersistenceSuspendDepth > 0,
    ),
    withRolloutPersistenceSuspended: vi.fn(async (fn: () => Promise<unknown>) => {
      rolloutPersistenceSuspendDepth += 1;
      try {
        return await fn();
      } finally {
        rolloutPersistenceSuspendDepth -= 1;
      }
    }),
  } as unknown as Session & {
    readonly state: AsyncLock<SessionState>;
    readonly submit: ReturnType<typeof vi.fn>;
    readonly emit: ReturnType<typeof vi.fn>;
    readonly nextInternalSubId: ReturnType<typeof vi.fn>;
    readonly newDefaultTurn: ReturnType<typeof vi.fn>;
    readonly newDefaultTurnWithSubId: ReturnType<typeof vi.fn>;
    readonly isRolloutPersistenceSuspended: ReturnType<typeof vi.fn>;
    readonly withRolloutPersistenceSuspended: ReturnType<typeof vi.fn>;
  };
}

function makeLive(): LiveAgent {
  const metadata: AgentMetadata = {
    agentId: "child-thread",
    agentPath: "/root/task_1",
    agentNickname: "worker",
    agentRole: "default",
    agentRoleWorkspaceId: ROLE_WORKSPACE.id,
    depth: 1,
  };
  return {
    agentId: "child-thread",
    agentPath: "/root/task_1",
    role: resolveAgentRole(ROLE_WORKSPACE, "default"),
    depth: 1,
    nickname: "worker",
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: "child-thread-up" }),
    downInbox: new Mailbox({ threadId: "child-thread-down" }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

describe("ConversationThreadManager", () => {
  test("registers the root session and tracks per-thread conversation state", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager();

    const snapshot = await manager.registerConversationRootSession(session, {
      prewarm: false,
    });

    expect(snapshot.threadId).toBe("root-thread");
    expect(snapshot.kind).toBe("root");
    expect(snapshot.prewarm).toBe("skipped");
    expect(snapshot.historyLength).toBe(0);
    expect(manager.threadManager.listThreadIds()).toEqual(["root-thread"]);
    expect(manager.listSnapshots()).toHaveLength(1);
  });

  test("observes child threads and tracks their live transcript state", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager();
    await manager.registerConversationRootSession(session, { prewarm: false });
    const live = makeLive();

    manager.threadManager.registerLiveAgent(live, {
      parentThreadId: "root-thread",
    });
    await manager.submitTurn("child-thread", {
      type: "user_input",
      input: "child prompt",
    });
    live.messages.push({
      role: "assistant",
      content: "child answer",
    } as never);

    expect(
      manager
        .listSnapshots()
        .map((snapshot) => snapshot.threadId)
        .sort(),
    ).toEqual(["child-thread", "root-thread"]);
    expect(manager.snapshot("child-thread")).toMatchObject({
      kind: "agent",
      parentThreadId: "root-thread",
      historyLength: 1,
    });
    expect(live.downInbox.hasPending()).toBe(true);
  });

  test("AgentControl routes child input through the conversation manager", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager({ now: () => 7 });
    const registry = new AgentRegistry({ maxThreads: 4 });
    const control = new AgentControl({
      session,
      registry,
      threadManager: manager,
    });
    manager.bindAgentControl(control);
    await manager.registerConversationRootSession(session, { prewarm: false });
    control.registerSessionRoot("root-thread");
    manager.registerLiveAgent(makeLive(), {
      parentThreadId: "root-thread",
    });

    await control.sendInput("child-thread", "via control");

    expect(manager.snapshot("child-thread").lastSubmittedAtMs).toBe(7);
    expect(manager.snapshot("child-thread").historyLength).toBe(0);
  });

  test("keeps inherited thread-manager methods on the wrapped manager state", async () => {
    const manager = new ConversationThreadManager();
    const live = makeLive();
    const thread = new AgenCThread({
      threadId: "manual-child",
      agentPath: live.agentPath,
      kind: "agent",
      live,
    });

    await manager.finalizeThreadSpawn(thread);

    expect(manager.state).toBe(manager.threadManager.state);
    expect(manager.hasThread("manual-child")).toBe(true);
    expect(manager.threadManager.hasThread("manual-child")).toBe(true);
    expect(manager.snapshot("manual-child")).toMatchObject({
      kind: "agent",
      historyLength: 0,
    });
  });

  test("replays rollout history into the live session state", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager({ now: () => 42 });
    await manager.registerConversationRootSession(session, { prewarm: false });
    const rolloutItems: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "turn-start",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t1" } },
        },
      },
      {
        type: "turn_context",
        payload: {
          turnId: "t1",
          cwd: "/tmp",
          approvalPolicy: "never",
          sandboxPolicy: "workspace-write",
          model: "grok-4",
          realtimeActive: true,
        } as unknown as RolloutItem extends {
          readonly type: "turn_context";
          readonly payload: infer P;
        }
          ? P
          : never,
      },
      { type: "response_item", payload: { role: "user", content: "hello" } },
      {
        type: "event_msg",
        payload: {
          id: "turn-complete",
          seq: 2,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
      },
    ];

    const replay = await manager.replayRolloutIntoSession(
      session,
      rolloutItems,
    );
    const state = session.state.unsafePeek();
    const snapshot = manager.snapshot("root-thread");

    expect(replay.appliedState).toBe(state);
    expect(state.history).toEqual([{ role: "user", content: "hello" }]);
    expect(state.previousTurnSettings?.model).toBe("grok-4");
    expect(state.previousTurnSettings?.realtimeActive).toBe(true);
    expect(state.referenceContextItem).toBeDefined();
    expect(snapshot.historyLength).toBe(1);
    expect(snapshot.rolloutItemCount).toBe(4);
    expect(snapshot.lastReplayAtMs).toBe(42);
  });

  test("forks a distinct replayed thread from truncated rollout history", async () => {
    const session = makeSession();
    const rolloutItems: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "first ask" } },
      {
        type: "response_item",
        payload: { role: "assistant", content: "first answer" },
      },
      {
        type: "response_item",
        payload: { role: "user", content: "second ask" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "second answer" },
      },
    ];
    const rolloutStore = {
      readAll: () => rolloutItems,
      rolloutPath: "/tmp/root-rollout.jsonl",
    };
    (session as Session & {
      rolloutStore?: typeof rolloutStore;
    }).rolloutStore = rolloutStore;
    const forkRunTurn = vi.fn(
      async function* (
        input: string | readonly LLMContentPart[],
        opts: { readonly history?: ReadonlyArray<RolloutItem["payload"]> },
      ) {
        const prior = opts.history ?? [];
        await session.state.update((current) => {
          const next = {
            ...current,
            history: [
              ...prior,
              { role: "user", content: input },
              { role: "assistant", content: "fork answer" },
            ],
          } as SessionState;
          return { next, result: undefined };
        });
        yield { type: "turn_complete" } as never;
      },
    );
    (
      session as Session & {
        runTurn: typeof forkRunTurn;
        emitPhaseEvent: ReturnType<typeof vi.fn>;
      }
    ).runTurn = forkRunTurn;
    (
      session as Session & {
        runTurn: typeof forkRunTurn;
        emitPhaseEvent: ReturnType<typeof vi.fn>;
      }
    ).emitPhaseEvent = vi.fn();
    const manager = new ConversationThreadManager({ now: () => 45 });
    await manager.registerConversationRootSession(session, { prewarm: false });

    const forked = await manager.forkThread(session, {
      kind: "truncate_before_nth_user_message",
      n: 1,
    });

    expect(forked.threadId).not.toBe("root-thread");
    expect(manager.hasThread(forked.threadId)).toBe(true);
    const secondFork = await manager.forkThread(session, {
      kind: "truncate_before_nth_user_message",
      n: 1,
    });
    expect(secondFork.threadId).not.toBe(forked.threadId);
    expect(manager.listThreadIds().sort()).toEqual([
      forked.threadId,
      "root-thread",
      secondFork.threadId,
    ].sort());
    expect(manager.snapshot(forked.threadId)).toMatchObject({
      kind: "root",
      historyLength: 2,
      rolloutItemCount: 2,
      lastReplayAtMs: 45,
    });
    await expect(
      manager.submitTurn(forked.threadId, {
        type: "user_input",
        input: "continue fork",
      }),
    ).resolves.toBe(forked.threadId);
    expect(forkRunTurn).toHaveBeenCalledWith(
      "continue fork",
      expect.objectContaining({
        history: [
          { role: "user", content: "first ask" },
          { role: "assistant", content: "first answer" },
        ],
      }),
    );
    expect(manager.snapshot(forked.threadId)).toMatchObject({
      historyLength: 4,
      lastSubmittedAtMs: 45,
    });
    expect(session.state.unsafePeek().history).toEqual([]);
    expect(session.rolloutStore).toBe(rolloutStore);
  });

  test("serializes forked turns behind root turns for the same source session", async () => {
    const session = makeSession();
    const rolloutItems: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "first ask" } },
      {
        type: "response_item",
        payload: { role: "assistant", content: "first answer" },
      },
    ];
    (session as Session & {
      rolloutStore?: { readAll(): RolloutItem[]; rolloutPath: string };
    }).rolloutStore = {
      readAll: () => rolloutItems,
      rolloutPath: "/tmp/root-rollout.jsonl",
    };
    let releaseRoot!: () => void;
    session.submit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRoot = resolve;
        }),
    );
    const forkRunTurn = vi.fn(
      async function* (
        input: string | readonly LLMContentPart[],
        opts: { readonly history?: ReadonlyArray<RolloutItem["payload"]> },
      ) {
        await session.state.update((current) => ({
          next: {
            ...current,
            history: [
              ...(opts.history ?? []),
              { role: "user", content: input },
              { role: "assistant", content: "fork answer" },
            ],
          } as SessionState,
          result: undefined,
        }));
        yield { type: "turn_complete" } as never;
      },
    );
    (
      session as Session & {
        runTurn: typeof forkRunTurn;
        emitPhaseEvent: ReturnType<typeof vi.fn>;
      }
    ).runTurn = forkRunTurn;
    (
      session as Session & {
        runTurn: typeof forkRunTurn;
        emitPhaseEvent: ReturnType<typeof vi.fn>;
      }
    ).emitPhaseEvent = vi.fn();
    const manager = new ConversationThreadManager({ now: () => 47 });
    await manager.registerConversationRootSession(session, { prewarm: false });
    const forked = await manager.forkThread(session);

    const rootSubmit = manager.submitTurn("root-thread", {
      type: "user_input",
      input: "root turn",
    });
    const forkSubmit = manager.submitTurn(forked.threadId, {
      type: "user_input",
      input: "fork turn",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(forkRunTurn).not.toHaveBeenCalled();
    releaseRoot();

    await expect(rootSubmit).resolves.toBe("root-thread");
    await expect(forkSubmit).resolves.toBe(forked.threadId);
    expect(forkRunTurn).toHaveBeenCalledTimes(1);
  });

  test("replays a resumed child thread rollout into the live transcript", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager({ now: () => 43 });
    await manager.registerConversationRootSession(session, { prewarm: false });
    const live = makeLive();
    manager.registerLiveAgent(live, {
      parentThreadId: "root-thread",
    });
    expect(live.messages).toEqual([]);

    const rolloutItems: RolloutItem[] = [
      {
        type: "response_item",
        payload: { role: "user", content: "child question" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "child answer" },
      },
    ];

    const replay = await manager.replayManagedThreadRollout(
      "child-thread",
      rolloutItems,
    );

    expect(replay.history).toHaveLength(2);
    expect(live.messages).toEqual([
      { role: "user", content: "child question" },
      { role: "assistant", content: "child answer" },
    ]);
    expect(manager.snapshot("child-thread")).toMatchObject({
      historyLength: 2,
      rolloutItemCount: 2,
      lastReplayAtMs: 43,
    });
  });

  test("auto-replays a restored child thread rollout from the sibling session directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-conversation-replay-"));
    try {
      const session = makeSession();
      const rootDir = join(tmp, "sessions", "root-thread");
      const childDir = join(tmp, "sessions", "child-thread");
      mkdirSync(rootDir, { recursive: true });
      mkdirSync(childDir, { recursive: true });
      const rootRolloutPath = join(rootDir, "rollout-root-thread.jsonl");
      const childRolloutPath = join(childDir, "rollout-child-thread.jsonl");
      writeFileSync(rootRolloutPath, "", "utf8");
      writeFileSync(
        childRolloutPath,
        [
          JSON.stringify({
            type: "response_item",
            payload: { role: "user", content: "restored child question" },
          }),
          JSON.stringify({
            type: "response_item",
            payload: { role: "assistant", content: "restored child answer" },
          }),
        ].join("\n"),
        "utf8",
      );
      (session as Session & { rolloutStore?: { rolloutPath: string } })
        .rolloutStore = { rolloutPath: rootRolloutPath };
      const manager = new ConversationThreadManager({ now: () => 44 });
      await manager.registerConversationRootSession(session, { prewarm: false });
      const live = makeLive();

      manager.registerLiveAgent(live, {
        parentThreadId: "root-thread",
      });

      expect(live.messages).toEqual([
        { role: "user", content: "restored child question" },
        { role: "assistant", content: "restored child answer" },
      ]);
      expect(manager.snapshot("child-thread")).toMatchObject({
        historyLength: 2,
        rolloutItemCount: 2,
        lastReplayAtMs: 44,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("records corrupt child rollout replay failure without crashing refresh", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-conversation-replay-"));
    try {
      const session = makeSession();
      const rootDir = join(tmp, "sessions", "root-thread");
      const childDir = join(tmp, "sessions", "child-thread");
      mkdirSync(rootDir, { recursive: true });
      mkdirSync(childDir, { recursive: true });
      const rootRolloutPath = join(rootDir, "rollout-root-thread.jsonl");
      const childRolloutPath = join(childDir, "rollout-child-thread.jsonl");
      writeFileSync(rootRolloutPath, "", "utf8");
      writeFileSync(childRolloutPath, "{bad-json\n", "utf8");
      (session as Session & { rolloutStore?: { rolloutPath: string } })
        .rolloutStore = { rolloutPath: rootRolloutPath };
      const manager = new ConversationThreadManager({ now: () => 46 });
      await manager.registerConversationRootSession(session, { prewarm: false });
      const live = makeLive();

      expect(() =>
        manager.registerLiveAgent(live, {
          parentThreadId: "root-thread",
        }),
      ).not.toThrow();

      expect(live.messages).toEqual([]);
      expect(manager.snapshot("child-thread")).toMatchObject({
        historyLength: 0,
        lastReplayAtMs: 46,
      });
      expect(manager.snapshot("child-thread").replayError).toBeTruthy();
      expect(manager.listSnapshots()).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("clears stale replay metadata when the rollout has no surviving turn context", async () => {
    const session = makeSession();
    await session.state.update((current) => ({
      next: {
        ...current,
        previousTurnSettings: { model: "old-model" },
        referenceContextItem: {
          turnId: "old-turn",
          cwd: "/old",
        } as never,
      },
      result: undefined,
    }));
    const manager = new ConversationThreadManager();

    await manager.replayRolloutIntoSession(session, [
      {
        type: "response_item",
        payload: { role: "assistant", content: "restored answer" },
      },
    ]);

    const state = session.state.unsafePeek();
    expect(state.previousTurnSettings).toBeUndefined();
    expect(state.referenceContextItem).toBeUndefined();
    expect(state.history).toEqual([
      { role: "assistant", content: "restored answer" },
    ]);
  });

  test("emits synthesized recovery events while replaying orphaned turns", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager();
    const rolloutItems: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "orphan-start",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "orphan-turn" } },
        },
      },
      { type: "response_item", payload: { role: "user", content: "mid-turn" } },
    ];

    const replay = await manager.replayRolloutIntoSession(
      session,
      rolloutItems,
      {
        emitSynthesized: true,
      },
    );

    expect(replay.reconstruction.orphanedTurnIds).toEqual(["orphan-turn"]);
    expect(session.emit).toHaveBeenCalled();
    expect(
      session.emit.mock.calls.some(
        ([event]) => event.msg.type === "turn_aborted",
      ),
    ).toBe(true);
    expect(
      manager.snapshot("root-thread").synthesizedEventCount,
    ).toBeGreaterThan(0);
  });

  test("routes turn operations through the managed execution loop", async () => {
    const session = makeSession();
    session.submit.mockImplementation(async (input: string) => {
      await session.state.update((current) => ({
        next: {
          ...current,
          history: [...current.history, { role: "user", content: input }],
        },
        result: undefined,
      }));
    });
    const manager = new ConversationThreadManager({ now: () => 100 });
    await manager.registerConversationRootSession(session, { prewarm: false });

    await manager.submitTurn("root-thread", {
      type: "user_input",
      input: "continue",
    });

    expect(session.submit).toHaveBeenCalledWith("continue");
    expect(manager.snapshot("root-thread").lastSubmittedAtMs).toBe(100);
    expect(manager.snapshot("root-thread").historyLength).toBe(1);
  });

  test("preserves structured root user input while routing through the execution loop", async () => {
    const session = makeSession();
    const input: readonly LLMContentPart[] = [
      { type: "text", text: "inspect this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    session.submit.mockImplementation(async (content) => {
      await session.state.update((current) => ({
        next: {
          ...current,
          history: [...current.history, { role: "user", content }],
        },
        result: undefined,
      }));
    });
    const manager = new ConversationThreadManager({ now: () => 101 });
    await manager.registerConversationRootSession(session, { prewarm: false });

    await manager.submitTurn("root-thread", {
      type: "user_input",
      input,
    });

    expect(session.submit).toHaveBeenCalledWith(input);
    expect(session.state.unsafePeek().history[0]).toEqual({
      role: "user",
      content: input,
    });
    expect(manager.snapshot("root-thread")).toMatchObject({
      lastSubmittedAtMs: 101,
      historyLength: 1,
    });
  });

  test("keeps structured child user input in mailbox metadata with display content", async () => {
    const session = makeSession();
    const input: readonly LLMContentPart[] = [
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xyz" } },
    ];
    const manager = new ConversationThreadManager({ now: () => 102 });
    await manager.registerConversationRootSession(session, { prewarm: false });
    const live = makeLive();
    manager.registerLiveAgent(live, {
      parentThreadId: "root-thread",
    });

    await manager.submitTurn("child-thread", {
      type: "user_input",
      input,
    });

    const [message] = live.downInbox.drain();
    expect(message).toMatchObject({
      content: "look at this\n[image]",
      triggerTurn: true,
      metadata: { kind: "user_input", inputContent: input },
    });
    expect(manager.snapshot("child-thread").lastSubmittedAtMs).toBe(102);
  });

  test("runs the default startup prewarm path", async () => {
    const session = makeSession();
    const manager = new ConversationThreadManager();

    const state = await manager.runStartupPrewarm(session);

    expect(state).toBe("ready");
    expect(session.newDefaultTurn).toHaveBeenCalledTimes(1);
    expect(manager.snapshot("root-thread").prewarm).toBe("ready");
  });

  test("runs provider startup prewarm when the session provider supports it", async () => {
    const session = makeSession();
    const providerHandle = {
      chatStream: vi.fn(async () => ({
        content: "prewarmed",
        toolCalls: [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        model: "test-model",
        finishReason: "stop",
      })),
    };
    const prewarmStartup = vi.fn(async () => providerHandle);
    (
      session.services.provider as { prewarmStartup?: typeof prewarmStartup }
    ).prewarmStartup = prewarmStartup;
    const manager = new ConversationThreadManager();

    const state = await manager.runStartupPrewarm(session);

    expect(state).toBe("ready");
    expect(prewarmStartup).toHaveBeenCalledWith({
      conversationId: "root-thread",
      threadId: "root-thread",
    });
    await expect(
      session.services.startupPrewarm?.consumeProviderHandle(),
    ).resolves.toBe(providerHandle);
    expect(manager.snapshot("root-thread").prewarm).toBe("ready");
  });

  test("keeps provider startup prewarm failure independent from startup status", async () => {
    const session = makeSession();
    const prewarmStartup = vi.fn(async () => {
      throw new Error("provider prewarm unavailable");
    });
    (
      session.services.provider as { prewarmStartup?: typeof prewarmStartup }
    ).prewarmStartup = prewarmStartup;
    const manager = new ConversationThreadManager();

    const state = await manager.runStartupPrewarm(session);

    expect(state).toBe("ready");
    expect(prewarmStartup).toHaveBeenCalledWith({
      conversationId: "root-thread",
      threadId: "root-thread",
    });
    expect(manager.snapshot("root-thread")).toMatchObject({
      prewarm: "ready",
    });
  });

  test("startup prewarm store disposes overwritten and cleared provider handles", async () => {
    const store = new SessionStartupPrewarmStore();
    const firstDispose = vi.fn(async () => {});
    const secondDispose = vi.fn(async () => {});

    store.setProviderHandle({
      chatStream: vi.fn(async () => ({
        content: "first",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      })),
      dispose: firstDispose,
    });
    store.setProviderHandle({
      chatStream: vi.fn(async () => ({
        content: "second",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      })),
      dispose: secondDispose,
    });
    await Promise.resolve();

    expect(firstDispose).toHaveBeenCalledTimes(1);
    await store.clear();
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  test("records default startup prewarm failure when turn context construction fails", async () => {
    const session = makeSession();
    session.newDefaultTurn.mockImplementation(() => {
      throw new Error("turn context unavailable");
    });
    const manager = new ConversationThreadManager();

    const state = await manager.runStartupPrewarm(session);

    expect(state).toBe("failed");
    expect(manager.snapshot("root-thread")).toMatchObject({
      prewarm: "failed",
      prewarmError: "turn context unavailable",
    });
  });

  test("runs startup prewarm and records failure without throwing", async () => {
    const session = makeSession();
    const prewarm = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const manager = new ConversationThreadManager({ prewarm });

    const state = await manager.runStartupPrewarm(session);
    const snapshot = manager.snapshot("root-thread");

    expect(state).toBe("failed");
    expect(prewarm).toHaveBeenCalledWith({
      session,
      threadId: "root-thread",
    });
    expect(snapshot.prewarm).toBe("failed");
    expect(snapshot.prewarmError).toBe("provider unavailable");
  });
});
