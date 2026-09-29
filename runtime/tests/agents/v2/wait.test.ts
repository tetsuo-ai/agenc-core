import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../session/session.js";
import { mkSession } from "../../fixtures.js";
import { formatSubagentNotification } from "../../../src/agents/status.js";
import { createWaitAgentTool } from "./wait.js";
import type { MultiAgentV2Options } from "./common.js";

function fixture(options?: {
  readonly maxConsecutiveWaitTimeouts?: number;
  readonly conversationId?: string;
}) {
  const waitForMailboxChange = vi.fn(
    async (_timeoutMs: number, _ownership?: unknown, _signal?: AbortSignal) => false,
  );
  const emit = vi.fn();
  const turn = { turnId: "turn-1" };
  const session = {
    conversationId: options?.conversationId ?? "root-session",
    activeTurn: { unsafePeek: () => turn },
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
  const control = { registerSessionRoot, listAgents, getLive: () => undefined };
  const opts = {
    getSession: () => session,
    workspace: {},
    ensureAgentControl: () => ({
      control,
      registry: {},
    }),
  } as unknown as MultiAgentV2Options;
  const tool = createWaitAgentTool(opts);
  return {
    control,
    tool,
    session,
    turn,
    waitForMailboxChange,
    listAgents,
    registerSessionRoot,
  };
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

  it("returns at once when the turn's abort signal fires, and counts no timeout", async () => {
    // #2201: a stopped swarm held its parent turn open until the wait's deadline.
    const { tool, waitForMailboxChange } = fixture();
    const controller = new AbortController();
    waitForMailboxChange.mockImplementationOnce(async (_timeoutMs, _ownership, signal) => {
      controller.abort("interrupted");
      return signal?.aborted === true ? false : true;
    });
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, "__abortSignal", { value: controller.signal, enumerable: false });
    const interrupted = await call(tool, args);
    expect(interrupted.body).toMatchObject({ interrupted: true, timed_out: false });
    expect(waitForMailboxChange).toHaveBeenLastCalledWith(
      expect.any(Number),
      undefined,
      controller.signal,
    );
    const next = await call(tool);
    expect(next.body).toMatchObject({ timed_out: true, consecutive_timeouts: 1 });
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

  it("gives each turn its own budget", async () => {
    const { tool, turn } = fixture();
    for (let n = 1; n <= 3; n += 1) await call(tool);
    expect((await call(tool)).isError).toBe(true);
    // The next turn asks a fresh agent to work: the budget the previous
    // turn spent must not fail its first wait.
    turn.turnId = "turn-2";
    const first = await call(tool);
    expect(first.isError).toBeUndefined();
    expect(first.body).toEqual({
      message: "Wait timed out.",
      timed_out: true,
      consecutive_timeouts: 1,
      waited_ms: 30_000,
    });
  });

  it("charges a wait to the turn that started it, not the one that replaced it", async () => {
    const { tool, turn, waitForMailboxChange } = fixture();
    let releaseWait!: () => void;
    waitForMailboxChange.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      return false;
    });
    const inFlight = call(tool);
    await Promise.resolve();
    // An interrupt starts the next turn while the wait is still sleeping;
    // `waitForMailboxChange` has no abort signal, so it keeps running.
    turn.turnId = "turn-2";
    releaseWait();
    await inFlight;
    const first = await call(tool);
    expect(first.isError).toBeUndefined();
    expect(first.body).toEqual({
      message: "Wait timed out.",
      timed_out: true,
      consecutive_timeouts: 1,
      waited_ms: 30_000,
    });
  });

  it("keeps streaks per session", async () => {
    const a = fixture({ conversationId: "a" });
    const b = fixture({ conversationId: "b" });
    for (let n = 0; n < 3; n += 1) await call(a.tool);
    expect((await call(b.tool)).body).toMatchObject({ consecutive_timeouts: 1 });
    expect((await call(a.tool)).isError).toBe(true);
  });
});

