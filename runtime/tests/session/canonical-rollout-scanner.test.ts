import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});

function createStore(sessionId: string): RolloutStore {
  const store = new RolloutStore({
    cwd: temporaryWorkspace,
    sessionId,
    agencVersion: "0.13.0",
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
