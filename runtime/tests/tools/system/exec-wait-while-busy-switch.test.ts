import { describe, expect, test, vi } from "vitest";

import { buildToolRegistry } from "../../../src/tool-registry.js";
import { EXEC_WAIT_WHILE_BUSY_ENV, execWaitWhileBusyEnabled } from "../../../src/tools/system/exec-wait-mode.js";
import type { Session } from "../../../src/session/session.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";
import { withExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { busyWaitWakeFor } from "../../../src/tools/system/exec-wait-wake.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";
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
  const mailbox = () => {
    let changed: (value: boolean) => void = () => {};
    return {
      waitForMailboxChange: vi.fn((_ms: number, _ownership: unknown, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          changed = resolve;
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        })),
      arrive: () => changed(true),
    };
  };

  test("a prompt queued for this conversation, delivered after the tool phase", () => {
    resetCommandQueueForTesting();
    try {
      const wake = busyWaitWakeFor({ conversationId: "conv-1", ...mailbox() })!();
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

  test("a prompt already queued when the wait starts, and input in the session mailbox", async () => {
    resetCommandQueueForTesting();
    try {
      enqueue({ value: "change of plan", mode: "prompt", queueOwner: owner("conv-1") });
      expect(busyWaitWakeFor({ conversationId: "conv-1" })!().signal.aborted).toBe(true);
      resetCommandQueueForTesting();
      const box = mailbox();
      const wake = busyWaitWakeFor({ conversationId: "conv-1", ...box })!();
      expect(box.waitForMailboxChange).toHaveBeenCalledTimes(1);
      expect(wake.signal.aborted).toBe(false);
      box.arrive();
      await Promise.resolve();
      await Promise.resolve();
      expect(wake.signal.aborted).toBe(true);
      wake.dispose();
      expect(busyWaitWakeFor(undefined)).toBeUndefined();
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("disposing stops watching the queue and the mailbox", () => {
    resetCommandQueueForTesting();
    try {
      const box = mailbox();
      const wake = busyWaitWakeFor({ conversationId: "conv-1", ...box })!();
      wake.dispose();
      const watchSignal = box.waitForMailboxChange.mock.calls[0]![2] as AbortSignal;
      expect(watchSignal.aborted).toBe(true);
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
