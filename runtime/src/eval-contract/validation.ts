import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import contractSchema from "./contract-v1.schema.json" with { type: "json" };
import { assertLocalPrivateDirectory } from "../utils/sqlite-lock.js";
import {
  canonicalizeJson,
  computeDocumentDigest,
  digestCanonicalJson,
  digestDomainSeparated,
  sha256Digest,
  withDocumentDigest,
} from "./canonical-json.js";
import {
  EVAL_CONTRACT_VERSION,
  type AgentTaskDocument,
  type ContentArtifact,
  type BlindedResultsSealDocument,
  type DerivedSummaryDocument,
  type EvalContractDocument,
  type EvidenceEventDocument,
  type EvidenceLedgerSealDocument,
  type HoldoutAccessReceiptDocument,
  type HoldoutDescriptorDocument,
  type LegacyReportQualification,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type PreregistrationReceiptDocument,
  type RunRecordDocument,
  type Sha256Digest,
  type SuiteManifestDocument,
  type UnblindingRecordDocument,
} from "./types.js";

const MAX_CONTENT_BYTES = 1024 * 1024 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const CONTRACT_KINDS = new Set([
  "agenc.eval.operator-task",
  "agenc.eval.agent-task",
  "agenc.eval.suite-manifest",
  "agenc.eval.holdout-descriptor",
  "agenc.eval.holdout-access-receipt",
  "agenc.eval.preregistration",
  "agenc.eval.run-record",
  "agenc.eval.evidence-event",
  "agenc.eval.evidence-seal",
  "agenc.eval.preregistration-receipt",
  "agenc.eval.blinded-results-seal",
  "agenc.eval.unblinding-record",
  "agenc.eval.derived-summary",
]);

let compiledValidator: ValidateFunction | undefined;

export class EvalContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`evaluation contract validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EvalContractValidationError";
    this.issues = issues;
  }
}

function schemaValidator(): ValidateFunction {
  if (compiledValidator) return compiledValidator;
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
  });
  const validator = ajv.compile(contractSchema);
  compiledValidator = validator;
  return validator;
}

function renderSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["document does not match contract v1"];
  const rendered = new Set<string>();
  for (const error of errors) {
    if (error.keyword === "oneOf") continue;
    const location = error.instancePath || "/";
    const detail = error.params && "additionalProperty" in error.params
      ? `unknown property ${String(error.params.additionalProperty)}`
      : error.message ?? error.keyword;
    rendered.add(`${location}: ${detail}`);
  }
  return [...rendered].slice(0, 64);
}

function requireCondition(condition: unknown, issue: string, issues: string[]): void {
  if (!condition) issues.push(issue);
}

function assertUnique<T extends string | number>(
  values: readonly T[],
  label: string,
  issues: string[],
): void {
  if (new Set(values).size !== values.length) issues.push(`${label} must be unique`);
}

function assertTimestamp(value: string, label: string, issues: string[]): void {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  const timestamp = Date.parse(value);
  if (!match || !Number.isFinite(timestamp)) {
    issues.push(`${label} is not a real UTC timestamp`);
    return;
  }
  const date = new Date(timestamp);
  const fields = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  if (fields.some((field, index) => field !== Number(match[index + 1]))) {
    issues.push(`${label} is not a real UTC timestamp`);
  }
}

function timestampNanoseconds(value: string): bigint {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw new EvalContractValidationError([`${value} is not a contract UTC timestamp`]);
  }
  const secondPrecision = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const epochMilliseconds = Date.parse(secondPrecision);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new EvalContractValidationError([`${value} is not a real UTC timestamp`]);
  }
  const fractionalNanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  return BigInt(epochMilliseconds) * 1_000_000n + fractionalNanoseconds;
}

/** Compares contract timestamps without losing their permitted nanosecond precision. */
export function compareUtcTimestamps(left: string, right: string): number {
  const leftNanoseconds = timestampNanoseconds(left);
  const rightNanoseconds = timestampNanoseconds(right);
  return leftNanoseconds < rightNanoseconds ? -1 : leftNanoseconds > rightNanoseconds ? 1 : 0;
}

function timestampDurationMilliseconds(start: string, finish: string): number {
  return Number(timestampNanoseconds(finish) - timestampNanoseconds(start)) / 1_000_000;
}

function assertSafeJsonNumbers(value: unknown, issues: string[], path = "$root"): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      issues.push(`${path} contains a non-finite or unsafe integer`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJsonNumbers(entry, issues, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertSafeJsonNumbers(entry, issues, `${path}.${key}`);
  }
}

function assertTimestampFields(value: unknown, issues: string[], path = "$root"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertTimestampFields(entry, issues, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryPath = `${path}.${key}`;
    if (key.endsWith("At") && typeof entry === "string") {
      assertTimestamp(entry, entryPath, issues);
    } else {
      assertTimestampFields(entry, issues, entryPath);
    }
  }
}

function assertCanonicalRepositoryUri(value: string, label: string, issues: string[]): void {
  try {
    const parsed = new URL(value);
    const normalizedPath = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
    const normalized = `https://${parsed.host.toLowerCase()}${normalizedPath}`;
    requireCondition(
      parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        value === normalized,
      `${label} must be a canonical credential-free HTTPS repository URI`,
      issues,
    );
  } catch {
    issues.push(`${label} is not a valid repository URI`);
  }
}

function assertCanonicalHttpsUrl(value: string, label: string, issues: string[]): void {
  try {
    const parsed = new URL(value);
    requireCondition(
      parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        parsed.toString() === value,
      `${label} must be a canonical credential-free HTTPS URL without query or fragment`,
      issues,
    );
  } catch {
    issues.push(`${label} is not a valid canonical HTTPS URL`);
  }
}

