import { describe, expect, it, vi } from "vitest";
import { createKillProcessTool } from "../../../src/tools/system/kill-process.js";
import { createListProcessesTool } from "../../../src/tools/system/list-processes.js";
import { UnifiedExecProcessManager } from "../../../src/unified-exec/process-manager.js";
import type { OwnedProcessView } from "../../../src/unified-exec/types.js";

const stopping: OwnedProcessView = {
  sessionId: 101,
  command: "synthetic owned work",
  cwd: "/tmp",
  tty: false,
  status: "stopping",
  startedAt: 1,
};

describe("owned-process liveness independent review", () => {
  it.each(["live", "all"] as const)("counts stopping sessions as live with status=%s", async (status) => {
    const tool = createListProcessesTool({
      unifiedExecManager: {
        maxTimeoutMs: 1000,
        execCommand: vi.fn(),
        writeStdin: vi.fn(),
        closeAll: vi.fn(),
        listOwnedProcesses: vi.fn(() => [stopping]),
      },
    });
    const result = JSON.parse(String((await tool.execute({ status })).content));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].status).toBe("stopping");
    expect(result.live_count).toBe(1);
  });

  it.each(["one", "many", "all"] as const)("keeps a real signalled session in owned_live_sessions for %s", async (kind) => {
    const manager = new UnifiedExecProcessManager({ maxTimeoutMs: 5000 });
    try {
      const started = await manager.execCommand({
        cmd: "trap '' TERM; sleep 10",
        yield_time_ms: 250,
        ownerId: "independent-review-owner",
      });
      const sessionId = started.session_id;
      expect(sessionId).toBeTypeOf("number");
      const selector = kind === "one" ? { session_id: sessionId }
        : kind === "many" ? { session_ids: [sessionId] } : { all: true };
      const tool = createKillProcessTool({ unifiedExecManager: manager });
      const result = await tool.execute({ ...selector, __agencSessionId: "independent-review-owner" });
      const views = manager.listOwnedProcesses({ ownerId: "independent-review-owner" });
      expect(result.isError).toBeUndefined();
      expect(views.find((view) => view.sessionId === sessionId)?.status).toBe("stopping");
      expect(JSON.parse(String(result.content)).owned_live_sessions).toContain(sessionId);
    } finally {
      await manager.closeAll();
    }
  });
});
