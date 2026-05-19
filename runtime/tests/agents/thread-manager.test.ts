import { describe, expect, it, vi } from "vitest";
import { AgentStatusTracker } from "./status.js";
import { Mailbox } from "./mailbox.js";
import { resolveAgentRole } from "./role.js";
import { ThreadManager } from "./thread-manager.js";
import type { LiveAgent } from "./control.js";
import type { AgentMetadata } from "./registry.js";

function makeSession() {
  return {
    conversationId: "root-thread",
    agentStatus: { value: { status: "pending_init" } },
    submit: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTerminal: vi.fn(),
    mailbox: { send: vi.fn(() => 1) },
    services: {
      mcpManager: { refreshFromConfig: vi.fn(async () => {}) },
    },
  } as never;
}

function makeLive(): LiveAgent {
  const metadata: AgentMetadata = {
    agentId: "child-thread",
    agentPath: "/root/task_1",
    agentNickname: "scout",
    agentRole: "explorer",
    depth: 1,
  };
  return {
    agentId: "child-thread",
    agentPath: "/root/task_1",
    role: resolveAgentRole("explorer"),
    depth: 1,
    nickname: "scout",
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

describe("ThreadManager", () => {
  it("registers a root session and routes user input ops", async () => {
    const session = makeSession();
    const manager = new ThreadManager(session);

    expect(manager.listThreadIds()).toEqual(["root-thread"]);
    await manager.sendOp("root-thread", {
      type: "user_input",
      input: "hello",
    });

    expect(session.submit).toHaveBeenCalledWith("hello");
    expect(manager.getThread("root-thread").kind).toBe("root");
  });

  it("registers live agents and routes IAC through the child inbox", async () => {
    const manager = new ThreadManager(makeSession());
    const live = makeLive();
    const created: string[] = [];
    manager.subscribeThreadCreated((threadId) => created.push(threadId));

    manager.registerLiveAgent(live, { parentThreadId: "root-thread" });
    await manager.sendOp("child-thread", {
      type: "inter_agent_communication",
      communication: {
        author: "/root",
        recipient: "/root/task_1",
        content: "continue",
        triggerTurn: true,
      },
    });

    expect(created).toEqual(["child-thread"]);
    expect(live.downInbox.hasPending()).toBe(true);
    expect(manager.getThread("child-thread").parentThreadId).toBe("root-thread");
    expect(manager.getThread("child-thread").kind).toBe("agent");
  });

  it("routes trigger-turn IAC to the root mailbox and wakes without display text", async () => {
    const session = makeSession();
    const manager = new ThreadManager(session);

    await manager.sendOp("root-thread", {
      type: "inter_agent_communication",
      communication: {
        author: "/root/idoru",
        recipient: "/root",
        content: '[{ "name": "agenc-m2-next" }]',
        triggerTurn: true,
      },
    });

    expect(session.mailbox.send).toHaveBeenCalledWith({
      author: "/root/idoru",
      recipient: "/root",
      content: '[{ "name": "agenc-m2-next" }]',
      triggerTurn: true,
      direction: "up",
      metadata: { kind: "inter_agent_communication" },
    });
    expect(session.submit).toHaveBeenCalledWith("", {
      displayUserMessage: null,
    });
  });

  it("owns agent spawning when bound to AgentControl", async () => {
    const live = makeLive();
    const control = {
      spawnLiveAgentForThreadManager: vi.fn(async () => live),
    };
    const registry = {
      registerRootThread: vi.fn(),
      agentIdForPath: vi.fn(() => "root-thread"),
    };
    const manager = new ThreadManager({
      rootSession: makeSession(),
      control: control as never,
      registry: registry as never,
    });

    const spawned = await manager.spawnLiveAgent({
      parentPath: "/root",
      agentName: "task_1",
    });

    expect(spawned).toBe(live);
    expect(control.spawnLiveAgentForThreadManager).toHaveBeenCalledWith({
      parentPath: "/root",
      agentName: "task_1",
    });
    expect(manager.getThread("child-thread").parentThreadId).toBe("root-thread");
  });

  it("removes managed threads", () => {
    const manager = new ThreadManager(makeSession());
    manager.registerLiveAgent(makeLive());

    expect(manager.hasThread("child-thread")).toBe(true);
    expect(manager.removeThread("child-thread")?.threadId).toBe("child-thread");
    expect(manager.hasThread("child-thread")).toBe(false);
  });

  it("shuts down tracked threads within a bounded window", async () => {
    const session = makeSession();
    const manager = new ThreadManager(session);
    manager.registerLiveAgent(makeLive());

    const report = await manager.shutdownAllThreadsBounded(100);

    expect(report).toEqual({
      completed: ["child-thread", "root-thread"],
      submitFailed: [],
      timedOut: [],
    });
    expect(manager.listThreadIds()).toEqual([]);
    expect(session.shutdown).toHaveBeenCalled();
  });
});
