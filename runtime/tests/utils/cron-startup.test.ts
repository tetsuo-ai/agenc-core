import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deferred = vi.hoisted(() => ({ loads: 0, failure: undefined as Error | undefined, read: vi.fn() }));
let workspace: string;
beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  deferred.loads = 0;
  deferred.failure = undefined;
  deferred.read.mockReset().mockResolvedValue([{ id: "persisted" }]);
  vi.doMock("../../src/utils/cronTasks.js", () => {
    deferred.loads++;
    if (deferred.failure) throw deferred.failure;
    return { readCronTasks: deferred.read };
  });
  workspace = await mkdtemp(join(tmpdir(), "cron-startup-"));
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });
const read = async (assertActive = () => {}) =>
  (await import("../../src/utils/cron-startup.js")).readStartupCronTasks(workspace, assertActive);
const record = async (contents = "{\"tasks\":[]}") => {
  await mkdir(join(workspace, ".agenc"), { mode: 0o700 });
  await writeFile(join(workspace, ".agenc", "scheduled_tasks.json"), contents);
};

describe("cron startup absence boundary", () => {
  it.each([false, true])("does not load cron machinery when no record exists (directory=%s)", async directory => {
    if (directory) await mkdir(join(workspace, ".agenc"), { mode: 0o700 });
    deferred.failure = new Error("cron implementation unavailable");
    expect(await read()).toEqual([]);
    expect(deferred.loads).toBe(0);
    expect(deferred.read).not.toHaveBeenCalled();
  });
  it.each(["", "{}", "malformed", '{"tasks":[{"id":"real"}]}'])("delegates every existing record unchanged: %s", async contents => {
    await record(contents);
    expect(await read()).toEqual([{ id: "persisted" }]);
    expect(deferred.read).toHaveBeenCalledExactlyOnceWith(workspace);
  });
  it("delegates an unsafe directory to the original confined reader", async () => {
    await mkdir(join(workspace, "other"));
    await symlink(join(workspace, "other"), join(workspace, ".agenc"));
    expect(await read()).toEqual([{ id: "persisted" }]);
    expect(deferred.read).toHaveBeenCalledOnce();
  });
  it("delegates unsafe workspace permissions even with no record", async () => {
    await chmod(workspace, 0o777);
    expect(await read()).toEqual([{ id: "persisted" }]);
    expect(deferred.read).toHaveBeenCalledOnce();
  });
  it("propagates deferred module failure for persisted state", async () => {
    await record();
    deferred.failure = new Error("cron implementation unavailable");
    const error = await read().catch(error => error);
    expect(error === deferred.failure || error.cause === deferred.failure).toBe(true);
    expect(deferred.read).not.toHaveBeenCalled();
  });
  it("keeps the original read error visible", async () => {
    await record();
    const error = Object.assign(new Error("confined read unavailable"), { code: "DESCRIPTOR_UNSUPPORTED" });
    deferred.read.mockRejectedValue(error);
    await expect(read()).rejects.toBe(error);
  });
  it.each([false, true])("checks cancellation after the probe (record=%s)", async present => {
    if (present) await record();
    const error = new Error("session startup was cancelled");
    await expect(read(() => { throw error; })).rejects.toBe(error);
    expect(deferred.loads).toBe(0);
  });
  it("checks cancellation again after the deferred import", async () => {
    await record();
    let checks = 0;
    await expect(read(() => { if (++checks === 2) throw new Error("cancelled during import"); }))
      .rejects.toThrow("cancelled during import");
    expect(deferred.loads).toBe(1);
    expect(deferred.read).not.toHaveBeenCalled();
  });
});