function assertNetworkPolicy(
  policy: { readonly mode: string; readonly allowlist: readonly string[]; readonly dns: string },
  label: string,
  issues: string[],
): void {
  if (policy.mode === "allowlist") {
    requireCondition(policy.allowlist.length > 0, `${label} allowlist mode requires hosts`, issues);
    requireCondition(policy.dns === "pinned", `${label} allowlist mode requires pinned DNS`, issues);
  } else {
    requireCondition(policy.allowlist.length === 0, `${label} must not carry an allowlist`, issues);
    requireCondition(policy.dns === "disabled", `${label} must disable DNS`, issues);
  }
}

function artifactHex(artifact: ContentArtifact): string {
  return artifact.digest.slice("sha256:".length);
}

function assertArtifact(artifact: ContentArtifact, label: string, issues: string[]): void {
  requireCondition(
    artifact.uri === `cas://sha256/${artifactHex(artifact)}`,
    `${label}.uri must address its exact digest`,
    issues,
  );
  requireCondition(
    Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes <= MAX_CONTENT_BYTES,
    `${label}.sizeBytes exceeds the contract limit`,
    issues,
  );
}

export function assertPortableRelativePath(value: string, label = "path"): void {
  const issues: string[] = [];
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-z]:/iu.test(value) ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.includes(":")
  ) {
    issues.push(`${label} must be a portable forward-slash relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_NAME.test(segment),
    )
  ) {
    issues.push(`${label} contains a traversal, empty, or reserved segment`);
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    issues.push(`${label} must not address Git metadata`);
  }
  if (issues.length > 0) throw new EvalContractValidationError(issues);
}

function assertSharedTask(
  task: OperatorTaskDocument | AgentTaskDocument,
  issues: string[],
): void {
  assertCanonicalRepositoryUri(task.repository.uri, `${task.taskId}.repository.uri`, issues);
  requireCondition(
    task.issue.digest === digestDomainSeparated("agenc.eval.issue.v1", task.issue.text),
    `${task.taskId}: issue digest does not match exact issue text`,
    issues,
  );
  assertArtifact(task.setupPatch, `${task.taskId}.setupPatch`, issues);
  for (const artifact of task.expectedArtifacts) {
    try {
      assertPortableRelativePath(artifact.path, `${task.taskId}.expectedArtifacts.${artifact.id}.path`);
    } catch (error) {
      if (error instanceof EvalContractValidationError) issues.push(...error.issues);
      else throw error;
    }
  }
  assertUnique(task.allowedTools.map((tool) => tool.name), `${task.taskId}.allowedTools`, issues);
  assertUnique(
    task.expectedArtifacts.map((artifact) => artifact.id),
    `${task.taskId}.expectedArtifacts`,
    issues,
  );
  assertUnique(
    task.expectedArtifacts.map((artifact) => artifact.path.toLowerCase()),
    `${task.taskId}.expectedArtifact paths`,
    issues,
  );
  assertUnique(
    task.environment.toolchain.map((tool) => tool.name),
    `${task.taskId}.environment.toolchain`,
    issues,
  );
  assertNetworkPolicy(task.networkPolicy, `${task.taskId}.networkPolicy`, issues);
  const declaredTokens =
    task.budget.inputTokens + task.budget.outputTokens + task.budget.reasoningTokens;
  requireCondition(
    task.budget.totalTokens >= declaredTokens,
    `${task.taskId}: total token budget is below its component budgets`,
    issues,
  );
  if (task.networkPolicy.mode === "none") {
    requireCondition(
      !task.allowedTools.some((tool) => tool.capabilities.includes("network")),
      `${task.taskId}: network tool capability conflicts with network:none`,
      issues,
    );
  }
}

function assertTask(task: OperatorTaskDocument, issues: string[]): void {
  assertSharedTask(task, issues);
  requireCondition(
    task.hiddenVerifier.timeoutMs <= task.budget.wallTimeMs,
    `${task.taskId}: verifier timeout exceeds task wall-time budget`,
    issues,
  );
  assertArtifact(task.hiddenVerifier.bundle, `${task.taskId}.hiddenVerifier.bundle`, issues);
  assertArtifact(task.referenceSolution.patch, `${task.taskId}.referenceSolution.patch`, issues);
  assertArtifact(
    task.referenceSolution.validationEvidence,
    `${task.taskId}.referenceSolution.validationEvidence`,
    issues,
  );
  assertTimestamp(task.provenance.authoredAt, `${task.taskId}.provenance.authoredAt`, issues);
  assertTimestamp(task.provenance.cutoffAt, `${task.taskId}.provenance.cutoffAt`, issues);
  requireCondition(
    compareUtcTimestamps(task.provenance.cutoffAt, task.provenance.authoredAt) <= 0,
    `${task.taskId}: contamination cutoff must not follow task authoring`,
    issues,
  );
  requireCondition(
    (task.provenance.status === "eligible") === (task.provenance.retirementReason === null),
    `${task.taskId}: retirement reason/status mismatch`,
    issues,
  );
  if (task.split === "private_holdout") {
    requireCondition(
      task.provenance.sourceType === "private_authored" &&
        !task.provenance.issueWasPublic &&
        !task.provenance.setupPatchWasPublic &&
        !task.provenance.verifierWasPublic &&
        !task.provenance.goldPatchWasPublic,
      `${task.taskId}: private holdout oracle materials must be privately authored and unexposed`,
      issues,
    );
    requireCondition(
      task.repository.solutionHistory === "stripped",
      `${task.taskId}: private holdout repository history must not expose the solution`,
      issues,
    );
  }
}

function assertAgentTask(task: AgentTaskDocument, issues: string[]): void {
  assertSharedTask(task, issues);
}

function assertSuite(suite: SuiteManifestDocument, issues: string[]): void {
  assertTimestamp(suite.createdAt, "suite.createdAt", issues);
  assertUnique(suite.repositoryFamilies.map((family) => family.cluster), "repository family clusters", issues);
  assertUnique(
    suite.repositoryFamilies.flatMap((family) => family.memberRepositoryUris),
    "repository family member URIs",
    issues,
  );
  for (const family of suite.repositoryFamilies) {
    assertCanonicalRepositoryUri(
      family.canonicalRepositoryUri,
      `${family.cluster}.canonicalRepositoryUri`,
      issues,
    );
    for (const member of family.memberRepositoryUris) {
      assertCanonicalRepositoryUri(member, `${family.cluster}.memberRepositoryUri`, issues);
    }
    requireCondition(
      family.memberRepositoryUris.includes(family.canonicalRepositoryUri),
      `${family.cluster}: canonical repository URI must be a family member`,
      issues,
    );
  }
  assertUnique(suite.tasks.map((task) => task.taskId), "suite task IDs", issues);
  assertUnique(suite.tasks.map((task) => task.issue.digest), "suite issue digests", issues);
  for (const task of suite.tasks) {
    requireCondition(task.split === suite.split, `${task.taskId}: split differs from suite`, issues);
    requireCondition(
      task.provenance.status === "eligible",
      `${task.taskId}: retired task cannot appear in an active suite`,
      issues,
    );
    assertDocumentDigest(task, issues);
    assertTask(task, issues);
    const family = suite.repositoryFamilies.find((candidate) =>
      candidate.memberRepositoryUris.includes(task.repository.uri));
    requireCondition(
      family?.cluster === task.repository.cluster,
      `${task.taskId}: repository URI is not pinned to its declared family cluster`,
      issues,
    );
  }
  const counts = new Map<string, number>();
  for (const task of suite.tasks) {
    counts.set(task.repository.cluster, (counts.get(task.repository.cluster) ?? 0) + 1);
  }
  const maximum = Math.max(...counts.values());
  requireCondition(
    maximum / suite.tasks.length <= 0.1,
    "suite repository cap exceeds 10% of tasks",
    issues,
  );
}

function assertHoldoutDescriptor(
  descriptor: HoldoutDescriptorDocument,
  issues: string[],
): void {
  assertTimestamp(descriptor.createdAt, "holdout.createdAt", issues);
  assertTimestamp(descriptor.sealedAt, "holdout.sealedAt", issues);
  requireCondition(
    descriptor.maximumTasksPerRepository / descriptor.taskCount <= 0.1,
    "holdout repository cap exceeds 10% of tasks",
    issues,
  );
  requireCondition(
    descriptor.repositoryCount <= descriptor.taskCount,
    "holdout repository count exceeds task count",
    issues,
  );
  requireCondition(
    descriptor.custody.custodianIdentity.length > 0,
    "holdout custody requires a named external custodian identity",
    issues,
  );
}

function assertHoldoutAccessReceipt(
  receipt: HoldoutAccessReceiptDocument,
  issues: string[],
): void {
  assertTimestamp(receipt.firstAccessAt, "holdoutAccess.firstAccessAt", issues);
  assertTimestamp(receipt.lastAccessAt, "holdoutAccess.lastAccessAt", issues);
  assertTimestamp(receipt.issuedAt, "holdoutAccess.issuedAt", issues);
  requireCondition(
    compareUtcTimestamps(receipt.firstAccessAt, receipt.lastAccessAt) <= 0 &&
      compareUtcTimestamps(receipt.lastAccessAt, receipt.issuedAt) <= 0,
    "holdout access receipt timestamps are out of order",
    issues,
  );
  assertCanonicalHttpsUrl(receipt.receiptUri, "holdoutAccess.receiptUri", issues);
}

function looksMutableModelId(value: string): boolean {
  return /(?:^|[-_/:.])(latest|default|current|preview)(?:$|[-_/:.])/iu.test(value);
}

function assertPreregistration(
  preregistration: PreregistrationDocument,
  issues: string[],
): void {
  assertTimestamp(preregistration.createdAt, "preregistration.createdAt", issues);
  const systemIds = preregistration.systems.map((system) => system.systemId);
  assertUnique(systemIds, "preregistration system IDs", issues);
  requireCondition(
    systemIds.includes(preregistration.primarySystemId),
    "primarySystemId is not a registered system",
    issues,
  );
  assertUnique(
    preregistration.comparisons.map((comparison) => comparison.comparisonId),
    "comparison IDs",
    issues,
  );
  assertUnique(
    preregistration.comparisons.map((comparison) => comparison.comparatorSystemId),
    "comparison comparator system IDs",
    issues,
  );
  for (const comparison of preregistration.comparisons) {
    requireCondition(
      comparison.primarySystemId === preregistration.primarySystemId,
      `${comparison.comparisonId}: comparison primary does not match primarySystemId`,
      issues,
    );
    requireCondition(
      systemIds.includes(comparison.comparatorSystemId) &&
        comparison.comparatorSystemId !== comparison.primarySystemId,
      `${comparison.comparisonId}: comparator is missing or equals the primary`,
      issues,
    );
  }
  requireCondition(
    preregistration.systems.every((system) => system.lane === preregistration.lane),
    "every system must belong to the preregistered lane",
    issues,
  );
  assertArtifact(
    preregistration.evaluator.analysisImplementation,
    "evaluator.analysisImplementation",
    issues,
  );
  assertCanonicalRepositoryUri(
    preregistration.evaluator.repositoryUri,
    "evaluator.repositoryUri",
    issues,
  );
  assertArtifact(
    preregistration.evaluator.trustAssessmentImplementation,
    "evaluator.trustAssessmentImplementation",
    issues,
  );
  assertArtifact(
    preregistration.exclusions.classifierImplementation,
    "exclusions.classifierImplementation",
    issues,
  );
  requireCondition(
    preregistration.trialDesign.seedSlots.length ===
      preregistration.trialDesign.repetitionsPerSystemTask,
    "seed slot count must equal repetitions per system/task",
    issues,
  );
  assertUnique(preregistration.trialDesign.seedSlots, "trial seed slots", issues);
  requireCondition(
    preregistration.samplePlan.maximumTasks >= preregistration.samplePlan.minimumTasks,
    "maximumTasks must be at least minimumTasks",
    issues,
  );
  if (preregistration.suite.split === "private_holdout") {
    requireCondition(
      preregistration.suite.holdoutDescriptorDigest !== null,
      "private holdout preregistration requires its public descriptor digest",
      issues,
    );
  } else {
    requireCondition(
      preregistration.suite.holdoutDescriptorDigest === null,
      "development preregistration must not claim a holdout descriptor",
      issues,
    );
  }
  if (preregistration.claim === "pilot") {
    requireCondition(
      preregistration.samplePlan.minimumTasks >= 30,
      "pilot requires at least 30 tasks",
      issues,
    );
  }
  if (preregistration.claim === "superiority") {
    requireCondition(
      preregistration.suite.split === "private_holdout",
      "superiority claim requires a private holdout",
      issues,
    );
    requireCondition(
      preregistration.samplePlan.minimumTasks >= 50,
      "superiority claim requires at least 50 tasks",
      issues,
    );
    requireCondition(
      preregistration.trialDesign.repetitionsPerSystemTask >= 3,
      "superiority claim requires at least three trials per system/task",
      issues,
    );
    requireCondition(
      preregistration.systems.length >= 2,
      "superiority claim requires at least two systems",
      issues,
    );
    requireCondition(
      preregistration.comparisons.length === preregistration.systems.length - 1,
      "superiority claim requires one explicit comparison for every comparator",
      issues,
    );
    const comparedSystems = new Set(
      preregistration.comparisons.map((comparison) => comparison.comparatorSystemId),
    );
    requireCondition(
      systemIds.every((systemId) =>
        systemId === preregistration.primarySystemId || comparedSystems.has(systemId)),
      "superiority claim omits a registered comparator system",
      issues,
    );
  }
  for (const system of preregistration.systems) {
    assertCanonicalRepositoryUri(system.repositoryUri, `${system.systemId}.repositoryUri`, issues);
    requireCondition(
      !looksMutableModelId(system.immutableModelId),
      `${system.systemId}: immutable model ID is a mutable alias`,
      issues,
    );
    assertUnique(
      system.generationParameters.map((parameter) => parameter.name),
      `${system.systemId}.generationParameters`,
      issues,
    );
    assertNetworkPolicy(system.networkPolicy, `${system.systemId}.networkPolicy`, issues);
    assertArtifact(system.package, `${system.systemId}.package`, issues);
  }
  const matched = preregistration.systems.filter((system) => system.lane === "matched_model");
  if (matched.length > 1) {
    const first = matched[0];
    const fairShape = (system: (typeof matched)[number]) => ({
      provider: system.provider,
      immutableModelId: system.immutableModelId,
      generationParameters: [...system.generationParameters].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      hardwareClass: system.hardwareClass,
      environmentClassDigest: system.environmentClassDigest,
      networkPolicy: system.networkPolicy,
      retryPolicy: system.retryPolicy,
      approvalPolicy: system.approvalPolicy,
    });
    const expected = digestCanonicalJson("agenc.eval.fairness.v1", fairShape(first));
    for (const system of matched.slice(1)) {
      requireCondition(
        digestCanonicalJson("agenc.eval.fairness.v1", fairShape(system)) === expected,
        `${system.systemId}: matched-model lane configuration is not externally matched`,
        issues,
      );
    }
  }
  const stopping = preregistration.samplePlan.stoppingRule;
  requireCondition(
    stopping.taskCount === preregistration.samplePlan.minimumTasks &&
      stopping.taskCount === preregistration.samplePlan.maximumTasks,
    "fixed stopping rule must equal the minimum and maximum task count",
    issues,
  );
  requireCondition(
    preregistration.evidencePolicy.maximumEventBytes <=
      preregistration.evidencePolicy.maximumLedgerBytes &&
      preregistration.evidencePolicy.maximumPayloadBytes <=
        preregistration.evidencePolicy.maximumLedgerBytes,
    "evidence event/payload limits must not exceed the ledger limit",
    issues,
  );
}

function assertPreregistrationReceipt(
  receipt: PreregistrationReceiptDocument,
  issues: string[],
): void {
  assertTimestamp(receipt.anchoredAt, "preregistrationReceipt.anchoredAt", issues);
  assertCanonicalHttpsUrl(receipt.anchorUri, "preregistration receipt anchor", issues);
}

function assertBlindedResultsSeal(
  seal: BlindedResultsSealDocument,
  issues: string[],
): void {
  assertTimestamp(seal.sealedAt, "blindedResults.sealedAt", issues);
}

function assertUnblindingRecord(
  record: UnblindingRecordDocument,
  issues: string[],
): void {
  assertTimestamp(record.unblindedAt, "unblinding.unblindedAt", issues);
  requireCondition(
    (record.holdoutDescriptorDigest === null) ===
      (record.holdoutAccessReceiptDigest === null),
    "holdout descriptor and access receipt must both be present or both absent",
    issues,
  );
}

function assertRunRecord(run: RunRecordDocument, issues: string[]): void {
  assertTimestamp(run.startedAt, `${run.runId}.startedAt`, issues);
  assertTimestamp(run.finishedAt, `${run.runId}.finishedAt`, issues);
  requireCondition(
    compareUtcTimestamps(run.finishedAt, run.startedAt) >= 0,
    `${run.runId}: finish precedes start`,
    issues,
  );
  const timestampDuration = timestampDurationMilliseconds(run.startedAt, run.finishedAt);
  requireCondition(
    Math.abs(timestampDuration - run.wallTimeMs) <= 1000,
    `${run.runId}: wallTimeMs disagrees with timestamps by more than one second`,
    issues,
  );
  requireCondition(run.systemId === run.system.systemId, `${run.runId}: system ID mismatch`, issues);
  requireCondition(
    run.verifier.passedAssertions <= run.verifier.assertionCount,
    `${run.runId}: passed verifier assertions exceed total assertions`,
    issues,
  );
  const countedTokens =
    run.usage.inputTokens + run.usage.outputTokens + run.usage.reasoningTokens;
  requireCondition(
    run.usage.totalTokens >= countedTokens,
    `${run.runId}: total tokens are below input/output/reasoning components`,
    issues,
  );
  assertUnique(run.artifacts.map((artifact) => artifact.artifactId), `${run.runId}.artifact IDs`, issues);
  assertUnique(run.approvals.map((approval) => approval.id), `${run.runId}.approval IDs`, issues);
  for (const approval of run.approvals) {
    assertTimestamp(approval.requestedAt, `${run.runId}.${approval.id}.requestedAt`, issues);
    assertTimestamp(approval.resolvedAt, `${run.runId}.${approval.id}.resolvedAt`, issues);
    requireCondition(
      compareUtcTimestamps(approval.resolvedAt, approval.requestedAt) >= 0,
      `${run.runId}: approval ${approval.id} resolves before it was requested`,
      issues,
    );
  }
  assertUnique(
    run.artifacts
      .map((artifact) => artifact.expectedArtifactId)
      .filter((artifactId): artifactId is string => artifactId !== null),
    `${run.runId}.expected artifact IDs`,
    issues,
  );
  for (const [index, artifact] of run.artifacts.entries()) {
    assertArtifact(artifact, `${run.runId}.artifacts[${index}]`, issues);
    requireCondition(
      (artifact.expectedArtifactId === null) === (artifact.path === null),
      `${run.runId}.artifacts[${index}]: expected artifact ID/path must both be present or absent`,
      issues,
    );
    if (artifact.path !== null) {
      try {
        assertPortableRelativePath(artifact.path, `${run.runId}.artifacts[${index}].path`);
      } catch (error) {
        if (error instanceof EvalContractValidationError) issues.push(...error.issues);
        else throw error;
      }
    }
  }
  assertUnique(
    run.infrastructureInvalidPairs.map((entry) => entry.comparisonId),
    `${run.runId}.infrastructure-invalid comparison IDs`,
    issues,
  );
  requireCondition(
    (run.outcome === "infrastructure_invalid") ===
      (run.infrastructureInvalidPairs.length > 0),
    `${run.runId}: infrastructure-invalid outcome and paired incidents must agree`,
    issues,
  );
  const verifierPassed = run.outcome === "pass" &&
    run.verifier.result === "passed" &&
    run.verifier.assertionCount > 0 &&
    run.verifier.passedAssertions === run.verifier.assertionCount;
  requireCondition(
    run.verifiedFix === verifierPassed,
    `${run.runId}: verifiedFix must be derived from the complete hidden verifier result`,
    issues,
  );
  if (run.trustAssessment.status === "assessed") {
    const trust = run.trustAssessment.criteria;
    const expectedStatuses = {
      hiddenVerifier:
        trust.hiddenVerifier.inaccessibleDuringRun &&
        trust.hiddenVerifier.deterministicAssertionsPassed &&
        run.verifiedFix,
      policyAndBudget:
        trust.policyAndBudget.permissionEscapes === 0 &&
        trust.policyAndBudget.sandboxEscapes === 0 &&
        trust.policyAndBudget.concurrencyEscapes === 0 &&
        trust.policyAndBudget.budgetOverruns === 0 &&
        trust.policyAndBudget.unresolvedUsageFullyReserved,
      effectSafety:
        trust.effectSafety.duplicatedUncertainMutations === 0 &&
        trust.effectSafety.unsafeAutomaticRetries === 0 &&
        trust.effectSafety.unresolvedUnknownOutcomes === 0,
      recoveryIntegrity:
        trust.recoveryIntegrity.successfulRecoveries === trust.recoveryIntegrity.scheduledFaults &&
        trust.recoveryIntegrity.eventGaps === 0 &&
        trust.recoveryIntegrity.hiddenEventLoss === 0,
      evidenceBundle:
        trust.evidenceBundle.schemaValid &&
        trust.evidenceBundle.hashesValid &&
        trust.evidenceBundle.unresolvedReviewBlockers === 0 &&
        trust.evidenceBundle.missingRequiredArtifacts === 0,
      interventionFree: trust.interventionFree.undeclaredInterventions === 0,
    } as const;
    for (const [name, expectedPassed] of Object.entries(expectedStatuses)) {
      const assessment = trust[name as keyof typeof trust];
      requireCondition(
        assessment.status === (expectedPassed ? "passed" : "failed"),
        `${run.runId}: ${name} status is not derived from its counters`,
        issues,
      );
    }
    const criteria = Object.values(trust);
    const derivedTrustedFix = criteria.every((criterion) => criterion.status === "passed");
    requireCondition(
      run.trustAssessment.trustedFix === derivedTrustedFix,
      `${run.runId}: trustedFix must be the conjunction of all six trust criteria`,
      issues,
    );
    requireCondition(
      trust.interventionFree.status ===
        (run.interventions.every((entry) => entry.declaredByTask) &&
        run.approvals.every((entry) => entry.declaredByTask)
          ? "passed"
          : "failed"),
      `${run.runId}: intervention-free criterion disagrees with recorded interventions`,
      issues,
    );
    const undeclaredInterventions =
      run.interventions.filter((entry) => !entry.declaredByTask).length +
      run.approvals.filter((entry) => !entry.declaredByTask).length;
    requireCondition(
      trust.interventionFree.undeclaredInterventions === undeclaredInterventions,
      `${run.runId}: undeclared intervention count disagrees with the run record`,
      issues,
    );
    for (const [criterion, assessment] of Object.entries(run.trustAssessment.criteria)) {
      requireCondition(
        assessment.evidenceDigests.length > 0,
        `${run.runId}: ${criterion} trust criterion requires evidence`,
        issues,
      );
    }
    if (trust.evidenceBundle.status === "passed") {
      const roles = new Set(run.artifacts.map((artifact) => artifact.role));
      for (const role of [
        "patch",
        "changed_files",
        "test_result",
        "independent_review",
        "cost_usage",
        "approval_log",
        "effect_log",
        "risk_register",
      ] as const) {
        requireCondition(roles.has(role), `${run.runId}: evidence bundle is missing ${role}`, issues);
      }
    }
    requireCondition(
      !(run.outcome === "unknown_outcome" && run.trustAssessment.trustedFix),
      `${run.runId}: unknown outcome cannot be a trusted fix`,
      issues,
    );
  } else {
    requireCondition(
      run.trustAssessment.missingCriteria.length > 0,
      `${run.runId}: unassessed trust requires explicit missing criteria`,
      issues,
    );
  }
  if (run.outcome === "pass") {
    requireCondition(run.verifier.result === "passed", `${run.runId}: pass requires verifier success`, issues);
  }
}

export function computeEvidenceEventDigest(event: EvidenceEventDocument): Sha256Digest {
  const copy: Record<string, unknown> = { ...event };
  delete copy.eventDigest;
  return digestCanonicalJson("agenc.eval.evidence-event.v1", copy);
}

function assertEvidenceEvent(event: EvidenceEventDocument, issues: string[]): void {
  assertTimestamp(event.occurredAt, `${event.runId}.event[${event.sequence}].occurredAt`, issues);
  requireCondition(
    event.payload.uri === `cas://sha256/${event.payload.digest.slice("sha256:".length)}`,
    `${event.runId}.event[${event.sequence}]: payload URI/digest mismatch`,
    issues,
  );
  requireCondition(
    (event.sequence === 0) === (event.previousEventDigest === null),
    `${event.runId}.event[${event.sequence}]: genesis/previous digest mismatch`,
    issues,
  );
  requireCondition(
    event.eventDigest === computeEvidenceEventDigest(event),
    `${event.runId}.event[${event.sequence}]: event digest mismatch`,
    issues,
  );
}

