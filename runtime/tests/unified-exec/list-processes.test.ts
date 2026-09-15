import { afterEach, describe, expect, it } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

const managers: UnifiedExecProcessManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.closeAll())); });

describe("managed process discovery and cleanup", () => {
  it("isolates session handles and preserves pending output across listing and termination", async () => {
    const manager = new UnifiedExecProcessManager();
    managers.push(manager);
    const first = await manager.execCommand({
      cmd: "printf initial; sleep 0.5; printf pending; sleep 30",
      ownerId: "first", yield_time_ms: 250,
    });
    const second = await manager.execCommand({ cmd: "sleep 30", ownerId: "second", yield_time_ms: 250 });
    await expect.poll(() => manager.listBackgroundProcesses().find((entry) => entry.ownerId === "first")?.outputTail)
      .toContain("pending");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(manager.listProcesses("first")).toEqual([expect.objectContaining({
        session_id: first.session_id, tty: false, started_at: expect.any(Number),
      })]);
      expect(manager.listProcesses("second").map((entry) => entry.session_id)).toEqual([second.session_id]);
      expect(manager.listProcesses("foreign")).toEqual([]);
      expect(manager.listProcesses()).toEqual([]);
    }
    await expect(manager.terminateProcess({ processId: first.session_id!, ownerId: "second" }))
      .rejects.toMatchObject({ code: "owner_denied" });
    expect(await manager.terminateProcess({ processId: first.session_id!, ownerId: "first" })).toEqual({ terminated: true });
    expect(manager.listProcesses("first")).toEqual([]);
    expect(manager.listProcesses("second")).toHaveLength(1);
    await expect(manager.terminateProcess({ processId: first.session_id!, ownerId: "second" }))
      .rejects.toMatchObject({ code: "owner_denied" });
    expect(await manager.terminateProcess({ processId: first.session_id!, ownerId: "first" })).toEqual({ terminated: false });
    const polled = await manager.writeStdin({ session_id: first.session_id!, ownerId: "first" });
    expect(polled.output).toContain("pending");
    expect(polled.session_id).toBeUndefined();
    expect(await manager.terminateProcess({ processId: first.session_id!, ownerId: "first" })).toEqual({ terminated: false });
  });
});
