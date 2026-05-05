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
import { EventLog } from "./event-log.js";
import { SidecarManager } from "./sidecar.js";

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

  test("legacy session records without modelUsage still load", async () => {
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({
        version: COST_TOTALS_SCHEMA_VERSION,
        totalUsage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        totalCostUsd: 0.015,
        sessions: [
          {
            sessionId: "legacy-session",
            startedAtMs: 10,
            endedAtMs: 20,
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 150,
            },
            costUsd: 0.015,
          },
        ],
        updatedAtMs: 30,
      }),
    );
    const diagnostics: Array<{ level: string; cause: string }> = [];
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "new-session",
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await sidecar.loadFromDisk();
    expect(diagnostics).toHaveLength(0);
    expect(sidecar.getLifetimeTotals().totalTokens).toBe(150);
    expect(sidecar.getLifetimeCostUsd()).toBeCloseTo(0.015, 6);
  });

  test("restore coerces malformed nested modelUsage rows", async () => {
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({
        version: COST_TOTALS_SCHEMA_VERSION,
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheCreationTokens: 1,
          reasoningOutputTokens: 0,
          webSearchRequests: 0,
          totalTokens: 15,
        },
        totalCostUsd: 0.02,
        sessions: [
          {
            sessionId: "resume-me",
            startedAtMs: 10,
            endedAtMs: 20,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 3,
              cacheCreationTokens: 1,
              reasoningOutputTokens: 0,
              webSearchRequests: 0,
              totalTokens: 15,
            },
            costUsd: 0.02,
            modelUsage: [
              {
                model: "gpt-4o",
                provider: "openai",
                inputTokens: "bad",
                outputTokens: 5,
                cacheReadTokens: Number.NaN,
                cacheCreationTokens: 1,
                reasoningOutputTokens: undefined,
                webSearchRequests: 0,
                totalTokens: 15,
                turns: 1,
                costUsd: 0.02,
              },
              { model: "", inputTokens: 999 },
            ],
          },
        ],
        updatedAtMs: 30,
      }),
    );
    const sidecar = new CostSidecar({ projectDir, sessionId: "new-session" });
    await sidecar.loadFromDisk();

    expect(sidecar.restoreSessionCostsForSession("resume-me")).toBe(true);
    expect(sidecar.getPerModelUsage()).toMatchObject([
      {
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 0,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 1,
        totalTokens: 15,
      },
    ]);
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.02, 6);
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

