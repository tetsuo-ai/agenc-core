import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessOutputBuffer, UnifiedExecProcessManager } from "./process-manager.js";

const managers: UnifiedExecProcessManager[] = [];
function manager(): UnifiedExecProcessManager {
  const instance = new UnifiedExecProcessManager();
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.closeAll()));
});

describe("operator background process control", () => {
  it("lists only yielded work and retains its outcome after model polling", async () => {
    const processes = manager();
    await processes.execCommand({ cmd: "printf foreground", yield_time_ms: 250 });
    expect(processes.listBackgroundProcesses()).toEqual([]);
    const execution = await processes.execCommand({
      cmd: "printf started; sleep 0.5; printf finished", yield_time_ms: 250,
      ownerId: "child-agent",
    });
    const [running] = processes.listBackgroundProcesses();
    expect(running).toMatchObject({ status: "running", ownerId: "child-agent", outputTail: "started" });
    expect(running?.taskId).not.toBe(String(execution.session_id));
    await expect.poll(() => processes.listBackgroundProcesses()[0]?.status).toBe("completed");
    const result = await processes.writeStdin({ session_id: execution.session_id!, ownerId: "child-agent" });
    expect(result.output).toContain("finished");
    expect(processes.listBackgroundProcesses()).toEqual([
      expect.objectContaining({ taskId: running?.taskId, status: "completed", exitCode: 0, outputTail: "startedfinished" }),
    ]);
  });

  it("acknowledges a real exit, preserves output, and keeps model ownership checks", async () => {
    const processes = manager();
    const execution = await processes.execCommand({
      cmd: "printf ready; sleep 30", yield_time_ms: 250, ownerId: "child-agent",
    });
    const task = processes.listBackgroundProcesses()[0]!;
    expect(() => processes.terminateProcess({ processId: execution.session_id!, ownerId: "foreign-agent" }))
      .toThrow(/owner|owned|access/i);
    await expect(processes.writeStdin({ session_id: execution.session_id!, ownerId: "foreign-agent" }))
      .rejects.toMatchObject({ code: "owner_denied" });
    const stop = await processes.stopBackgroundProcess(task.taskId);
    expect(stop).toEqual({ stopped: true });
    expect(processes.listBackgroundProcesses()[0]).toMatchObject({ status: "killed", endedAt: expect.any(Number), outputTail: "ready" });
    await expect(processes.stopBackgroundProcess(task.taskId)).resolves.toEqual({ stopped: false });
    const endedAt = processes.listBackgroundProcesses()[0]!.endedAt!;
    await delay(20);
    const result = await processes.writeStdin({ session_id: execution.session_id!, ownerId: "child-agent" });
    expect(result.session_id).toBeUndefined();
    expect(result.durationMs).toBe(endedAt - task.startedAt);
    expect(processes.listBackgroundProcesses()[0]?.status).toBe("killed");
  });

  it("rejects stale and foreign handles even when numeric process IDs coincide", async () => {
    const previous = manager();
    const current = manager();
    const first = await previous.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
    const second = await current.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
    expect(first.session_id).toBe(second.session_id);
    const oldTaskId = previous.listBackgroundProcesses()[0]!.taskId;
    await previous.closeAll();
    await expect(current.stopBackgroundProcess(oldTaskId)).resolves.toEqual({ stopped: false });
    await expect(current.stopBackgroundProcess(String(second.session_id))).resolves.toEqual({ stopped: false });
    await delay(20);
    expect(current.listBackgroundProcesses()[0]?.status).toBe("running");
  });

  it("keeps inspection bounded, chronological and independent of output drains", () => {
    const buffer = new ProcessOutputBuffer(64);
    buffer.append("stdout", "already-read");
    buffer.drain();
    buffer.append("stderr", "error");
    buffer.append("stdout", "x".repeat(10_000));
    buffer.append("stderr", "é-end");
    const snapshot = buffer.snapshot();
    expect(snapshot.outputTail).toHaveLength(8192);
    expect(snapshot.outputTail.endsWith("é-end")).toBe(true);
    expect(snapshot.outputBytes).toBe(Buffer.byteLength("already-readerror" + "x".repeat(10_000) + "é-end"));
    expect(buffer.snapshot()).toEqual(snapshot);
    expect(buffer.drain().map((chunk) => chunk.chunk).join("")).toContain("é-end");
    expect(buffer.snapshot()).toEqual(snapshot);
  });
});
