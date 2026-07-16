import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  withDocumentDigest,
} from "./canonical-json.js";
import {
  isExternallyVerifiedEvidenceLedger,
  type VerifiedEvidenceLedger,
} from "./evidence-ledger.js";
import {
  compareUtcTimestamps,
  projectTaskForAgent,
  validateEvalContractDocument,
} from "./validation.js";
import {
  EVAL_CONTRACT_VERSION,
  type BlindedResultsSealDocument,
  type DerivedSummaryDocument,
  type HoldoutAccessReceiptDocument,
  type HoldoutDescriptorDocument,
  type InfrastructureInvalidReason,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type PreregistrationReceiptDocument,
  type RunRecordDocument,
  type Sha256Digest,
  type SuiteManifestDocument,
  type SystemConfigurationPin,
  type SystemSummary,
  type UnblindingRecordDocument,
} from "./types.js";

export interface EvaluationLifecycleAnchors {
  /** Each digest must come from outside the result/evidence storage root. */
  readonly expectedPreregistrationReceiptDigest: Sha256Digest;
  readonly expectedBlindedResultsSealDigest: Sha256Digest;
  readonly expectedUnblindingRecordDigest: Sha256Digest;
  readonly preregistrationReceiptVerifierDigest: Sha256Digest;
  readonly expectedHoldoutAccessReceiptDigest: Sha256Digest | null;
  readonly holdoutAccessReceiptVerifierDigest: Sha256Digest | null;
  verifyPreregistrationReceipt(
    preregistrationBytes: Uint8Array,
    receipt: PreregistrationReceiptDocument,
  ): boolean | Promise<boolean>;
  verifyHoldoutAccessReceipt?(
    receiptBytes: Uint8Array,
    receipt: HoldoutAccessReceiptDocument,
  ): boolean | Promise<boolean>;
}

export interface EvaluationExperimentBundle {
  readonly suite: SuiteManifestDocument;
  readonly holdoutDescriptor?: HoldoutDescriptorDocument;
  readonly holdoutAccessReceipt?: HoldoutAccessReceiptDocument;
  readonly preregistration: PreregistrationDocument;
  readonly preregistrationReceipt: PreregistrationReceiptDocument;
  readonly blindedResultsSeal: BlindedResultsSealDocument;
  readonly unblindingRecord: UnblindingRecordDocument;
  readonly runs: readonly RunRecordDocument[];
  readonly verifiedEvidence: readonly VerifiedEvidenceLedger[];
  readonly lifecycleAnchors: EvaluationLifecycleAnchors;
}

export interface DerivedSummaryOptions {
  readonly summaryId: string;
  readonly generatedAt: string;
}

interface InfrastructureExclusion {
  readonly comparisonId: string;
  readonly taskId: string;
  readonly seedSlot: number;
  readonly primaryRunId: string;
  readonly comparatorRunId: string;
  readonly incidentId: string;
  readonly reason: InfrastructureInvalidReason;
  readonly evidenceDigest: Sha256Digest;
  readonly classifierVersion: string;
  readonly classifierImplementationDigest: Sha256Digest;
}

export interface ValidatedBundle {
  /** Deep-frozen call-time snapshot used for every cross-document decision. */
  readonly bundle: EvaluationExperimentBundle;
  readonly runByCell: ReadonlyMap<string, RunRecordDocument>;
  readonly evidenceByRun: ReadonlyMap<string, VerifiedEvidenceLedger>;
  readonly exclusions: readonly InfrastructureExclusion[];
}

export class EvaluationBundleValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`evaluation experiment bundle validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EvaluationBundleValidationError";
    this.issues = issues;
  }
}

function requireBundle(condition: unknown, issue: string, issues: string[]): void {
  if (!condition) issues.push(issue);
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function deepFreezeSnapshot<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeSnapshot(nested);
  }
  return Object.freeze(value);
}

function cloneContractSnapshot<T>(value: T): T {
  return deepFreezeSnapshot(JSON.parse(canonicalizeJson(value)) as T);
}

function snapshotEvaluationBundle(bundle: EvaluationExperimentBundle): EvaluationExperimentBundle {
  const anchors = bundle.lifecycleAnchors;
  const lifecycleAnchors: EvaluationLifecycleAnchors = {
    expectedPreregistrationReceiptDigest: anchors.expectedPreregistrationReceiptDigest,
    expectedBlindedResultsSealDigest: anchors.expectedBlindedResultsSealDigest,
    expectedUnblindingRecordDigest: anchors.expectedUnblindingRecordDigest,
    preregistrationReceiptVerifierDigest: anchors.preregistrationReceiptVerifierDigest,
    expectedHoldoutAccessReceiptDigest: anchors.expectedHoldoutAccessReceiptDigest,
    holdoutAccessReceiptVerifierDigest: anchors.holdoutAccessReceiptVerifierDigest,
    verifyPreregistrationReceipt: anchors.verifyPreregistrationReceipt.bind(anchors),
    ...(anchors.verifyHoldoutAccessReceipt
      ? { verifyHoldoutAccessReceipt: anchors.verifyHoldoutAccessReceipt.bind(anchors) }
      : {}),
  };
  return deepFreezeSnapshot({
    suite: cloneContractSnapshot(bundle.suite),
    ...(bundle.holdoutDescriptor
      ? { holdoutDescriptor: cloneContractSnapshot(bundle.holdoutDescriptor) }
      : {}),
    ...(bundle.holdoutAccessReceipt
      ? { holdoutAccessReceipt: cloneContractSnapshot(bundle.holdoutAccessReceipt) }
      : {}),
    preregistration: cloneContractSnapshot(bundle.preregistration),
    preregistrationReceipt: cloneContractSnapshot(bundle.preregistrationReceipt),
    blindedResultsSeal: cloneContractSnapshot(bundle.blindedResultsSeal),
    unblindingRecord: cloneContractSnapshot(bundle.unblindingRecord),
    runs: bundle.runs.map(cloneContractSnapshot),
    verifiedEvidence: [...bundle.verifiedEvidence],
    lifecycleAnchors: deepFreezeSnapshot(lifecycleAnchors),
  });
}

function snapshotSummaryOptions(options: DerivedSummaryOptions): DerivedSummaryOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new EvaluationBundleValidationError(["summary options must be an object"]);
  }
  let snapshot: Partial<DerivedSummaryOptions>;
  try {
    snapshot = cloneContractSnapshot(options);
  } catch (error) {
    throw new EvaluationBundleValidationError([
      `summary options are not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const issues: string[] = [];
  requireBundle(
    Object.keys(snapshot).length === 2 &&
      typeof snapshot.summaryId === "string" &&
      CONTRACT_ID_PATTERN.test(snapshot.summaryId),
    "summary options require only a valid summaryId and generatedAt",
    issues,
  );
  requireBundle(
    typeof snapshot.generatedAt === "string",
    "summary options generatedAt must be a contract UTC timestamp",
    issues,
  );
  if (typeof snapshot.generatedAt === "string") {
    try {
      compareUtcTimestamps(snapshot.generatedAt, snapshot.generatedAt);
    } catch {
      issues.push("summary options generatedAt must be a contract UTC timestamp");
    }
  }
  if (issues.length > 0) throw new EvaluationBundleValidationError(issues);
  return snapshot as DerivedSummaryOptions;
}

function sortedValue(value: readonly unknown[]): readonly unknown[] {
  return [...value].sort((left, right) => compareCodeUnits(canonicalizeJson(left), canonicalizeJson(right)));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cellKey(systemId: string, taskId: string, seedSlot: number): string {
  return `${systemId}\u0000${taskId}\u0000${seedSlot}`;
}

export interface ExecutionOrderInput {
  readonly systemIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly seedSlots: readonly number[];
  readonly orderSeed: number;
}

export interface ExecutionOrderCell {
  readonly systemId: string;
  readonly taskId: string;
  readonly seedSlot: number;
}

const CONTRACT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const UINT32_MAX = 0xffff_ffff;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_EXECUTION_ORDER_CELLS = 1_000_000;

function assertExecutionOrderInput(input: ExecutionOrderInput): void {
  const candidate = input as Partial<ExecutionOrderInput> | null;
  const issues: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    throw new EvaluationBundleValidationError(["execution-order input must be an object"]);
  }
  for (const [name, values] of [
    ["systemIds", candidate.systemIds],
    ["taskIds", candidate.taskIds],
  ] as const) {
    requireBundle(
      isDenseArray(values) && values.length > 0,
      `${name} must be a non-empty dense array`,
      issues,
    );
    if (Array.isArray(values)) {
      requireBundle(
        values.every((value) => typeof value === "string" && CONTRACT_ID_PATTERN.test(value)),
        `${name} must contain only contract IDs`,
        issues,
      );
      requireBundle(new Set(values).size === values.length, `${name} must be unique`, issues);
    }
  }
  requireBundle(
    isDenseArray(candidate.seedSlots) && candidate.seedSlots.length > 0,
    "seedSlots must be a non-empty dense array",
    issues,
  );
  if (Array.isArray(candidate.seedSlots)) {
    requireBundle(
      candidate.seedSlots.every((seed) => Number.isSafeInteger(seed) && seed >= 0),
      "seedSlots must contain only non-negative safe integers",
      issues,
    );
    requireBundle(
      new Set(candidate.seedSlots).size === candidate.seedSlots.length,
      "seedSlots must be unique",
      issues,
    );
  }
  requireBundle(
    Number.isInteger(candidate.orderSeed) &&
      (candidate.orderSeed ?? 0) >= 1 &&
      (candidate.orderSeed ?? 0) <= UINT32_MAX,
    "orderSeed must be an integer in [1, 2^32 - 1]",
    issues,
  );
  if (
    Array.isArray(candidate.systemIds) &&
    Array.isArray(candidate.taskIds) &&
    Array.isArray(candidate.seedSlots)
  ) {
    const matrixSize =
      candidate.systemIds.length * candidate.taskIds.length * candidate.seedSlots.length;
    requireBundle(
      Number.isSafeInteger(matrixSize) && matrixSize <= MAX_EXECUTION_ORDER_CELLS,
      `execution-order matrix exceeds ${MAX_EXECUTION_ORDER_CELLS} cells`,
      issues,
    );
  }
  if (issues.length > 0) throw new EvaluationBundleValidationError(issues);
}

