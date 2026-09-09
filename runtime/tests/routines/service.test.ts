import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
function workspaceExpectation(cwd: string) {
  const stat = lstatSync(cwd, { bigint: true });
  return { cwd, dev: String(stat.dev), ino: String(stat.ino) };
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

  it("accepts approved workspace identities without storing request guards and preserves legacy aliases", async () => {
    const f = setup(); const expectedWorkspace = workspaceExpectation(f.cwd);
    const routine = f.service.create({ ...f.params, expectedWorkspace }).routine;
    expect(routine.cwd).toBe(f.cwd); expect(routine).not.toHaveProperty("expectedWorkspace");
    const nextCwd = join(f.home, "next-project"); mkdirSync(nextCwd);
    const updated = f.service.update({ id: routine.id, patch: { cwd: nextCwd }, expectedUpdatedAt: routine.updatedAt, expectedWorkspace: workspaceExpectation(nextCwd) }).routine;
    expect(updated.cwd).toBe(nextCwd); expect(updated).not.toHaveProperty("expectedWorkspace");
    expect(readFileSync(f.path, "utf8")).not.toContain("expectedWorkspace");
    const alias = join(f.home, "project-alias"); symlinkSync(f.cwd, alias, "dir");
    expect(f.service.create({ ...f.params, cwd: alias }).routine.cwd).toBe(f.cwd);
    expect(f.service.update({ id: routine.id, patch: { cwd: alias } }).routine.cwd).toBe(f.cwd);
    await f.service.close();
    const restored = new RoutineService({ home: f.home, executor: f.executor }); services.push(restored);
    expect(restored.get({ id: routine.id }).routine.cwd).toBe(f.cwd);
  });

  it.each(["symlink", "replacement", "ancestor-symlink"])("rejects a workspace %s introduced after approval before creating anything", kind => {
    const f = setup();
    const approved = kind === "ancestor-symlink" ? join(f.cwd, "child") : f.cwd;
    if (kind === "ancestor-symlink") mkdirSync(approved);
    const expectedWorkspace = workspaceExpectation(approved);
    const other = join(f.home, "outside-project"); mkdirSync(other);
    if (kind === "ancestor-symlink") mkdirSync(join(other, "child"));
    renameSync(f.cwd, join(f.home, "original-project"));
    if (kind === "replacement") mkdirSync(f.cwd); else symlinkSync(other, f.cwd, "dir");
    const disk = readFileSync(f.path, "utf8"), events: unknown[] = [];
    f.service.onUpdated(event => events.push(event));
    expect(() => f.service.create({ ...f.params, cwd: approved, expectedWorkspace }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_CONFLICT" }));
    expect(f.service.list().routines).toEqual([]); expect(events).toEqual([]);
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(disk);
    // A rejected expectation does not poison the service's storage health.
    expect(f.service.create({ ...f.params, cwd: other }).routine.cwd).toBe(other);
  });

  it.each(["cwd", "dev", "ino"])("checks the approved %s on create and update before any commit", field => {
    const f = setup(); const routine = f.service.create(f.params).routine;
    const target = join(f.home, "target"); mkdirSync(target);
    const expectedWorkspace = { ...workspaceExpectation(target), [field]: field === "cwd" ? f.cwd : "0" };
    const disk = readFileSync(f.path, "utf8"), events: unknown[] = [];
    f.service.onUpdated(event => events.push(event));
    expect(() => f.service.create({ ...f.params, cwd: target, expectedWorkspace }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_CONFLICT" }));
    expect(() => f.service.update({ id: routine.id, patch: { cwd: target, name: "must not persist" }, expectedWorkspace }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_CONFLICT" }));
    expect(f.service.get({ id: routine.id }).routine).toEqual(routine); expect(events).toEqual([]);
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  it("rejects a changed workspace on update with its original identity and revision intact", () => {
    const f = setup(); const routine = f.service.create(f.params).routine;
    const target = join(f.home, "target"), outside = join(f.home, "outside"); mkdirSync(target); mkdirSync(outside);
    const expectedWorkspace = workspaceExpectation(target);
    renameSync(target, join(f.home, "original-target")); symlinkSync(outside, target, "dir");
    const disk = readFileSync(f.path, "utf8");
    expect(() => f.service.update({ id: routine.id, patch: { cwd: target }, expectedUpdatedAt: routine.updatedAt, expectedWorkspace }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_CONFLICT" }));
    expect(f.service.get({ id: routine.id }).routine).toEqual(routine); expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  it("rejects malformed or misplaced workspace expectations without side effects", () => {
    const f = setup(); const routine = f.service.create(f.params).routine;
    const valid = workspaceExpectation(f.cwd), disk = readFileSync(f.path, "utf8");
    for (const expectedWorkspace of [
      null, [], {}, { ...valid, extra: true }, { cwd: valid.cwd, dev: valid.dev },
      { ...valid, cwd: "." }, { ...valid, cwd: `${f.cwd}/../project` }, { ...valid, cwd: "/" + "x".repeat(4096) },
      ...[null, 12, "", "-1", "1.0", "1e2", "1\n", "x", "1".repeat(33)].flatMap(value => [{ ...valid, dev: value }, { ...valid, ino: value }]),
    ]) {
      expect(() => f.service.create({ ...f.params, expectedWorkspace })).toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
      expect(() => f.service.update({ id: routine.id, patch: { cwd: f.cwd }, expectedWorkspace })).toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    }
    expect(() => f.service.update({ id: routine.id, patch: { name: "no cwd" }, expectedWorkspace: valid }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    expect(() => f.service.update({ id: routine.id, patch: { cwd: f.cwd, expectedWorkspace: valid } }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    expect(f.service.get({ id: routine.id }).routine).toEqual(routine); expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  it.each(["cwd", "permissionMode", "instructions"])("refuses a reviewed run after %s changes without writing or starting work", async field => {
    const execute = vi.fn(async () => "completed" as const); const f = setup({ execute });
    const reviewed = f.service.create({ ...f.params, permissionMode: "plan" }).routine;
    const other = join(f.home, "other-project"); mkdirSync(other);
    const patch = field === "cwd" ? { cwd: other } : field === "permissionMode" ? { permissionMode: "default" } : { instructions: "New instructions" };
    const changed = f.service.update({ id: reviewed.id, patch }).routine;
    const disk = readFileSync(f.path, "utf8"), events: unknown[] = [];
    f.service.onUpdated(event => events.push(event));
    expect(() => f.service.run({ id: reviewed.id, expectedUpdatedAt: reviewed.updatedAt }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_CONFLICT" }));
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled(); expect(events).toEqual([]);
    expect(f.service.runs({ id: reviewed.id }).runs).toEqual([]);
    expect(f.service.get({ id: reviewed.id }).routine).toEqual(changed);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  it("snapshots the exact accepted revision synchronously and preserves revisionless callers", async () => {
    const execute = vi.fn<RoutineExecutor["execute"]>(async () => "completed"); const f = setup({ execute });
    const reviewed = f.service.create(f.params).routine;
    f.service.run({ id: reviewed.id, expectedUpdatedAt: reviewed.updatedAt });
    // The executor is deferred, but its configuration was already frozen by run.
    f.service.update({ id: reviewed.id, patch: { instructions: "Only the next run sees this" } });
    await terminal(f.service, reviewed.id);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ instructions: reviewed.instructions, updatedAt: reviewed.updatedAt });
    f.service.run({ id: reviewed.id }); await terminal(f.service, reviewed.id);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ instructions: "Only the next run sees this" });
  });

  it.each([null, 12, "", "x".repeat(65)])("rejects malformed run revisions before side effects: %j", revision => {
    const execute = vi.fn(async () => "completed" as const); const f = setup({ execute });
    const routine = f.service.create(f.params).routine;
    const disk = readFileSync(f.path, "utf8");
    expect(() => f.service.run({ id: routine.id, expectedUpdatedAt: revision }))
      .toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    expect(execute).not.toHaveBeenCalled(); expect(f.service.runs({ id: routine.id }).runs).toEqual([]);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
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
