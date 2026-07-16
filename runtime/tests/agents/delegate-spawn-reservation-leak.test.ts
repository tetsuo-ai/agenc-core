import { describe, expect, it, vi } from "vitest";

vi.mock("./fork-context.js", () => ({
  forkSubagent: vi.fn(async () => ({
    messages: [{ role: "user", content: "seed prompt" }],
  })),
}));

vi.mock("./run-agent.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../session/event-log.js", () => ({
  emitWarning: vi.fn(),
}));

import { AgentStatusTracker } from "./status.js";
import { Mailbox } from "./mailbox.js";
import { createAgentRoleWorkspace, resolveAgentRole } from "./role.js";
import { delegate } from "./delegate.js";
import { runAgent } from "./run-agent.js";
import type { LiveAgent } from "./control.js";
import type { AgentMetadata } from "./registry.js";

const mockRunAgent = vi.mocked(runAgent);
const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

function makeLive(
  agentId: string,
  agentPath: string,
  nickname = "alpha",
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: nickname,
    agentRole: "default",
    agentRoleWorkspaceId: ROLE_WORKSPACE.id,
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(ROLE_WORKSPACE, undefined),
    depth: 1,
    nickname,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeParentSession() {
  return {
    conversationId: "parent-session",
    abortController: new AbortController(),
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    snapshotHistoryMessages: () => [],
    sessionConfiguration: { cwd: "/repo" },
    config: { cwd: "/repo" },
  };
}

function runResult(outcome: "completed" | "errored" | "aborted") {
  return (async function* () {
    return {
      threadId: "m0_inspector_1",
      durationMs: 5,
      outcome,
      ...(outcome === "errored" ? { error: new Error("first turn boom") } : {}),
    };
  })();
}

/**
 * Models the live path/slot reservation that the real registry + control own.
 * spawn() reserves /root/<name>; a second spawn at the same path throws
 * (mirroring AgentPathExistsError). releaseSpawnedThread() frees the path,
 * and control.shutdown() cascades into that release exactly once (idempotent).
 */
function makeHarness() {
  const byPath = new Map<string, string>();
  const path = "/root/m0_inspector_1";

  const registry = {
    releaseSpawnedThread: vi.fn(async (threadId: string) => {
      for (const [reservedPath, id] of byPath) {
        if (id === threadId) byPath.delete(reservedPath);
      }
    }),
  };

  const control = {
    spawn: vi.fn(async () => {
      if (byPath.has(path)) {
        throw new Error(`agent path already exists: ${path}`);
      }
      const live = makeLive("m0_inspector_1", path, "m0_inspector");
      byPath.set(path, live.agentId);
      return live;
    }),
    shutdown: vi.fn(async (threadId: string) => {
      await registry.releaseSpawnedThread(threadId);
    }),
    markThreadSpawnEdgeClosed: vi.fn(async () => {}),
    resumeAgentFromRollout: vi.fn(),
  };

  return { control, registry, byPath, path };
}

describe("delegate spawn-reservation leak on background errors", () => {
  it("releases the registry path when a background run errors so a re-spawn succeeds", async () => {
    const { control, registry, byPath, path } = makeHarness();

    mockRunAgent.mockImplementationOnce(() => runResult("errored"));

    const first = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: registry as never,
      taskPrompt: "inspect",
    });

    expect(first.kind).toBe("async_launched");
    if (first.kind !== "async_launched") throw new Error("expected async_launched");
    await first.thread.join();

    // The errored terminal outcome must have triggered delegate-scoped shutdown,
    // which releases the path reservation.
    expect(control.shutdown).toHaveBeenCalledWith(
      "m0_inspector_1",
      "delegate_teardown",
    );
    expect(registry.releaseSpawnedThread).toHaveBeenCalledWith("m0_inspector_1");
    expect(byPath.has(path)).toBe(false);

    // Retry: re-spawn at the same path must now succeed (no collision).
    mockRunAgent.mockImplementationOnce(() => runResult("completed"));
    const retry = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: registry as never,
      taskPrompt: "inspect again",
    });

    expect(retry.kind).toBe("async_launched");
    if (retry.kind !== "async_launched") throw new Error("expected async_launched");
    await retry.thread.join();
    expect(control.spawn).toHaveBeenCalledTimes(2);
  });

  it("leaves the slot reserved (no delegate shutdown) on a clean completion", async () => {
    const { control, registry, byPath, path } = makeHarness();

    mockRunAgent.mockImplementationOnce(() => runResult("completed"));

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: registry as never,
      taskPrompt: "inspect",
    });

    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") throw new Error("expected async_launched");
    await outcome.thread.join();

    // Completed async runs keep the fire-and-forget behavior: no delegate-scoped
    // shutdown, slot stays reserved until the lifecycle owner reclaims it.
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(byPath.has(path)).toBe(true);
  });
});
