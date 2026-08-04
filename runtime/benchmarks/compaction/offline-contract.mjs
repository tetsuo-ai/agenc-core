export const COMPACTION_OFFLINE_SCHEMA_VERSION = 1;
export const COMPACTION_OFFLINE_SUITE_ID = "agenc.c2.compaction-held-out.v1";
export const COMPACTION_OFFLINE_EVIDENCE_KIND = "deterministic_offline";
export const COMPACTION_OFFLINE_CANDIDATE_IDS = Object.freeze([
  "c2_planner_deterministic_extractive_proxy_v1",
  "tail_window_deterministic_extractive_baseline_v1",
]);

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

export function validateCompactionOfflineCorpus(corpus) {
  requireObject(corpus, "corpus");
  requireExact(
    corpus.schema_version,
    COMPACTION_OFFLINE_SCHEMA_VERSION,
    "corpus.schema_version",
  );
  requireExact(
    corpus.suite_id,
    COMPACTION_OFFLINE_SUITE_ID,
    "corpus.suite_id",
  );
  nonemptyString(corpus.corpus_version, "corpus.corpus_version");
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new TypeError("corpus.cases must be a nonempty array");
  }
  const caseIds = new Set();
  for (const entry of corpus.cases) {
    requireObject(entry, "corpus case");
    nonemptyString(entry.case_id, "case.case_id");
    if (caseIds.has(entry.case_id)) {
      throw new TypeError(`duplicate corpus case ${entry.case_id}`);
    }
    caseIds.add(entry.case_id);
    positiveSafeInteger(entry.summary_utf8_budget, "case.summary_utf8_budget");
    if (!Array.isArray(entry.messages) || entry.messages.length === 0) {
      throw new TypeError(`${entry.case_id} messages must be nonempty`);
    }
    for (const message of entry.messages) {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new TypeError(`${entry.case_id} message role must be user or assistant`);
      }
      nonemptyString(message.content, `${entry.case_id} message content`);
      if (message.repeat !== undefined) {
        positiveSafeInteger(message.repeat, `${entry.case_id} message repeat`);
      }
    }
    if (!Array.isArray(entry.expected_facts) || entry.expected_facts.length === 0) {
      throw new TypeError(`${entry.case_id} expected_facts must be nonempty`);
    }
    const factIds = new Set();
    for (const fact of entry.expected_facts) {
      nonemptyString(fact.fact_id, `${entry.case_id} fact_id`);
      nonemptyString(fact.needle, `${entry.case_id} fact needle`);
      if (typeof fact.required_for_recovery !== "boolean") {
        throw new TypeError(`${entry.case_id} required_for_recovery must be boolean`);
      }
      if (factIds.has(fact.fact_id)) {
        throw new TypeError(`duplicate fact ${entry.case_id}/${fact.fact_id}`);
      }
      factIds.add(fact.fact_id);
    }
    if (!Array.isArray(entry.injection_canaries) || entry.injection_canaries.length === 0) {
      throw new TypeError(`${entry.case_id} injection_canaries must be nonempty`);
    }
    for (const canary of entry.injection_canaries) {
      nonemptyString(canary, `${entry.case_id} injection canary`);
    }
  }
  return corpus;
}

