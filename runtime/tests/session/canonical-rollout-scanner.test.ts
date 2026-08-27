import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { COMPACTION_SOURCE_DIGEST_DOMAIN } from "../../src/services/compact/transaction-types.js";
import { scanCanonicalRollout } from "../../src/session/canonical-rollout-scanner.js";
import { RolloutStore } from "../../src/session/rollout-store.js";

let temporaryHome = "";
let previousHome: string | undefined;
let temporaryWorkspace = "";

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "agenc-c2-scan-home-"));
  temporaryWorkspace = mkdtempSync(join(tmpdir(), "agenc-c2-scan-workspace-"));
  previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = temporaryHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  rmSync(temporaryHome, { recursive: true, force: true });
  rmSync(temporaryWorkspace, { recursive: true, force: true });
});

describe("canonical rollout compaction scanner", () => {
  it("retains no ordinary rows from a large zero-compaction journal", () => {
    const store = createStore("zero-c2-large");
    const rolloutPath = store.rolloutPath;
    try {
      for (let index = 0; index < 2_500; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "user", content: `ordinary-${index}-${"x".repeat(256)}` },
        });
      }
      store.flushDurable();
    } finally {
      store.close();
    }

    const scan = scanCanonicalRollout(rolloutPath, {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "zero-c2-large",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    });
    expect(scan.proof.recordCount).toBe(2_501);
    expect(scan.attempts.size).toBe(0);
    expect(scan.sourceRecords.size).toBe(0);
  });

  it("checks the operational deadline while streaming", () => {
    const store = createStore("scan-deadline");
    const rolloutPath = store.rolloutPath;
    try {
      for (let index = 0; index < 50; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "user", content: `deadline-${index}` },
        });
      }
      store.flushDurable();
    } finally {
      store.close();
    }
    let tick = 0;
    expect(() => scanCanonicalRollout(rolloutPath, {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "scan-deadline",
      expectedEpoch: 1,
      maximumScanMilliseconds: 5,
      nowMilliseconds: () => tick++,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    })).toThrow(/scan deadline/i);
  });

  it("reconstructs and physically maps a large active history", () => {
    const store = createStore("large-active-history");
    const rolloutPath = store.rolloutPath;
    try {
      for (let index = 0; index < 5_000; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `active-${index}-${"x".repeat(256)}`,
          },
        });
      }
      store.flushDurable();
    } finally {
      store.close();
    }

    const scan = scanCanonicalRollout(rolloutPath, {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "large-active-history",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      captureActiveHistory: true,
    });
    expect(scan.activeHistory?.messages).toHaveLength(5_000);
    expect(scan.activeHistory?.positions).toHaveLength(5_000);
    expect(scan.sourceRecords.size).toBe(5_000);
    expect(scan.activeHistory?.messages.at(-1)?.content).toContain("active-4999");
  });

  it("isolates scan registries under each captured session temp root", async () => {
    const store = createStore("session-temp-authority");
    const rolloutPath = store.rolloutPath;
    try {
      store.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "temp authority" },
      });
      store.flushDurable();
    } finally {
      store.close();
    }

    const rootA = join(temporaryHome, "scan-temp-a");
    const rootB = join(temporaryHome, "scan-temp-b");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });

    const scanAt = async (sessionTempRoot: string): Promise<Set<string>> => {
      const observedEntries = new Set<string>();
      await Promise.resolve();
      scanCanonicalRollout(rolloutPath, {
        sessionTempRoot,
        expectedRunId: "session-temp-authority",
        expectedEpoch: 1,
        maximumScanMilliseconds: 30_000,
        nowMilliseconds: () => {
          for (const entry of readdirSync(sessionTempRoot)) {
            observedEntries.add(entry);
          }
          return Date.now();
        },
        compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      });
      return observedEntries;
    };

    const [entriesA, entriesB] = await Promise.all([
      scanAt(rootA),
      scanAt(rootB),
    ]);

    for (const entries of [entriesA, entriesB]) {
      expect([...entries]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^agenc-recovery-identities-/u),
          expect.stringMatching(/^agenc-c2-payloads-/u),
        ]),
      );
    }
    expect(readdirSync(rootA)).toEqual([]);
    expect(readdirSync(rootB)).toEqual([]);
  });

  it("removes a partial payload registry when SQLite initialization fails", () => {
    const store = createStore("payload-init-failure");
    const rolloutPath = store.rolloutPath;
    store.close();
    const sessionTempRoot = join(temporaryHome, "payload-init-temp");
    mkdirSync(sessionTempRoot, { recursive: true });
    const originalPragma = Database.prototype.pragma;
    const pragmaSpy = vi
      .spyOn(Database.prototype, "pragma")
      .mockImplementation(function (
        this: Database.Database,
        source: string,
        options?: Database.PragmaOptions,
      ) {
        if (this.name.endsWith("payloads.sqlite")) {
          throw new Error("injected payload registry initialization failure");
        }
        return originalPragma.call(this, source, options);
      });
    try {
      expect(() =>
        scanCanonicalRollout(rolloutPath, {
          sessionTempRoot,
          expectedRunId: "payload-init-failure",
          expectedEpoch: 1,
          maximumScanMilliseconds: 30_000,
          compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
        }),
      ).toThrow("injected payload registry initialization failure");
    } finally {
      pragmaSpy.mockRestore();
    }
    expect(readdirSync(sessionTempRoot)).toEqual([]);
  });
});

function createStore(sessionId: string): RolloutStore {
  const store = new RolloutStore({
    cwd: temporaryWorkspace,
    sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: join(temporaryHome, "rollout-temp"),
    autoStartScheduler: false,
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: temporaryWorkspace,
    originator: "canonical-scanner-test",
    agencVersion: "0.13.0",
  });
  return store;
}
