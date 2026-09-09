import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { computeNextCronRun, parseCronExpression } from "../utils/cron.js";
import type { Routine, RoutineCapabilities, RoutineConfig, RoutineRun, RoutineRunStatus, RoutineSchedule, RoutineUpdatedEvent, RoutineWorkspaceExpectation } from "./types.js";

export const MAX_ROUTINES = 100;
export const MAX_ROUTINE_RUNS = 50;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const ACTIVE = new Set<RoutineRunStatus>(["starting", "running", "waiting_permission"]);
const CREATE_KEYS = ["name", "description", "instructions", "cwd", "schedule", "provider", "model", "permissionMode", "enabled", "notifyOnCompletion"];
type Identity = { dev: string; ino: string };
type Entry = { routine: Routine; cwdIdentity: Identity; runs: RoutineRun[] };
type Document = { version: 1; entries: Entry[] };

export class RoutineError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RoutineError"; }
}
/** Execution could not prove quiescence; fence this routine until daemon restart. */
export class RoutineExecutionUnsettledError extends Error {}
function invalid(message: string): never { throw new RoutineError("ROUTINE_INVALID_ARGUMENT", message); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value)) return invalid("Routine parameters must be an object.");
  if (Object.keys(value).some((key) => !keys.includes(key))) return invalid("Routine parameters contain unsupported fields.");
  return value;
}
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > max || (!empty && !value.trim())) return invalid(`${label} must be ${empty ? "a" : "a nonempty"} string of at most ${max} bytes.`);
  return value;
}
function bool(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") return invalid(`${label} must be a boolean.`);
  return value;
}
function identity(path: string): Identity {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a directory");
  return { dev: String(stats.dev), ino: String(stats.ino) };
}
function sameIdentity(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino; }
function cwdAuthority(value: unknown): { cwd: string; cwdIdentity: Identity } {
  const input = text(value, "cwd", 4096);
  if (!isAbsolute(input)) return invalid("cwd must be an absolute existing directory.");
  try {
    const cwd = normalize(realpathSync(input));
    return { cwd, cwdIdentity: identity(cwd) };
  } catch { return invalid("cwd must be an absolute existing directory."); }
}
function workspaceExpectation(value: unknown): RoutineWorkspaceExpectation | undefined {
  if (value === undefined) return undefined;
  const input = object(value, ["cwd", "dev", "ino"]);
  const cwd = text(input.cwd, "expectedWorkspace.cwd", 4096);
  if (!isAbsolute(cwd) || normalize(cwd) !== cwd) return invalid("expectedWorkspace.cwd must be a normalized absolute path.");
  const digitString = (field: "dev" | "ino"): string => {
    const value = input[field];
    if (typeof value !== "string" || value.length < 1 || value.length > 32 || /[^0-9]/.test(value)) return invalid(`expectedWorkspace.${field} must be a digit string of at most 32 characters.`);
    return value;
  };
  return { cwd, dev: digitString("dev"), ino: digitString("ino") };
}
function guardWorkspace(expected: RoutineWorkspaceExpectation | undefined, cwd: string, cwdIdentity: Identity): void {
  if (expected && (expected.cwd !== cwd || !sameIdentity(expected, cwdIdentity))) {
    throw new RoutineError("ROUTINE_CONFLICT", "Workspace changed; refresh it before saving.");
  }
}
function schedule(value: unknown, now: Date): RoutineSchedule {
  const input = object(value, ["kind", "expression"]);
  if (input.kind === "manual" && input.expression === undefined) return { kind: "manual" };
  if (input.kind !== "cron") return invalid("schedule must be manual or a five-field cron expression.");
  const expression = text(input.expression, "Cron expression", 256).trim().replace(/\s+/g, " ");
  const fields = parseCronExpression(expression);
  if (!fields || !computeNextCronRun(fields, now)) return invalid("Cron expression is invalid or has no upcoming occurrence.");
  return { kind: "cron", expression };
}
function nextRun(routine: Pick<Routine, "schedule" | "enabled">, now: Date): string | null {
  if (!routine.enabled || routine.schedule.kind === "manual") return null;
  const fields = parseCronExpression(routine.schedule.expression);
  return fields ? computeNextCronRun(fields, now)?.toISOString() ?? null : null;
}
function normalizeCreate(value: unknown, now: Date): { config: Required<Pick<RoutineConfig, "name" | "description" | "instructions" | "cwd" | "schedule" | "permissionMode" | "enabled" | "notifyOnCompletion">> & Pick<RoutineConfig, "provider" | "model">; cwdIdentity: Identity } {
  const input = object(value, CREATE_KEYS);
  const authority = cwdAuthority(input.cwd);
  if (input.permissionMode !== undefined && input.permissionMode !== "default" && input.permissionMode !== "plan") return invalid("Routine permission mode must be default or plan.");
  const optional = (key: "provider" | "model") => ({ [key]: input[key] === undefined ? undefined : text(input[key], key, 256, true).trim() || undefined });
  return {
    cwdIdentity: authority.cwdIdentity,
    config: {
      name: text(input.name, "Name", 128).trim(), description: text(input.description ?? "", "Description", 2048, true),
      instructions: text(input.instructions, "Instructions", 16_384), cwd: authority.cwd,
      schedule: schedule(input.schedule, now), permissionMode: input.permissionMode ?? "default",
      enabled: bool(input.enabled, "enabled", true), notifyOnCompletion: bool(input.notifyOnCompletion, "notifyOnCompletion", true),
      ...optional("provider"), ...optional("model"),
    },
  };
}

