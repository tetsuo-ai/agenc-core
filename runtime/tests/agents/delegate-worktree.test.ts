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

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStatusTracker } from "./status.js";
import { Mailbox } from "./mailbox.js";
import { createAgentRoleWorkspace, resolveAgentRole } from "./role.js";
import { delegate } from "./delegate.js";
import { runAgent } from "./run-agent.js";
import type { LiveAgent } from "./control.js";
import type { AgentMetadata } from "./registry.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const mockRunAgent = vi.mocked(runAgent);
const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

function makeLive(agentId: string, agentPath: string): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: "wt",
    agentRole: "default",
    agentRoleWorkspaceId: ROLE_WORKSPACE.id,
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(ROLE_WORKSPACE, undefined),
    depth: 1,
    nickname: "wt",
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  } as unknown as LiveAgent;
}

function makeParentSession(cwd: string) {
  return {
    conversationId: "parent-session",
    abortController: new AbortController(),
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    snapshotHistoryMessages: () => [],
    sessionConfiguration: { cwd },
    config: { cwd },
    services: {
      sandboxExecutionBroker: explicitDangerBroker.forkForCwd(cwd),
    },
  };
}

function git(cwd: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd, encoding: "utf8" });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agenc-wt-repo-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@test.invalid");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  return repo;
}

function gatedRun(): {
  release: () => void;
  impl: () => AsyncGenerator<
    never,
    {
      threadId: string;
      durationMs: number;
      outcome: "completed";
      finalMessage: string;
    }
  >;
} {
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => {
    releaseFn = resolveGate;
  });
  return {
    release: () => releaseFn(),
    impl: () =>
      (async function* () {
        await gate;
        return {
          threadId: "t",
          durationMs: 1,
          outcome: "completed" as const,
          finalMessage: "done",
        };
      })(),
  };
}