function sha256OrderSampler(orderSeed: number): (upperExclusive: number) => number {
  let counter = 0;
  return (upperExclusive: number) => {
    const acceptanceLimit = Math.floor(UINT32_RANGE / upperExclusive) * upperExclusive;
    while (true) {
      const wordDigest = digestCanonicalJson(
        "agenc.eval.execution-order-random-word.v1",
        { orderSeed, counter },
      );
      counter += 1;
      const word = Number.parseInt(
        wordDigest.slice("sha256:".length, "sha256:".length + 8),
        16,
      );
      if (word < acceptanceLimit) return word % upperExclusive;
    }
  };
}

export function derivePlannedExecutionOrder(
  input: ExecutionOrderInput,
): readonly ExecutionOrderCell[] {
  assertExecutionOrderInput(input);
  const cells: ExecutionOrderCell[] = [];
  for (const systemId of [...input.systemIds].sort(compareCodeUnits)) {
    for (const taskId of [...input.taskIds].sort(compareCodeUnits)) {
      for (const seedSlot of [...input.seedSlots].sort((left, right) => left - right)) {
        cells.push({ systemId, taskId, seedSlot });
      }
    }
  }
  const drawIndex = sha256OrderSampler(input.orderSeed);
  for (let index = cells.length - 1; index > 0; index -= 1) {
    const replacement = drawIndex(index + 1);
    [cells[index], cells[replacement]] = [cells[replacement], cells[index]];
  }
  return cells;
}

export function computePlannedExecutionOrderDigest(
  input: ExecutionOrderInput,
): Sha256Digest {
  return digestCanonicalJson(
    "agenc.eval.execution-order.v1",
    derivePlannedExecutionOrder(input),
  );
}

function compareDecimal(left: string, right: string): number {
  const parse = (value: string): { readonly integer: bigint; readonly scale: number } => {
    const [whole, fraction = ""] = value.split(".");
    return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
  };
  const a = parse(left);
  const b = parse(right);
  const scale = Math.max(a.scale, b.scale);
  const leftInteger = a.integer * 10n ** BigInt(scale - a.scale);
  const rightInteger = b.integer * 10n ** BigInt(scale - b.scale);
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}

function actualSystemProjection(system: SystemConfigurationPin): unknown {
  return {
    systemId: system.systemId,
    release: system.release,
    commit: system.commit,
    packageDigest: system.package.digest,
    image: system.image,
    agentConfigDigest: system.agentConfigDigest,
    publicConfigDigest: system.publicConfigDigest,
    redactedConfigFields: [...system.redactedConfigFields].sort(),
    systemPromptDigest: system.systemPromptDigest,
    toolManifestDigest: system.toolManifestDigest,
    installCommandDigest: system.installCommandDigest,
    environmentClassDigest: system.environmentClassDigest,
    provider: system.provider,
    requestedModelId: system.requestedModelId,
    immutableModelId: system.immutableModelId,
    generationParameters: sortedValue(system.generationParameters),
    retryPolicy: system.retryPolicy,
    approvalPolicy: system.approvalPolicy,
  };
}

function runSystemProjection(run: RunRecordDocument): unknown {
  return {
    ...run.system,
    redactedConfigFields: [...run.system.redactedConfigFields].sort(),
    generationParameters: sortedValue(run.system.generationParameters),
    providerReportedModelId: undefined,
  };
}

function withoutUndefined(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined),
  );
}

function evidenceReference(verified: VerifiedEvidenceLedger): RunRecordDocument["evidence"] {
  const { inspection, seal } = verified;
  const { statement, receipt } = seal;
  if (!inspection.genesisEventDigest || !inspection.headEventDigest) {
    throw new EvaluationBundleValidationError([`${inspection.runId}: verified ledger is empty`]);
  }
  return {
    contractDigest: inspection.contractDigest,
    taskId: inspection.taskId,
    systemId: inspection.systemId,
    ledgerDigest: inspection.ledgerDigest,
    ledgerByteLength: inspection.ledgerByteLength,
    genesisEventDigest: inspection.genesisEventDigest,
    headEventDigest: inspection.headEventDigest,
    eventCount: inspection.eventCount,
    platformProtectionVerifierDigest: inspection.platformProtectionVerifierDigest,
    sealDigest: seal.sealDigest,
    statementDigest: receipt.statementDigest,
    anchorPolicyDigest: receipt.anchorPolicyDigest,
    signatureAlgorithm: receipt.signatureAlgorithm,
    signatureDigest: receipt.signatureDigest,
    verificationMaterialDigest: receipt.verificationMaterialDigest,
    anchorUri: receipt.anchorUri,
    signerIdentity: receipt.signerIdentity,
    sealedAt: statement.sealedAt,
  };
}

export type TrustAssessmentAttestationInput = Pick<
  RunRecordDocument,
  | "runId"
  | "experimentId"
  | "taskId"
  | "systemId"
  | "startedAt"
  | "finishedAt"
  | "outcome"
  | "verifiedFix"
  | "usage"
  | "approvals"
  | "interventions"
  | "artifacts"
  | "verifier"
  | "trustAssessment"
  | "infrastructureInvalidPairs"
>;

export function createTrustAssessmentStatement(
  run: TrustAssessmentAttestationInput,
): unknown {
  return {
    kind: "agenc.eval.trust-assessment-statement",
    contractVersion: EVAL_CONTRACT_VERSION,
    runId: run.runId,
    experimentId: run.experimentId,
    taskId: run.taskId,
    systemId: run.systemId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    verifiedFix: run.verifiedFix,
    assessmentImplementationDigest:
      run.trustAssessment.status === "assessed"
        ? run.trustAssessment.assessmentImplementationDigest
        : null,
    usage: run.usage,
    approvals: run.approvals,
    interventions: run.interventions,
    artifacts: run.artifacts,
    verifier: run.verifier,
    trustAssessment: run.trustAssessment,
    infrastructureInvalidPairs: run.infrastructureInvalidPairs,
  };
}

export function createHoldoutAccessStatement(
  receipt: HoldoutAccessReceiptDocument,
): unknown {
  const {
    documentDigest: _documentDigest,
    signatureAlgorithm: _signatureAlgorithm,
    signatureDigest: _signatureDigest,
    verificationMaterialDigest: _verificationMaterialDigest,
    receiptUri: _receiptUri,
    ...statement
  } = receipt;
  return statement;
}

const REQUIRED_TRUST_EVIDENCE_TYPES = Object.freeze({
  hiddenVerifier: ["verifier.completed"],
  policyAndBudget: ["budget.reconciled", "policy.evaluated", "sandbox.evaluated", "usage.reported"],
  effectSafety: ["effect.result"],
  recoveryIntegrity: ["recovery.assessed"],
  evidenceBundle: ["artifact.recorded", "review.completed", "risk.recorded"],
  interventionFree: ["intervention.recorded"],
} as const);

export interface InfrastructureClassificationInput {
  readonly comparisonId: string;
  readonly taskId: string;
  readonly seedSlot: number;
  readonly incidentId: string;
  readonly reason: InfrastructureInvalidReason;
  readonly classifierVersion: string;
  readonly classifierImplementationDigest: Sha256Digest;
}

export function createInfrastructureClassificationStatement(
  input: InfrastructureClassificationInput,
): unknown {
  return {
    kind: "agenc.eval.infrastructure-classification-statement",
    contractVersion: EVAL_CONTRACT_VERSION,
    ...input,
    classification: "infrastructure_invalid",
  };
}

