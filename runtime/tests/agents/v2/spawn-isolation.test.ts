import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../delegate.js", () => ({
  delegate: vi.fn(),
}));

import { createSpawnAgentTool } from "./spawn.js";
import { delegate } from "../delegate.js";
import type { MultiAgentV2Options } from "./common.js";
import type { Session } from "../../session/session.js";
import { createAgentRoleWorkspace } from "../role.js";
import { signSessionId } from "../_deps/filesystem-args.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/repo");

const mockDelegate = vi.mocked(delegate);

interface FakeSchema {
  readonly properties: Record<string, Record<string, unknown>>;
}

function fakeThread(
  withWorktree: boolean,
  opts: {
    readonly threadId?: string;
    readonly agentPath?: string;
    readonly worktreeSlug?: string;
  } = {},
): unknown {
  const threadId = opts.threadId ?? "thread-x";
  const agentPath = opts.agentPath ?? "/root/writer_a";
  const worktreeSlug = opts.worktreeSlug ?? "writer_a";
  return {
    threadId,
    live: {
      agentId: threadId,
      agentPath,
      nickname: "wt",
      role: { name: "default" },
      status: { value: "running", watch: () => () => {} },
    },
    ...(withWorktree
      ? {
          worktree: {
            path: `/repo/.agenc-worktrees/${worktreeSlug}`,
            branch: `worktree-${worktreeSlug}`,
            gitRoot: "/repo",
            created: true,
          },
        }
      : {}),
    onStatusChange: () => () => {},
    join: async () => ({
      threadId,
      durationMs: 1,
      outcome: "completed",
    }),
  };
}

function makeSession(): Session {
  const emitted: unknown[] = [];
  return {
    conversationId: "conv-1",
    roleWorkspace: ROLE_WORKSPACE,
    emit: (event: unknown) => emitted.push(event),
    nextInternalSubId: () => `sub-${emitted.length}`,
    modelInfo: { slug: "test-model" },
    sessionConfiguration: {
      cwd: "/repo",
      collaborationMode: { model: "test-model" },
    },
    config: { multiAgentV2: { hideSpawnAgentMetadata: false } },
    services: {
      modelsManager: {
        tryListModels: () => undefined,
        listModels: async () => [],
        getModelInfo: async () => ({ slug: "test-model" }),
      },
    },
  } as unknown as Session;
}

function makeOptions(
  session: Session,
  liveById: Readonly<Record<string, unknown>> = {},
): MultiAgentV2Options {
  return {
    getSession: () => session,
    workspace: ROLE_WORKSPACE,
    ensureAgentControl: () => ({
      control: {
        roleWorkspace: ROLE_WORKSPACE,
        assertRoleWorkspace: () => {},
        getLive: (id: string) => liveById[id],
      },
      registry: {},
    }),
  } as unknown as MultiAgentV2Options;
}

