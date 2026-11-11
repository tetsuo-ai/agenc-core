import { beforeAll, describe, expect, test, vi } from "vitest";

import { buildToolRegistry } from "../../../src/tool-registry.js";
import { EXEC_WAIT_WHILE_BUSY_ENV, execWaitWhileBusyEnabled } from "../../../src/tools/system/exec-wait-mode.js";
import type { Session } from "../../../src/session/session.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";
import { withExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { busyWaitWakeFor, loadBusyWaitQueue } from "../../../src/tools/system/exec-wait-wake.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";
import { setRunDeadlineClockForTests } from "../../../src/session/run-deadline.js";
import { enqueue, enqueuePendingNotification, resetCommandQueueForTesting } from "../../../src/utils/messageQueueManager.js";

// wait33: in the Superyat run on 0.19.32, 45 model calls only polled a
// running command (16.6M of 98.4M input tokens). A Light exec_command or
// empty write_stdin poll whose command is still using CPU at the end of its
// yield now asks the process manager to keep waiting (waitWhileBusy). These
// tests pin which calls ask for it, from the session environment through the
// registry to the manager request.

describe("execWaitWhileBusyEnabled", () => {
  test("is on by default and only a defined false value turns it off", () => {
    expect(execWaitWhileBusyEnabled({})).toBe(true);
    expect(execWaitWhileBusyEnabled({ [EXEC_WAIT_WHILE_BUSY_ENV]: "" })).toBe(true);
    expect(execWaitWhileBusyEnabled({ [EXEC_WAIT_WHILE_BUSY_ENV]: "1" })).toBe(true);
    expect(execWaitWhileBusyEnabled({ [EXEC_WAIT_WHILE_BUSY_ENV]: "0" })).toBe(false);
    expect(execWaitWhileBusyEnabled({ [EXEC_WAIT_WHILE_BUSY_ENV]: "false" })).toBe(false);
    expect(execWaitWhileBusyEnabled({ [EXEC_WAIT_WHILE_BUSY_ENV]: "off" })).toBe(false);
  });
});

function sessionWith(env: Record<string, string> = {}): Session {
  return {
    services: {
      providerEnvironment: env,
      configStore: { current: () => ({}) },
    },
  } as unknown as Session;
}

function output(): ExecCommandToolOutput {
  return {
    output: "", stdout: "", stderr: "", exitCode: 0, exit_code: 0, durationMs: 1,
    wall_time_seconds: 0.001, timedOut: false, truncated: false, original_token_count: 0,
  };
}

function registry(session: Session, lightMode: boolean) {
  const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(async () => output());
  const writeStdin = vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(async () => output());
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: Number.POSITIVE_INFINITY,
    execCommand,
    writeStdin,
    closeAll: vi.fn(async () => {}),
  };
  const built = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode, getSession: () => session, unifiedExecManager: manager,
  });
  const tool = (name: string) => built.tools.find((candidate) => candidate.name === name)!;
  return {
    execCommand,
    writeStdin,
    exec: (args: Record<string, unknown>) => tool("exec_command").execute(withExplicitDangerBoundary(args)),
    poll: (args: Record<string, unknown>) => tool("write_stdin").execute(withExplicitDangerBoundary(args)),
  };
}