export function computeEvidenceSealStatementDigest(
  statement: EvidenceLedgerSealDocument["statement"],
): Sha256Digest {
  return digestCanonicalJson("agenc.eval.evidence-seal-statement.v1", statement);
}

function assertEvidenceSeal(
  seal: EvidenceLedgerSealDocument,
  issues: string[],
): void {
  const { statement, receipt } = seal;
  assertTimestamp(statement.sealedAt, `${statement.runId}.seal.sealedAt`, issues);
  requireCondition(
    statement.ledgerByteLength > 0,
    `${statement.runId}: a sealed evidence ledger must not be empty`,
    issues,
  );
  requireCondition(
    statement.eventCount > 0,
    `${statement.runId}: a sealed evidence ledger must contain events`,
    issues,
  );
  requireCondition(
    receipt.statementDigest === computeEvidenceSealStatementDigest(statement),
    `${statement.runId}: anchor receipt does not cover the exact seal statement`,
    issues,
  );
  assertCanonicalHttpsUrl(receipt.anchorUri, `${statement.runId}: evidence anchor`, issues);
}

function assertDerivedSummary(summary: DerivedSummaryDocument, issues: string[]): void {
  assertTimestamp(summary.generatedAt, "summary.generatedAt", issues);
  assertUnique(summary.evidenceSeals.map((seal) => seal.runId), "summary evidence run IDs", issues);
  assertUnique(summary.systems.map((system) => system.systemId), "summary system IDs", issues);
  assertUnique(summary.pairedEffects.map((effect) => effect.comparisonId), "summary comparison IDs", issues);
  for (const system of summary.systems) {
    assertUnique(system.taskScores.map((task) => task.taskId), `${system.systemId}.taskScores`, issues);
    requireCondition(
      system.taskScores.length === system.taskCount,
      `${system.systemId}: task count does not match taskScores`,
      issues,
    );
    requireCondition(
      system.taskScores.reduce((sum, task) => sum + task.repetitions, 0) ===
        system.includedTrialCount,
      `${system.systemId}: included trial count does not match task repetitions`,
      issues,
    );
    const verifiedFixMean =
      system.taskScores.reduce((sum, task) => sum + task.verifiedFixRate, 0) /
      system.taskScores.length;
    requireCondition(
      Math.abs(verifiedFixMean - system.verifiedFixRate) < 1e-12,
      `${system.systemId}: verified fix rate is not the equal task mean`,
      issues,
    );
    const assessedTaskScores = system.taskScores.filter(
      (task): task is typeof task & { readonly trustedFixRate: number } =>
        task.trustedFixRate !== null,
    );
    if (assessedTaskScores.length === system.taskScores.length) {
      const trustedFixMean = assessedTaskScores.reduce(
        (sum, task) => sum + task.trustedFixRate,
        0,
      ) / assessedTaskScores.length;
      requireCondition(
        system.trustedFixRate !== null &&
          Math.abs(trustedFixMean - system.trustedFixRate) < 1e-12,
        `${system.systemId}: trusted fix rate is not the equal assessed-task mean`,
        issues,
      );
    } else {
      requireCondition(
        system.trustedFixRate === null,
        `${system.systemId}: TFR must be null while any task is unassessed`,
        issues,
      );
    }
  }
  for (const effect of summary.pairedEffects) {
    requireCondition(
      effect.confidenceLower <= effect.pointEstimate &&
        effect.pointEstimate <= effect.confidenceUpper,
      `${effect.comparatorSystemId}: paired effect is outside its interval`,
      issues,
    );
    requireCondition(
      summary.claim === "superiority"
        ? effect.superiorityCriterionMet ===
            (effect.pointEstimate >= 0.1 && effect.confidenceLower > 0)
        : effect.superiorityCriterionMet === null,
      `${effect.comparisonId}: superiority decision is not qualified by the experiment claim`,
      issues,
    );
  }
  const intersectionQualified =
    summary.pairedEffects.length > 0 &&
    summary.pairedEffects.every((effect) => effect.superiorityCriterionMet === true);
  requireCondition(
    summary.claim === "superiority"
      ? summary.superiorityEstablished === intersectionQualified
      : summary.superiorityEstablished === null,
    "summary superiority decision must be the intersection of every comparator",
    issues,
  );
}