export function validateCompactionOfflineReport(report) {
  requireObject(report, "report");
  requireExact(
    report.schemaVersion,
    COMPACTION_OFFLINE_SCHEMA_VERSION,
    "report.schemaVersion",
  );
  requireExact(report.suiteId, COMPACTION_OFFLINE_SUITE_ID, "report.suiteId");
  requireObject(report.corpus, "report.corpus");
  nonemptyString(report.corpus.version, "report.corpus.version");
  if (!HEX_SHA256.test(report.corpus.sha256)) {
    throw new TypeError("report corpus SHA-256 is invalid");
  }
  positiveSafeInteger(report.corpus.caseCount, "report.corpus.caseCount");
  positiveSafeInteger(report.corpus.sourceMessages, "report.corpus.sourceMessages");
  positiveSafeInteger(report.corpus.sourceUtf8Bytes, "report.corpus.sourceUtf8Bytes");
  positiveSafeInteger(report.corpus.expectedFacts, "report.corpus.expectedFacts");
  requireObject(report.evidence, "report.evidence");
  requireExact(
    report.evidence.kind,
    COMPACTION_OFFLINE_EVIDENCE_KIND,
    "report.evidence.kind",
  );
  requireExact(report.evidence.networkAccess, false, "report.evidence.networkAccess");
  requireExact(
    report.evidence.providerCallsExecuted,
    0,
    "report.evidence.providerCallsExecuted",
  );
  requireExact(
    report.evidence.providerQualityClaimed,
    false,
    "report.evidence.providerQualityClaimed",
  );
  if (
    !Array.isArray(report.candidates) ||
    report.candidates.length !== COMPACTION_OFFLINE_CANDIDATE_IDS.length
  ) {
    throw new TypeError("report must contain the complete offline candidate set");
  }
  const candidateIds = new Set();
  for (const candidate of report.candidates) {
    validateCandidate(candidate, report.corpus.caseCount);
    candidateIds.add(candidate.candidateId);
  }
  if (candidateIds.size !== COMPACTION_OFFLINE_CANDIDATE_IDS.length) {
    throw new TypeError("report contains duplicate candidates");
  }
  for (const candidateId of COMPACTION_OFFLINE_CANDIDATE_IDS) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`report is missing candidate ${candidateId}`);
    }
  }
  requireObject(report.measurements, "report.measurements");
  finiteNonnegative(
    report.measurements.suiteElapsedMs,
    "report.measurements.suiteElapsedMs",
  );
  nonnegativeSafeInteger(
    report.measurements.rssDeltaBytes,
    "report.measurements.rssDeltaBytes",
  );
  nonemptyString(report.measurements.node, "report.measurements.node");
  nonemptyString(report.measurements.platform, "report.measurements.platform");
  return report;
}

export function deterministicCompactionOfflineProjection(report) {
  const clone = structuredClone(validateCompactionOfflineReport(report));
  clone.measurements = {
    suiteElapsedMs: null,
    rssDeltaBytes: null,
    node: null,
    platform: null,
  };
  for (const candidate of clone.candidates) {
    candidate.metrics.localPerformance.elapsedMs = null;
    candidate.metrics.localPerformance.rssDeltaBytes = null;
  }
  return clone;
}

export function assertCompactionOfflineAcceptance(report) {
  validateCompactionOfflineReport(report);
  const candidate = report.candidates.find(
    (entry) =>
      entry.candidateId ===
      "c2_planner_deterministic_extractive_proxy_v1",
  );
  if (candidate?.gates.allPassed !== true) {
    throw new Error("C2 deterministic offline proxy did not pass every common gate");
  }
  return report;
}

function validateCandidate(candidate, expectedCaseCount) {
  requireObject(candidate, "candidate");
  if (!COMPACTION_OFFLINE_CANDIDATE_IDS.includes(candidate.candidateId)) {
    throw new TypeError(`unknown offline candidate ${String(candidate.candidateId)}`);
  }
  nonemptyString(candidate.label, "candidate.label");
  requireExact(candidate.providerNative, false, "candidate.providerNative");
  requireExact(
    candidate.productionSummaryImplementation,
    false,
    "candidate.productionSummaryImplementation",
  );
  requireExact(candidate.executedProviderCalls, 0, "candidate.executedProviderCalls");
  if (!Array.isArray(candidate.cases) || candidate.cases.length !== expectedCaseCount) {
    throw new TypeError(`${candidate.candidateId} has an incomplete case set`);
  }
  const caseIds = new Set();
  for (const entry of candidate.cases) {
    requireObject(entry, "candidate case");
    nonemptyString(entry.caseId, "candidate caseId");
    if (caseIds.has(entry.caseId)) {
      throw new TypeError(`duplicate candidate case ${entry.caseId}`);
    }
    caseIds.add(entry.caseId);
    if (!HEX_SHA256.test(entry.outputSha256)) {
      throw new TypeError("candidate output SHA-256 is invalid");
    }
    nonnegativeSafeInteger(entry.statementCount, "candidate statementCount");
    validateQuality(entry.quality, "candidate case quality");
    validateShrink(entry.shrink, "candidate case shrink");
    validateCalls(entry.calls, "candidate case calls");
    requireObject(entry.operationCounts, "candidate case operationCounts");
    for (const [name, value] of Object.entries(entry.operationCounts)) {
      nonnegativeSafeInteger(value, `case operationCounts.${name}`);
    }
    validateGates(entry.gates, "candidate case gates");
  }
  requireObject(candidate.metrics, "candidate.metrics");
  const quality = candidate.metrics.quality;
  validateQuality(quality, "candidate.metrics.quality");
  const shrink = candidate.metrics.shrink;
  validateShrink(shrink, "candidate.metrics.shrink");
  const calls = candidate.metrics.calls;
  validateCalls(calls, "candidate.metrics.calls");
  const operations = candidate.metrics.operationCounts;
  requireObject(operations, "candidate.metrics.operationCounts");
  for (const [name, value] of Object.entries(operations)) {
    nonnegativeSafeInteger(value, `operationCounts.${name}`);
  }
  const performance = candidate.metrics.localPerformance;
  requireObject(performance, "candidate.metrics.localPerformance");
  finiteNonnegative(performance.elapsedMs, "localPerformance.elapsedMs");
  nonnegativeSafeInteger(performance.rssDeltaBytes, "localPerformance.rssDeltaBytes");
  validateGates(candidate.gates, "candidate.gates");
}