function lastRequest(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return mock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("which Light waits continue while the command is busy", () => {
  test("a foreground command with the default or a longer yield, and an empty poll", async () => {
    const light = registry(sessionWith(), true);
    await light.exec({ cmd: "npm run build" });
    expect(lastRequest(light.execCommand)).toMatchObject({ cmd: "npm run build", yield_time_ms: 30_000, waitWhileBusy: true });
    await light.exec({ cmd: "node shots.mjs", yield_time_ms: 120_000 });
    expect(lastRequest(light.execCommand)).toMatchObject({ yield_time_ms: 120_000, waitWhileBusy: true });
    await light.exec({ cmd: "node shots.mjs", yield_time_ms: 30_000, timeoutMs: 300_000 });
    expect(lastRequest(light.execCommand)).toMatchObject({ timeoutMs: 300_000, onTimeout: "background", waitWhileBusy: true });
    await light.poll({ session_id: 7, chars: "", yield_time_ms: 60_000 });
    expect(lastRequest(light.writeStdin)).toMatchObject({ session_id: 7, chars: "", waitWhileBusy: true });
    await light.poll({ session_id: 7, chars: "", yield_time_ms: 30_000 });
    expect(lastRequest(light.writeStdin)).toMatchObject({ yield_time_ms: 30_000, waitWhileBusy: true });
    await light.poll({ session_id: 7 });
    expect(lastRequest(light.writeStdin)).toMatchObject({ session_id: 7, waitWhileBusy: true });
  });

  test("not a background start, a tty, a shorter explicit yield, a short poll or input sent to a session", async () => {
    const light = registry(sessionWith(), true);
    await light.exec({ cmd: "npm run dev", background: true });
    expect(lastRequest(light.execCommand)).not.toHaveProperty("waitWhileBusy");
    await light.exec({ cmd: "python3", tty: true });
    expect(lastRequest(light.execCommand)).not.toHaveProperty("waitWhileBusy");
    await light.exec({ cmd: "npm run dev", yield_time_ms: 5_000 });
    expect(lastRequest(light.execCommand)).not.toHaveProperty("waitWhileBusy");
    await light.poll({ session_id: 7, chars: "q\n" });
    expect(lastRequest(light.writeStdin)).not.toHaveProperty("waitWhileBusy");
    // A poll that asks for less than exec_command's default yield keeps it.
    await light.poll({ session_id: 7, chars: "", yield_time_ms: 5_000 });
    expect(lastRequest(light.writeStdin)).toMatchObject({ yield_time_ms: 5_000 });
    expect(lastRequest(light.writeStdin)).not.toHaveProperty("waitWhileBusy");
    await light.poll({ session_id: 7, chars: "", yield_time_ms: 29_999 });
    expect(lastRequest(light.writeStdin)).not.toHaveProperty("waitWhileBusy");
  });

  test(`${EXEC_WAIT_WHILE_BUSY_ENV}=0 and Standard sessions keep every yield`, async () => {
    for (const [session, lightMode] of [[sessionWith({ [EXEC_WAIT_WHILE_BUSY_ENV]: "0" }), true], [sessionWith(), false]] as const) {
      const built = registry(session, lightMode);
      await built.exec({ cmd: "npm run build" });
      expect(lastRequest(built.execCommand)).not.toHaveProperty("waitWhileBusy");
      await built.poll({ session_id: 7, chars: "" });
      expect(lastRequest(built.writeStdin)).not.toHaveProperty("waitWhileBusy");
    }
  });
});

describe("what ends a busy wait early", () => {
  const owner = (conversationId: string) => ({ kind: "session" as const, conversationId });
  // The queue is loaded on first use, to keep it out of the CLI's startup graph.
  // With it loaded, a wake watches the queue from the moment it is made.
  beforeAll(async () => { await loadBusyWaitQueue(); });

  test("a prompt queued for this conversation, delivered after the tool phase", () => {
    resetCommandQueueForTesting();
    try {
      const wake = busyWaitWakeFor({ conversationId: "conv-1" })!();
      enqueue({ value: "other chat", mode: "prompt", queueOwner: owner("conv-2") });
      enqueuePendingNotification({ value: "<task-notification/>", mode: "task-notification", queueOwner: owner("conv-1") });
      enqueue({ value: "/compact", mode: "prompt", queueOwner: owner("conv-1") });
      expect(wake.signal.aborted).toBe(false);
      enqueue({ value: "stop and use port 4000 instead", mode: "prompt", queueOwner: owner("conv-1") });
      expect(wake.signal.aborted).toBe(true);
      expect(wake.signal.reason).toBe("input");
      wake.dispose();
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("a prompt already queued when the wait starts, but not session mailbox input", async () => {
    resetCommandQueueForTesting();
    try {
      enqueue({ value: "change of plan", mode: "prompt", queueOwner: owner("conv-1") });
      expect(busyWaitWakeFor({ conversationId: "conv-1" })!().signal.aborted).toBe(true);
      resetCommandQueueForTesting();
      // The turn reads the mailbox only when it starts: ending the wait for
      // its input would hand the model nothing, so it is not watched.
      const waitForMailboxChange = vi.fn(async () => true);
      const session = { conversationId: "conv-1", hasPendingInput: () => true, waitForMailboxChange };
      const wake = busyWaitWakeFor(session)!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(waitForMailboxChange).not.toHaveBeenCalled();
      expect(wake.signal.aborted).toBe(false);
      wake.dispose();
      expect(busyWaitWakeFor(undefined)).toBeUndefined();
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("disposing stops watching the queue", () => {
    resetCommandQueueForTesting();
    try {
      const wake = busyWaitWakeFor({ conversationId: "conv-1" })!();
      wake.dispose();
      enqueue({ value: "late", mode: "prompt", queueOwner: owner("conv-1") });
      expect(wake.signal.aborted).toBe(false);
    } finally {
      resetCommandQueueForTesting();
    }
  });

  /** A dispatched call: the runtime attaches the invoking session. */
  function dispatched(args: Record<string, unknown>, toolName: string): Record<string, unknown> {
    attachToolRuntimeContext(args, {
      callId: "call-wake", toolName, runtimeKind: "function", classification: "exclusive",
      supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
      requestedSandboxMode: "danger_full_access", sandboxMode: "danger_full_access", approvalResolved: true,
      rawArgs: "{}",
      invocation: {
        session: { conversationId: "conv-1", services: { runtimeOptions: {} } },
        payload: { kind: "function", arguments: "{}" },
        turn: { subId: "turn-wake", cwd: "/tmp" },
      },
    } as never);
    return args;
  }

  test("Light exec and poll requests that wait while busy carry it, for the invoking session", async () => {
    resetCommandQueueForTesting();
    try {
      const light = registry(sessionWith(), true);
      await light.exec(dispatched({ cmd: "npm run build" }, "exec_command"));
      const wake = lastRequest(light.execCommand).busyWaitWake as () => { signal: AbortSignal; dispose(): void };
      expect(wake).toEqual(expect.any(Function));
      const started = wake();
      enqueue({ value: "use the staging config", mode: "prompt", queueOwner: owner("conv-1") });
      expect(started.signal.aborted).toBe(true);
      started.dispose();
      await light.poll(dispatched({ session_id: 7, chars: "", yield_time_ms: 60_000 }, "write_stdin"));
      expect(lastRequest(light.writeStdin)).toHaveProperty("busyWaitWake");
      await light.exec(dispatched({ cmd: "npm run dev", background: true }, "exec_command"));
      expect(lastRequest(light.execCommand)).not.toHaveProperty("busyWaitWake");
    } finally {
      resetCommandQueueForTesting();
    }
  });
});

describe("the deadline reserve ends a busy wait", () => {
  function fakeClock(now: number) {
    const scheduled: Array<{ delayMs: number; fire: () => void; cancelled: boolean }> = [];
    setRunDeadlineClockForTests({
      now: () => now,
      schedule: (delayMs, fire) => {
        const timer = { delayMs, fire, cancelled: false };
        scheduled.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    return scheduled;
  }
  const deadlineSession = (deadlineAt: number, deadlineReserveMs: number) => ({
    conversationId: "conv-1",
    services: { runtimeOptions: { deadlineAt, deadlineReserveMs } },
  });

  test("when the reserve starts during the wait", () => {
    try {
      const scheduled = fakeClock(1_000_000);
      // The reserve starts 90 s from now: 3 minutes left, 90 s of reserve.
      const wake = busyWaitWakeFor(deadlineSession(1_000_000 + 180_000, 90_000))!();
      expect(wake.signal.aborted).toBe(false);
      expect(scheduled.map((timer) => timer.delayMs)).toEqual([90_000]);
      scheduled[0]!.fire();
      expect(wake.signal.aborted).toBe(true);
      expect(wake.signal.reason).toBe("deadline_reserve");
      wake.dispose();
    } finally {
      setRunDeadlineClockForTests(null);
    }
  });

  test("at once inside the reserve, never without a deadline, and dispose cancels the timer", () => {
    try {
      const scheduled = fakeClock(1_000_000);
      expect(busyWaitWakeFor(deadlineSession(1_000_000 + 60_000, 90_000))!().signal.reason).toBe("deadline_reserve");
      const plain = busyWaitWakeFor({ conversationId: "conv-1", services: { runtimeOptions: {} } })!();
      expect(plain.signal.aborted).toBe(false);
      expect(scheduled).toEqual([]);
      const later = busyWaitWakeFor(deadlineSession(1_000_000 + 600_000, 120_000))!();
      later.dispose();
      expect(scheduled[0]!.cancelled).toBe(true);
      expect(later.signal.aborted).toBe(false);
    } finally {
      setRunDeadlineClockForTests(null);
    }
  });
});
