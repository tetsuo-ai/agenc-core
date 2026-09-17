import { describe, expect, it, vi } from "vitest";
import { createKillProcessTool } from "./system/kill-process.js";
import type {
  OwnedProcessView,
  UnifiedExecProcessManagerLike,
} from "../unified-exec/types.js";
import { UnifiedExecError } from "../unified-exec/types.js";

function fakeManager(
  terminated: boolean,
): UnifiedExecProcessManagerLike & { terminateProcess: ReturnType<typeof vi.fn> } {
  return {
    maxTimeoutMs: 1_000,
    execCommand: vi.fn(),
    writeStdin: vi.fn(),
    terminateProcess: vi.fn(() => ({ terminated })),
    closeAll: vi.fn(),
  } as never;
}

function view(sessionId: number, status: OwnedProcessView["status"]): OwnedProcessView {
  return { sessionId, command: `cmd-${sessionId}`, cwd: "/w", tty: false, status, startedAt: sessionId };
}

/** A manager that knows the owner's inventory as well as single and bulk termination. */
function inventoryManager(live: readonly number[]) {
  const manager = {
    maxTimeoutMs: 1_000,
    execCommand: vi.fn(),
    writeStdin: vi.fn(),
    terminateProcess: vi.fn((request: { processId: number }) => ({
      terminated: live.includes(request.processId),
    })),
    terminateOwnedProcesses: vi.fn((request: { processIds?: readonly number[] }) => ({
      results: (request.processIds ?? live).map((sessionId) => ({
        sessionId,
        terminated: live.includes(sessionId),
      })),
    })),
    listOwnedProcesses: vi.fn(() => [
      ...live.map((id) => view(id, "running")),
      view(62, "completed"),
      view(44, "killed"),
    ]),
    closeAll: vi.fn(),
  };
  return manager;
}

describe("kill_process tool", () => {
  it("terminates a live session by session_id", async () => {
    const manager = fakeManager(true);
    const tool = createKillProcessTool({ unifiedExecManager: manager });
    const result = await tool.execute({ session_id: 7 });
    expect(manager.terminateProcess).toHaveBeenCalledWith({ processId: 7 });
    expect(JSON.parse(String(result.content))).toEqual({
      session_id: 7,
      terminated: true,
    });
    expect(result.isError).toBeUndefined();
  });

  it("rejects the removed process_id input alias", async () => {
    const manager = fakeManager(false);
    const tool = createKillProcessTool({ unifiedExecManager: manager });
    const result = await tool.execute({ process_id: 9 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("unknown field `process_id`");
    expect(manager.terminateProcess).not.toHaveBeenCalled();
  });

  it("forwards owner id and surfaces owner_denied errors", async () => {
    const manager = {
      maxTimeoutMs: 1_000,
      execCommand: vi.fn(),
      writeStdin: vi.fn(),
      terminateProcess: vi.fn(() => {
        throw new Error("process is owned by another agent/session");
      }),
      closeAll: vi.fn(),
    };
    const tool = createKillProcessTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({
      session_id: 3,
      __agencSessionId: "foreign",
    } as never);
    expect(manager.terminateProcess).toHaveBeenCalledWith({
      processId: 3,
      ownerId: "foreign",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects calls without an id", async () => {
    const tool = createKillProcessTool({
      unifiedExecManager: fakeManager(true),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });

  it("rejects calls that mix the target selectors", async () => {
    const manager = inventoryManager([83]);
    const tool = createKillProcessTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({ session_id: 83, all: true });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("exactly one of");
    expect(manager.terminateProcess).not.toHaveBeenCalled();
    expect(manager.terminateOwnedProcesses).not.toHaveBeenCalled();
  });

  it("is audited as performing no filesystem write so the sandbox admits it", () => {
    // The sandbox classifies a mutating tool with no resolvable write target
    // as indeterminate and denies it. kill_process only signals a process,
    // and its schema carries no path the model could steer (only session
    // ids and a boolean), so it declares the audited exemption instead of
    // being denied everywhere.
    const tool = createKillProcessTool({ unifiedExecManager: fakeManager(true) });
    expect(tool.metadata?.virtualNoFsWrites).toBe(true);
    expect(tool.inputSchema).toMatchObject({
      properties: {
        session_id: { type: "number" },
        session_ids: { type: "array", items: { type: "number" } },
        all: { type: "boolean" },
      },
      additionalProperties: false,
    });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
      "session_id",
      "session_ids",
      "all",
    ]);
  });
});

/**
 * The Terminal-Bench shape from #2477: kill_process(44) → true, then 62 and
 * 67 → false ("already exited"), then live handles 83/86/87 remain. The
 * model must be able to find that remaining owned work from the tool result
 * alone, without matching task filenames against the process table.
 */
describe("kill_process recovery through owned identity (#2477)", () => {
  it("names the remaining owned live sessions after a stale id reports terminated=false", async () => {
    const manager = inventoryManager([83, 86, 87]);
    const tool = createKillProcessTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({ session_id: 62, __agencSessionId: "conv-a" } as never);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      session_id: 62,
      terminated: false,
      note: "no live process with this id (already exited or unknown)",
      owned_live_sessions: [83, 86, 87],
      owned_live_sessions_note: expect.stringMatching(
        /stop them by session_id or with all=true.*Do not search the process table/u,
      ),
    });
    expect(manager.listOwnedProcesses).toHaveBeenCalledWith({ ownerId: "conv-a" });
  });

  it("stops several sessions through the manager's owned bulk path", async () => {
    const manager = inventoryManager([83, 86, 87]);
    const tool = createKillProcessTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({
      session_ids: [83, 67, 86],
      __agencSessionId: "conv-a",
    } as never);
    expect(manager.terminateOwnedProcesses).toHaveBeenCalledWith({
      processIds: [83, 67, 86],
      ownerId: "conv-a",
    });
    expect(manager.terminateProcess).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.content))).toMatchObject({
      session_ids: [83, 67, 86],
      results: [
        { session_id: 83, terminated: true },
        { session_id: 67, terminated: false },
        { session_id: 86, terminated: true },
      ],
    });
  });

  it("all=true stops only the caller's own live sessions", async () => {
    const manager = inventoryManager([83, 86, 87]);
    const tool = createKillProcessTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({ all: true, __agencSessionId: "conv-a" } as never);
    expect(manager.terminateOwnedProcesses).toHaveBeenCalledWith({ ownerId: "conv-a" });
    expect(JSON.parse(String(result.content))).toMatchObject({
      all: true,
      results: [
        { session_id: 83, terminated: true },
        { session_id: 86, terminated: true },
        { session_id: 87, terminated: true },
      ],
    });
  });

  it("a bulk request naming another owner's session is refused with no effect", async () => {
    const manager = inventoryManager([83]);
    manager.terminateOwnedProcesses.mockImplementation(() => {
      throw new UnifiedExecError("owner_denied", "process is owned by another agent/session");
    });
    const tool = createKillProcessTool({ unifiedExecManager: manager as never });
    const result = await tool.execute({
      session_ids: [83, 91],
      __agencSessionId: "conv-a",
    } as never);
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content))).toMatchObject({ code: "owner_denied" });
    expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
  });

  it("refuses bulk selectors on a runtime without the owned bulk path", async () => {
    const manager = fakeManager(true);
    const tool = createKillProcessTool({ unifiedExecManager: manager });
    const result = await tool.execute({ all: true });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("bulk process termination is not supported");
    expect(manager.terminateProcess).not.toHaveBeenCalled();
  });
});
