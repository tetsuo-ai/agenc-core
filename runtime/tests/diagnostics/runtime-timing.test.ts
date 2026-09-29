import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir as temporaryRoot } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("disabled instrumentation performs no writes and preserves failures", async () => {
  vi.stubEnv("AGENC_RUNTIME_TIMING", "");
  const { runtimeSpan, timedRuntime, flushRuntimeTiming } = await import("../../src/diagnostics/runtime-timing.js");
  runtimeSpan("disabled")();
  const failure = new Error("operation failed");
  await expect(timedRuntime("error", async () => { throw failure; })).rejects.toBe(failure);
  flushRuntimeTiming();
});

test("records intervals once, counts bytes, and preserves result identity", async () => {
  const directory = mkdtempSync(pathJoin(temporaryRoot(), "runtime-timing-"));
  directories.push(directory);
  vi.stubEnv("AGENC_RUNTIME_TIMING", pathJoin(directory, "spans"));
  const { runtimeSpan, timedRuntime, flushRuntimeTiming } = await import("../../src/diagnostics/runtime-timing.js");
  const finish = runtimeSpan("persistence.write", { bytes: 123 });
  finish(); finish();
  const value = {};
  expect(await timedRuntime("tool.invoke", async () => value)).toBe(value);
  flushRuntimeTiming();
  const rows = readFileSync(pathJoin(directory, readdirSync(directory)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ name: "persistence.write", bytes: 123, pid: process.pid });
  expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  expect(rows[0].start_ms).toBeGreaterThan(Date.now() - 10_000);
});

test("an unavailable diagnostic destination cannot change an operation", async () => {
  vi.stubEnv("AGENC_RUNTIME_TIMING", "/nonexistent-runtime-timing-directory/spans");
  const { timedRuntime, flushRuntimeTiming } = await import("../../src/diagnostics/runtime-timing.js");
  expect(await timedRuntime("success", async () => 17)).toBe(17);
  expect(() => flushRuntimeTiming()).not.toThrow();
});

test("enabled timing closes synchronous and asynchronous failures exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-timing-"));
  directories.push(directory);
  vi.stubEnv("AGENC_RUNTIME_TIMING", join(directory, "spans"));
  const { timedRuntime, flushRuntimeTiming } = await import("../../src/diagnostics/runtime-timing.js");
  const synchronous = new Error("synchronous failure");
  const asynchronous = new Error("asynchronous failure");
  await expect(timedRuntime("sync", () => { throw synchronous; })).rejects.toBe(synchronous);
  await expect(timedRuntime("async", async () => { throw asynchronous; })).rejects.toBe(asynchronous);
  flushRuntimeTiming();
  flushRuntimeTiming();
  const rows = readFileSync(join(directory, readdirSync(directory)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.name)).toEqual(["sync", "async"]);
  expect(new Set(rows.map(row => row.id)).size).toBe(2);
});

test("disabled timing preserves the original promise and synchronous throw", async () => {
  vi.stubEnv("AGENC_RUNTIME_TIMING", "");
  const { timedRuntime } = await import("../../src/diagnostics/runtime-timing.js");
  const original = Promise.resolve({});
  expect(timedRuntime("identity", () => original)).toBe(original);
  const failure = new Error("synchronous failure");
  expect(() => timedRuntime("sync", () => { throw failure; })).toThrow(failure);
});
