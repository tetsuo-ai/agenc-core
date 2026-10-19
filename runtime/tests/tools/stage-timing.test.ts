import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { toolStage, withCompletedToolTiming, withToolTiming } from "../../src/tools/stage-timing.js";

afterEach(() => vi.unstubAllEnvs());
it("attributes nested stages and concurrent calls without storing tool data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-timing-"));
  try {
    const file = join(dir, "timings.jsonl");
    vi.stubEnv("AGENC_TOOL_TIMINGS_FILE", file);
    const session = {};
    await Promise.all(["a", "b"].map(callId => withToolTiming(session, callId, "FileRead", async () => {
      await toolStage("admission", async () => {
        await toolStage("execution", () => new Promise(resolve => setTimeout(resolve, 5)));
      });
    })));
    for (const id of ["a", "b"]) withCompletedToolTiming(session, id, () => toolStage("persistence", () => {}));
    const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.callId)).toEqual(["a", "b"]);
    for (const row of rows) {
      expect(row.stagesMs.execution).toBeGreaterThan(0);
      expect(row.stagesMs.admission).toBeGreaterThanOrEqual(0);
      expect(Object.values(row.stagesMs).reduce((sum: number, value) => sum + Number(value), 0)).toBeLessThanOrEqual(row.totalMs + 1);
      expect(Object.keys(row).sort()).toEqual(["callId", "path", "queueAndOtherMs", "stagesMs", "toolName", "totalMs", "version"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("preserves errors with diagnostics enabled and with an unwritable output", async () => {
  vi.stubEnv("AGENC_TOOL_TIMINGS_FILE", "/missing/tool-timings.jsonl");
  const session = {};
  const error = new Error("dispatch failed");
  await expect(withToolTiming(session, "c", "Edit", () => toolStage("execution", async () => { throw error; }))).rejects.toBe(error);
  expect(() => withCompletedToolTiming(session, "c", () => { throw error; })).toThrow(error);
});