/** One atomic, bounded, private file under the daemon's canonical home. */
class RoutineStore {
  readonly root: string;
  readonly path: string;
  readonly rootIdentity: Identity;
  constructor(home: string) {
    try {
      const canonicalHome = realpathSync(home);
      this.root = join(canonicalHome, "routines");
      mkdirSync(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RoutineError("ROUTINE_STORAGE_UNAVAILABLE", "Routine storage is unavailable.");
      this.root = join(realpathSync(home), "routines");
    }
    try {
      this.rootIdentity = identity(this.root);
      if (realpathSync(this.root) !== this.root) throw new Error("symlink");
      if (process.platform !== "win32" && (lstatSync(this.root).mode & 0o077) !== 0) throw new Error("insecure directory");
    } catch { throw new RoutineError("ROUTINE_STORAGE_UNAVAILABLE", "Routine storage must be a private directory, without symlinks."); }
    this.path = join(this.root, "routines-v1.json");
  }
  private assertRoot(): void {
    if (realpathSync(this.root) !== this.root || !sameIdentity(this.rootIdentity, identity(this.root))) throw new Error("Routine storage changed.");
  }
  read(): Document {
    let fd: number | undefined;
    try {
      this.assertRoot();
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STORE_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("invalid storage file");
      const document: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!record(document) || document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > MAX_ROUTINES) throw new Error("invalid storage document");
      return document as Document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      throw new RoutineError("ROUTINE_STORAGE_UNAVAILABLE", "Routine storage is invalid or unavailable; existing data was preserved.");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  write(document: Document): void {
    const temp = join(this.root, `.routines-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      this.assertRoot();
      try {
        const stat = lstatSync(this.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid storage target");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const serialized = JSON.stringify(document);
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("storage too large");
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, serialized); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.assertRoot(); renameSync(temp, this.path);
      if (process.platform !== "win32") { const dir = openSync(this.root, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } }
    } catch { throw new RoutineError("ROUTINE_STORAGE_UNAVAILABLE", "Routine state could not be saved."); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* Only our uniquely named staging file. */ }
    }
  }
}

export interface RoutineExecutionContext {
  readonly signal: AbortSignal;
  bind(ids: { agentId: string; sessionId: string; coreRunId: string }): void;
}
export interface RoutineExecutor {
  execute(routine: Routine, run: RoutineRun, context: RoutineExecutionContext): Promise<"completed" | "failed" | "cancelled">;
}
type Active = { controller: AbortController; done: Promise<void>; runId: string };

export class RoutineService {
  readonly #store: RoutineStore;
  readonly #executor: RoutineExecutor;
  readonly #now: () => Date;
  #entries: Entry[];
  #active = new Map<string, Active>();
  #held = new Set<string>();
  #listeners = new Set<(event: RoutineUpdatedEvent) => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #started = false;
  #healthy = true;
  constructor(options: { home: string; executor: RoutineExecutor; now?: () => Date }) {
    this.#store = new RoutineStore(options.home); this.#executor = options.executor; this.#now = options.now ?? (() => new Date());
    this.#entries = this.#store.read().entries;
    try {
      const ids = new Set<string>();
      for (const entry of this.#entries) {
        const r = entry.routine;
        object(entry, ["routine", "cwdIdentity", "runs"]);
        object(r, [...CREATE_KEYS, "id", "createdAt", "updatedAt", "nextRunAt", "lastRun"]);
        if (!record(r) || typeof r.id !== "string" || !/^routine_[a-f0-9-]{36}$/.test(r.id) || ids.has(r.id)) throw new Error("invalid id");
        ids.add(r.id);
        if (!Array.isArray(entry.runs) || entry.runs.length > MAX_ROUTINE_RUNS || !record(entry.cwdIdentity) || typeof entry.cwdIdentity.dev !== "string" || typeof entry.cwdIdentity.ino !== "string") throw new Error("invalid history");
        // Disk configuration is untrusted too; validation must not require a workspace that may have been removed.
        const config = Object.fromEntries(CREATE_KEYS.filter((key) => r[key] !== undefined).map((key) => [key, r[key]]));
        const validated = normalizeCreate({ ...config, cwd: this.#store.root }, this.#now()).config;
        if (typeof r.cwd !== "string" || !isAbsolute(r.cwd) || normalize(r.cwd) !== r.cwd || !validDate(r.createdAt) || !validDate(r.updatedAt)) throw new Error("invalid configuration");
        entry.routine = { ...r, ...validated, cwd: r.cwd };
        const runIds = new Set<string>();
        for (const run of entry.runs) {
          object(run, ["id", "routineId", "status", "trigger", "startedAt", "finishedAt", "agentId", "sessionId", "coreRunId", "error"]);
          if (!record(run) || typeof run.id !== "string" || !/^routine_run_[a-f0-9-]{36}$/.test(run.id) || run.routineId !== r.id || ![...ACTIVE, "completed", "failed", "cancelled", "interrupted"].includes(run.status) || !validDate(run.startedAt) || (run.finishedAt !== null && !validDate(run.finishedAt)) || !["manual", "schedule"].includes(run.trigger)) throw new Error("invalid run");
          if (runIds.has(run.id) || ACTIVE.has(run.status) !== (run.finishedAt === null)) throw new Error("invalid run lifecycle");
          runIds.add(run.id);
          for (const key of ["agentId", "sessionId", "coreRunId", "error"] as const) if (run[key] !== null && (typeof run[key] !== "string" || run[key]!.length > 2048)) throw new Error("invalid run field");
        }
      }
    } catch { throw new RoutineError("ROUTINE_STORAGE_UNAVAILABLE", "Routine storage contains invalid records; existing data was preserved."); }
  }
  capabilities(params: unknown = {}): RoutineCapabilities {
    object(params, []);
    this.#assertOpen();
    return { version: 1, available: true, scheduleKinds: ["manual", "cron"], permissionModes: ["default", "plan"], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, executionMode: "local", maxRoutines: MAX_ROUTINES, maxRunsPerRoutine: MAX_ROUTINE_RUNS };
  }
  start(): void {
    this.#assertOpen(); if (this.#started) return;
    const now = this.#now();
    this.#commit(() => {
      for (const entry of this.#entries) {
        entry.runs = entry.runs.map((run) => ACTIVE.has(run.status) ? { ...run, status: "interrupted", finishedAt: now.toISOString(), error: "Daemon stopped before this run finished. It was not restarted automatically." } : run);
        entry.routine = { ...entry.routine, nextRunAt: nextRun(entry.routine, now), lastRun: entry.runs[0] ?? null };
      }
    });
    this.#started = true; this.#arm();
  }
  onUpdated(listener: (event: RoutineUpdatedEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  list(params: unknown = {}): { routines: Routine[] } { object(params, []); this.#assertOpen(); return { routines: structuredClone(this.#entries.map((e) => e.routine)) }; }
  get(params: unknown): { routine: Routine } { const p = object(params, ["id"]); return { routine: structuredClone(this.#entry(p.id).routine) }; }
  create(params: unknown): { routine: Routine } {
    this.#assertOpen(); if (this.#entries.length >= MAX_ROUTINES) throw new RoutineError("ROUTINE_LIMIT", `At most ${MAX_ROUTINES} routines are supported.`);
    const { expectedWorkspace, ...config } = object(params, [...CREATE_KEYS, "expectedWorkspace"]);
    const expected = workspaceExpectation(expectedWorkspace);
    const now = this.#now(); const normalized = normalizeCreate(config, now);
    guardWorkspace(expected, normalized.config.cwd, normalized.cwdIdentity);
    const routine: Routine = { ...normalized.config, id: `routine_${randomUUID()}`, createdAt: now.toISOString(), updatedAt: now.toISOString(), nextRunAt: nextRun(normalized.config, now), lastRun: null };
    this.#commit(() => { this.#entries.push({ routine, cwdIdentity: normalized.cwdIdentity, runs: [] }); });
    this.#emit(routine.id, "created"); this.#arm(); return { routine: structuredClone(routine) };
  }
  update(params: unknown): { routine: Routine } {
    const p = object(params, ["id", "patch", "expectedUpdatedAt", "expectedWorkspace"]); const entry = this.#entry(p.id); this.#guard(entry, p.expectedUpdatedAt);
    const patch = object(p.patch, CREATE_KEYS); if (Object.keys(patch).length === 0) return invalid("Routine patch must contain a setting.");
    const expected = workspaceExpectation(p.expectedWorkspace);
    if (expected && patch.cwd === undefined) return invalid("expectedWorkspace requires patch.cwd.");
    const existing = Object.fromEntries(CREATE_KEYS.filter((key) => entry.routine[key] !== undefined).map((key) => [key, entry.routine[key]]));
    const now = this.#now(); const normalized = normalizeCreate({ ...existing, ...patch, ...(patch.cwd === undefined ? { cwd: this.#store.root } : {}) }, now);
    const config = { ...normalized.config, cwd: patch.cwd === undefined ? entry.routine.cwd : normalized.config.cwd };
    guardWorkspace(expected, config.cwd, normalized.cwdIdentity);
    this.#commit(() => {
      entry.routine = { ...entry.routine, ...config, updatedAt: new Date(Math.max(now.getTime(), Date.parse(entry.routine.updatedAt) + 1)).toISOString(), nextRunAt: nextRun(config, now) };
      if (patch.cwd !== undefined) entry.cwdIdentity = normalized.cwdIdentity;
    });
    this.#emit(entry.routine.id, "updated"); this.#arm(); return { routine: structuredClone(entry.routine) };
  }
  delete(params: unknown): { deleted: true } {
    const p = object(params, ["id", "expectedUpdatedAt"]); const entry = this.#entry(p.id); this.#guard(entry, p.expectedUpdatedAt);
    if (this.#active.has(entry.routine.id) || this.#held.has(entry.routine.id)) throw new RoutineError("ROUTINE_BUSY", "Cancel the active routine run before deleting this routine.");
    this.#commit(() => { this.#entries = this.#entries.filter((e) => e !== entry); }); this.#emit(entry.routine.id, "deleted"); this.#arm(); return { deleted: true };
  }
  runs(params: unknown): { runs: RoutineRun[] } {
    const p = object(params, ["id", "limit"]); const entry = this.#entry(p.id); const limit = p.limit ?? MAX_ROUTINE_RUNS;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROUTINE_RUNS) return invalid(`limit must be between 1 and ${MAX_ROUTINE_RUNS}.`);
    return { runs: structuredClone(entry.runs.slice(0, limit)) };
  }
  run(params: unknown): { run: RoutineRun } {
    const p = object(params, ["id", "expectedUpdatedAt"]); const entry = this.#entry(p.id);
    // No await between this guard and #launch's configuration snapshot/commit:
    // a concurrent editor cannot substitute an unreviewed workspace or policy.
    this.#guard(entry, p.expectedUpdatedAt);
    return { run: this.#launch(entry, "manual") };
  }
  async cancel(params: unknown): Promise<{ run: RoutineRun }> {
    const p = object(params, ["id", "runId"]); const entry = this.#entry(p.id); const active = this.#active.get(entry.routine.id);
    const selected = p.runId === undefined ? entry.runs[0] : entry.runs.find((run) => run.id === text(p.runId, "runId", 128));
    if (!selected) throw new RoutineError("ROUTINE_RUN_NOT_FOUND", "Routine run was not found.");
    if (active?.runId === selected.id) { active.controller.abort(); await active.done; }
    return { run: structuredClone(entry.runs.find((run) => run.id === selected.id)!) };
  }
  /** Called from the existing daemon event fan-out, without lifecycle polling. */
  observeSessionEvent(sessionId: string, event: { method?: unknown }): void {
    if (this.#closed || !this.#healthy) return;
    const waiting = ["event.permission_request", "event.user_input_request", "event.mcp_elicitation_request"].includes(String(event.method));
    if (!waiting && event.method !== "event.message_chunk") return;
    for (const entry of this.#entries) {
      const run = entry.runs.find((r) => r.sessionId === sessionId && ACTIVE.has(r.status));
      const status = waiting ? "waiting_permission" : "running";
      if (run && run.status !== status) {
        try { this.#replaceRun(entry, run.id, { status }); }
        catch { /* Routine storage failure must not interrupt the owning Core event stream. */ }
      }
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    const active = [...this.#active.values()]; for (const run of active) run.controller.abort();
    await Promise.allSettled(active.map((run) => run.done)); this.#listeners.clear();
  }
  #assertOpen(): void { if (this.#closed || !this.#healthy) throw new RoutineError("ROUTINE_UNAVAILABLE", "Routine service is unavailable."); }
  #entry(id: unknown): Entry {
    this.#assertOpen(); const value = text(id, "id", 128); const entry = this.#entries.find((e) => e.routine.id === value);
    if (!entry) throw new RoutineError("ROUTINE_NOT_FOUND", "Routine was not found."); return entry;
  }
  #guard(entry: Entry, expected: unknown): void {
    if (expected !== undefined && text(expected, "expectedUpdatedAt", 64) !== entry.routine.updatedAt) throw new RoutineError("ROUTINE_CONFLICT", "Routine changed; refresh it before saving.");
  }
  #commit(operation: () => void): void {
    const previous = structuredClone(this.#entries);
    try { operation(); this.#store.write({ version: 1, entries: this.#entries }); }
    catch (error) { this.#entries = previous; this.#healthy = false; if (this.#timer) clearTimeout(this.#timer); for (const run of this.#active.values()) run.controller.abort(); throw error; }
  }
  #emit(id: string, reason: RoutineUpdatedEvent["reason"]): void { for (const listener of this.#listeners) { try { listener({ id, reason }); } catch { /* UI observers do not own persisted state. */ } } }
  #replaceRun(entry: Entry, runId: string, patch: Partial<RoutineRun>): void {
    this.#commit(() => { entry.runs = entry.runs.map((r) => r.id === runId ? { ...r, ...patch } : r); entry.routine = { ...entry.routine, lastRun: entry.runs[0] ?? null }; }); this.#emit(entry.routine.id, "run");
  }
  #launch(entry: Entry, trigger: "manual" | "schedule"): RoutineRun {
    this.#assertOpen(); if (this.#active.has(entry.routine.id) || this.#held.has(entry.routine.id)) throw new RoutineError("ROUTINE_BUSY", "This routine already has an active run.");
    const run: RoutineRun = { id: `routine_run_${randomUUID()}`, routineId: entry.routine.id, status: "starting", trigger, startedAt: this.#now().toISOString(), finishedAt: null, agentId: null, sessionId: null, coreRunId: null, error: null };
    const snapshot = structuredClone(entry.routine); const cwdIdentity = { ...entry.cwdIdentity };
    this.#commit(() => { entry.runs = [run, ...entry.runs].slice(0, MAX_ROUTINE_RUNS); entry.routine = { ...entry.routine, lastRun: run }; });
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      let status: RoutineRunStatus = "failed"; let error: string | null = null;
      try {
        if (controller.signal.aborted) status = "cancelled";
        else {
          if (realpathSync(snapshot.cwd) !== snapshot.cwd || !sameIdentity(identity(snapshot.cwd), cwdIdentity)) throw new Error("workspace changed");
          status = await this.#executor.execute(snapshot, run, { signal: controller.signal, bind: (ids) => { this.#replaceRun(entry, run.id, { ...ids, status: "running" }); } });
        }
        if (status === "failed") error = "Core could not complete this run. Open its session for details.";
      } catch (cause) {
        if (cause instanceof RoutineExecutionUnsettledError) {
          this.#held.add(entry.routine.id); status = "running";
          error = "Core could not confirm this run stopped. Further invocations are blocked until the daemon restarts.";
        } else error = "Routine could not run. Check its workspace, provider configuration, and session details.";
      }
      if (this.#closed) { status = "interrupted"; error = "Daemon stopped before this run finished. It was not restarted automatically."; }
      try { this.#replaceRun(entry, run.id, { status, finishedAt: ACTIVE.has(status) ? null : this.#now().toISOString(), error }); }
      finally { this.#active.delete(entry.routine.id); }
    }).catch(() => { this.#active.delete(entry.routine.id); });
    this.#active.set(entry.routine.id, { controller, done, runId: run.id }); this.#emit(entry.routine.id, "run"); return structuredClone(run);
  }
  #arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (!this.#started || this.#closed || !this.#healthy) return;
    const times = this.#entries.flatMap((e) => e.routine.nextRunAt === null ? [] : [Date.parse(e.routine.nextRunAt)]);
    if (!times.length) return;
    this.#timer = setTimeout(() => this.#tick(), Math.max(1, Math.min(30_000, Math.min(...times) - this.#now().getTime())));
    this.#timer.unref?.();
  }
  #tick(): void {
    if (this.#closed || !this.#healthy) return;
    try {
      const now = this.#now();
      const due = this.#entries.filter((e) => e.routine.enabled && e.routine.nextRunAt !== null && Date.parse(e.routine.nextRunAt) <= now.getTime());
      if (due.length) {
        // Advance once from current time: missed ticks never form a catch-up burst.
        this.#commit(() => { for (const entry of due) entry.routine = { ...entry.routine, nextRunAt: nextRun(entry.routine, now) }; });
        for (const entry of due) { if (!this.#active.has(entry.routine.id) && !this.#held.has(entry.routine.id)) this.#launch(entry, "schedule"); else this.#emit(entry.routine.id, "updated"); }
      }
    } catch { /* Storage failures stop the scheduler via #commit; no process-level rejection. */ }
    this.#arm();
  }
}
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
