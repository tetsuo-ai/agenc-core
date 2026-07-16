import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../delegate.js", () => ({
  delegate: vi.fn(),
}));

import { createSpawnAgentTool } from "./spawn.js";
import { delegate } from "../delegate.js";
import type { MultiAgentV2Options } from "./common.js";
import type { Session } from "../../session/session.js";
import { createAgentRoleWorkspace } from "../role.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/repo");

const mockDelegate = vi.mocked(delegate);

interface FakeSchema {
  readonly properties: Record<string, Record<string, unknown>>;
}

function fakeThread(withWorktree: boolean): unknown {
  return {
    threadId: "thread-x",
    live: {
      agentId: "thread-x",
      agentPath: "/root/writer_a",
      nickname: "wt",
      role: { name: "default" },
      status: { value: "running", watch: () => () => {} },
    },
    ...(withWorktree
      ? {
          worktree: {
            path: "/repo/.agenc-worktrees/writer_a",
            branch: "agent/writer_a",
            gitRoot: "/repo",
            created: true,
          },
        }
      : {}),
    onStatusChange: () => () => {},
    join: async () => ({
      threadId: "thread-x",
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

function makeOptions(session: Session): MultiAgentV2Options {
  return {
    getSession: () => session,
    workspace: ROLE_WORKSPACE,
    ensureAgentControl: () => ({
      control: {
        roleWorkspace: ROLE_WORKSPACE,
        assertRoleWorkspace: () => {},
        getLive: () => undefined,
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

  it("passes isolation + worktreeSlug (task_name) through to delegate", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    mockDelegate.mockResolvedValueOnce({
      kind: "async_launched",
      thread: fakeThread(true) as never,
    });
    const result = await tool.execute({
      message: "write the parser",
      task_name: "writer_a",
      fork_turns: "none",
      isolation: "worktree",
    });
    expect(mockDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "worktree",
        worktreeSlug: "writer_a",
      }),
    );
    const payload = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >;
    expect(payload.isolation).toBe("worktree");
    expect(payload.worktree_path).toBe("/repo/.agenc-worktrees/writer_a");
    expect(payload.worktree_branch).toBe("agent/writer_a");
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