describe("wait_agent turn budget on a real Session", () => {
  /**
   * The unit fixture above supplies its own `activeTurn` stub, so it cannot
   * tell whether the tool still reads the turn the runtime actually keeps.
   * Here only the sleep is stubbed: the turn ids, the `activeTurn` lock and
   * the spawn/finish boundary are the production ones.
   */
  function realFixture(): {
    readonly session: Session;
    readonly tool: ReturnType<typeof createWaitAgentTool>;
  } {
    const { session } = mkSession();
    vi.spyOn(session, "waitForMailboxChange").mockResolvedValue(false);
    const opts = {
      getSession: () => session,
      workspace: {},
      ensureAgentControl: () => ({
        control: {
          registerSessionRoot: () => {},
          listAgents: () => [],
          getLive: () => undefined,
        },
        registry: {},
      }),
    } as unknown as MultiAgentV2Options;
    return { session, tool: createWaitAgentTool(opts) };
  }

  it("spends the budget within a live turn and restarts it in the next", async () => {
    const { session, tool } = realFixture();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    for (let n = 1; n <= 3; n += 1) {
      expect((await call(tool)).body).toMatchObject({
        consecutive_timeouts: n,
      });
    }
    expect((await call(tool)).isError).toBe(true);

    await session.onTaskFinished("turn-A");
    await session.spawnTask({ subId: "turn-B", kind: "regular" });
    const first = await call(tool);
    expect(first.isError).toBeUndefined();
    expect(first.body).toEqual({
      message: "Wait timed out.",
      timed_out: true,
      consecutive_timeouts: 1,
      waited_ms: 30_000,
    });
  });

  it("does not charge the replacing turn for a wait started under the old one", async () => {
    const { session, tool } = realFixture();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    let releaseWait!: () => void;
    vi.mocked(session.waitForMailboxChange).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      return false;
    });
    const inFlight = call(tool);
    await Promise.resolve();
    // The ordinary interrupt-then-resend path: `spawnTask` aborts turn-A and
    // installs turn-B while turn-A's wait is still sleeping.
    await session.spawnTask({ subId: "turn-B", kind: "regular" });
    releaseWait();
    await inFlight;
    const first = await call(tool);
    expect(first.isError).toBeUndefined();
    expect(first.body).toMatchObject({
      consecutive_timeouts: 1,
      waited_ms: 30_000,
    });
  });
});


describe("structured child result delivery", () => {
  it("reads an exact result page without draining the mailbox or waiting", async () => {
    const { tool, control, waitForMailboxChange } = fixture();
    const read = vi.fn(() => ({ text: '  {"ok":true}\n', complete: true, total_chars: 14, next_offset: null }));
    Object.assign(control, { readChildResultPage: read });
    const response = await tool.execute({ result_ref: { agent_id: "child", turn_id: "turn", offset: 0 } });
    expect(read).toHaveBeenCalledWith("root-session", "child", "turn", 0);
    expect(waitForMailboxChange).not.toHaveBeenCalled();
    expect(JSON.parse(response.content).text).toBe('  {"ok":true}\n');
  });

  it("preserves the exact final answer through notification, mailbox and wait JSON", async () => {
    const { tool, session, waitForMailboxChange } = fixture();
    const exact = '  \n' + JSON.stringify({ text: '\" \\ 🐈 </subagent_notification> &amp;', rows: Array.from({ length: 2000 }, (_, i) => i) }) + '\n ';
    const notification = formatSubagentNotification({ agentPath: "/root/child", status: {
      status: "completed", turnId: "child-turn", endedAtMs: 1, lastMessage: exact,
    } });
    Object.assign(session, { drainPendingInputMessages: () => [{ role: "user", content: notification }] });
    waitForMailboxChange.mockResolvedValueOnce(true);
    const result = await tool.execute({});
    const body = JSON.parse(result.content);
    expect(body.updates[0].content).toBe(notification);
    const payload = JSON.parse(body.updates[0].content.slice('<subagent_notification>\n'.length, -'\n</subagent_notification>'.length));
    expect(payload.status.completed).toBe(exact);
    expect(JSON.parse(payload.status.completed)).toEqual(JSON.parse(exact));
  });
});