function validateQuality(quality, label) {
  requireObject(quality, label);
  nonnegativeSafeInteger(quality.matchedFacts, `${label}.matchedFacts`);
  positiveSafeInteger(quality.totalFacts, `${label}.totalFacts`);
  permille(quality.factRecallPermille, `${label}.factRecallPermille`);
  nonnegativeSafeInteger(
    quality.matchedRecoveryFacts,
    `${label}.matchedRecoveryFacts`,
  );
  positiveSafeInteger(
    quality.totalRecoveryFacts,
    `${label}.totalRecoveryFacts`,
  );
  permille(quality.recoveryRecallPermille, `${label}.recoveryRecallPermille`);
}

function validateShrink(shrink, label) {
  requireObject(shrink, label);
  positiveSafeInteger(shrink.sourceUtf8Bytes, `${label}.sourceUtf8Bytes`);
  nonnegativeSafeInteger(shrink.summaryUtf8Bytes, `${label}.summaryUtf8Bytes`);
  nonnegativeSafeInteger(shrink.savedUtf8Bytes, `${label}.savedUtf8Bytes`);
  permille(shrink.reductionPermille, `${label}.reductionPermille`);
  positiveSafeInteger(
    shrink.sourceEstimatedTokens,
    `${label}.sourceEstimatedTokens`,
  );
  nonnegativeSafeInteger(
    shrink.summaryEstimatedTokens,
    `${label}.summaryEstimatedTokens`,
  );
  nonnegativeSafeInteger(
    shrink.savedEstimatedTokens,
    `${label}.savedEstimatedTokens`,
  );
}

function validateCalls(calls, label) {
  requireObject(calls, label);
  nonnegativeSafeInteger(
    calls.plannedProviderCalls,
    `${label}.plannedProviderCalls`,
  );
  requireExact(calls.executedProviderCalls, 0, `${label}.executedProviderCalls`);
  nonnegativeSafeInteger(calls.plannedInputTokens, `${label}.plannedInputTokens`);
}

function validateGates(gates, label) {
  requireObject(gates, label);
  const gateNames = ["quality", "injection", "provenance", "shrink", "recovery"];
  for (const name of gateNames) {
    if (typeof gates[name] !== "boolean") {
      throw new TypeError(`${label}.${name} must be boolean`);
    }
  }
  if (typeof gates.allPassed !== "boolean") {
    throw new TypeError(`${label}.allPassed must be boolean`);
  }
  const expectedAllPassed = gateNames.every((name) => gates[name]);
  if (gates.allPassed !== expectedAllPassed) {
    throw new TypeError(`${label}.allPassed is inconsistent`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label} must be ${String(expected)}`);
  }
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
}

function finiteNonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be finite and nonnegative`);
  }
}

function permille(value, label) {
  nonnegativeSafeInteger(value, label);
  if (value > 1000) throw new TypeError(`${label} cannot exceed 1000`);
}
