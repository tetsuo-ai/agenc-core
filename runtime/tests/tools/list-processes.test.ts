import { describe, expect, it, vi } from "vitest";
import { createListProcessesTool } from "../../src/tools/system/list-processes.js";
import type { UnifiedExecProcessManagerLike } from "../../src/unified-exec/types.js";

describe("list_processes", () => {
  it("uses injected ownership and accepts no model owner or PID selector", async () => {
    const listProcesses = vi.fn(() => [{ session_id: 4, command: "test", cwd: "/app", tty: false, started_at: 10 }]);
    const tool = createListProcessesTool({ unifiedExecManager: { listProcesses } as unknown as UnifiedExecProcessManagerLike });
    const result = await tool.execute({ __agencSessionId: "session-a" });
    expect(listProcesses).toHaveBeenCalledWith("session-a");
    expect(JSON.parse(String(result.content))).toMatchObject({ processes: [{ session_id: 4 }] });
    listProcesses.mockClear();
    for (const key of ["ownerId", "owner_id", "pid", "session_id"]) {
      expect((await tool.execute({ [key]: "foreign" })).isError).toBe(true);
    }
    expect(listProcesses).not.toHaveBeenCalled();
    expect(tool.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("fails explicitly when the runtime cannot list processes", async () => {
    const tool = createListProcessesTool({ unifiedExecManager: {} as UnifiedExecProcessManagerLike });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("not supported");
  });
});
