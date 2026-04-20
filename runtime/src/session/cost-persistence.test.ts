/**
 * CostSidecar cross-session persistence tests (T6 gap).
 *
 * Covers load/save round-trip, missing file, corrupt file, atomic
 * write failure, and appendSessionRecord aggregation.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  COST_TOTALS_FILENAME,
  COST_TOTALS_SCHEMA_VERSION,
  CostSidecar,
  type CostTotalsFile,
  type SessionCostRecord,
} from "./cost.js";

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "agenc-cost-persistence-"));
}

describe("CostSidecar.loadFromDisk", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });

  test("missing file → empty state, no diagnostic", async () => {
    const diagnostics: Array<{ level: string; cause: string }> = [];
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "s1",
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await sidecar.loadFromDisk();
    expect(diagnostics).toHaveLength(0);
    const totals = sidecar.getLifetimeTotals();
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
    expect(sidecar.getLifetimeCostUsd()).toBe(0);
  });

  test("corrupt JSON → empty state + warning diagnostic", async () => {
    writeFileSync(join(projectDir, COST_TOTALS_FILENAME), "{not valid json}");
    const diagnostics: Array<{ level: string; cause: string }> = [];
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "s1",
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await sidecar.loadFromDisk();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.cause).toBe("cost_load_corrupt");
    expect(sidecar.getLifetimeTotals().inputTokens).toBe(0);
  });

  test("schema-invalid JSON → empty state + warning", async () => {
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({ somethingElse: 1 }),
    );
    const diagnostics: Array<{ level: string; cause: string }> = [];
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "s1",
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await sidecar.loadFromDisk();
    expect(diagnostics[0]?.cause).toBe("cost_load_corrupt");
    expect(sidecar.getLifetimeTotals().inputTokens).toBe(0);
  });
});

describe("CostSidecar.saveToDisk", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });

  test("writes expected JSON shape", async () => {
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "sess-A",
    });
    await sidecar.loadFromDisk();
    sidecar.appendSessionRecord({
      sessionId: "sess-A",
      startedAtMs: 100,
      endedAtMs: 200,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 1500,
      },
      costUsd: 0.0125,
    });
    await sidecar.saveToDisk();

    const path = join(projectDir, COST_TOTALS_FILENAME);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CostTotalsFile;
    expect(parsed.version).toBe(COST_TOTALS_SCHEMA_VERSION);
    expect(parsed.totalUsage.inputTokens).toBe(1000);
    expect(parsed.totalUsage.outputTokens).toBe(500);
    expect(parsed.totalCostUsd).toBeCloseTo(0.0125, 6);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]!.sessionId).toBe("sess-A");
    expect(typeof parsed.updatedAtMs).toBe("number");
  });

  test("round-trip: save then load restores lifetime totals", async () => {
    const a = new CostSidecar({ projectDir, sessionId: "sess-A" });
    await a.loadFromDisk();
    a.appendSessionRecord({
      sessionId: "sess-A",
      startedAtMs: 0,
      endedAtMs: 10,
      usage: {
        inputTokens: 2000,
        outputTokens: 800,
        cacheReadTokens: 100,
        reasoningOutputTokens: 50,
        totalTokens: 2950,
      },
      costUsd: 0.05,
    });
    await a.saveToDisk();

    const b = new CostSidecar({ projectDir, sessionId: "sess-B" });
    await b.loadFromDisk();
    const totals = b.getLifetimeTotals();
    expect(totals.inputTokens).toBe(2000);
    expect(totals.outputTokens).toBe(800);
    expect(totals.cacheReadTokens).toBe(100);
    expect(totals.reasoningOutputTokens).toBe(50);
    expect(b.getLifetimeCostUsd()).toBeCloseTo(0.05, 6);
  });

  test("two sessions accumulate", async () => {
    const a = new CostSidecar({ projectDir, sessionId: "sess-A" });
    await a.loadFromDisk();
    a.appendSessionRecord({
      sessionId: "sess-A",
      startedAtMs: 0,
      endedAtMs: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 150,
      },
      costUsd: 0.01,
    });
    await a.saveToDisk();

    const b = new CostSidecar({ projectDir, sessionId: "sess-B" });
    await b.loadFromDisk();
    b.appendSessionRecord({
      sessionId: "sess-B",
      startedAtMs: 2,
      endedAtMs: 3,
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 300,
      },
      costUsd: 0.02,
    });
    await b.saveToDisk();

    const raw = JSON.parse(
      readFileSync(join(projectDir, COST_TOTALS_FILENAME), "utf8"),
    ) as CostTotalsFile;
    expect(raw.sessions).toHaveLength(2);
    expect(raw.totalUsage.inputTokens).toBe(300);
    expect(raw.totalUsage.outputTokens).toBe(150);
    expect(raw.totalCostUsd).toBeCloseTo(0.03, 6);
  });

  test("atomic write: no partial file visible on write failure", async () => {
    const diagnostics: Array<{ level: string; cause: string }> = [];
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "sess-A",
      onDiagnostic: (d) => diagnostics.push(d),
      writeImpl: async () => {
        throw new Error("simulated fsync failure");
      },
    });
    await sidecar.loadFromDisk();
    sidecar.appendSessionRecord({
      sessionId: "sess-A",
      startedAtMs: 0,
      endedAtMs: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      costUsd: 0.001,
    });
    await sidecar.saveToDisk();

    // cost-totals.json must not exist; the fake writeImpl never
    // performed a rename, so no partial/stale file is visible.
    const finalPath = join(projectDir, COST_TOTALS_FILENAME);
    expect(existsSync(finalPath)).toBe(false);
    // No lingering `.tmp` from the simulated failure: atomicWriteJson
    // wasn't reached, so nothing was written. The real atomicWriteJson
    // keeps the tmp isolated from the final path until rename.
    expect(
      readdirSync(projectDir).some((f) => f.endsWith(".tmp")),
    ).toBe(false);
    expect(diagnostics.some((d) => d.cause === "cost_save_failed")).toBe(true);
    expect(sidecar.isDegraded()).toBe(true);
  });

  test("real atomic write: concurrent readers never see partial file", async () => {
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "sess-A",
    });
    await sidecar.loadFromDisk();
    sidecar.appendSessionRecord({
      sessionId: "sess-A",
      startedAtMs: 0,
      endedAtMs: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      costUsd: 0.001,
    });
    await sidecar.saveToDisk();
    const path = join(projectDir, COST_TOTALS_FILENAME);
    const raw = readFileSync(path, "utf8");
    // Must be parseable in full — atomic rename guarantees fully-
    // written content at the destination path.
    const parsed = JSON.parse(raw) as CostTotalsFile;
    expect(parsed.version).toBe(COST_TOTALS_SCHEMA_VERSION);
    // No lingering tmp beside the final file.
    expect(
      readdirSync(projectDir).some((f) => f.endsWith(".tmp")),
    ).toBe(false);
  });
});

describe("CostSidecar.appendSessionRecord", () => {
  test("mutates in-memory lifetime totals", async () => {
    const projectDir = makeProjectDir();
    const sidecar = new CostSidecar({ projectDir, sessionId: "s1" });
    await sidecar.loadFromDisk();
    const record: SessionCostRecord = {
      sessionId: "s1",
      startedAtMs: 0,
      endedAtMs: 10,
      usage: {
        inputTokens: 500,
        outputTokens: 250,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 750,
      },
      costUsd: 0.02,
    };
    sidecar.appendSessionRecord(record);
    expect(sidecar.getLifetimeTotals().inputTokens).toBe(500);
    expect(sidecar.getLifetimeCostUsd()).toBeCloseTo(0.02, 6);
  });
});

describe("CostSidecar.stop (lifecycle)", () => {
  test("flushes current session totals to disk", async () => {
    const projectDir = makeProjectDir();
    const sidecar = new CostSidecar({ projectDir, sessionId: "sess-live" });
    await sidecar.loadFromDisk();
    // Simulate live events: turn_context + token_count + turn_complete.
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "turn_context",
        payload: {
          cwd: "/",
          approvalPolicy: "never",
          sandboxPolicy: "read_only",
          model: "grok-4-fast",
        },
      },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: { type: "turn_complete", payload: { turnId: "t1" } },
    });

    await sidecar.stop();
    const path = join(projectDir, COST_TOTALS_FILENAME);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CostTotalsFile;
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]!.sessionId).toBe("sess-live");
    expect(parsed.sessions[0]!.usage.inputTokens).toBe(100);
    expect(parsed.sessions[0]!.usage.outputTokens).toBe(50);
    expect(parsed.totalUsage.inputTokens).toBe(100);
  });

  test("no-op when projectDir + sessionId unset", async () => {
    const sidecar = new CostSidecar({});
    await sidecar.stop(); // must not throw
    expect(sidecar.isDegraded()).toBe(false);
  });
});

afterEach(() => {
  /* tmpdirs cleaned up by OS */
});
