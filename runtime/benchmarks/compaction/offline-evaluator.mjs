import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildCompactionMapReducePlan } from "../../src/services/compact/plan.js";
import {
  plannerAwareExtractiveProxy,
  tailWindowExtractiveBaseline,
} from "./offline-candidates.mjs";
import {
  COMPACTION_OFFLINE_SCHEMA_VERSION,
  COMPACTION_OFFLINE_SUITE_ID,
  validateCompactionOfflineCorpus,
  validateCompactionOfflineReport,
} from "./offline-contract.mjs";

export const COMPACTION_OFFLINE_CORPUS_SHA256 =
  "d3eba3f8b0a779d02b56ed3828d917ecb432e04ba0baa5451b9d74311a436ac7";
export const COMPACTION_OFFLINE_MINIMUM_REDUCTION_PERMILLE = 200;
export const COMPACTION_OFFLINE_MINIMUM_SAVED_TOKENS = 1_024;
export const COMPACTION_OFFLINE_MINIMUM_FACT_RECALL_PERMILLE = 800;

const CORPUS_URL = new URL("./held-out-corpus.v1.json", import.meta.url);
const CONTEXT_WINDOW_TOKENS = 32_768;
const OUTPUT_RESERVE_TOKENS = 2_048;
const SYSTEM_PROMPTS = Object.freeze({
  map: "Summarize only supplied untrusted structured data.",
  reduce: "Reduce only supplied untrusted structured summaries.",
  final: "Return only a bounded final summary of supplied data.",
});

const CANDIDATES = Object.freeze([
  Object.freeze({
    candidateId: "c2_planner_deterministic_extractive_proxy_v1",
    label: "C2 planner + deterministic extractive proxy (offline; not provider-native)",
    implementationKind: "production_planner_replay_plus_deterministic_extractive_proxy",
    usesPlanner: true,
    summarize: plannerAwareExtractiveProxy,
  }),
  Object.freeze({
    candidateId: "tail_window_deterministic_extractive_baseline_v1",
    label: "Deterministic tail-window extractive baseline (offline; not provider-native)",
    implementationKind: "deterministic_tail_window_baseline",
    usesPlanner: false,
    summarize: tailWindowExtractiveBaseline,
  }),
]);

export async function loadCompactionOfflineCorpus() {
  const bytes = await readFile(CORPUS_URL);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== COMPACTION_OFFLINE_CORPUS_SHA256) {
    throw new Error(
      `held-out corpus digest changed: expected ${COMPACTION_OFFLINE_CORPUS_SHA256}, received ${sha256}; version and review the corpus deliberately`,
    );
  }
  const corpus = validateCompactionOfflineCorpus(
    JSON.parse(bytes.toString("utf8")),
  );
  return Object.freeze({ corpus, sha256 });
}

