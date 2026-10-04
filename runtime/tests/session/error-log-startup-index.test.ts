import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorLogSidecar } from "../../src/session/error-log.js";
import type { Event } from "../../src/session/event-log.js";
import { LogsRepository } from "../../src/state/logs.js";
import { StateSqliteReader } from "../../src/state/sqlite-driver.js";

const failures = vi.hoisted(() => ({ append: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
    if (failures.append) throw Object.assign(new Error("injected full disk"), { code: "ENOSPC" });
    return fs.appendFileSync(...args);
  } };
});
let project: string;
const sidecars: ErrorLogSidecar[] = [];
beforeEach(() => { project = mkdtempSync(join(tmpdir(), "startup-log-index-")); });
afterEach(async () => {
  failures.append = false;
  vi.restoreAllMocks();
  for (const sidecar of sidecars.splice(0)) await sidecar.stop();
  rmSync(project, { recursive: true, force: true });
});
function make(deferStartupIndex = true, sessionId = "fresh") {
  const sidecar = new ErrorLogSidecar({ projectDir: project, sessionId, deferStartupIndex });
  sidecars.push(sidecar);
  return sidecar;
}
function event(seq: number, message = `warning ${seq}`, type = "warning"): Event {
  return { id: String(seq), seq, msg: { type, payload: { cause: "cron_storage_unavailable", message } } } as Event;
}
const logsPath = () => join(project, "agenc-logs_1.sqlite");
function rows() {
  const reader = new StateSqliteReader({ projectDir: project,
    stateDbPath: join(project, "agenc-state_1.sqlite"), logsDbPath: logsPath() });
  try { return reader.prepareLogs("SELECT timestamp, level, thread_id, message, payload_json FROM logs ORDER BY id").all() as Array<Record<string, string>>; }
  finally { reader.close(); }
}

describe("bounded fresh one-shot diagnostic indexing", () => {
  it("retains immutable redacted event-time values and the existing JSONL entries", async () => {
    const sidecar = make(); await sidecar.start();
    expect(existsSync(join(project, "agenc-state_1.sqlite"))).toBe(true);
    const warning = event(1, "Authorization: Bearer sk-test-1234567890abcdefghijklmnop");
    sidecar.onEvent(warning);
    (warning.msg as { payload: { message: string } }).payload.message = "mutated afterwards";
    sidecar.onEvent(event(2));
    expect(existsSync(logsPath())).toBe(false);
    sidecar.flushNow();
    const indexed = rows();
    const entries = readdirSync(join(project, "errors")).filter(name => name.endsWith(".jsonl"))
      .flatMap(name => readFileSync(join(project, "errors", name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    expect(indexed).toHaveLength(2);
    expect(indexed.map(row => JSON.parse(row.payload_json!))).toEqual(entries);
    expect(JSON.stringify(indexed)).not.toContain("1234567890abcdefghijklmnop");
    expect(JSON.stringify(indexed)).not.toContain("mutated afterwards");
    expect(indexed.map(row => row.message)).toEqual(entries.map(row => row.message));
    sidecar.flushStartupIndex();
    expect(rows()).toHaveLength(2);
  });
  it("keeps default full sessions and a later session with existing logs immediate", () => {
    const full = make(false, "full");
    expect(existsSync(logsPath())).toBe(true);
    full.onEvent(event(1));
    const later = make(true, "later"); later.onEvent(event(2));
    expect(rows().map(row => row.thread_id)).toEqual(["full", "later"]);
  });
  it("validates existing malformed logs eagerly", () => {
    writeFileSync(logsPath(), "not a database");
    expect(() => make()).toThrow();
  });
  it("allows a concurrent full opener without sharing its buffering or transaction policy", () => {
    const buffered = make(); buffered.onEvent(event(1)); buffered.onEvent(event(2));
    const full = make(false, "full"); full.onEvent(event(3));
    expect(rows().map(row => row.message)).toEqual(["warning 3"]);
    buffered.flushStartupIndex();
    expect(rows().map(row => row.message)).toEqual(["warning 3", "warning 1", "warning 2"]);
    full.onEvent(event(4)); buffered.onEvent(event(5));
    expect(rows()).toHaveLength(5);
  });
  it("drains on count overflow and remains immediate", () => {
    const sidecar = make();
    for (let seq = 1; seq <= 32; seq++) sidecar.onEvent(event(seq));
    expect(existsSync(logsPath())).toBe(false);
    sidecar.onEvent(event(33)); sidecar.onEvent(event(34));
    expect(rows().map(row => row.message)).toEqual(Array.from({ length: 34 }, (_, i) => `warning ${i + 1}`));
  });
  it.each(["x".repeat(40_000), "界".repeat(6_000)])("bounds retained UTF-8 bytes including a single oversized row (%#)", large => {
    const sidecar = make(); sidecar.onEvent(event(1)); sidecar.onEvent(event(2, large));
    expect(existsSync(logsPath())).toBe(true);
    sidecar.onEvent(event(3));
    expect(rows().map(row => row.message)).toEqual(["warning 1", large, "warning 3"]);
  });
  it.each(["error", "stream_error"])("drains preceding warnings before %s", type => {
    const sidecar = make(); sidecar.onEvent(event(1)); sidecar.onEvent(event(2, "failed", type));
    expect(rows().map(row => row.level)).toEqual(["warning", type]);
  });
  it("does not replay a failed append on reentrant/repeated flush or stop", async () => {
    const sidecar = make(); sidecar.onEvent(event(1)); sidecar.onEvent(event(2));
    const append = vi.spyOn(LogsRepository.prototype, "tryAppend").mockImplementation(() => {
      sidecar.flushStartupIndex(); return false;
    });
    sidecar.flushStartupIndex(); sidecar.flushStartupIndex(); await sidecar.stop();
    sidecar.onEvent(event(3)); await sidecar.stop();
    expect(append).toHaveBeenCalledTimes(2);
    expect(existsSync(logsPath())).toBe(false);
  });
  it("drains before closing and ignores late events", async () => {
    const sidecar = make(); sidecar.onEvent(event(1));
    await sidecar.stop(); sidecar.onEvent(event(2)); sidecar.flushNow();
    expect(rows().map(row => row.message)).toEqual(["warning 1"]);
  });
  it("keeps degraded JSONL replay from creating additional index entries", async () => {
    const sidecar = make(); await sidecar.start();
    failures.append = true;
    for (let seq = 1; seq <= 32; seq++) sidecar.onEvent(event(seq));
    expect(sidecar.isDegraded()).toBe(true);
    expect(existsSync(logsPath())).toBe(false);
    sidecar.onEvent(event(33, "degraded error", "error"));
    expect(rows()).toHaveLength(32);
    expect(sidecar.getStats().degradedBufferSize).toBe(1);
    failures.append = false;
    // Exercise the real retry flush without waiting for its periodic timer.
    const degraded = (sidecar as unknown as { degraded: { tryFlush(): Promise<boolean> } }).degraded;
    await degraded.tryFlush();
    expect(rows()).toHaveLength(32);
  });
});
