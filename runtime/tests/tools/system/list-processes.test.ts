import { describe, expect, it, vi } from "vitest";
import { createListProcessesTool } from "../../../src/tools/system/list-processes.js";
import type { OwnedProcessView } from "../../../src/unified-exec/types.js";

function view(
  sessionId: number,
  status: OwnedProcessView["status"],
  extra: Partial<OwnedProcessView> = {},
): OwnedProcessView {
  return {
    sessionId,
    command: `python3 cracker.py --session ${sessionId}`,
    cwd: "/app",
    tty: false,
    status,
    startedAt: Date.UTC(2026, 8, 13, 21, 0, sessionId),
    ...extra,
  };
}

function managerWith(views: readonly OwnedProcessView[]) {
  return {
    maxTimeoutMs: 1_000,
    execCommand: vi.fn(),
    writeStdin: vi.fn(),
    listOwnedProcesses: vi.fn(() => [...views]),
    closeAll: vi.fn(),
  };
}

describe("list_processes tool (#2477)", () => {
  it("is a read-only, approval-free inventory with no path argument", () => {
    const tool = createListProcessesTool({ unifiedExecManager: managerWith([]) as never });
    expect(tool.name).toBe("list_processes");
    expect(tool.isReadOnly).toBe(true);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.metadata?.mutating).toBe(false);
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["status"]);
  });

  it("asks the manager for the caller's own sessions and lists live ones by default", async () => {
    const manager = managerWith([
      view(44, "killed", { endedAt: Date.UTC(2026, 8, 13, 21, 1), exitCode: 143 }),
      view(62, "completed", { endedAt: Date.UTC(2026, 8, 13, 21, 2), exitCode: 0 }),
      view(83, "running"),
      view(86, "stopping"),
      view(87, "running", { tty: true }),
    ]);
    const tool = createListProcessesTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({ __agencSessionId: "conv-a" } as never);
    expect(manager.listOwnedProcesses).toHaveBeenCalledWith({ ownerId: "conv-a" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    // 83 running, 86 stopping and 87 running are all listed above, so the
    // count that accompanies them has to include the signalled-but-unexited
    // session too. Counting only `running` reported 3 sessions as 2 live.
    expect(parsed.live_count).toBe(3);
    expect(parsed.note).toMatch(/Only sessions this conversation started/u);
    expect(parsed.note).toMatch(/rather than matching command text in the process table/u);
    expect(parsed.sessions).toEqual([
      {
        session_id: 83,
        status: "running",
        command: "python3 cracker.py --session 83",
        cwd: "/app",
        tty: false,
        started_at: "2026-09-13T21:01:23.000Z",
      },
      {
        session_id: 86,
        status: "stopping",
        command: "python3 cracker.py --session 86",
        cwd: "/app",
        tty: false,
        started_at: "2026-09-13T21:01:26.000Z",
      },
      {
        session_id: 87,
        status: "running",
        command: "python3 cracker.py --session 87",
        cwd: "/app",
        tty: true,
        started_at: "2026-09-13T21:01:27.000Z",
      },
    ]);
  });

  it("status=all also carries exited sessions with their outcome", async () => {
    const manager = managerWith([
      view(62, "completed", { endedAt: Date.UTC(2026, 8, 13, 21, 2), exitCode: 0 }),
      view(83, "running"),
    ]);
    const tool = createListProcessesTool({ unifiedExecManager: manager as never });
    const parsed = JSON.parse(String((await tool.execute({ status: "all" })).content));
    expect(parsed.sessions).toEqual([
      expect.objectContaining({
        session_id: 62,
        status: "completed",
        exit_code: 0,
        ended_at: "2026-09-13T21:02:00.000Z",
      }),
      expect.objectContaining({ session_id: 83, status: "running" }),
    ]);
    // Without a session context the manager is asked for unowned work only.
    expect(manager.listOwnedProcesses).toHaveBeenCalledWith({});
  });

  it("rejects an unknown status filter and a runtime without inventory", async () => {
    const tool = createListProcessesTool({ unifiedExecManager: managerWith([]) as never });
    expect((await tool.execute({ status: "everything" })).isError).toBe(true);
    const legacy = createListProcessesTool({
      unifiedExecManager: {
        maxTimeoutMs: 1_000,
        execCommand: vi.fn(),
        writeStdin: vi.fn(),
        closeAll: vi.fn(),
      } as never,
    });
    const result = await legacy.execute({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("not supported");
  });
});