describe("spawn_agent isolation", () => {
  beforeEach(() => {
    mockDelegate.mockReset();
  });

  it("exposes the isolation enum in the input schema", () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    const schema = tool.inputSchema as unknown as FakeSchema;
    expect(schema.properties.isolation?.enum).toEqual(["none", "worktree"]);
    expect(String(schema.properties.isolation?.description)).toContain(
      "worktree",
    );
  });

  it("passes a session/path/spawn-scoped worktree slug through to delegate", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    mockDelegate.mockImplementationOnce(async (delegateOpts) => {
      const worktreeSlug = delegateOpts.worktreeSlug;
      return {
        kind: "async_launched",
        thread: fakeThread(true, {
          ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        }) as never,
      };
    });
    const result = await tool.execute({
      message: "write the parser",
      task_name: "writer_a",
      fork_turns: "none",
      isolation: "worktree",
      __callId: "spawn-writer-a",
    });
    const delegateOpts = mockDelegate.mock.calls[0]?.[0];
    expect(delegateOpts).toEqual(
      expect.objectContaining({ isolation: "worktree" }),
    );
    const worktreeSlug = delegateOpts?.worktreeSlug;
    expect(worktreeSlug).toMatch(/^writer_a-[a-f0-9]{32}$/u);
    expect(worktreeSlug?.length).toBeLessThanOrEqual(64);
    const payload = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >;
    expect(payload.isolation).toBe("worktree");
    expect(payload.worktree_path).toBe(
      `/repo/.agenc-worktrees/${worktreeSlug}`,
    );
    expect(payload.worktree_branch).toBe(`worktree-${worktreeSlug}`);
  });

  it("gives nested parents with the same child name distinct worktree paths and branches", async () => {
    const session = makeSession();
    const liveById = {
      "parent-a": {
        agentId: "parent-a",
        agentPath: "/root/parent_a",
        nickname: "parent-a",
        role: { name: "default" },
      },
      "parent-b": {
        agentId: "parent-b",
        agentPath: "/root/parent_b",
        nickname: "parent-b",
        role: { name: "default" },
      },
    };
    const tool = createSpawnAgentTool(makeOptions(session, liveById));
    let threadCounter = 0;
    mockDelegate.mockImplementation(async (delegateOpts) => {
      threadCounter += 1;
      const worktreeSlug = delegateOpts.worktreeSlug;
      return {
        kind: "async_launched",
        thread: fakeThread(true, {
          threadId: `thread-${threadCounter}`,
          agentPath: `${delegateOpts.parentPath}/shared_writer`,
          ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        }) as never,
      };
    });

    const first = await tool.execute({
      message: "write from parent A",
      task_name: "shared_writer",
      isolation: "worktree",
      __agencSessionId: "parent-a",
      __agencSessionIdSig: signSessionId("parent-a"),
      __callId: "shared-spawn-epoch",
    });
    const second = await tool.execute({
      message: "write from parent B",
      task_name: "shared_writer",
      isolation: "worktree",
      __agencSessionId: "parent-b",
      __agencSessionIdSig: signSessionId("parent-b"),
      __callId: "shared-spawn-epoch",
    });

    const firstOpts = mockDelegate.mock.calls[0]?.[0];
    const secondOpts = mockDelegate.mock.calls[1]?.[0];
    expect(firstOpts?.parentPath).toBe("/root/parent_a");
    expect(secondOpts?.parentPath).toBe("/root/parent_b");
    expect(firstOpts?.worktreeSlug).not.toBe(secondOpts?.worktreeSlug);
    expect(firstOpts?.worktreeSlug).toMatch(
      /^shared_writer-[a-f0-9]{32}$/u,
    );
    expect(secondOpts?.worktreeSlug).toMatch(
      /^shared_writer-[a-f0-9]{32}$/u,
    );

    const firstPayload = JSON.parse(String(first.content)) as Record<
      string,
      unknown
    >;
    const secondPayload = JSON.parse(String(second.content)) as Record<
      string,
      unknown
    >;
    expect(firstPayload.worktree_path).not.toBe(secondPayload.worktree_path);
    expect(firstPayload.worktree_branch).not.toBe(
      secondPayload.worktree_branch,
    );
  });

  it("gives a later logical respawn at the same path a fresh worktree", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    let threadCounter = 0;
    mockDelegate.mockImplementation(async (delegateOpts) => {
      threadCounter += 1;
      const worktreeSlug = delegateOpts.worktreeSlug;
      return {
        kind: "async_launched",
        thread: fakeThread(true, {
          threadId: `respawn-thread-${threadCounter}`,
          agentPath: "/root/shared_writer",
          ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        }) as never,
      };
    });

    const first = await tool.execute({
      message: "first logical worker",
      task_name: "shared_writer",
      isolation: "worktree",
      __callId: "spawn-epoch-one",
    });
    const second = await tool.execute({
      message: "replacement logical worker",
      task_name: "shared_writer",
      isolation: "worktree",
      __callId: "spawn-epoch-two",
    });

    const firstOpts = mockDelegate.mock.calls[0]?.[0];
    const secondOpts = mockDelegate.mock.calls[1]?.[0];
    expect(firstOpts?.parentPath).toBe("/root");
    expect(secondOpts?.parentPath).toBe("/root");
    expect(firstOpts?.worktreeSlug).not.toBe(secondOpts?.worktreeSlug);

    const firstPayload = JSON.parse(String(first.content)) as Record<
      string,
      unknown
    >;
    const secondPayload = JSON.parse(String(second.content)) as Record<
      string,
      unknown
    >;
    expect(firstPayload.worktree_path).not.toBe(secondPayload.worktree_path);
    expect(firstPayload.worktree_branch).not.toBe(
      secondPayload.worktree_branch,
    );
  });

  it("omits isolation from delegate opts when not requested", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    mockDelegate.mockResolvedValueOnce({
      kind: "async_launched",
      thread: fakeThread(false) as never,
    });
    const result = await tool.execute({
      message: "scan the repo",
      task_name: "scanner_a",
      fork_turns: "none",
    });
    const delegateOpts = mockDelegate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(delegateOpts.isolation).toBeUndefined();
    expect(delegateOpts.worktreeSlug).toBeUndefined();
    const payload = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >;
    expect(payload.worktree_path).toBeUndefined();
  });

  it("rejects invalid isolation values before spawning", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    const result = await tool.execute({
      message: "do it",
      task_name: "x",
      isolation: "chroot",
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(
      "isolation must be `none` or `worktree`",
    );
    expect(mockDelegate).not.toHaveBeenCalled();
  });
});