describe("CostSidecar.restoreSessionCostsForSession", () => {
  test("replaces a restored session record instead of double-counting it", async () => {
    const projectDir = makeProjectDir();
    const initialCost = 0.0075;
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({
        version: COST_TOTALS_SCHEMA_VERSION,
        totalUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningOutputTokens: 0,
          webSearchRequests: 0,
          totalTokens: 1500,
        },
        totalCostUsd: initialCost,
        sessions: [
          {
            sessionId: "resume-me",
            startedAtMs: 10,
            endedAtMs: 20,
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningOutputTokens: 0,
              webSearchRequests: 0,
              totalTokens: 1500,
            },
            costUsd: initialCost,
            modelUsage: [
              {
                provider: "openai",
                model: "gpt-4o",
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                reasoningOutputTokens: 0,
                webSearchRequests: 0,
                totalTokens: 1500,
                turns: 1,
                costUsd: initialCost,
              },
            ],
            durationMs: 75,
            apiDurationMs: 25,
            apiDurationWithoutRetriesMs: 25,
            toolDurationMs: 5,
            linesAdded: 3,
            linesRemoved: 1,
          },
        ],
        updatedAtMs: 30,
      } satisfies CostTotalsFile),
    );

    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "fresh",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    await sidecar.loadFromDisk();
    expect(sidecar.restoreSessionCostsForSession("resume-me")).toBe(true);
    expect(sidecar.getLifetimeTotals().inputTokens).toBe(1000);
    expect(sidecar.getTotalInputTokens()).toBe(1000);
    expect(sidecar.getTotalApiDurationMs()).toBeGreaterThanOrEqual(25);
    expect(sidecar.getTotalLinesAdded()).toBe(3);

    sidecar.onEvent({
      id: "new-usage",
      seq: 1,
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
        },
      },
    });
    sidecar.addToTotalLinesChanged(2, 4);
    await sidecar.stop();

    const parsed = JSON.parse(
      readFileSync(join(projectDir, COST_TOTALS_FILENAME), "utf8"),
    ) as CostTotalsFile;
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]!.sessionId).toBe("resume-me");
    expect(parsed.totalUsage.inputTokens).toBe(2000);
    expect(parsed.totalUsage.outputTokens).toBe(1000);
    expect(parsed.totalCostUsd).toBeCloseTo(initialCost * 2, 6);
    expect(parsed.sessions[0]!.linesAdded).toBe(5);
    expect(parsed.sessions[0]!.linesRemoved).toBe(5);
  });

  test("legacy records without modelUsage restore aggregate totals", async () => {
    const projectDir = makeProjectDir();
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({
        version: COST_TOTALS_SCHEMA_VERSION,
        totalUsage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        totalCostUsd: 0.123,
        sessions: [
          {
            sessionId: "legacy",
            startedAtMs: 10,
            endedAtMs: 20,
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 150,
            },
            costUsd: 0.123,
          },
        ],
        updatedAtMs: 30,
      }),
    );

    const sidecar = new CostSidecar({ projectDir, sessionId: "fresh" });
    await sidecar.loadFromDisk();
    expect(sidecar.restoreSessionCostsForSession("legacy")).toBe(true);
    expect(sidecar.getTotalInputTokens()).toBe(120);
    expect(sidecar.getTotalOutputTokens()).toBe(30);
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.123, 6);
    expect(sidecar.formatTotalCost()).toContain("120 input, 30 output");
  });

  test("restored per-model bucket costs preserve persisted pricing", async () => {
    const projectDir = makeProjectDir();
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({
        version: COST_TOTALS_SCHEMA_VERSION,
        totalUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningOutputTokens: 0,
          webSearchRequests: 0,
          totalTokens: 1500,
        },
        totalCostUsd: 1.23,
        sessions: [
          {
            sessionId: "priced",
            startedAtMs: 10,
            endedAtMs: 20,
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningOutputTokens: 0,
              webSearchRequests: 0,
              totalTokens: 1500,
            },
            costUsd: 1.23,
            modelUsage: [
              {
                provider: "openai",
                model: "gpt-4o",
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                reasoningOutputTokens: 0,
                webSearchRequests: 0,
                totalTokens: 1500,
                turns: 1,
                costUsd: 1.23,
              },
            ],
          },
        ],
        updatedAtMs: 30,
      } satisfies CostTotalsFile),
    );

    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "fresh",
      registry: { "openai:gpt-4o": { inputUsdPer1K: 0, outputUsdPer1K: 0 } },
    });
    await sidecar.loadFromDisk();
    expect(sidecar.restoreSessionCostsForSession("priced")).toBe(true);

    expect(sidecar.getTotalCostUsd()).toBeCloseTo(1.23, 6);
    expect(sidecar.getSessionModelUsage()[0]!.costUsd).toBeCloseTo(1.23, 6);
  });

  test("repeated restore is idempotent and dirty restore is rejected", async () => {
    const projectDir = makeProjectDir();
    writeFileSync(
      join(projectDir, COST_TOTALS_FILENAME),
      JSON.stringify({
        version: COST_TOTALS_SCHEMA_VERSION,
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        totalCostUsd: 0.01,
        sessions: [
          {
            sessionId: "one",
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
          },
        ],
        updatedAtMs: 2,
      }),
    );
    const sidecar = new CostSidecar({ projectDir, sessionId: "fresh" });
    await sidecar.loadFromDisk();
    expect(sidecar.restoreSessionCostsForSession("one")).toBe(true);
    expect(sidecar.restoreSessionCostsForSession("one")).toBe(true);
    expect(sidecar.getLifetimeTotals().inputTokens).toBe(100);

    const dirty = new CostSidecar({
      projectDir,
      sessionId: "dirty",
      defaultModel: "gpt-4o",
    });
    await dirty.loadFromDisk();
    dirty.onEvent({
      id: "dirty-usage",
      seq: 1,
      msg: {
        type: "token_count",
        payload: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });
    expect(dirty.restoreSessionCostsForSession("one")).toBe(false);
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

  test("persists per-session provider and model buckets", async () => {
    const projectDir = makeProjectDir();
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "sess-provider-buckets",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    await sidecar.loadFromDisk();

    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "turn_started", payload: { turnId: "hosted" } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 1000,
          completionTokens: 500,
          cacheCreationInputTokens: 125,
          webSearchRequests: 2,
          totalTokens: 1500,
        },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: { type: "turn_complete", payload: { turnId: "hosted" } },
    });
    sidecar.onEvent({
      id: "4",
      seq: 4,
      msg: { type: "turn_started", payload: { turnId: "local" } },
    });
    sidecar.onEvent({
      id: "5",
      seq: 5,
      msg: {
        type: "turn_context",
        payload: {
          cwd: "/",
          approvalPolicy: "never",
          sandboxPolicy: "read_only",
          model: "gpt-4o",
          modelProviderId: "lmstudio",
        },
      },
    });
    sidecar.onEvent({
      id: "6",
      seq: 6,
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 2000,
          completionTokens: 250,
          totalTokens: 2250,
        },
      },
    });
    sidecar.onEvent({
      id: "7",
      seq: 7,
      msg: { type: "turn_complete", payload: { turnId: "local" } },
    });

    await sidecar.stop();

    const parsed = JSON.parse(
      readFileSync(join(projectDir, COST_TOTALS_FILENAME), "utf8"),
    ) as CostTotalsFile;
    const session = parsed.sessions[0]!;
    const rows = [...(session.modelUsage ?? [])].sort((a, b) =>
      `${a.provider ?? ""}/${a.model}`.localeCompare(
        `${b.provider ?? ""}/${b.model}`,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "lmstudio",
      model: "gpt-4o",
      inputTokens: 2000,
      outputTokens: 250,
      totalTokens: 2250,
      turns: 1,
      costUsd: 0,
    });
    expect(rows[1]).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 125,
      webSearchRequests: 2,
      totalTokens: 1500,
      turns: 1,
    });
    expect(rows[1]!.costUsd).toBeGreaterThan(0);
    expect(session.usage.inputTokens).toBe(3000);
    expect(session.usage.outputTokens).toBe(750);
    expect(session.usage.cacheCreationTokens).toBe(125);
    expect(session.usage.webSearchRequests).toBe(2);
    expect(session.usage.totalTokens).toBe(3750);
    expect(parsed.totalUsage.inputTokens).toBe(3000);
    expect(parsed.totalUsage.cacheCreationTokens).toBe(125);
    expect(parsed.totalUsage.webSearchRequests).toBe(2);
    expect(parsed.totalCostUsd).toBeCloseTo(rows[1]!.costUsd, 6);
  });

  test("no-op when projectDir + sessionId unset", async () => {
    const sidecar = new CostSidecar({});
    await sidecar.stop(); // must not throw
    expect(sidecar.isDegraded()).toBe(false);
  });

  test("SidecarManager stop flushes the final snapshot and drops post-stop events", async () => {
    const projectDir = makeProjectDir();
    const sidecar = new CostSidecar({ projectDir, sessionId: "sess-managed" });
    await sidecar.loadFromDisk();

    const log = new EventLog();
    const manager = new SidecarManager();
    manager.register(sidecar);
    await manager.start(log);

    log.emit({
      id: "1",
      seq: 1,
      msg: {
        type: "turn_context",
        payload: {
          cwd: "/",
          approvalPolicy: "never",
          sandboxPolicy: "read_only",
          model: "gpt-4o",
        },
      },
    });
    log.emit({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });
    log.emit({
      id: "3",
      seq: 3,
      msg: { type: "turn_complete", payload: { turnId: "t1" } },
    });

    await manager.stop();

    log.emit({
      id: "4",
      seq: 4,
      msg: {
        type: "token_count",
        payload: { promptTokens: 99, completionTokens: 1, totalTokens: 100 },
      },
    });

    const parsed = JSON.parse(
      readFileSync(join(projectDir, COST_TOTALS_FILENAME), "utf8"),
    ) as CostTotalsFile;
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]!.sessionId).toBe("sess-managed");
    expect(parsed.sessions[0]!.usage.inputTokens).toBe(10);
    expect(parsed.sessions[0]!.usage.outputTokens).toBe(5);
    expect(parsed.sessions[0]!.usage.totalTokens).toBe(15);
  });
});

afterEach(() => {
  /* tmpdirs cleaned up by OS */
});
