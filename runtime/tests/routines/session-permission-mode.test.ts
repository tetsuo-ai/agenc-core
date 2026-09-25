/**
 * A routine runs with the permission mode of the session that created it
 * (owner decision, 2026-09-22). These tests pin where that mode may come from:
 * the live session's permission registry, resolved by the daemon, or the
 * operator's own Routines screen. Never from a model's tool arguments, never
 * wider than the authority that asked, and never wider than today for a
 * caller that names no authority at all.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_ROUTINE_GRANT,
  OPERATOR_ROUTINE_GRANT,
  parseRoutinePermissionAuthority,
  resolveRoutinePermissionGrant,
  routineCeilingForSessionMode,
  sessionRoutineGrant,
} from "../../src/routines/permission-authority.js";
import { RoutineService, type RoutineExecutor } from "../../src/routines/service.js";

const roots: string[] = [];
const services: RoutineService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(execute: RoutineExecutor["execute"] = vi.fn(async () => "completed" as const)) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-routine-mode-"))); roots.push(home);
  const cwd = join(home, "project"); mkdirSync(cwd);
  const service = new RoutineService({ home, executor: { execute } }); services.push(service); service.start();
  const params = { name: "Tick", instructions: "Append the time to ticks.txt.", cwd, schedule: { kind: "cron" as const, expression: "* * * * *" } };
  return { home, cwd, service, params, path: join(home, "routines", "routines-v1.json") };
}

describe("routine permission ceiling from a session's live mode", () => {
  it.each([
    ["bypassPermissions", "bypassPermissions"],
    ["acceptEdits", "acceptEdits"],
    ["default", "default"],
    ["plan", "plan"],
    // The daemon may host an interactive default session as unattended.
    ["unattended", "default"],
    // Auto approves at least what acceptEdits approves, never more for a routine.
    ["auto", "acceptEdits"],
    ["dontAsk", "default"],
    ["bubble", "default"],
    [undefined, "default"],
    ["something-new", "default"],
  ])("maps session mode %s to routine ceiling %s", (sessionMode, ceiling) => {
    expect(routineCeilingForSessionMode(sessionMode)).toBe(ceiling);
  });
});

describe("routine creation records the session's current mode", () => {
  it.each(["bypassPermissions", "acceptEdits", "default"] as const)(
    "gives a routine created from a %s session that mode when the request names none",
    (mode) => {
      const f = setup();
      const routine = f.service.create(f.params, sessionRoutineGrant(mode)).routine;
      expect(routine.permissionMode).toBe(mode);
      expect(JSON.parse(readFileSync(f.path, "utf8")).entries[0].routine.permissionMode).toBe(mode);
    },
  );

  it("rejects a model-supplied mode wider than its session and stores nothing", () => {
    const f = setup();
    for (const [sessionMode, requested] of [
      ["default", "bypassPermissions"], ["default", "acceptEdits"], ["acceptEdits", "bypassPermissions"],
      ["plan", "default"], ["unattended", "acceptEdits"],
    ] as const) {
      expect(() => f.service.create({ ...f.params, permissionMode: requested }, sessionRoutineGrant(sessionMode)))
        .toThrow(expect.objectContaining({ code: "ROUTINE_PERMISSION_DENIED" }));
    }
    expect(f.service.list().routines).toEqual([]);
  });

  it("honors a narrower mode the model requests", () => {
    const f = setup();
    const grant = sessionRoutineGrant("bypassPermissions");
    for (const mode of ["acceptEdits", "default", "plan", "bypassPermissions"] as const) {
      expect(f.service.create({ ...f.params, permissionMode: mode }, grant).routine.permissionMode).toBe(mode);
    }
  });

  it("keeps today's contract for a caller that names no authority", () => {
    const f = setup();
    expect(f.service.create(f.params).routine.permissionMode).toBe("default");
    expect(f.service.create({ ...f.params, permissionMode: "plan" }).routine.permissionMode).toBe("plan");
    // Same refusal, same code and message as before this change.
    for (const permissionMode of ["acceptEdits", "bypassPermissions"]) {
      expect(() => f.service.create({ ...f.params, permissionMode })).toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT", message: "Routine permission mode must be default or plan." }));
      expect(() => f.service.create({ ...f.params, permissionMode }, LEGACY_ROUTINE_GRANT)).toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    }
    expect(() => f.service.create({ ...f.params, permissionMode: "auto" }, OPERATOR_ROUTINE_GRANT))
      .toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
  });

  it("lets the operator's Routines screen pick any mode a session could use, defaulting to default", () => {
    const f = setup();
    expect(f.service.create(f.params, OPERATOR_ROUTINE_GRANT).routine.permissionMode).toBe("default");
    for (const mode of ["plan", "default", "acceptEdits", "bypassPermissions"] as const) {
      expect(f.service.create({ ...f.params, permissionMode: mode }, OPERATOR_ROUTINE_GRANT).routine.permissionMode).toBe(mode);
    }
  });

  it("advertises every mode a routine can carry", () => {
    const f = setup();
    expect(f.service.capabilities().permissionModes).toEqual(["default", "plan", "acceptEdits", "bypassPermissions"]);
  });
});

describe("routine updates cannot launder a narrower session into a wider routine", () => {
  it("refuses to change what a wider routine runs from a narrower session", () => {
    const f = setup();
    const routine = f.service.create(f.params, sessionRoutineGrant("bypassPermissions")).routine;
    const narrow = sessionRoutineGrant("default");
    const other = join(f.home, "other"); mkdirSync(other);
    for (const patch of [
      { instructions: "Delete everything." }, { cwd: other }, { model: "another-model" }, { provider: "another" },
      { permissionMode: "acceptEdits" },
    ]) {
      expect(() => f.service.update({ id: routine.id, patch }, narrow)).toThrow(expect.objectContaining({ code: "ROUTINE_PERMISSION_DENIED" }));
      // A caller naming no authority is refused too, with the original contract's code.
      expect(() => f.service.update({ id: routine.id, patch })).toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    }
    expect(f.service.get({ id: routine.id }).routine).toEqual(routine);
  });

  it("still lets a narrower session pause, rename, reschedule or narrow a wider routine", () => {
    const f = setup();
    const routine = f.service.create(f.params, sessionRoutineGrant("bypassPermissions")).routine;
    const narrow = sessionRoutineGrant("default");
    expect(f.service.update({ id: routine.id, patch: { enabled: false, name: "Paused tick" } }, narrow).routine)
      .toMatchObject({ enabled: false, name: "Paused tick", permissionMode: "bypassPermissions" });
    expect(f.service.update({ id: routine.id, patch: { schedule: { kind: "manual" } } }).routine.permissionMode).toBe("bypassPermissions");
    expect(f.service.update({ id: routine.id, patch: { permissionMode: "default", instructions: "Only read." } }, narrow).routine.permissionMode).toBe("default");
  });

  it("lets an equal session or the operator change a wide routine", () => {
    const f = setup();
    const routine = f.service.create(f.params, sessionRoutineGrant("acceptEdits")).routine;
    expect(f.service.update({ id: routine.id, patch: { instructions: "Append twice." } }, sessionRoutineGrant("acceptEdits")).routine.instructions).toBe("Append twice.");
    expect(f.service.update({ id: routine.id, patch: { permissionMode: "bypassPermissions" } }, OPERATOR_ROUTINE_GRANT).routine.permissionMode).toBe("bypassPermissions");
    expect(() => f.service.update({ id: routine.id, patch: { instructions: "x" } }, sessionRoutineGrant("acceptEdits")))
      .toThrow(expect.objectContaining({ code: "ROUTINE_PERMISSION_DENIED" }));
  });
});

describe("stored routines", () => {
  it("reloads a wider stored mode and treats a stored routine without one as today's default", async () => {
    const f = setup();
    const wide = f.service.create(f.params, sessionRoutineGrant("bypassPermissions")).routine;
    const legacy = f.service.create(f.params).routine;
    await f.service.close();
    const document = JSON.parse(readFileSync(f.path, "utf8"));
    delete document.entries[1].routine.permissionMode;
    writeFileSync(f.path, JSON.stringify(document), { mode: 0o600 });
    const restored = new RoutineService({ home: f.home, executor: { execute: vi.fn(async () => "completed" as const) } });
    services.push(restored);
    expect(restored.get({ id: wide.id }).routine.permissionMode).toBe("bypassPermissions");
    expect(restored.get({ id: legacy.id }).routine.permissionMode).toBe("default");
  });
});

describe("request-only permission authority", () => {
  it("accepts exactly a live session reference or the operator", () => {
    expect(parseRoutinePermissionAuthority(undefined)).toBeUndefined();
    expect(parseRoutinePermissionAuthority({ kind: "operator" })).toEqual({ kind: "operator" });
    expect(parseRoutinePermissionAuthority({ kind: "session", sessionId: "session_1" })).toEqual({ kind: "session", sessionId: "session_1" });
    for (const value of [
      null, "operator", [], {}, { kind: "session" }, { kind: "session", sessionId: "" }, { kind: "session", sessionId: 7 },
      { kind: "session", sessionId: "x".repeat(257) }, { kind: "operator", sessionId: "s" },
      { kind: "session", sessionId: "s", permissionMode: "bypassPermissions" }, { kind: "model" }, { kind: "operator", mode: "bypassPermissions" },
    ]) {
      expect(() => parseRoutinePermissionAuthority(value), JSON.stringify(value)).toThrow(expect.objectContaining({ code: "ROUTINE_INVALID_ARGUMENT" }));
    }
  });

  function connection(overrides: Partial<{ operator: boolean; mode: string; held: boolean }> = {}) {
    const liveSession = vi.fn(async (sessionId: string) => ({ sessionId: `live-${sessionId}`, mode: overrides.mode ?? "bypassPermissions" }));
    const holdsSession = vi.fn(async () => overrides.held ?? true);
    return { operator: overrides.operator ?? false, liveSession, holdsSession };
  }

  it("reads the session's mode from the daemon, not from the request", async () => {
    const held = connection({ operator: true });
    await expect(resolveRoutinePermissionGrant({ kind: "session", sessionId: "chat" }, held)).resolves.toEqual(sessionRoutineGrant("bypassPermissions"));
    expect(held.liveSession).toHaveBeenCalledExactlyOnceWith("chat");
    // Holding is checked against the canonical live session, not the name given.
    expect(held.holdsSession).toHaveBeenCalledExactlyOnceWith("live-chat");
    await expect(resolveRoutinePermissionGrant(undefined, held)).resolves.toEqual(LEGACY_ROUTINE_GRANT);
    await expect(resolveRoutinePermissionGrant({ kind: "operator" }, held)).resolves.toEqual(OPERATOR_ROUTINE_GRANT);
    expect(held.liveSession).toHaveBeenCalledOnce();
  });

  it("refuses when the session's mode cannot be read", async () => {
    await expect(resolveRoutinePermissionGrant({ kind: "session", sessionId: "gone" }, {
      ...connection(), liveSession: async () => { throw new Error("session not found"); },
    })).rejects.toMatchObject({ code: "ROUTINE_PERMISSION_DENIED" });
  });

  it("grants a session's mode only to the connection that holds it, and the operator only to an operator connection", async () => {
    await expect(resolveRoutinePermissionGrant({ kind: "session", sessionId: "chat" }, connection({ held: false })))
      .rejects.toMatchObject({ code: "ROUTINE_PERMISSION_DENIED", message: expect.stringContaining("not attached to this connection") });
    await expect(resolveRoutinePermissionGrant({ kind: "operator" }, connection({ operator: false })))
      .rejects.toMatchObject({ code: "ROUTINE_PERMISSION_DENIED" });
  });
});
