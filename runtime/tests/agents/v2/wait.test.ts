import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../session/session.js";
import { createWaitAgentTool } from "./wait.js";
import type { MultiAgentV2Options } from "./common.js";

function fixture(options?: {
  readonly maxConsecutiveWaitTimeouts?: number;
  readonly conversationId?: string;
}) {
  const waitForMailboxChange = vi.fn(async (_timeoutMs: number) => false);
  const emit = vi.fn();
  const session = {
    conversationId: options?.conversationId ?? "root-session",
    emit,
    nextInternalSubId: () => "sub-1",
    waitForMailboxChange,
    drainPendingInputMessages: () => [
      { role: "user", content: "child says: done" },
    ],
    config: {
      multiAgentV2: {
        minWaitTimeoutMs: 10_000,
        defaultWaitTimeoutMs: 30_000,
        maxWaitTimeoutMs: 3_600_000,
        ...(options?.maxConsecutiveWaitTimeouts !== undefined
          ? { maxConsecutiveWaitTimeouts: options.maxConsecutiveWaitTimeouts }
          : {}),
      },
    },
  } as unknown as Session;
  const registerSessionRoot = vi.fn();
  const listAgents = vi.fn(() => [
    {
      agentName: "/root",
      agentStatus: { status: "pending_init" as const },
      lastTaskMessage: "Main thread",
    },
    {
      agentName: "/root/verify_security_md",
      agentStatus: {
        status: "running" as const,
        turnId: "turn-1",
        startedAtMs: 1,
      },
      lastTaskMessage: "verify SECURITY.md",
    },
  ]);
  const opts = {
    getSession: () => session,
    workspace: {},
    ensureAgentControl: () => ({
      control: { registerSessionRoot, listAgents, getLive: () => undefined },
      registry: {},
    }),
  } as unknown as MultiAgentV2Options;
  const tool = createWaitAgentTool(opts);
  return { tool, session, waitForMailboxChange, listAgents, registerSessionRoot };
}

async function call(tool: ReturnType<typeof createWaitAgentTool>, args = {}) {
  const result = await tool.execute(args, {} as never);
  return { ...result, body: JSON.parse(result.content) as Record<string, unknown> };
}

describe("wait_agent consecutive timeouts", () => {
  it("counts timed-out waits and fails at the fourth with the agents' status", async () => {
    const { tool, listAgents } = fixture();
    for (let n = 1; n <= 3; n += 1) {
      const result = await call(tool);
      expect(result.isError).toBeUndefined();
      expect(result.body).toEqual({
        message: "Wait timed out.",
        timed_out: true,
        consecutive_timeouts: n,
        waited_ms: 30_000 * n,
      });
    }
    expect(listAgents).not.toHaveBeenCalled();
    const fourth = await call(tool);
    expect(fourth.isError).toBe(true);
    expect(fourth.body).toMatchObject({
      timed_out: true,
      consecutive_timeouts: 4,
      waited_ms: 120_000,
      agents: [
        {
          agent_name: "/root/verify_security_md",
          last_task_message: "verify SECURITY.md",
        },
      ],
    });
    const error = fourth.body.error as string;
    expect(error).toContain("timed out 4 times in a row (120 s)");
    expect(error).toContain("close_agent");
    expect(error).toContain("timeout_ms up to 3600000");
    // A fifth identical call keeps failing, so the tool-loop repeat guard can end the poll.
    const fifth = await call(tool);
    expect(fifth.isError).toBe(true);
    expect(fifth.body).toMatchObject({ consecutive_timeouts: 5 });
  });

  it("a completed wait clears the streak", async () => {
    const { tool, waitForMailboxChange } = fixture();
    await call(tool);
    await call(tool);
    await call(tool);
    waitForMailboxChange.mockResolvedValueOnce(true);
    const completed = await call(tool);
    expect(completed.isError).toBeUndefined();
    expect(completed.body).toEqual({
      message: "Wait completed.",
      timed_out: false,
      updates: [{ role: "user", content: "child says: done" }],
    });
    for (let n = 1; n <= 3; n += 1) {
      const result = await call(tool);
      expect(result.isError).toBeUndefined();
      expect(result.body).toMatchObject({ consecutive_timeouts: n });
    }
  });

  it("the threshold follows the session config and never drops below one", async () => {
    const two = fixture({ maxConsecutiveWaitTimeouts: 2 });
    expect((await call(two.tool)).isError).toBeUndefined();
    expect((await call(two.tool)).isError).toBe(true);
    const zero = fixture({ maxConsecutiveWaitTimeouts: 0 });
    const first = await call(zero.tool);
    expect(first.isError).toBe(true);
    expect(first.body).toMatchObject({ consecutive_timeouts: 1 });
  });

  it("counts the wait the model asked for, not the default", async () => {
    const { tool } = fixture();
    const result = await call(tool, { timeout_ms: 60_000 });
    expect(result.body).toMatchObject({ waited_ms: 60_000 });
  });

  it("keeps streaks per session", async () => {
    const a = fixture({ conversationId: "a" });
    const b = fixture({ conversationId: "b" });
    for (let n = 0; n < 3; n += 1) await call(a.tool);
    expect((await call(b.tool)).body).toMatchObject({ consecutive_timeouts: 1 });
    expect((await call(a.tool)).isError).toBe(true);
  });
});