function validateRunAgainstPins(
  run: RunRecordDocument,
  task: OperatorTaskDocument,
  system: SystemConfigurationPin,
  preregistration: PreregistrationDocument,
  receipt: PreregistrationReceiptDocument,
  evidence: VerifiedEvidenceLedger,
  issues: string[],
): void {
  const agentTask = projectTaskForAgent(task);
  requireBundle(run.experimentId === preregistration.experimentId, `${run.runId}: experiment mismatch`, issues);
  requireBundle(
    run.preregistrationDigest === preregistration.documentDigest,
    `${run.runId}: preregistration digest mismatch`,
    issues,
  );
  requireBundle(
    run.preregistrationReceiptDigest === receipt.documentDigest,
    `${run.runId}: preregistration receipt digest mismatch`,
    issues,
  );
  requireBundle(
    run.suiteManifestDigest === preregistration.suite.manifestDigest,
    `${run.runId}: suite manifest digest mismatch`,
    issues,
  );
  requireBundle(run.taskId === task.taskId, `${run.runId}: task ID mismatch`, issues);
  requireBundle(
    run.operatorTaskDigest === task.documentDigest,
    `${run.runId}: operator task digest mismatch`,
    issues,
  );
  requireBundle(
    run.agentTaskDigest === agentTask.documentDigest,
    `${run.runId}: agent task projection digest mismatch`,
    issues,
  );
  requireBundle(
    run.repositoryCluster === task.repository.cluster,
    `${run.runId}: repository cluster mismatch`,
    issues,
  );
  requireBundle(run.systemId === system.systemId, `${run.runId}: system ID mismatch`, issues);
  requireBundle(
    run.verifier.verifierId === task.hiddenVerifier.id &&
      run.verifier.verifierVersion === task.hiddenVerifier.version &&
      run.verifier.bundleDigest === task.hiddenVerifier.bundle.digest,
    `${run.runId}: hidden verifier result differs from the pinned verifier`,
    issues,
  );
  requireBundle(
    canonicalizeJson(withoutUndefined(runSystemProjection(run))) ===
      canonicalizeJson(actualSystemProjection(system)),
    `${run.runId}: actual system/model/config/retry/approval snapshot differs from its pin`,
    issues,
  );
  requireBundle(
    run.system.providerReportedModelId === system.immutableModelId,
    `${run.runId}: provider-reported model ID differs from the immutable pin`,
    issues,
  );
  requireBundle(
    run.evaluator.commit === preregistration.evaluator.commit &&
      run.evaluator.image === preregistration.evaluator.image &&
      run.evaluator.harnessConfigDigest === preregistration.evaluator.harnessConfigDigest &&
      run.evaluator.analysisImplementationDigest ===
        preregistration.evaluator.analysisImplementation.digest &&
      run.evaluator.trustAssessmentImplementationDigest ===
        preregistration.evaluator.trustAssessmentImplementation.digest,
    `${run.runId}: evaluator snapshot differs from its preregistration`,
    issues,
  );
  requireBundle(
    run.environment.image === task.environment.image &&
      run.environment.platform === task.environment.platform &&
      run.environment.hardwareClass === task.environment.hardwareClass &&
      canonicalizeJson(run.environment.toolchain) === canonicalizeJson(task.environment.toolchain) &&
      canonicalizeJson(run.environment.networkPolicy) === canonicalizeJson(task.networkPolicy) &&
      run.environment.permissionPolicyDigest === task.permissionPolicy.policyDigest,
    `${run.runId}: task environment or policy differs from its pin`,
    issues,
  );
  requireBundle(
    canonicalizeJson(task.resetRecipe) === canonicalizeJson(preregistration.resetPolicy) &&
      run.resetReceipt.recipeDigest === task.resetRecipe.digest &&
      run.resetReceipt.recipeDigest === preregistration.resetPolicy.digest &&
      run.resetReceipt.repositoryCommit === task.repository.commit,
    `${run.runId}: task reset recipe or receipt differs from the preregistered reset/repository`,
    issues,
  );
  requireBundle(
    run.approvals.every((approval) =>
      task.permissionPolicy.allowedApprovalKinds.includes(approval.kind) &&
      system.approvalPolicy.allowedKinds.includes(approval.kind)),
    `${run.runId}: recorded approval kind is outside a pinned allowlist`,
    issues,
  );
  requireBundle(run.wallTimeMs <= task.budget.wallTimeMs, `${run.runId}: wall-time budget exceeded`, issues);
  requireBundle(run.usage.inputTokens <= task.budget.inputTokens, `${run.runId}: input-token budget exceeded`, issues);
  requireBundle(run.usage.outputTokens <= task.budget.outputTokens, `${run.runId}: output-token budget exceeded`, issues);
  requireBundle(run.usage.reasoningTokens <= task.budget.reasoningTokens, `${run.runId}: reasoning-token budget exceeded`, issues);
  requireBundle(
    run.usage.cacheReadTokens + run.usage.cacheWriteTokens <= task.budget.cacheTokens,
    `${run.runId}: cache-token budget exceeded`,
    issues,
  );
  requireBundle(run.usage.totalTokens <= task.budget.totalTokens, `${run.runId}: total-token budget exceeded`, issues);
  requireBundle(run.usage.toolCalls <= task.budget.toolCalls, `${run.runId}: tool-call budget exceeded`, issues);
  requireBundle(run.usage.turns <= task.budget.turns, `${run.runId}: turn budget exceeded`, issues);
  requireBundle(
    run.usage.retries <= Math.max(0, system.retryPolicy.maxAttempts - 1),
    `${run.runId}: retry policy exceeded`,
    issues,
  );
  if (run.usage.providerCost.status === "reported") {
    requireBundle(
      compareDecimal(run.usage.providerCost.amount, task.budget.usd) <= 0,
      `${run.runId}: provider cost exceeded its hard USD cap`,
      issues,
    );
  } else {
    requireBundle(
      compareDecimal(run.usage.providerCost.reservedAmount, task.budget.usd) <= 0,
      `${run.runId}: reserved provider-cost bound exceeded its hard USD cap`,
      issues,
    );
  }
  for (const expected of task.expectedArtifacts) {
    const matches = run.artifacts.filter(
      (artifact) => artifact.expectedArtifactId === expected.id,
    );
    const match = matches[0];
    requireBundle(
      matches.length === 1 && match !== undefined &&
        match.path === expected.path &&
        match.mediaType === expected.mediaType &&
        match.sizeBytes <= expected.maxBytes,
      `${run.runId}: required artifact ${expected.id} does not match its task pin`,
      issues,
    );
  }
  const expectedArtifactIds = new Set(task.expectedArtifacts.map((artifact) => artifact.id));
  requireBundle(
    run.artifacts.every((artifact) =>
      artifact.expectedArtifactId === null || expectedArtifactIds.has(artifact.expectedArtifactId)),
    `${run.runId}: run contains an artifact binding not declared by the task`,
    issues,
  );
  requireBundle(
    canonicalizeJson(run.evidence) === canonicalizeJson(evidenceReference(evidence)),
    `${run.runId}: run evidence reference differs from externally verified bytes`,
    issues,
  );
  requireBundle(
    evidence.inspection.contractDigest === preregistration.documentDigest &&
      evidence.inspection.taskId === task.taskId &&
      evidence.inspection.systemId === system.systemId,
    `${run.runId}: evidence ledger identity differs from the pinned experiment cell`,
    issues,
  );
  const firstEvidenceEvent = evidence.inspection.events[0];
  const terminalEvidenceEvent = evidence.inspection.events.at(-1);
  requireBundle(
    firstEvidenceEvent?.type === "run.started" &&
      compareUtcTimestamps(firstEvidenceEvent.occurredAt, run.startedAt) === 0 &&
      terminalEvidenceEvent?.type === "run.finished" &&
      compareUtcTimestamps(terminalEvidenceEvent.occurredAt, run.finishedAt) === 0,
    `${run.runId}: evidence chronology does not match run start/finish`,
    issues,
  );
  requireBundle(
    compareUtcTimestamps(evidence.seal.statement.sealedAt, run.finishedAt) >= 0,
    `${run.runId}: evidence was sealed before the run finished`,
    issues,
  );
  requireBundle(
    evidence.anchorVerifierDigest === preregistration.evidencePolicy.anchorVerifierDigest &&
      evidence.seal.receipt.anchorPolicyDigest === preregistration.evidencePolicy.anchorPolicyDigest &&
      evidence.platformProtectionVerifierDigest ===
        preregistration.evidencePolicy.platformProtectionVerifierDigest,
    `${run.runId}: evidence anchor policy/verifier differs from preregistration`,
    issues,
  );
  requireBundle(
    evidence.inspection.ledgerByteLength <= preregistration.evidencePolicy.maximumLedgerBytes &&
      evidence.inspection.eventCount <= preregistration.evidencePolicy.maximumEvents,
    `${run.runId}: evidence ledger exceeds its preregistered limits`,
    issues,
  );
  for (const event of evidence.inspection.events) {
    requireBundle(
      Buffer.byteLength(canonicalizeJson(event), "utf8") + 1 <=
        preregistration.evidencePolicy.maximumEventBytes &&
        event.payload.sizeBytes <= preregistration.evidencePolicy.maximumPayloadBytes,
      `${run.runId}: evidence event ${event.eventId} exceeds its preregistered limits`,
      issues,
    );
    requireBundle(
      event.payload.redactionPolicyDigest === preregistration.evidencePolicy.redactionPolicyDigest,
      `${run.runId}: evidence event ${event.eventId} used an unpinned redaction policy`,
      issues,
    );
  }
  const payloadEvents = new Map<Sha256Digest, Set<string>>();
  for (const event of evidence.inspection.events) {
    const types = payloadEvents.get(event.payload.digest) ?? new Set<string>();
    types.add(event.type);
    payloadEvents.set(event.payload.digest, types);
  }
  for (const artifact of run.artifacts) {
    const matchingPayload = evidence.inspection.events.find((event) =>
      event.payload.digest === artifact.digest &&
      event.payload.sizeBytes === artifact.sizeBytes &&
      event.payload.mediaType === artifact.mediaType &&
      event.payload.uri === artifact.uri);
    requireBundle(
      matchingPayload !== undefined,
      `${run.runId}: artifact ${artifact.artifactId} is not backed by verified payload bytes`,
      issues,
    );
  }
  requireBundle(
    payloadEvents.get(run.verifier.evidenceDigest)?.has("verifier.completed") === true,
    `${run.runId}: verifier evidence is not backed by a verified verifier payload`,
    issues,
  );
  if (run.usage.providerCost.status === "unavailable") {
    requireBundle(
      payloadEvents.get(run.usage.providerCost.evidenceDigest)?.has("usage.reported") === true,
      `${run.runId}: unavailable provider cost lacks verified usage evidence`,
      issues,
    );
  }
  if (run.trustAssessment.status === "assessed") {
    requireBundle(
      run.trustAssessment.assessmentImplementationDigest ===
        preregistration.evaluator.trustAssessmentImplementation.digest,
      `${run.runId}: trust assessment implementation was not preregistered`,
      issues,
    );
    const trustEvents = evidence.inspection.events.filter((event) => event.type === "trust.assessed");
    const trustEvent = trustEvents[0];
    const trustBytes = Buffer.from(canonicalizeJson(createTrustAssessmentStatement(run)), "utf8");
    requireBundle(
      trustEvents.length === 1 && trustEvent !== undefined &&
        trustEvent.producer.binaryDigest ===
          preregistration.evaluator.trustAssessmentImplementation.digest &&
        trustEvent.payload.mediaType === "application/vnd.agenc.eval-trust-assessment+json" &&
        trustEvent.payload.sizeBytes === trustBytes.byteLength &&
        trustEvent.payload.digest === sha256Digest(trustBytes),
      `${run.runId}: assessed trust lacks an exact attestation from the preregistered implementation`,
      issues,
    );
    const unknownEffectEvents = evidence.inspection.events.filter(
      (event) => event.type === "effect.unknown_outcome",
    ).length;
    const eventGapEvents = evidence.inspection.events.filter(
      (event) => event.type === "event.gap",
    ).length;
    requireBundle(
      run.trustAssessment.criteria.effectSafety.unresolvedUnknownOutcomes >=
        unknownEffectEvents,
      `${run.runId}: trust assessment contradicts anchored unknown-outcome events`,
      issues,
    );
    requireBundle(
      run.trustAssessment.criteria.recoveryIntegrity.eventGaps >= eventGapEvents,
      `${run.runId}: trust assessment contradicts anchored event-gap evidence`,
      issues,
    );
    const availableEvidence = new Set<Sha256Digest>([
      ...evidence.inspection.events
        .filter((event) => event.type !== "trust.assessed")
        .map((event) => event.payload.digest),
    ]);
    for (const [criterion, assessment] of Object.entries(run.trustAssessment.criteria)) {
      requireBundle(
        assessment.evidenceDigests.every((digest) => availableEvidence.has(digest)),
        `${run.runId}: ${criterion} cites evidence outside the verified ledger/bundle`,
        issues,
      );
      const citedTypes = new Set(
        assessment.evidenceDigests.flatMap((digest) => [...(payloadEvents.get(digest) ?? [])]),
      );
      const requiredTypes = REQUIRED_TRUST_EVIDENCE_TYPES[
        criterion as keyof typeof REQUIRED_TRUST_EVIDENCE_TYPES
      ];
      requireBundle(
        requiredTypes.every((type) => citedTypes.has(type)),
        `${run.runId}: ${criterion} lacks its required typed evidence events`,
        issues,
      );
    }
  } else {
    requireBundle(
      !evidence.inspection.events.some((event) => event.type === "trust.assessed"),
      `${run.runId}: unassessed trust must not carry an assessed-trust attestation`,
      issues,
    );
  }
}

