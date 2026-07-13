import { describe, expect, it, vi } from "vitest";
import { createKillProcessTool } from "./system/kill-process.js";
import type { UnifiedExecProcessManagerLike } from "../unified-exec/types.js";

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

  it("accepts the process_id alias and reports benign no-ops", async () => {
    const manager = fakeManager(false);
    const tool = createKillProcessTool({ unifiedExecManager: manager });
    const result = await tool.execute({ process_id: 9 });
    const payload = JSON.parse(String(result.content)) as {
      terminated: boolean;
      note?: string;
    };
    expect(payload.terminated).toBe(false);
    expect(payload.note).toContain("already exited or unknown");
    expect(result.isError).toBeUndefined();
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
});