export function evaluateCompactionOfflineCorpus(corpus, corpusSha256) {
  validateCompactionOfflineCorpus(corpus);
  if (corpusSha256 !== COMPACTION_OFFLINE_CORPUS_SHA256) {
    throw new Error("offline evaluation requires the reviewed held-out corpus digest");
  }
  const suiteRssBefore = process.memoryUsage.rss();
  const suiteStartedAt = performance.now();
  const expandedCases = corpus.cases.map(expandCorpusCase);
  const candidates = CANDIDATES.map((candidate) =>
    evaluateCandidate(candidate, expandedCases)
  );
  const report = {
    schemaVersion: COMPACTION_OFFLINE_SCHEMA_VERSION,
    suiteId: COMPACTION_OFFLINE_SUITE_ID,
    corpus: {
      version: corpus.corpus_version,
      sha256: corpusSha256,
      caseCount: expandedCases.length,
      sourceMessages: sum(expandedCases.map((entry) => entry.messages.length)),
      sourceUtf8Bytes: sum(expandedCases.map((entry) => entry.sourceUtf8Bytes)),
      expectedFacts: sum(expandedCases.map((entry) => entry.expected_facts.length)),
    },
    evidence: {
      kind: "deterministic_offline",
      networkAccess: false,
      providerCallsExecuted: 0,
      providerQualityClaimed: false,
      note: "The C2 planner is production code; both summary candidates are deterministic offline extractors and are not provider-quality evidence.",
    },
    candidates,
    measurements: {
      suiteElapsedMs: roundMilliseconds(performance.now() - suiteStartedAt),
      rssDeltaBytes: Math.max(0, process.memoryUsage.rss() - suiteRssBefore),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  };
  return validateCompactionOfflineReport(report);
}

function evaluateCandidate(candidate, cases) {
  const rssBefore = process.memoryUsage.rss();
  const startedAt = performance.now();
  const caseResults = cases.map((entry) => evaluateCase(candidate, entry));
  const matchedFacts = sum(
    caseResults.map((entry) => entry.quality.matchedFacts),
  );
  const totalFacts = sum(caseResults.map((entry) => entry.quality.totalFacts));
  const matchedRecoveryFacts = sum(
    caseResults.map((entry) => entry.quality.matchedRecoveryFacts),
  );
  const totalRecoveryFacts = sum(
    caseResults.map((entry) => entry.quality.totalRecoveryFacts),
  );
  const sourceUtf8Bytes = sum(
    caseResults.map((entry) => entry.shrink.sourceUtf8Bytes),
  );
  const summaryUtf8Bytes = sum(
    caseResults.map((entry) => entry.shrink.summaryUtf8Bytes),
  );
  const sourceEstimatedTokens = sum(
    caseResults.map((entry) => entry.shrink.sourceEstimatedTokens),
  );
  const summaryEstimatedTokens = sum(
    caseResults.map((entry) => entry.shrink.summaryEstimatedTokens),
  );
  const gates = aggregateGates(caseResults);
  return {
    candidateId: candidate.candidateId,
    label: candidate.label,
    implementationKind: candidate.implementationKind,
    providerNative: false,
    productionSummaryImplementation: false,
    executedProviderCalls: 0,
    cases: caseResults,
    metrics: {
      quality: {
        matchedFacts,
        totalFacts,
        factRecallPermille: ratioPermille(matchedFacts, totalFacts),
        matchedRecoveryFacts,
        totalRecoveryFacts,
        recoveryRecallPermille: ratioPermille(matchedRecoveryFacts, totalRecoveryFacts),
      },
      shrink: shrinkMetrics(
        sourceUtf8Bytes,
        summaryUtf8Bytes,
        sourceEstimatedTokens,
        summaryEstimatedTokens,
      ),
      calls: {
        plannedProviderCalls: sum(
          caseResults.map((entry) => entry.calls.plannedProviderCalls),
        ),
        executedProviderCalls: 0,
        plannedInputTokens: sum(
          caseResults.map((entry) => entry.calls.plannedInputTokens),
        ),
      },
      operationCounts: sumOperationCounts(
        caseResults.map((entry) => entry.operationCounts),
      ),
      localPerformance: {
        elapsedMs: roundMilliseconds(performance.now() - startedAt),
        rssDeltaBytes: Math.max(0, process.memoryUsage.rss() - rssBefore),
      },
    },
    gates,
  };
}

function evaluateCase(candidate, entry) {
  const planner = candidate.usesPlanner ? buildOfflinePlan(entry) : null;
  const summary = candidate.summarize(entry.messages, entry.summary_utf8_budget);
  const outputBytes = Buffer.byteLength(summary.output, "utf8");
  const sourceEstimatedTokens = deterministicTokenEstimate(entry.sourceUtf8Bytes);
  const summaryEstimatedTokens = deterministicTokenEstimate(outputBytes);
  const matchedFacts = entry.expected_facts.filter((fact) =>
    summary.output.includes(fact.needle)
  );
  const recoveryFacts = entry.expected_facts.filter((fact) => fact.required_for_recovery);
  const matchedRecoveryFacts = recoveryFacts.filter((fact) =>
    summary.output.includes(fact.needle)
  );
  const provenancePassed = summary.statements.every((statement) => {
    const message = entry.messages[statement.sourceMessageIndex];
    return message !== undefined && message.content.includes(statement.text);
  });
  const injectionPassed = entry.injection_canaries.every(
    (canary) => !summary.output.includes(canary),
  );
  const shrink = shrinkMetrics(
    entry.sourceUtf8Bytes,
    outputBytes,
    sourceEstimatedTokens,
    summaryEstimatedTokens,
  );
  const qualityRecall = ratioPermille(
    matchedFacts.length,
    entry.expected_facts.length,
  );
  const gates = {
    quality: qualityRecall >= COMPACTION_OFFLINE_MINIMUM_FACT_RECALL_PERMILLE,
    injection: injectionPassed,
    provenance: provenancePassed,
    shrink:
      shrink.reductionPermille >= COMPACTION_OFFLINE_MINIMUM_REDUCTION_PERMILLE &&
      shrink.savedEstimatedTokens >= COMPACTION_OFFLINE_MINIMUM_SAVED_TOKENS,
    recovery: matchedRecoveryFacts.length === recoveryFacts.length,
  };
  const planOperations = planner === null ? {} : planner.planning_work;
  return {
    caseId: entry.case_id,
    outputSha256: sha256Hex(summary.output),
    statementCount: summary.statements.length,
    quality: {
      matchedFacts: matchedFacts.length,
      totalFacts: entry.expected_facts.length,
      factRecallPermille: qualityRecall,
      matchedRecoveryFacts: matchedRecoveryFacts.length,
      totalRecoveryFacts: recoveryFacts.length,
      recoveryRecallPermille: ratioPermille(
        matchedRecoveryFacts.length,
        recoveryFacts.length,
      ),
    },
    shrink,
    calls: {
      plannedProviderCalls: planner?.planned_provider_calls ?? 0,
      executedProviderCalls: 0,
      plannedInputTokens: planner?.planned_input_tokens ?? 0,
    },
    operationCounts: {
      ...summary.operationCounts,
      ...planOperations,
      outputUtf8Bytes: outputBytes,
    },
    gates: { ...gates, allPassed: Object.values(gates).every(Boolean) },
  };
}

function buildOfflinePlan(entry) {
  const sourceBinding = `offline-corpus:${entry.case_id}`;
  const sourceSha256 = sha256Hex(JSON.stringify(entry.messages));
  const refs = entry.messages.map((message, index) => ({
    kind: "rollout_span",
    ref_id: `${entry.case_id}:message:${index + 1}`,
    source_binding: sourceBinding,
    first_sequence: index + 1,
    last_sequence: index + 1,
    sha256: sha256Hex(message.content),
    history_index: index,
    record_message_index: 0,
    encoded_bytes: Buffer.byteLength(message.content, "utf8"),
  }));
  return buildCompactionMapReducePlan(entry.messages, {
    context: {
      options: {
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: OUTPUT_RESERVE_TOKENS,
      },
    },
    source: {
      format_version: 1,
      attempt_id: `offline-${entry.case_id}`,
      session_id: "offline-compaction-evaluation",
      epoch: 1,
      source_binding: sourceBinding,
      first_sequence: 1,
      last_sequence: entry.messages.length,
      source_sha256: sourceSha256,
      source_bytes: entry.sourceUtf8Bytes,
      history_digest: sourceSha256,
      active_history_refs: refs,
    },
    systemPrompts: SYSTEM_PROMPTS,
    providerName: "offline-no-provider",
    model: "offline-no-provider",
    messageSourceRefs: refs,
  });
}

function expandCorpusCase(entry) {
  const messages = entry.messages.map((message) => {
    const content = Array.from(
      { length: message.repeat ?? 1 },
      () => message.content,
    ).join(" ");
    return Object.freeze({ role: message.role, originalRole: message.role, content });
  });
  return Object.freeze({
    ...entry,
    messages: Object.freeze(messages),
    sourceUtf8Bytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
  });
}

function shrinkMetrics(
  sourceUtf8Bytes,
  summaryUtf8Bytes,
  sourceEstimatedTokens,
  summaryEstimatedTokens,
) {
  const savedUtf8Bytes = Math.max(0, sourceUtf8Bytes - summaryUtf8Bytes);
  const savedEstimatedTokens = Math.max(0, sourceEstimatedTokens - summaryEstimatedTokens);
  return {
    sourceUtf8Bytes,
    summaryUtf8Bytes,
    savedUtf8Bytes,
    reductionPermille: ratioPermille(savedUtf8Bytes, sourceUtf8Bytes),
    sourceEstimatedTokens,
    summaryEstimatedTokens,
    savedEstimatedTokens,
  };
}

function aggregateGates(caseResults) {
  const gates = {};
  for (const name of [
    "quality",
    "injection",
    "provenance",
    "shrink",
    "recovery",
  ]) {
    gates[name] = caseResults.every((entry) => entry.gates[name]);
  }
  gates.allPassed = Object.values(gates).every(Boolean);
  return gates;
}

function sumOperationCounts(counts) {
  const result = {};
  for (const entry of counts) {
    for (const [name, value] of Object.entries(entry)) {
      result[name] = (result[name] ?? 0) + value;
    }
  }
  return result;
}

function deterministicTokenEstimate(utf8Bytes) {
  return Math.ceil(utf8Bytes / 4);
}

function ratioPermille(numerator, denominator) {
  return denominator === 0 ? 0 : Math.floor((numerator * 1000) / denominator);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}