function matchingInfrastructureExclusion(
  comparisonId: string,
  primary: RunRecordDocument,
  comparator: RunRecordDocument,
  primaryEvidence: VerifiedEvidenceLedger,
  comparatorEvidence: VerifiedEvidenceLedger,
  preregistration: PreregistrationDocument,
  issues: string[],
): InfrastructureExclusion | null {
  const left = primary.infrastructureInvalidPairs.find((entry) =>
    entry.comparisonId === comparisonId && entry.counterpartRunId === comparator.runId);
  const right = comparator.infrastructureInvalidPairs.find((entry) =>
    entry.comparisonId === comparisonId && entry.counterpartRunId === primary.runId);
  if (!left && !right) return null;
  const leftIncident = left && {
    comparisonId: left.comparisonId,
    reason: left.reason,
    incidentId: left.incidentId,
    evidenceDigest: left.evidenceDigest,
    classifierVersion: left.classifierVersion,
    classifierImplementationDigest: left.classifierImplementationDigest,
  };
  const rightIncident = right && {
    comparisonId: right.comparisonId,
    reason: right.reason,
    incidentId: right.incidentId,
    evidenceDigest: right.evidenceDigest,
    classifierVersion: right.classifierVersion,
    classifierImplementationDigest: right.classifierImplementationDigest,
  };
  if (
    !left ||
    !right ||
    canonicalizeJson(leftIncident) !== canonicalizeJson(rightIncident)
  ) {
    issues.push(
      `${comparisonId}/${primary.taskId}/${primary.seedSlot}: infrastructure exclusion is not an exact paired incident`,
    );
    return null;
  }
  requireBundle(
    preregistration.exclusions.allowedInfrastructureReasons.includes(left.reason),
    `${comparisonId}/${primary.taskId}/${primary.seedSlot}: infrastructure reason was not preregistered`,
    issues,
  );
  requireBundle(
    primary.outcome === "infrastructure_invalid" &&
      comparator.outcome === "infrastructure_invalid",
    `${comparisonId}/${primary.taskId}/${primary.seedSlot}: infrastructure exclusion requires both paired outcomes to be infrastructure-invalid`,
    issues,
  );
  requireBundle(
    left.classifierVersion === preregistration.exclusions.classifierVersion &&
      left.classifierImplementationDigest ===
        preregistration.exclusions.classifierImplementation.digest,
    `${comparisonId}/${primary.taskId}/${primary.seedSlot}: infrastructure classifier was not preregistered`,
    issues,
  );
  const isPinnedClassifierEvent = (
    event: VerifiedEvidenceLedger["inspection"]["events"][number],
  ) => {
    const expectedBytes = Buffer.from(canonicalizeJson(
      createInfrastructureClassificationStatement({
        comparisonId,
        taskId: primary.taskId,
        seedSlot: primary.seedSlot,
        incidentId: left.incidentId,
        reason: left.reason,
        classifierVersion: left.classifierVersion,
        classifierImplementationDigest: left.classifierImplementationDigest,
      }),
    ), "utf8");
    return event.type === "infrastructure.classified" &&
    event.payload.mediaType ===
      "application/vnd.agenc.eval-infrastructure-classification+json" &&
    event.payload.sizeBytes === expectedBytes.byteLength &&
    event.payload.digest === sha256Digest(expectedBytes) &&
    event.payload.digest === left.evidenceDigest &&
    event.producer.version === preregistration.exclusions.classifierVersion &&
    event.producer.binaryDigest === preregistration.exclusions.classifierImplementation.digest;
  };
  const primaryHasEvidence = primaryEvidence.inspection.events.some(isPinnedClassifierEvent);
  const comparatorHasEvidence = comparatorEvidence.inspection.events.some(isPinnedClassifierEvent);
  requireBundle(
    primaryHasEvidence && comparatorHasEvidence,
    `${comparisonId}/${primary.taskId}/${primary.seedSlot}: infrastructure incident lacks a shared typed classifier receipt`,
    issues,
  );
  return {
    comparisonId,
    taskId: primary.taskId,
    seedSlot: primary.seedSlot,
    primaryRunId: primary.runId,
    comparatorRunId: comparator.runId,
    incidentId: left.incidentId,
    reason: left.reason,
    evidenceDigest: left.evidenceDigest,
    classifierVersion: left.classifierVersion,
    classifierImplementationDigest: left.classifierImplementationDigest,
  };
}