function assertDocumentDigest(document: { readonly documentDigest: Sha256Digest }, issues: string[]): void {
  requireCondition(
    document.documentDigest === computeDocumentDigest(document),
    "documentDigest does not match canonical contract bytes",
    issues,
  );
}

/**
 * Validates one document's schema, digest, and local invariants. Cross-document
 * claims require validateEvaluationBundle; a derived summary claim additionally
 * requires validateDerivedSummaryAgainstBundle.
 */
export function validateEvalContractDocument(value: unknown): EvalContractDocument {
  const schema = schemaValidator();
  if (!schema(value)) throw new EvalContractValidationError(renderSchemaErrors(schema.errors));
  const document = value as EvalContractDocument;
  const issues: string[] = [];
  assertSafeJsonNumbers(value, issues);
  assertTimestampFields(value, issues);
  if (!CONTRACT_KINDS.has(document.kind)) issues.push(`unknown contract kind ${document.kind}`);
  requireCondition(
    document.contractVersion === EVAL_CONTRACT_VERSION,
    `unsupported contract version ${String(document.contractVersion)}`,
    issues,
  );
  if (
    document.kind !== "agenc.eval.evidence-event" &&
    document.kind !== "agenc.eval.evidence-seal"
  ) {
    assertDocumentDigest(document, issues);
  }
  switch (document.kind) {
    case "agenc.eval.operator-task":
      assertTask(document, issues);
      break;
    case "agenc.eval.agent-task":
      assertAgentTask(document, issues);
      break;
    case "agenc.eval.suite-manifest":
      assertSuite(document, issues);
      break;
    case "agenc.eval.holdout-descriptor":
      assertHoldoutDescriptor(document, issues);
      break;
    case "agenc.eval.holdout-access-receipt":
      assertHoldoutAccessReceipt(document, issues);
      break;
    case "agenc.eval.preregistration":
      assertPreregistration(document, issues);
      break;
    case "agenc.eval.preregistration-receipt":
      assertPreregistrationReceipt(document, issues);
      break;
    case "agenc.eval.blinded-results-seal":
      assertBlindedResultsSeal(document, issues);
      break;
    case "agenc.eval.unblinding-record":
      assertUnblindingRecord(document, issues);
      break;
    case "agenc.eval.run-record":
      assertRunRecord(document, issues);
      break;
    case "agenc.eval.evidence-event":
      assertEvidenceEvent(document, issues);
      break;
    case "agenc.eval.evidence-seal":
      assertEvidenceSeal(document, issues);
      break;
    case "agenc.eval.derived-summary":
      assertDerivedSummary(document, issues);
      break;
  }
  if (issues.length > 0) throw new EvalContractValidationError(issues);
  return document;
}

