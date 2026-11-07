import { describe, expect, test, vi } from "vitest";

import { buildToolRegistry } from "../../../src/tool-registry.js";
import { EXEC_WAIT_WHILE_BUSY_ENV, execWaitWhileBusyEnabled } from "../../../src/tools/system/exec-wait-mode.js";
import type { Session } from "../../../src/session/session.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";
import { withExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

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