export async function validateEvaluationBundle(
  bundle: EvaluationExperimentBundle,
): Promise<ValidatedBundle> {
  const issues: string[] = [];
  const candidate = bundle as Partial<EvaluationExperimentBundle> | null;
  if (!candidate || typeof candidate !== "object") {
    throw new EvaluationBundleValidationError(["evaluation bundle must be an object"]);
  }
  for (const [name, document] of [
    ["suite", candidate.suite],
    ["preregistration", candidate.preregistration],
    ["preregistrationReceipt", candidate.preregistrationReceipt],
    ["blindedResultsSeal", candidate.blindedResultsSeal],
    ["unblindingRecord", candidate.unblindingRecord],
  ] as const) {
    requireBundle(
      typeof document === "object" && document !== null && !Array.isArray(document),
      `${name} must be a document object`,
      issues,
    );
  }
  requireBundle(isDenseArray(candidate.runs), "runs must be a dense array", issues);
  requireBundle(
    isDenseArray(candidate.verifiedEvidence),
    "verifiedEvidence must be a dense array",
    issues,
  );
  requireBundle(
    candidate.lifecycleAnchors !== undefined &&
      candidate.lifecycleAnchors !== null &&
      typeof candidate.lifecycleAnchors === "object",
    "lifecycleAnchors is required",
    issues,
  );
  requireBundle(
    typeof candidate.lifecycleAnchors?.verifyPreregistrationReceipt === "function",
    "lifecycleAnchors.verifyPreregistrationReceipt must be a function",
    issues,
  );
  if (issues.length > 0) throw new EvaluationBundleValidationError(issues);
  const validateDocument = (document: unknown) => {
    try {
      validateEvalContractDocument(document);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  };
  for (const document of [
    bundle.suite,
    bundle.preregistration,
    bundle.preregistrationReceipt,
    bundle.blindedResultsSeal,
    bundle.unblindingRecord,
    ...bundle.runs,
  ]) {
    validateDocument(document);
  }
  for (const document of [bundle.holdoutDescriptor, bundle.holdoutAccessReceipt]) {
    if (document !== undefined) validateDocument(document);
  }
  if (issues.length > 0) throw new EvaluationBundleValidationError(issues);
  if (!bundle.verifiedEvidence.every(isExternallyVerifiedEvidenceLedger)) {
    throw new EvaluationBundleValidationError([
      "bundle contains evidence that did not come from anchored ledger verification",
    ]);
  }
  bundle = snapshotEvaluationBundle(bundle);
  const { preregistration, preregistrationReceipt, lifecycleAnchors } = bundle;
  requireBundle(
    bundle.suite.documentDigest === preregistration.suite.manifestDigest &&
      bundle.suite.suiteId === preregistration.suite.suiteId &&
      bundle.suite.suiteVersion === preregistration.suite.suiteVersion &&
      bundle.suite.split === preregistration.suite.split,
    "suite does not match the preregistration",
    issues,
  );
  const selectedTaskCount = bundle.suite.tasks.length;
  const selectedRepositoryCount = new Set(
    bundle.suite.tasks.map((task) => task.repository.cluster),
  ).size;
  requireBundle(
    selectedTaskCount >= preregistration.samplePlan.minimumTasks &&
      selectedTaskCount <= preregistration.samplePlan.maximumTasks,
    "selected suite task count is outside the preregistered sample bounds",
    issues,
  );
  requireBundle(
    selectedRepositoryCount >= preregistration.samplePlan.minimumRepositories,
    "selected suite has fewer repository families than preregistered",
    issues,
  );
  const stoppingRule = preregistration.samplePlan.stoppingRule;
  requireBundle(
    selectedTaskCount === stoppingRule.taskCount,
    "selected suite task count is not a preregistered stopping point",
    issues,
  );
  const executionOrderInput: ExecutionOrderInput = {
    systemIds: preregistration.systems.map((system) => system.systemId),
    taskIds: bundle.suite.tasks.map((task) => task.taskId),
    seedSlots: preregistration.trialDesign.seedSlots,
    orderSeed: preregistration.trialDesign.orderSeed,
  };
  const expectedExecutionOrder = derivePlannedExecutionOrder(executionOrderInput);
  requireBundle(
    preregistration.trialDesign.plannedExecutionOrderDigest ===
      computePlannedExecutionOrderDigest(executionOrderInput),
    "planned randomized execution-order digest does not match the pinned matrix/seed",
    issues,
  );
  const executionIndexByCell = new Map(
    expectedExecutionOrder.map((cell, index) => [
      cellKey(cell.systemId, cell.taskId, cell.seedSlot),
      index,
    ]),
  );
  const familyMapDigest = digestCanonicalJson(
    "agenc.eval.repository-family-map.v1",
    bundle.suite.repositoryFamilies,
  );
  requireBundle(
    preregistration.suite.repositoryFamilyMapDigest === familyMapDigest,
    "repository family map digest does not match the suite",
    issues,
  );
  if (preregistration.suite.split === "private_holdout") {
    requireBundle(
      bundle.holdoutDescriptor?.documentDigest === preregistration.suite.holdoutDescriptorDigest,
      "private holdout descriptor does not match the preregistration",
      issues,
    );
    requireBundle(
      bundle.holdoutDescriptor !== undefined &&
        compareUtcTimestamps(bundle.holdoutDescriptor.sealedAt, preregistration.createdAt) <= 0,
      "holdout must be sealed before preregistration",
      issues,
    );
    if (bundle.holdoutDescriptor) {
      const tasksPerRepository = new Map<string, number>();
      for (const task of bundle.suite.tasks) {
        tasksPerRepository.set(
          task.repository.cluster,
          (tasksPerRepository.get(task.repository.cluster) ?? 0) + 1,
        );
      }
      const maximumTasksPerRepository = Math.max(...tasksPerRepository.values());
      requireBundle(
        bundle.holdoutDescriptor.suiteId === bundle.suite.suiteId &&
          bundle.holdoutDescriptor.suiteVersion === bundle.suite.suiteVersion &&
          bundle.holdoutDescriptor.status === "sealed",
        "holdout descriptor names a different suite/version or is not sealed",
        issues,
      );
      requireBundle(
        bundle.holdoutDescriptor.taskCount === selectedTaskCount &&
          bundle.holdoutDescriptor.repositoryCount === selectedRepositoryCount &&
          bundle.holdoutDescriptor.maximumTasksPerRepository === maximumTasksPerRepository,
        "unblinded holdout contents differ from the sealed descriptor counts",
        issues,
      );
      requireBundle(
        canonicalizeJson(bundle.holdoutDescriptor.taskManifestCommitment) ===
          canonicalizeJson(preregistration.suite.taskSelectionCommitment),
        "holdout task-manifest commitment differs from the preregistered selection",
        issues,
      );
      requireBundle(
        bundle.holdoutDescriptor.unsealPolicyDigest ===
          preregistration.unblinding.policyDigest,
        "holdout unseal policy differs from preregistered unblinding policy",
        issues,
      );
    }
  } else {
    requireBundle(bundle.holdoutDescriptor === undefined, "development bundle must not include a holdout descriptor", issues);
    requireBundle(bundle.holdoutAccessReceipt === undefined, "development bundle must not include a holdout access receipt", issues);
    requireBundle(
      lifecycleAnchors.expectedHoldoutAccessReceiptDigest === null &&
        lifecycleAnchors.holdoutAccessReceiptVerifierDigest === null &&
        lifecycleAnchors.verifyHoldoutAccessReceipt === undefined,
      "development bundle must not configure private holdout access verification",
      issues,
    );
  }
  requireBundle(
    preregistrationReceipt.preregistrationDigest === preregistration.documentDigest,
    "preregistration receipt points to a different preregistration",
    issues,
  );
  requireBundle(
    preregistrationReceipt.statementDigest ===
      digestCanonicalJson("agenc.eval.preregistration-statement.v1", preregistration),
    "preregistration receipt does not cover the exact preregistration",
    issues,
  );
  requireBundle(
    preregistrationReceipt.anchorPolicyDigest === preregistration.evidencePolicy.anchorPolicyDigest,
    "preregistration receipt used an unpinned anchor policy",
    issues,
  );
  requireBundle(
    lifecycleAnchors.preregistrationReceiptVerifierDigest ===
      preregistration.evidencePolicy.anchorVerifierDigest,
    "preregistration receipt verifier was not preregistered",
    issues,
  );
  requireBundle(
    preregistrationReceipt.documentDigest === lifecycleAnchors.expectedPreregistrationReceiptDigest,
    "preregistration receipt differs from the external anchor",
    issues,
  );
  requireBundle(
    bundle.blindedResultsSeal.documentDigest === lifecycleAnchors.expectedBlindedResultsSealDigest,
    "blinded-results seal differs from the external anchor",
    issues,
  );
  requireBundle(
    bundle.unblindingRecord.documentDigest === lifecycleAnchors.expectedUnblindingRecordDigest,
    "unblinding record differs from the external anchor",
    issues,
  );
  const preregistrationBytes = Buffer.from(canonicalizeJson(preregistration), "utf8");
  if (!(await lifecycleAnchors.verifyPreregistrationReceipt(preregistrationBytes, preregistrationReceipt))) {
    issues.push("preregistration receipt failed its pinned external verifier");
  }
  requireBundle(
    compareUtcTimestamps(preregistration.createdAt, preregistrationReceipt.anchoredAt) <= 0,
    "preregistration receipt predates its statement",
    issues,
  );
  const runByCell = new Map<string, RunRecordDocument>();
  const runIds = new Set<string>();
  const evidenceByRun = new Map(bundle.verifiedEvidence.map((entry) => [entry.inspection.runId, entry]));
  requireBundle(
    evidenceByRun.size === bundle.verifiedEvidence.length,
    "verified evidence contains duplicate run IDs",
    issues,
  );
  const tasks = new Map(bundle.suite.tasks.map((task) => [task.taskId, task]));
  const systems = new Map(preregistration.systems.map((system) => [system.systemId, system]));
  for (const run of bundle.runs) {
    if (runIds.has(run.runId)) issues.push(`duplicate runId ${run.runId}`);
    runIds.add(run.runId);
    const task = tasks.get(run.taskId);
    const system = systems.get(run.systemId);
    const evidence = evidenceByRun.get(run.runId);
    if (!task || !system || !evidence) {
      issues.push(`${run.runId}: run has an unpinned task/system or missing externally verified evidence`);
      continue;
    }
    const expectedTrialIndex = preregistration.trialDesign.seedSlots.indexOf(run.seedSlot);
    requireBundle(
      expectedTrialIndex >= 0 && run.trialIndex === expectedTrialIndex,
      `${run.runId}: trial index/seed slot was not preregistered`,
      issues,
    );
    const key = cellKey(run.systemId, run.taskId, run.seedSlot);
    requireBundle(
      run.executionIndex === executionIndexByCell.get(key),
      `${run.runId}: execution index differs from the preregistered randomized interleave`,
      issues,
    );
    if (runByCell.has(key)) issues.push(`${run.runId}: duplicate system/task/seed cell`);
    runByCell.set(key, run);
    requireBundle(
      compareUtcTimestamps(preregistrationReceipt.anchoredAt, run.startedAt) <= 0,
      `${run.runId}: run started before preregistration was externally anchored`,
      issues,
    );
    validateRunAgainstPins(run, task, system, preregistration, preregistrationReceipt, evidence, issues);
  }
  for (const system of preregistration.systems) {
    for (const task of bundle.suite.tasks) {
      for (const seedSlot of preregistration.trialDesign.seedSlots) {
        if (!runByCell.has(cellKey(system.systemId, task.taskId, seedSlot))) {
          issues.push(`missing planned run cell ${system.systemId}/${task.taskId}/${seedSlot}`);
        }
      }
    }
  }
  requireBundle(
    runByCell.size ===
      preregistration.systems.length *
        bundle.suite.tasks.length *
        preregistration.trialDesign.seedSlots.length,
    "run matrix contains missing or extra cells",
    issues,
  );
  const chronologicallyOrderedRuns = [...bundle.runs].sort(
    (left, right) => compareUtcTimestamps(left.startedAt, right.startedAt),
  );
  requireBundle(
    chronologicallyOrderedRuns.every((run, index) =>
      run.executionIndex === index &&
      (index === 0 || compareUtcTimestamps(
        run.startedAt,
        chronologicallyOrderedRuns[index - 1]?.startedAt ?? run.startedAt,
      ) > 0)),
    "run start chronology does not prove the preregistered randomized interleave",
    issues,
  );
  requireBundle(
    evidenceByRun.size === bundle.runs.length &&
      [...evidenceByRun.keys()].every((runId) => runIds.has(runId)),
    "verified evidence set differs from the complete run matrix",
    issues,
  );
  const matrixDigest = digestCanonicalJson(
    "agenc.eval.complete-run-matrix.v1",
    [...bundle.runs]
      .map((run) => ({ runId: run.runId, runDigest: run.documentDigest, sealDigest: run.evidence.sealDigest }))
      .sort((left, right) => compareCodeUnits(left.runId, right.runId)),
  );
  const sealSetDigest = digestCanonicalJson(
    "agenc.eval.evidence-seal-set.v1",
    [...bundle.runs].map((run) => run.evidence.sealDigest).sort(),
  );
  requireBundle(
    bundle.blindedResultsSeal.experimentId === preregistration.experimentId &&
      bundle.blindedResultsSeal.preregistrationDigest === preregistration.documentDigest &&
      bundle.blindedResultsSeal.preregistrationReceiptDigest === preregistrationReceipt.documentDigest &&
      bundle.blindedResultsSeal.completeRunMatrixDigest === matrixDigest &&
      bundle.blindedResultsSeal.evidenceSealSetDigest === sealSetDigest,
    "blinded-results seal does not commit to the complete verified run matrix",
    issues,
  );
  if (preregistration.suite.split === "private_holdout") {
    const descriptor = bundle.holdoutDescriptor;
    const accessReceipt = bundle.holdoutAccessReceipt;
    const accessVerifier = lifecycleAnchors.verifyHoldoutAccessReceipt;
    requireBundle(
      descriptor !== undefined && accessReceipt !== undefined && accessVerifier !== undefined,
      "private holdout requires a verified access receipt",
      issues,
    );
    if (descriptor && accessReceipt && accessVerifier) {
      const projectedRunIdsDigest = digestCanonicalJson(
        "agenc.eval.projected-run-ids.v1",
        [...bundle.runs].map((run) => run.runId).sort(compareCodeUnits),
      );
      requireBundle(
        accessReceipt.documentDigest === lifecycleAnchors.expectedHoldoutAccessReceiptDigest &&
          accessReceipt.receiptVerifierDigest ===
            lifecycleAnchors.holdoutAccessReceiptVerifierDigest &&
          accessReceipt.receiptVerifierDigest === descriptor.custody.custodyVerifierDigest,
        "holdout access receipt differs from its externally pinned verifier/receipt",
        issues,
      );
      requireBundle(
        accessReceipt.experimentId === preregistration.experimentId &&
          accessReceipt.holdoutDescriptorDigest === descriptor.documentDigest &&
          accessReceipt.suiteManifestDigest === bundle.suite.documentDigest &&
          accessReceipt.preregistrationDigest === preregistration.documentDigest &&
          accessReceipt.blindedResultsSealDigest === bundle.blindedResultsSeal.documentDigest &&
          accessReceipt.completeRunMatrixDigest === matrixDigest &&
          accessReceipt.projectedRunIdsDigest === projectedRunIdsDigest,
        "holdout access receipt is not bound to the exact experiment/run matrix",
        issues,
      );
      requireBundle(
        accessReceipt.accessPolicyDigest === descriptor.accessPolicyDigest &&
          accessReceipt.unsealPolicyDigest === descriptor.unsealPolicyDigest &&
          accessReceipt.unsealPolicyDigest === preregistration.unblinding.policyDigest &&
          accessReceipt.projectionPolicyDigest === descriptor.custody.projectionPolicyDigest &&
          accessReceipt.implementerPrincipalSetDigest ===
            descriptor.custody.implementerPrincipalSetDigest &&
          accessReceipt.custodianIdentity === descriptor.custody.custodianIdentity &&
          accessReceipt.authorizedRole === preregistration.unblinding.authorizedRole &&
          accessReceipt.authorizedPrincipal === bundle.unblindingRecord.unblindedBy &&
          accessReceipt.authorizationEvidenceDigest ===
            bundle.unblindingRecord.authorizationEvidenceDigest,
        "holdout access receipt is not bound to custody/authorization policy",
        issues,
      );
      requireBundle(
        compareUtcTimestamps(preregistrationReceipt.anchoredAt, accessReceipt.firstAccessAt) <= 0 &&
          compareUtcTimestamps(accessReceipt.firstAccessAt, accessReceipt.lastAccessAt) <= 0 &&
          compareUtcTimestamps(accessReceipt.lastAccessAt, bundle.blindedResultsSeal.sealedAt) <= 0 &&
          compareUtcTimestamps(bundle.blindedResultsSeal.sealedAt, accessReceipt.issuedAt) <= 0 &&
          compareUtcTimestamps(accessReceipt.issuedAt, bundle.unblindingRecord.unblindedAt) <= 0,
        "holdout access receipt chronology violates preregistration/seal/unblinding order",
        issues,
      );
      if (!(await accessVerifier(
        Buffer.from(canonicalizeJson(createHoldoutAccessStatement(accessReceipt)), "utf8"),
        accessReceipt,
      ))) {
        issues.push("holdout access receipt failed its pinned external verifier");
      }
    }
  }
  const latestFinish = bundle.runs.reduce((latest, run) =>
    compareUtcTimestamps(run.finishedAt, latest) > 0 ? run.finishedAt : latest,
  bundle.runs[0]?.finishedAt ?? bundle.blindedResultsSeal.sealedAt);
  requireBundle(
    compareUtcTimestamps(latestFinish, bundle.blindedResultsSeal.sealedAt) <= 0,
    "blinded-results seal predates a run result",
    issues,
  );
  requireBundle(
    bundle.runs.every((run) =>
      compareUtcTimestamps(run.evidence.sealedAt, bundle.blindedResultsSeal.sealedAt) <= 0),
    "blinded-results seal predates an evidence seal",
    issues,
  );
  requireBundle(
    bundle.unblindingRecord.experimentId === preregistration.experimentId &&
      bundle.unblindingRecord.preregistrationDigest === preregistration.documentDigest &&
      bundle.unblindingRecord.preregistrationReceiptDigest === preregistrationReceipt.documentDigest &&
      bundle.unblindingRecord.blindedResultsSealDigest === bundle.blindedResultsSeal.documentDigest &&
      bundle.unblindingRecord.holdoutDescriptorDigest ===
        (bundle.holdoutDescriptor?.documentDigest ?? null) &&
      bundle.unblindingRecord.holdoutAccessReceiptDigest ===
        (bundle.holdoutAccessReceipt?.documentDigest ?? null) &&
      bundle.unblindingRecord.policyDigest === preregistration.unblinding.policyDigest &&
      bundle.unblindingRecord.authorizedRole === preregistration.unblinding.authorizedRole,
    "unblinding record does not link the exact lifecycle documents",
    issues,
  );
  requireBundle(
    compareUtcTimestamps(
      bundle.blindedResultsSeal.sealedAt,
      bundle.unblindingRecord.unblindedAt,
    ) <= 0,
    "results were unblinded before the complete matrix was sealed",
    issues,
  );
  const exclusions: InfrastructureExclusion[] = [];
  for (const comparison of preregistration.comparisons) {
    for (const task of bundle.suite.tasks) {
      for (const seedSlot of preregistration.trialDesign.seedSlots) {
        const primary = runByCell.get(cellKey(comparison.primarySystemId, task.taskId, seedSlot));
        const comparator = runByCell.get(cellKey(comparison.comparatorSystemId, task.taskId, seedSlot));
        if (!primary || !comparator) continue;
        const exclusion = matchingInfrastructureExclusion(
          comparison.comparisonId,
          primary,
          comparator,
          evidenceByRun.get(primary.runId) as VerifiedEvidenceLedger,
          evidenceByRun.get(comparator.runId) as VerifiedEvidenceLedger,
          preregistration,
          issues,
        );
        if (exclusion) exclusions.push(exclusion);
      }
    }
  }
  for (const run of bundle.runs) {
    for (const incident of run.infrastructureInvalidPairs) {
      const paired = exclusions.some((entry) =>
        entry.comparisonId === incident.comparisonId &&
        (entry.primaryRunId === run.runId || entry.comparatorRunId === run.runId) &&
        (entry.primaryRunId === incident.counterpartRunId ||
          entry.comparatorRunId === incident.counterpartRunId));
      if (!paired) {
        issues.push(`${run.runId}: infrastructure-invalid incident lacks an exact paired exclusion`);
      }
    }
  }
  if (issues.length > 0) throw new EvaluationBundleValidationError(issues);
  return { bundle, runByCell, evidenceByRun, exclusions };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new EvaluationBundleValidationError(["cannot average an empty set"]);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function comparisonSeed(seed: number, comparisonId: string): number {
  const digest = digestCanonicalJson("agenc.eval.bootstrap-seed.v1", { seed, comparisonId });
  const derived = Number.parseInt(digest.slice("sha256:".length, "sha256:".length + 8), 16) >>> 0;
  return derived === 0 ? 0x9e3779b9 : derived;
}

function randomGenerator(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function type7Quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export interface RepositoryClusteredBootstrapTaskDifference {
  readonly cluster: string;
  readonly difference: number;
}

export interface RepositoryClusteredBootstrapInference {
  readonly resamples: number;
  readonly randomSeed: number;
}

/**
 * The single production implementation of contract-v1 repository-clustered
 * percentile bootstrap inference. Power planning calls this same function so
 * its decision rule cannot drift from result derivation.
 */
export function computeRepositoryClusteredPercentileInterval(
  taskDifferences: readonly { readonly cluster: string; readonly difference: number }[],
  comparisonId: string,
  inference: RepositoryClusteredBootstrapInference,
): { readonly lower: number; readonly upper: number } {
  const grouped = new Map<string, number[]>();
  for (const task of taskDifferences) {
    const group = grouped.get(task.cluster) ?? [];
    group.push(task.difference);
    grouped.set(task.cluster, group);
  }
  const clusters = [...grouped.keys()].sort();
  const clusterSummaries = clusters.map((cluster) => {
    const values = grouped.get(cluster) ?? [];
    return {
      sum: values.reduce((total, value) => total + value, 0),
      count: values.length,
    };
  });
  const random = randomGenerator(comparisonSeed(inference.randomSeed, comparisonId));
  const samples: number[] = [];
  for (let iteration = 0; iteration < inference.resamples; iteration += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusterSummaries[Math.floor(random() * clusterSummaries.length)];
      sum += cluster.sum;
      count += cluster.count;
    }
    samples.push(sum / count);
  }
  samples.sort((left, right) => left - right);
  return {
    lower: type7Quantile(samples, 0.025),
    upper: type7Quantile(samples, 0.975),
  };
}

export interface PairedTaskTrials {
  readonly taskId: string;
  readonly repositoryCluster: string;
  readonly trialDifferences: readonly number[];
}

export function computePairedTfrEffect(
  tasks: readonly PairedTaskTrials[],
  comparisonId: string,
  inference: PreregistrationDocument["inference"],
): { readonly pointEstimate: number; readonly confidenceLower: number; readonly confidenceUpper: number } {
  const issues: string[] = [];
  const taskEntries: readonly PairedTaskTrials[] = Array.isArray(tasks) ? tasks : [];
  const inferenceCandidate = inference as Partial<PreregistrationDocument["inference"]> | null;
  requireBundle(
    typeof comparisonId === "string" && CONTRACT_ID_PATTERN.test(comparisonId),
    "paired TFR effect requires a valid comparison ID",
    issues,
  );
  requireBundle(
    isDenseArray(tasks) && taskEntries.length > 0,
    "paired TFR effect requires non-empty dense task trials",
    issues,
  );
  requireBundle(
    new Set(taskEntries.map((task) => task?.taskId)).size === taskEntries.length,
    "paired TFR task IDs must be unique",
    issues,
  );
  for (const task of taskEntries) {
    if (!task || typeof task !== "object" || !Array.isArray(task.trialDifferences)) {
      issues.push("paired TFR task entries must be objects with trial differences");
      continue;
    }
    requireBundle(
      typeof task.taskId === "string" &&
        CONTRACT_ID_PATTERN.test(task.taskId) &&
        typeof task.repositoryCluster === "string" &&
        CONTRACT_ID_PATTERN.test(task.repositoryCluster),
      "paired TFR tasks require valid task and repository-cluster IDs",
      issues,
    );
    requireBundle(
      task.trialDifferences.length > 0 &&
        task.trialDifferences.every((value) => Number.isFinite(value) && value >= -1 && value <= 1),
      `${task.taskId}: trial differences must be finite values in [-1, 1]`,
      issues,
    );
  }
  requireBundle(
    inferenceCandidate !== null &&
      typeof inferenceCandidate === "object" &&
      Number.isInteger(inferenceCandidate.resamples) &&
      (inferenceCandidate.resamples ?? 0) >= 10_000 &&
      (inferenceCandidate.resamples ?? 0) <= 1_000_000,
    "paired TFR resamples must be an integer in [10000, 1000000]",
    issues,
  );
  requireBundle(
    inferenceCandidate !== null &&
      typeof inferenceCandidate === "object" &&
      Number.isInteger(inferenceCandidate.randomSeed) &&
      (inferenceCandidate.randomSeed ?? 0) >= 1 &&
      (inferenceCandidate.randomSeed ?? 0) <= UINT32_MAX,
    "paired TFR randomSeed must be an integer in [1, 2^32 - 1]",
    issues,
  );
  if (issues.length > 0) throw new EvaluationBundleValidationError(issues);
  const taskDifferences = taskEntries.map((task) => ({
    cluster: task.repositoryCluster,
    difference: mean(task.trialDifferences),
  }));
  const pointEstimate = mean(taskDifferences.map((entry) => entry.difference));
  const interval = computeRepositoryClusteredPercentileInterval(
    taskDifferences,
    comparisonId,
    inference,
  );
  return {
    pointEstimate,
    confidenceLower: interval.lower,
    confidenceUpper: interval.upper,
  };
}

function summaryEvidenceReference(verified: VerifiedEvidenceLedger): DerivedSummaryDocument["evidenceSeals"][number] {
  const reference = evidenceReference(verified);
  return {
    runId: verified.inspection.runId,
    contractDigest: reference.contractDigest,
    taskId: reference.taskId,
    systemId: reference.systemId,
    ledgerDigest: reference.ledgerDigest,
    ledgerByteLength: reference.ledgerByteLength,
    headEventDigest: reference.headEventDigest,
    eventCount: reference.eventCount,
    platformProtectionVerifierDigest: reference.platformProtectionVerifierDigest,
    sealDigest: reference.sealDigest,
    statementDigest: reference.statementDigest,
    anchorPolicyDigest: reference.anchorPolicyDigest,
    signatureAlgorithm: reference.signatureAlgorithm,
    signatureDigest: reference.signatureDigest,
    verificationMaterialDigest: reference.verificationMaterialDigest,
    anchorUri: reference.anchorUri,
    signerIdentity: reference.signerIdentity,
    sealedAt: reference.sealedAt,
  };
}

export async function deriveExperimentSummary(
  bundle: EvaluationExperimentBundle,
  options: DerivedSummaryOptions,
): Promise<DerivedSummaryDocument> {
  const stableOptions = snapshotSummaryOptions(options);
  const validated = await validateEvaluationBundle(bundle);
  bundle = validated.bundle;
  const excludedPairCells = new Set(
    validated.exclusions.map((entry) =>
      `${entry.comparisonId}\u0000${entry.taskId}\u0000${entry.seedSlot}`),
  );
  const systemSummaries: SystemSummary[] = bundle.preregistration.systems.map((system) => {
    const taskScores = bundle.suite.tasks.map((task) => {
      const runs = bundle.preregistration.trialDesign.seedSlots
        .map((seedSlot) => validated.runByCell.get(cellKey(system.systemId, task.taskId, seedSlot)))
        .filter((run): run is RunRecordDocument => run !== undefined);
      const allAssessed = runs.every((run) => run.trustAssessment.status === "assessed");
      return {
        taskId: task.taskId,
        repositoryCluster: task.repository.cluster,
        repetitions: runs.length,
        verifiedFixRate: mean(runs.map((run) => Number(run.verifiedFix))),
        trustedFixRate: allAssessed
          ? mean(runs.map((run) => Number(run.trustAssessment.trustedFix)))
          : null,
      };
    });
    const includedRuns = bundle.runs.filter((run) => run.systemId === system.systemId);
    const allTasksAssessed = taskScores.every((task) => task.trustedFixRate !== null);
    return {
      systemId: system.systemId,
      taskCount: taskScores.length,
      includedTrialCount: includedRuns.length,
      pairwiseInfrastructureExclusionCount: validated.exclusions.filter((exclusion) => {
        const primary = validated.runByCell.get(
          cellKey(bundle.preregistration.primarySystemId, exclusion.taskId, exclusion.seedSlot),
        );
        const comparator = bundle.runs.find((run) => run.runId === exclusion.comparatorRunId);
        return primary?.systemId === system.systemId || comparator?.systemId === system.systemId;
      }).length,
      unassessedTrialCount: includedRuns.filter((run) => run.trustAssessment.status === "unassessed").length,
      verifiedFixRate: mean(taskScores.map((task) => task.verifiedFixRate)),
      trustedFixRate: allTasksAssessed
        ? mean(taskScores.map((task) => task.trustedFixRate as number))
        : null,
      taskScores,
    };
  });
  const pairedEffects: Array<DerivedSummaryDocument["pairedEffects"][number]> = [];
  for (const comparison of bundle.preregistration.comparisons) {
    const taskTrials: PairedTaskTrials[] = [];
    let fullyAssessed = true;
    for (const task of bundle.suite.tasks) {
      const paired = bundle.preregistration.trialDesign.seedSlots.flatMap((seedSlot) => {
        const primary = validated.runByCell.get(cellKey(comparison.primarySystemId, task.taskId, seedSlot));
        const comparator = validated.runByCell.get(cellKey(comparison.comparatorSystemId, task.taskId, seedSlot));
        if (
          !primary ||
          !comparator ||
          excludedPairCells.has(`${comparison.comparisonId}\u0000${task.taskId}\u0000${seedSlot}`)
        ) {
          return [];
        }
        return [{ primary, comparator }];
      });
      if (paired.length === 0) {
        throw new EvaluationBundleValidationError([
          `${comparison.comparisonId}/${task.taskId}: no valid paired repetitions remain`,
        ]);
      }
      if (paired.some(({ primary, comparator }) =>
        primary.trustAssessment.status !== "assessed" || comparator.trustAssessment.status !== "assessed")) {
        fullyAssessed = false;
        continue;
      }
      taskTrials.push({
        taskId: task.taskId,
        repositoryCluster: task.repository.cluster,
        trialDifferences: paired.map(({ primary, comparator }) =>
          Number(primary.trustAssessment.trustedFix) - Number(comparator.trustAssessment.trustedFix)),
      });
    }
    if (!fullyAssessed) continue;
    const effect = computePairedTfrEffect(
      taskTrials,
      comparison.comparisonId,
      bundle.preregistration.inference,
    );
    const pointEstimate = effect.pointEstimate;
    pairedEffects.push({
      comparisonId: comparison.comparisonId,
      comparatorSystemId: comparison.comparatorSystemId,
      pointEstimate,
      confidenceLower: effect.confidenceLower,
      confidenceUpper: effect.confidenceUpper,
      confidenceLevel: "0.95",
      method: "repository_clustered_paired_percentile_bootstrap",
      resamples: bundle.preregistration.inference.resamples,
      superiorityCriterionMet: bundle.preregistration.claim === "superiority"
        ? pointEstimate >= 0.1 && effect.confidenceLower > 0
        : null,
    });
  }
  if (
    bundle.preregistration.claim === "superiority" &&
    pairedEffects.length !== bundle.preregistration.comparisons.length
  ) {
    throw new EvaluationBundleValidationError([
      "confirmatory superiority TFR is unavailable while any paired run is unassessed",
    ]);
  }
  const summary = withDocumentDigest<DerivedSummaryDocument>({
    kind: "agenc.eval.derived-summary",
    contractVersion: EVAL_CONTRACT_VERSION,
    summaryId: stableOptions.summaryId,
    generatedAt: stableOptions.generatedAt,
    derived: true,
    claim: bundle.preregistration.claim,
    experimentId: bundle.preregistration.experimentId,
    preregistrationDigest: bundle.preregistration.documentDigest,
    preregistrationReceiptDigest: bundle.preregistrationReceipt.documentDigest,
    blindedResultsSealDigest: bundle.blindedResultsSeal.documentDigest,
    unblindingRecordDigest: bundle.unblindingRecord.documentDigest,
    suiteManifestDigest: bundle.suite.documentDigest,
    analysisImplementationDigest: bundle.preregistration.evaluator.analysisImplementation.digest,
    evidenceSeals: [...bundle.verifiedEvidence]
      .sort((left, right) => compareCodeUnits(left.inspection.runId, right.inspection.runId))
      .map(summaryEvidenceReference),
    systems: systemSummaries,
    pairedEffects,
    superiorityEstablished: bundle.preregistration.claim === "superiority"
      ? pairedEffects.every((effect) => effect.superiorityCriterionMet === true)
      : null,
    excludedInfrastructurePairs: validated.exclusions,
    rawEvidenceEmbedded: false,
  });
  if (compareUtcTimestamps(bundle.unblindingRecord.unblindedAt, stableOptions.generatedAt) > 0) {
    throw new EvaluationBundleValidationError(["summary predates unblinding"]);
  }
  return validateEvalContractDocument(summary) as DerivedSummaryDocument;
}

export async function validateDerivedSummaryAgainstBundle(
  bundle: EvaluationExperimentBundle,
  summary: DerivedSummaryDocument,
): Promise<DerivedSummaryDocument> {
  const validated = validateEvalContractDocument(summary);
  if (validated.kind !== "agenc.eval.derived-summary") {
    throw new EvaluationBundleValidationError(["expected an evaluation derived summary"]);
  }
  const stableSummary = cloneContractSnapshot(validated);
  const expected = await deriveExperimentSummary(bundle, {
    summaryId: stableSummary.summaryId,
    generatedAt: stableSummary.generatedAt,
  });
  if (canonicalizeJson(stableSummary) !== canonicalizeJson(expected)) {
    throw new EvaluationBundleValidationError([
      "derived summary does not exactly match fresh derivation from the anchored bundle",
    ]);
  }
  return expected;
}
