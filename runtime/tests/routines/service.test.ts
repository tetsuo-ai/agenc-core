import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ROUTINE_RUNS, RoutineExecutionUnsettledError, RoutineService, type RoutineExecutor } from "../../src/routines/service.js";

const roots: string[] = [];
const services: RoutineService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(executor: RoutineExecutor = { execute: vi.fn(async () => "completed" as const) }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-routines-test-"))); roots.push(home);
  const cwd = join(home, "project"); mkdirSync(cwd);
  const service = new RoutineService({ home, executor }); services.push(service); service.start();
  const params = { name: "Daily check", instructions: "Inspect the workspace.", cwd, schedule: { kind: "manual" as const } };
  return { home, cwd, service, executor, params, path: join(home, "routines", "routines-v1.json") };
}
async function terminal(service: RoutineService, id: string): Promise<void> {
  await vi.waitFor(() => expect(["completed", "failed", "cancelled", "interrupted"]).toContain(service.runs({ id }).runs[0]?.status));
}

describe("daemon-owned local routines", () => {
  it("still honours an explicitly chosen plan mode and never rewrites a stored one", async () => {
    // The default changed; a routine the operator configured as plan must not
    // be silently converted, on create or on reload.
    const { service, params } = setup();
    const planned = service.create({ ...params, permissionMode: "plan" }).routine;
    expect(planned.permissionMode).toBe("plan");
    expect(service.list().routines.find((r) => r.id === planned.id)?.permissionMode).toBe("plan");
  });

  it("persists CRUD, defaults to default mode, guards stale edits, and returns detached values", async () => {
    const f = setup(); const events: unknown[] = []; f.service.onUpdated((event) => events.push(event));
    const { routine } = f.service.create(f.params);
    // Plan mode ends by handing a plan to a person, and a routine has nobody
    // to hand it to, so the default is the mode that can actually finish.
    expect(routine).toMatchObject({ permissionMode: "default", enabled: true, notifyOnCompletion: true, lastRun: null, nextRunAt: null });
    const list = f.service.list(); (list.routines as unknown as { name: string }[])[0]!.name = "tampered";
    expect(f.service.get({ id: routine.id }).routine.name).toBe("Daily check");
    const updated = f.service.update({ id: routine.id, patch: { name: "Weekly check", schedule: { kind: "cron", expression: "0 9 * * 1" } }, expectedUpdatedAt: routine.updatedAt }).routine;
    expect(updated.updatedAt).not.toBe(routine.updatedAt); expect(updated.nextRunAt).not.toBeNull();
    expect(() => f.service.update({ id: routine.id, patch: { name: "stale" }, expectedUpdatedAt: routine.updatedAt })).toThrow("changed");
    expect(() => f.service.delete({ id: routine.id, expectedUpdatedAt: routine.updatedAt })).toThrow("changed");
    await f.service.close();
    const restored = new RoutineService({ home: f.home, executor: f.executor }); services.push(restored); restored.start();
    expect(restored.get({ id: routine.id }).routine.name).toBe("Weekly check");
    expect(restored.delete({ id: routine.id, expectedUpdatedAt: updated.updatedAt })).toEqual({ deleted: true });
    expect(restored.list()).toEqual({ routines: [] });
    expect(events).toEqual([{ id: routine.id, reason: "created" }, { id: routine.id, reason: "updated" }]);
    if (process.platform !== "win32") expect(statSync(f.path).mode & 0o777).toBe(0o600);
  });

  it("rejects authority escalation, unknown keys, malformed schedules, invalid paths, and oversized content", () => {
    const f = setup();
    for (const patch of [
      { permissionMode: "bypassPermissions" }, { permissionMode: "auto" }, { runtimeOptions: {} }, { enabled: "yes" },
      { cwd: "." }, { cwd: join(f.home, "missing") }, { name: " " }, { instructions: "x".repeat(16_385) },
      { schedule: { kind: "cron", expression: "* * * * * *" } }, { schedule: { kind: "cron", expression: "60 * * * *" } },
      { schedule: { kind: "manual", expression: "* * * * *" } }, { schedule: { kind: "webhook" } },
    ]) expect(() => f.service.create({ ...f.params, ...patch })).toThrow();
    expect(f.service.list().routines).toHaveLength(0);
    expect(() => f.service.list({ unexpected: true })).toThrow();
    expect(() => f.service.get({ id: "../escape" })).toThrow("not found");
  });

  it("clears provider/model overrides and keeps run updates out of the edit revision", async () => {
    const f = setup(); const { routine } = f.service.create({ ...f.params, provider: "grok", model: "grok-test" });
    const changed = f.service.update({ id: routine.id, patch: { provider: "", model: "" } }).routine;
    expect(changed.provider).toBeUndefined(); expect(changed.model).toBeUndefined();
    f.service.run({ id: routine.id }); await terminal(f.service, routine.id);
    expect(f.service.get({ id: routine.id }).routine.updatedAt).toBe(changed.updatedAt);
  });

  it("fences new work and deletion after an unproven cancellation", async () => {
    const f = setup({ execute: async () => { throw new RoutineExecutionUnsettledError("unsettled"); } });
    const { routine } = f.service.create(f.params); f.service.run({ id: routine.id });
    await vi.waitFor(() => expect(f.service.runs({ id: routine.id }).runs[0]!.error).toContain("could not confirm"));
    expect(f.service.runs({ id: routine.id }).runs[0]).toMatchObject({ status: "running", finishedAt: null });
    expect(() => f.service.run({ id: routine.id })).toThrow("active run");
    expect(() => f.service.delete({ id: routine.id })).toThrow("Cancel");
  });

  it("can pause a routine whose workspace was removed, without rebinding its authority", () => {
    const f = setup(); const { routine } = f.service.create({ ...f.params, schedule: { kind: "cron", expression: "* * * * *" } });
    rmSync(f.cwd, { recursive: true });
    const paused = f.service.update({ id: routine.id, patch: { enabled: false } }).routine;
    expect(paused.enabled).toBe(false); expect(paused.nextRunAt).toBeNull(); expect(paused.cwd).toBe(f.cwd);
  });

  it("fires from real scheduler timers, pauses/resumes, and cancels timers on shutdown", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 10));
    const execute = vi.fn(async () => "completed" as const); const f = setup({ execute });
    const { routine } = f.service.create({ ...f.params, schedule: { kind: "cron", expression: "* * * * *" } });
    expect(routine.nextRunAt).toBe(new Date(2026, 0, 1, 10, 1).toISOString());
    await vi.advanceTimersByTimeAsync(49_999); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(execute).toHaveBeenCalledTimes(1);
    expect(f.service.runs({ id: routine.id }).runs[0]).toMatchObject({ trigger: "schedule", status: "completed" });
    f.service.update({ id: routine.id, patch: { enabled: false } });
    await vi.advanceTimersByTimeAsync(180_000); expect(execute).toHaveBeenCalledTimes(1);
    expect(f.service.get({ id: routine.id }).routine.nextRunAt).toBeNull();
    f.service.update({ id: routine.id, patch: { enabled: true } });
    await vi.advanceTimersByTimeAsync(60_000); expect(execute).toHaveBeenCalledTimes(2);
    await f.service.close(); await vi.advanceTimersByTimeAsync(120_000); expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not burst after a missed tick and fences overlapping scheduled/manual runs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 10));
    const execute = vi.fn((_routine, _run, context) => new Promise<"cancelled">((resolve) => context.signal.addEventListener("abort", () => resolve("cancelled"))));
    const f = setup({ execute }); const { routine } = f.service.create({ ...f.params, schedule: { kind: "cron", expression: "* * * * *" } });
    vi.setSystemTime(new Date(2026, 0, 1, 10, 12, 10)); await vi.advanceTimersByTimeAsync(30_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(() => f.service.run({ id: routine.id })).toThrow("active run");
    await vi.advanceTimersByTimeAsync(180_000); expect(execute).toHaveBeenCalledTimes(1);
    expect(() => f.service.delete({ id: routine.id })).toThrow("Cancel");
    const cancelled = await f.service.cancel({ id: routine.id }); expect(cancelled.run.status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(60_000); expect(execute).toHaveBeenCalledTimes(2);
  });

  it("freezes config for an active invocation and permits explicit run while paused", async () => {
    const snapshots: string[] = []; let finish!: (value: "completed") => void;
    const f = setup({ execute: async (routine, _run, context) => {
      snapshots.push(routine.instructions);
      return new Promise<"completed">((resolve) => { finish = resolve; context.signal.addEventListener("abort", () => resolve("completed")); });
    } });
    const { routine } = f.service.create({ ...f.params, enabled: false }); f.service.run({ id: routine.id });
    await vi.waitFor(() => expect(snapshots).toEqual([f.params.instructions]));
    f.service.update({ id: routine.id, patch: { instructions: "Updated for future runs" } }); finish("completed"); await terminal(f.service, routine.id);
    f.service.run({ id: routine.id }); await vi.waitFor(() => expect(snapshots).toEqual([f.params.instructions, "Updated for future runs"])); finish("completed"); await terminal(f.service, routine.id);
  });

  it("bounds run history and preserves failure/cancellation records without sensitive error text", async () => {
    let count = 0;
    const f = setup({ execute: async () => { count++; if (count === 1) throw new Error("sk-live-private-password"); return count === 2 ? "cancelled" : "completed"; } });
    const { routine } = f.service.create(f.params); f.service.run({ id: routine.id }); await terminal(f.service, routine.id);
    expect(f.service.runs({ id: routine.id }).runs[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(f.service.runs({ id: routine.id }))).not.toContain("sk-live");
    for (let i = 0; i < MAX_ROUTINE_RUNS + 1; i++) { f.service.run({ id: routine.id }); await terminal(f.service, routine.id); }
    expect(f.service.runs({ id: routine.id }).runs).toHaveLength(MAX_ROUTINE_RUNS);
    expect(f.service.runs({ id: routine.id, limit: 3 }).runs).toHaveLength(3);
    for (const limit of [0, 51, 1.5, "3"]) expect(() => f.service.runs({ id: routine.id, limit })).toThrow();
  });

  it("recovers crash-interrupted runs and skips missed schedules on restart", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 1, 10));
    const f = setup(); const { routine } = f.service.create({ ...f.params, schedule: { kind: "cron", expression: "* * * * *" } });
    f.service.run({ id: routine.id }); const crashed = readFileSync(f.path, "utf8"); await f.service.close();
    writeFileSync(f.path, crashed, { mode: 0o600 }); vi.setSystemTime(new Date(2026, 0, 2, 12));
    const execute = vi.fn(async () => "completed" as const); const restarted = new RoutineService({ home: f.home, executor: { execute } }); services.push(restarted); restarted.start();
    expect(restarted.runs({ id: routine.id }).runs[0]).toMatchObject({ status: "interrupted" });
    expect(execute).not.toHaveBeenCalled(); expect(restarted.get({ id: routine.id }).routine.nextRunAt).toBe(new Date(2026, 0, 2, 12, 1).toISOString());
  });

  it("marks permission waits using existing daemon events", async () => {
    const f = setup({ execute: async (_r, _run, context) => {
      context.bind({ agentId: "agent", sessionId: "session", coreRunId: "agent" });
      return new Promise<"cancelled">((resolve) => context.signal.addEventListener("abort", () => resolve("cancelled")));
    } });
    const { routine } = f.service.create(f.params); f.service.run({ id: routine.id });
    await vi.waitFor(() => expect(f.service.runs({ id: routine.id }).runs[0]!.status).toBe("running"));
    f.service.observeSessionEvent("other-session", { method: "event.permission_request" });
    expect(f.service.runs({ id: routine.id }).runs[0]!.status).toBe("running");
    f.service.observeSessionEvent("session", { method: "event.permission_request" });
    expect(f.service.runs({ id: routine.id }).runs[0]!.status).toBe("waiting_permission");
    expect((await f.service.cancel({ id: routine.id })).run.status).toBe("cancelled");
  });

  it("fails closed on a replaced workspace and preserves a symlinked storage target", async () => {
    const execute = vi.fn(async () => "completed" as const); const f = setup({ execute }); const { routine } = f.service.create(f.params);
    renameSync(f.cwd, join(f.home, "original-project")); mkdirSync(f.cwd);
    f.service.run({ id: routine.id }); await terminal(f.service, routine.id);
    expect(execute).not.toHaveBeenCalled(); expect(f.service.runs({ id: routine.id }).runs[0]!.status).toBe("failed");
    const victim = join(f.home, "preserved.json"); writeFileSync(victim, "do not touch");
    rmSync(f.path); symlinkSync(victim, f.path);
    expect(() => f.service.update({ id: routine.id, patch: { name: "cannot write" } })).toThrow("saved");
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(() => f.service.run({ id: routine.id })).toThrow("unavailable");
  });

  it("preserves malformed stores and refuses a symlinked or public store directory", async () => {
    const f = setup(); await f.service.close(); writeFileSync(f.path, "malformed", { mode: 0o600 });
    expect(() => new RoutineService({ home: f.home, executor: f.executor })).toThrow("preserved");
    expect(readFileSync(f.path, "utf8")).toBe("malformed");
    const target = join(f.home, "other"); mkdirSync(target, { mode: 0o700 }); rmSync(join(f.home, "routines"), { recursive: true }); symlinkSync(target, join(f.home, "routines"));
    expect(() => new RoutineService({ home: f.home, executor: f.executor })).toThrow("private directory");
    rmSync(join(f.home, "routines")); mkdirSync(join(f.home, "routines"), { mode: 0o700 });
    if (process.platform !== "win32") { chmodSync(join(f.home, "routines"), 0o755); expect(() => new RoutineService({ home: f.home, executor: f.executor })).toThrow("private directory"); }
  });
});
