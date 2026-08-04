import { describe, expect, test } from "vitest";

import { plannerAwareExtractiveProxy } from "../../benchmarks/compaction/offline-candidates.mjs";
import {
  assertCompactionOfflineAcceptance,
  deterministicCompactionOfflineProjection,
  validateCompactionOfflineReport,
} from "../../benchmarks/compaction/offline-contract.mjs";
import {
  COMPACTION_OFFLINE_CORPUS_SHA256,
  evaluateCompactionOfflineCorpus,
  loadCompactionOfflineCorpus,
} from "../../benchmarks/compaction/offline-evaluator.mjs";
import { runCompactionOfflineEvaluation } from "../../benchmarks/compaction/run-offline-evaluation.mjs";

describe("C2 held-out offline evaluator", () => {
  test("binds the versioned corpus and reproduces every deterministic metric", async () => {
    const { corpus, sha256 } = await loadCompactionOfflineCorpus();
    const first = evaluateCompactionOfflineCorpus(corpus, sha256);
    const second = evaluateCompactionOfflineCorpus(corpus, sha256);

    expect(sha256).toBe(COMPACTION_OFFLINE_CORPUS_SHA256);
    expect(corpus.cases).toHaveLength(3);
    expect(deterministicCompactionOfflineProjection(first)).toEqual(
      deterministicCompactionOfflineProjection(second),
    );
    await expect(runCompactionOfflineEvaluation(["--check"])).resolves.toMatchObject({
      mode: "check",
    });
  });

  test("labels offline evidence honestly and hard-gates the C2 proxy", async () => {
    const { corpus, sha256 } = await loadCompactionOfflineCorpus();
    const report = evaluateCompactionOfflineCorpus(corpus, sha256);
    const proxy = report.candidates.find(
      (candidate: any) =>
        candidate.candidateId === "c2_planner_deterministic_extractive_proxy_v1",
    );
    const tail = report.candidates.find(
      (candidate: any) =>
        candidate.candidateId === "tail_window_deterministic_extractive_baseline_v1",
    );

    expect(report.evidence).toMatchObject({
      kind: "deterministic_offline",
      networkAccess: false,
      providerCallsExecuted: 0,
      providerQualityClaimed: false,
    });
    expect(
      report.candidates.every(
        (candidate: any) =>
          candidate.providerNative === false &&
          candidate.productionSummaryImplementation === false &&
          candidate.executedProviderCalls === 0,
      ),
    ).toBe(true);
    expect(proxy.gates).toEqual({
      quality: true,
      injection: true,
      provenance: true,
      shrink: true,
      recovery: true,
      allPassed: true,
    });
    expect(proxy.metrics.calls).toMatchObject({
      plannedProviderCalls: 3,
      executedProviderCalls: 0,
    });
    expect(proxy.metrics.shrink.savedEstimatedTokens).toBeGreaterThanOrEqual(
      3_072,
    );
    expect(tail.gates).toMatchObject({
      quality: false,
      injection: false,
      provenance: true,
      shrink: true,
      recovery: false,
      allPassed: false,
    });
    expect(() => assertCompactionOfflineAcceptance(report)).not.toThrow();
  });

  test("keeps candidate generation independent from held-out answer keys", async () => {
    const { corpus } = await loadCompactionOfflineCorpus();
    const entry = corpus.cases[0];
    const messages = entry.messages.map((message: any) => ({
      role: message.role,
      content: Array.from(
        { length: message.repeat ?? 1 },
        () => message.content,
      ).join(" "),
    }));
    const first = plannerAwareExtractiveProxy(
      messages,
      entry.summary_utf8_budget,
    );
    const mutatedAnswerKey = structuredClone(entry.expected_facts);
    for (const fact of mutatedAnswerKey) fact.needle = `unseen-${fact.fact_id}`;
    const second = plannerAwareExtractiveProxy(
      messages,
      entry.summary_utf8_budget,
    );

    expect(mutatedAnswerKey).not.toEqual(entry.expected_facts);
    expect(second).toEqual(first);
  });

  test("rejects fabricated provider evidence and inconsistent gate records", async () => {
    const { corpus, sha256 } = await loadCompactionOfflineCorpus();
    const report = evaluateCompactionOfflineCorpus(corpus, sha256);

    const fabricatedEvidence = structuredClone(report);
    fabricatedEvidence.evidence.providerCallsExecuted = 1;
    expect(() => validateCompactionOfflineReport(fabricatedEvidence)).toThrow(
      /providerCallsExecuted/u,
    );

    const fabricatedCandidate = structuredClone(report);
    fabricatedCandidate.candidates[0].providerNative = true;
    expect(() => validateCompactionOfflineReport(fabricatedCandidate)).toThrow(
      /providerNative/u,
    );

    const inconsistentGate = structuredClone(report);
    inconsistentGate.candidates[0].gates.quality = false;
    expect(() => validateCompactionOfflineReport(inconsistentGate)).toThrow(
      /allPassed is inconsistent/u,
    );

    expect(() =>
      evaluateCompactionOfflineCorpus(corpus, "0".repeat(64)),
    ).toThrow(/reviewed held-out corpus digest/u);
  });
});