describe("delegate worktree isolation (real git)", () => {
  it("gives two agents distinct worktrees; unchanged ones are removed, dirty ones kept", async () => {
    const repo = initRepo();
    try {
      const gateA = gatedRun();
      const gateB = gatedRun();
      mockRunAgent
        .mockImplementationOnce(gateA.impl)
        .mockImplementationOnce(gateB.impl);
      const control = {
        spawn: vi
          .fn()
          .mockResolvedValueOnce(makeLive("thread-a", "/root/agent_a"))
          .mockResolvedValueOnce(makeLive("thread-b", "/root/agent_b")),
        shutdown: vi.fn(async () => {}),
        markThreadSpawnEdgeClosed: vi.fn(async () => {}),
        resumeAgentFromRollout: vi.fn(),
      };
      const parent = makeParentSession(repo) as never;

      const outcomeA = await delegate({
        parent,
        parentPath: "/root",
        control: control as never,
        registry: {} as never,
        taskPrompt: "write files",
        isolation: "worktree",
        worktreeSlug: "agent_a",
      });
      const outcomeB = await delegate({
        parent,
        parentPath: "/root",
        control: control as never,
        registry: {} as never,
        taskPrompt: "write files too",
        isolation: "worktree",
        worktreeSlug: "agent_b",
      });
      if (outcomeA.kind !== "async_launched") {
        throw new Error(`A: ${JSON.stringify(outcomeA)}`);
      }
      if (outcomeB.kind !== "async_launched") {
        throw new Error(`B: ${JSON.stringify(outcomeB)}`);
      }

      const pathA = outcomeA.thread.worktree?.path;
      const pathB = outcomeB.thread.worktree?.path;
      expect(pathA).toBeDefined();
      expect(pathB).toBeDefined();
      expect(pathA).not.toBe(pathB);
      expect(existsSync(pathA!)).toBe(true);
      expect(existsSync(pathB!)).toBe(true);

      // Both "agents" write the same relative file — no conflict, they
      // live in different directories.
      writeFileSync(join(pathA!, "shared.txt"), "from A", "utf8");
      // B stays clean (simulates a no-op agent).

      gateA.release();
      gateB.release();
      await outcomeA.thread.join();
      await outcomeB.thread.join();

      // A is dirty → kept for review. B unchanged → removed.
      expect(existsSync(pathA!)).toBe(true);
      expect(existsSync(pathB!)).toBe(false);
      // The parent working tree never saw the write.
      expect(existsSync(join(repo, "shared.txt"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("threads the immutable turn-start SHA even when the worker advances HEAD", async () => {
    const repo = initRepo();
    try {
      const firstSha = git(repo, "rev-parse", "HEAD").trim();
      let capturedBase: string | undefined;
      let workerHead: string | undefined;
      mockRunAgent.mockImplementationOnce((params) =>
        (async function* () {
          capturedBase = params.worktreeBaseCommit;
          const worktreePath = params.worktree?.path;
          if (worktreePath === undefined) throw new Error("missing worktree");
          writeFileSync(join(worktreePath, "result.txt"), "result\n", "utf8");
          git(worktreePath, "add", "result.txt");
          git(worktreePath, "commit", "-m", "agent result");
          workerHead = git(worktreePath, "rev-parse", "HEAD").trim();
          return {
            threadId: params.live.agentId,
            durationMs: 1,
            outcome: "completed" as const,
            finalMessage: "done",
          };
        })(),
      );
      const control = {
        spawn: vi
          .fn()
          .mockResolvedValue(makeLive("thread-sha", "/root/agent_sha")),
        shutdown: vi.fn(async () => {}),
        markThreadSpawnEdgeClosed: vi.fn(async () => {}),
        resumeAgentFromRollout: vi.fn(),
      };

      const outcome = await delegate({
        parent: makeParentSession(repo) as never,
        parentPath: "/root",
        control: control as never,
        registry: {} as never,
        taskPrompt: "commit the result",
        isolation: "worktree",
        worktreeSlug: "agent_sha",
        forceSynchronous: true,
      });

      expect(outcome.kind).toBe("sync_completed");
      expect(capturedBase).toBe(firstSha);
      expect(workerHead).toMatch(/^[0-9a-f]{40}$/);
      expect(workerHead).not.toBe(firstSha);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects worktree isolation outside a git repository", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "agenc-wt-plain-"));
    try {
      const control = {
        spawn: vi.fn(),
        shutdown: vi.fn(),
        resumeAgentFromRollout: vi.fn(),
      };
      const outcome = await delegate({
        parent: makeParentSession(plainDir) as never,
        parentPath: "/root",
        control: control as never,
        registry: {} as never,
        taskPrompt: "task",
        isolation: "worktree",
        worktreeSlug: "agent_x",
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.reason).toContain("not inside a git repository");
      }
      expect(control.spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("captures the resumed base without deleting pre-existing retained work", async () => {
    const repo = initRepo();
    try {
      const worktreePath = join(repo, ".agenc-worktrees", "agent_resume");
      git(repo, "worktree", "add", "-b", "worktree-agent_resume", worktreePath);
      writeFileSync(join(worktreePath, "agent.txt"), "already committed\n");
      git(worktreePath, "add", "agent.txt");
      git(worktreePath, "commit", "-m", "existing agent work");
      expect(git(worktreePath, "rev-parse", "HEAD").trim()).not.toBe(
        git(repo, "rev-parse", "HEAD").trim(),
      );

      const gate = gatedRun();
      mockRunAgent.mockImplementationOnce(gate.impl);
      const control = {
        spawn: vi
          .fn()
          .mockResolvedValue(makeLive("thread-resume", "/root/agent_resume")),
        shutdown: vi.fn(async () => {}),
        markThreadSpawnEdgeClosed: vi.fn(async () => {}),
        resumeAgentFromRollout: vi.fn(),
      };

      const outcome = await delegate({
        parent: makeParentSession(repo) as never,
        parentPath: "/root",
        control: control as never,
        registry: {} as never,
        taskPrompt: "inspect without changes",
        isolation: "worktree",
        worktreeSlug: "agent_resume",
      });
      if (outcome.kind !== "async_launched") {
        throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
      }

      gate.release();
      await outcome.thread.join();

      // A turn-relative base must not erase commits retained before this
      // invocation. Resumed worktrees require an explicit later cleanup even
      // when the current turn itself is a no-op.
      expect(existsSync(worktreePath)).toBe(true);
      expect(git(worktreePath, "show", "HEAD:agent.txt").trim()).toBe(
        "already committed",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
