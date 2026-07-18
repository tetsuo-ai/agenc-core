import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digestCanonicalJson } from "../../src/eval-contract/index.js";
import type {
  TrustConformanceSuiteDefinitionDocument,
  TrustFixtureBundleDocument,
} from "../../src/eval-suites/index.js";
import {
  aggregateTrustAttempts,
  runTrustConformanceSuite,
  runTrustSuiteFromFiles,
  type TrustRunResult,
} from "../../src/eval-executor/index.js";

const SUITE_DIR = path.resolve(
  __dirname,
  "../../eval/suites/trust-conformance/1.0.0",
);
const REPOSITORY_COMMIT = "deadbeef".repeat(5);

function loadSuite(): {
  definition: TrustConformanceSuiteDefinitionDocument;
  fixtures: TrustFixtureBundleDocument;
} {
  return {
    definition: JSON.parse(
      readFileSync(path.join(SUITE_DIR, "definition.json"), "utf8"),
    ) as TrustConformanceSuiteDefinitionDocument,
    fixtures: JSON.parse(
      readFileSync(path.join(SUITE_DIR, "fixtures.json"), "utf8"),
    ) as TrustFixtureBundleDocument,
  };
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let cachedRun: Promise<TrustRunResult> | null = null;
function runSuiteOnce(): Promise<TrustRunResult> {
  cachedRun ??= (async () => {
    const { definition, fixtures } = loadSuite();
    return runTrustConformanceSuite({
      definition,
      fixtures,
      seedSlot: 0,
      repositoryCommit: REPOSITORY_COMMIT,
      systemConfigurationDigest: digestCanonicalJson(
        "agenc.eval.trust-system-configuration.v1",
        { test: true },
      ),
    });
  })();
  return cachedRun;
}

describe("trust-conformance executor", () => {
  it("evaluates every scenario with zero infrastructure-invalid attempts", async () => {
    const { summary, attempts } = await runSuiteOnce();
    expect(attempts).toHaveLength(7);
    expect(summary.total).toBe(7);
    expect(summary.infrastructureInvalid).toBe(0);
    // Every attempt was genuinely evaluated: fault injected, invariants real.
    for (const attempt of attempts) {
      expect(attempt.report.fault.injected).toBe(true);
      expect(attempt.report.invariantResults.length).toBeGreaterThan(0);
      expect(
        attempt.rawEvidence.some((event) => event.type === "infrastructure.error"),
      ).toBe(false);
    }
  }, 120_000);

  it("pins the honest per-family outcomes for today's runtime (M3/M4 gap data)", async () => {
    const { summary } = await runSuiteOnce();
    // Both directions are regression-sensitive: a runtime regression flips a
    // passed family to failed; a harness bug faking a pass flips a failed
    // family to passed. Either way this assertion goes red.
    // Baseline history: 3/7 -> 4/7 with the M3 budget reservation kernel
    // (reconciliation_exactly_once), 4/7 -> 5/7 with the M4 event-gap
    // markers, 5/7 -> 6/7 with the M4 unknown-outcome gate (a session with
    // an unresolved poisoned effect refuses new side-effecting mutations
    // until explicit review resolution, so dependent_mutations_stopped
    // genuinely passes).
    expect(summary.faultFamilyResults).toEqual({
      budget: "passed",
      cancellation: "failed",
      event_loss: "passed",
      permission: "passed",
      reconnect: "passed",
      restart: "passed",
      uncertain_effect: "passed",
    });
    expect(summary.passed).toBe(6);
    expect(summary.failed).toBe(1);
    expect(summary.trustRecoveryRate).toBeCloseTo(6 / 7, 10);
  }, 120_000);

  it("reports exactly the known capability-gap invariants as failed", async () => {
    const { summary } = await runSuiteOnce();
    const sortedFailures = [...summary.failedInvariants].sort((a, b) =>
      `${a.scenarioId}:${a.invariant}`.localeCompare(`${b.scenarioId}:${b.invariant}`));
    expect(sortedFailures).toEqual([
      {
        scenarioId: "cancel-parent-after-child-admission",
        invariant: "descendant_admission_stopped",
      },
      {
        scenarioId: "cancel-parent-after-child-admission",
        invariant: "queued_and_running_descendants_cancelled",
      },
    ]);
    expect(summary.zeroTolerance).toEqual({
      policyEscapeCount: 0,
      duplicatedUncertainMutationCount: 0,
      hiddenEventLossCount: 0,
    });
    expect(summary.unknownOutcomeCount).toBe(1);
  }, 120_000);

  it("records required evidence types for every passing report", async () => {
    const { attempts } = await runSuiteOnce();
    for (const attempt of attempts) {
      if (attempt.report.outcome !== "passed") continue;
      for (const required of attempt.plan.requiredEvidenceTypes) {
        expect(
          attempt.report.observedEvidenceTypes,
          `${attempt.report.scenarioId} missing ${required}`,
        ).toContain(required);
      }
    }
  }, 120_000);

  it("rejects aggregation across mismatched seed slots and duplicate fault classes", async () => {
    const { definition } = loadSuite();
    const { attempts } = await runSuiteOnce();
    expect(() =>
      aggregateTrustAttempts({ definition, seedSlot: 1 }, attempts),
    ).toThrow(/seed-slot mismatch/);
    expect(() =>
      aggregateTrustAttempts({ definition, seedSlot: 0 }, [
        attempts[0]!,
        attempts[0]!,
      ]),
    ).toThrow(/duplicate fault class/);
  }, 120_000);

  it("writes validated, non-clobberable artifacts and preserves failed-attempt state", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "agenc-trust-out-"));
    tempDirs.push(outputDir);
    const summary = await runTrustSuiteFromFiles({
      suiteDir: SUITE_DIR,
      seedSlot: 0,
      outputDir,
      repositoryCommit: REPOSITORY_COMMIT,
    });
    expect(summary.infrastructureInvalid).toBe(0);
    const entries = readdirSync(outputDir);
    expect(entries).toContain("trust-summary.slot0.json");
    expect(entries).toContain("trust-restart-after-reservation.slot0.json");
    expect(entries).toContain(
      "trust-restart-after-reservation.slot0.evidence.json",
    );
    // Content-addressed summary document.
    const summaryDoc = JSON.parse(
      readFileSync(path.join(outputDir, "trust-summary.slot0.json"), "utf8"),
    ) as { kind?: string; documentDigest?: string; summary?: { total?: number } };
    expect(summaryDoc.kind).toBe("agenc.eval.trust-run-summary");
    expect(summaryDoc.documentDigest).toMatch(/^sha256:/);
    expect(summaryDoc.summary?.total).toBe(7);
    // Failed attempts keep their forensic state (SQLite DBs, ledger, audit);
    // passing attempts are cleaned. Only cancellation still fails.
    const preserved = readdirSync(path.join(outputDir, "attempts"));
    expect(preserved).toEqual([
      "trust-cancel-parent-after-child-admission-slot0",
    ]);
    // wx flags: a rerun into the same output dir must refuse to clobber.
    await expect(
      runTrustSuiteFromFiles({
        suiteDir: SUITE_DIR,
        seedSlot: 0,
        outputDir,
        repositoryCommit: REPOSITORY_COMMIT,
      }),
    ).rejects.toThrow(/EEXIST/);
  }, 120_000);
});