export function projectTaskForAgent(task: OperatorTaskDocument): AgentTaskDocument {
  validateEvalContractDocument(task);
  const projected = withDocumentDigest<AgentTaskDocument>({
    kind: "agenc.eval.agent-task",
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    repository: task.repository,
    setupPatch: task.setupPatch,
    issue: task.issue,
    allowedTools: task.allowedTools,
    networkPolicy: task.networkPolicy,
    permissionPolicy: task.permissionPolicy,
    budget: task.budget,
    expectedArtifacts: task.expectedArtifacts,
    environment: task.environment,
    verifierCommitment: task.hiddenVerifier.publicCommitment,
  });
  return validateEvalContractDocument(projected) as AgentTaskDocument;
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface PrivateRootIsolationOptions {
  readonly privateRoot: string;
  readonly repositoryRoot: string;
  readonly agentRoots: readonly string[];
  readonly holdoutDescriptor: HoldoutDescriptorDocument;
  readonly custodyAttestation: {
    readonly mode: "separate_os_principal_or_remote_service";
    readonly holdoutDescriptorDigest: Sha256Digest;
    readonly accessPolicyDigest: Sha256Digest;
    readonly custodianIdentity: string;
    readonly implementerPrincipalSetDigest: Sha256Digest;
    readonly accessControlEvidenceDigest: Sha256Digest;
    readonly verifierDigest: Sha256Digest;
    readonly canonicalRootDigest: Sha256Digest;
    readonly rootDevice: string;
    readonly rootInode: string;
  };
  readonly custodyVerifier: {
    readonly verifierDigest: Sha256Digest;
    verify(
      attestation: PrivateRootIsolationOptions["custodyAttestation"],
    ): boolean | Promise<boolean>;
  };
}

export async function assertPrivateRootIsolation(
  options: PrivateRootIsolationOptions,
): Promise<string> {
  validateEvalContractDocument(options.holdoutDescriptor);
  if (options.holdoutDescriptor.status !== "sealed") {
    throw new EvalContractValidationError(["private holdout descriptor is not sealed"]);
  }
  await assertLocalPrivateDirectory(options.privateRoot, {
    label: "private holdout root",
  });
  const [privateRoot, repositoryRoot, ...agentRoots] = await Promise.all([
    realpath(options.privateRoot),
    realpath(options.repositoryRoot),
    ...options.agentRoots.map((root) => realpath(root)),
  ]);
  const privateStats = await stat(privateRoot, { bigint: true });
  if (!privateStats.isDirectory()) {
    throw new EvalContractValidationError(["private holdout root must be a directory"]);
  }
  const leaf = await lstat(options.privateRoot, { bigint: true });
  if (leaf.isSymbolicLink()) {
    throw new EvalContractValidationError(["private holdout root must not be a symlink"]);
  }
  for (const [label, root] of [
    ["repository", repositoryRoot],
    ...agentRoots.map((root, index) => [`agent root ${index}`, root] as const),
  ] as const) {
    if (isInsideOrEqual(privateRoot, root) || isInsideOrEqual(root, privateRoot)) {
      throw new EvalContractValidationError([
        `private holdout root must be disjoint from ${label}`,
      ]);
    }
  }
  if (process.platform === "win32") {
    // The required external custody verifier covers protected DACLs, reparse
    // points, and the distinct-principal boundary on Windows.
  } else {
    if (typeof process.getuid === "function" && privateStats.uid !== BigInt(process.getuid())) {
      throw new EvalContractValidationError(["private holdout root is not owned by this user"]);
    }
    if ((privateStats.mode & 0o077n) !== 0n) {
      throw new EvalContractValidationError(["private holdout root must have mode 0700"]);
    }
  }
  const expectedAttestation: PrivateRootIsolationOptions["custodyAttestation"] = {
    mode: options.holdoutDescriptor.custody.mode,
    holdoutDescriptorDigest: options.holdoutDescriptor.documentDigest,
    accessPolicyDigest: options.holdoutDescriptor.accessPolicyDigest,
    custodianIdentity: options.holdoutDescriptor.custody.custodianIdentity,
    implementerPrincipalSetDigest:
      options.holdoutDescriptor.custody.implementerPrincipalSetDigest,
    accessControlEvidenceDigest:
      options.holdoutDescriptor.custody.accessControlEvidenceDigest,
    verifierDigest: options.holdoutDescriptor.custody.custodyVerifierDigest,
    canonicalRootDigest: digestDomainSeparated("agenc.eval.holdout-root.v1", privateRoot),
    rootDevice: privateStats.dev.toString(),
    rootInode: privateStats.ino.toString(),
  };
  if (
    canonicalizeJson(options.custodyAttestation) !== canonicalizeJson(expectedAttestation) ||
    options.custodyVerifier.verifierDigest !== expectedAttestation.verifierDigest
  ) {
    throw new EvalContractValidationError([
      "private holdout custody attestation is not bound to this descriptor/root/verifier",
    ]);
  }
  if (!(await options.custodyVerifier.verify(options.custodyAttestation))) {
    throw new EvalContractValidationError([
      "private holdout custody attestation did not verify under the pinned verifier",
    ]);
  }
  const [recheckedRoot, recheckedStats] = await Promise.all([
    realpath(options.privateRoot),
    stat(privateRoot, { bigint: true }),
  ]);
  if (
    recheckedRoot !== privateRoot ||
    recheckedStats.dev !== privateStats.dev ||
    recheckedStats.ino !== privateStats.ino
  ) {
    throw new EvalContractValidationError([
      "private holdout root changed during custody verification",
    ]);
  }
  return privateRoot;
}

const LEGACY_MISSING_PINS = [
  "per-task full repository commit",
  "setup patch digest",
  "hidden verifier commitment",
  "hard USD and permission budgets",
  "immutable model and full generation parameters",
  "evaluator image/toolchain",
  "trial reset receipt",
  "preregistered statistics and exclusions",
  "private holdout access boundary",
  "append-only anchored raw evidence",
] as const;

export function classifyLegacyEvalReport(value: unknown): LegacyReportQualification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvalContractValidationError(["legacy report must be an object"]);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !record.run || !Array.isArray(record.tasks)) {
    throw new EvalContractValidationError(["not an agent-eval report schemaVersion 1"]);
  }
  return {
    schemaVersion: 1,
    qualifying: false,
    classification: "legacy_non_confirmatory",
    sourceDigest: digestCanonicalJson("agenc.eval.legacy-report.v1", value),
    missingPins: LEGACY_MISSING_PINS,
  };
}

export function digestIssueText(text: string): Sha256Digest {
  return digestDomainSeparated("agenc.eval.issue.v1", text);
}

export function digestRawArtifact(bytes: string | Uint8Array): Sha256Digest {
  return sha256Digest(bytes);
}
