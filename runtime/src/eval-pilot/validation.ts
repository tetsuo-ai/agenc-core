import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import pilotCurationSchema from "./pilot-curation-v1.schema.json" with { type: "json" };
import {
  canonicalizeJson,
  computeDocumentDigest,
  digestCanonicalJson,
  digestDomainSeparated,
  projectTaskForAgent,
  validateEvalContractDocument,
  type ContentArtifact,
  type OperatorTaskDocument,
  type Sha256Digest,
  type SuiteManifestDocument,
} from "../eval-contract/index.js";
import {
  EVALUATION_PILOT_CATEGORIES,
  EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES,
  EVALUATION_PILOT_MAXIMUM_TASKS_PER_REPOSITORY,
  EVALUATION_PILOT_MAXIMUM_TOTAL_ARTIFACT_BYTES,
  EVALUATION_PILOT_MINIMUM_REPOSITORIES,
  EVALUATION_PILOT_STRESSORS,
  EVALUATION_PILOT_STRESSOR_MECHANISMS,
  EVALUATION_PILOT_TASK_COUNT,
  type EvaluationPilotCurationDocument,
  type EvaluationPilotIndependentSolveEvidence,
  type EvaluationPilotLicenseEvidence,
  type EvaluationPilotNegativePatchEvidence,
  type EvaluationPilotSourceRowEvidence,
  type EvaluationPilotStressor,
  type EvaluationPilotStressorEvidence,
  type EvaluationPilotTaskCuration,
  type EvaluationPilotTaskEvidence,
  type EvaluationPilotUpstreamPreflightEvidence,
  type ValidatedEvaluationPilotCatalog,
} from "./types.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

let compiledSchema: ValidateFunction | undefined;

export class EvaluationPilotValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`evaluation pilot validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EvaluationPilotValidationError";
    this.issues = issues;
  }
}

export interface EvaluationPilotRequiredArtifact {
  readonly role:
    | "dataset_license"
    | "selection_implementation"
    | "source_row"
    | "upstream_triple_preflight"
    | "independent_solve_review"
    | "negative_patch_review"
    | "stressor_evidence"
    | "operator_setup_patch"
    | "operator_hidden_verifier_bundle"
    | "operator_reference_solution_patch"
    | "operator_reference_validation_evidence";
  readonly taskId: string | null;
  readonly artifact: ContentArtifact;
}

export interface EvaluationPilotEvidenceDocuments {
  readonly licenseEvidence: unknown;
  readonly taskEvidence: ReadonlyMap<
    string,
    {
      readonly sourceRow: unknown;
      readonly upstreamTriplePreflight: unknown;
      readonly independentSolveReview: unknown;
      readonly negativePatchReview: unknown;
      readonly stressorEvidence: unknown;
    }
  >;
}

function schemaValidator(): ValidateFunction {
  if (compiledSchema) return compiledSchema;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
  compiledSchema = ajv.compile(pilotCurationSchema);
  return compiledSchema;
}

function renderSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["document does not match development pilot curation protocol v1"];
  const issues = new Set<string>();
  for (const error of errors) {
    const location = error.instancePath || "/";
    const detail = error.params && "additionalProperty" in error.params
      ? `unknown property ${String(error.params.additionalProperty)}`
      : error.message ?? error.keyword;
    issues.add(`${location}: ${detail}`);
  }
  return [...issues].slice(0, 128);
}

function requireCondition(condition: unknown, issue: string, issues: string[]): void {
  if (!condition) issues.push(issue);
}

function assertExactSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
  issues: string[],
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  requireCondition(
    actual.length === actualSet.size &&
      actualSet.size === expectedSet.size &&
      [...expectedSet].every((value) => actualSet.has(value)),
    `${label} must contain exactly ${expected.join(", ")}`,
    issues,
  );
}

function assertTimestamp(value: string, label: string, issues: string[]): void {
  const match = TIMESTAMP_PATTERN.exec(value);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed)) {
    issues.push(`${label} is not a real UTC timestamp`);
    return;
  }
  const date = new Date(parsed);
  const fields = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  const supplied = match.slice(1, 7).map(Number);
  requireCondition(
    fields.every((field, index) => field === supplied[index]),
    `${label} is not a real UTC timestamp`,
    issues,
  );
}

function artifactUri(artifact: ContentArtifact): string {
  return `cas://sha256/${artifact.digest.slice("sha256:".length)}`;
}

function assertArtifact(artifact: ContentArtifact, label: string, issues: string[]): void {
  requireCondition(
    DIGEST_PATTERN.test(artifact.digest) && artifact.uri === artifactUri(artifact),
    `${label} must use the canonical CAS URI for its SHA-256 digest`,
    issues,
  );
  requireCondition(
    Number.isSafeInteger(artifact.sizeBytes) &&
      artifact.sizeBytes > 0 &&
      artifact.sizeBytes <= EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES,
    `${label}.sizeBytes is outside the pilot artifact limit`,
    issues,
  );
}

export function getEvaluationPilotRequiredArtifacts(
  document: EvaluationPilotCurationDocument,
  suite: SuiteManifestDocument,
): readonly EvaluationPilotRequiredArtifact[] {
  const artifacts: EvaluationPilotRequiredArtifact[] = [
    {
      role: "dataset_license",
      taskId: null,
      artifact: document.sourceDataset.license.evidence,
    },
    {
      role: "selection_implementation",
      taskId: null,
      artifact: document.sourceDataset.selection.implementation,
    },
  ];
  for (const task of document.tasks) {
    artifacts.push(
      { role: "source_row", taskId: task.taskId, artifact: task.source.row },
      {
        role: "upstream_triple_preflight",
        taskId: task.taskId,
        artifact: task.qa.upstreamTriplePreflight,
      },
      {
        role: "independent_solve_review",
        taskId: task.taskId,
        artifact: task.qa.independentSolveReview,
      },
      {
        role: "negative_patch_review",
        taskId: task.taskId,
        artifact: task.qa.negativePatchReview,
      },
      {
        role: "stressor_evidence",
        taskId: task.taskId,
        artifact: task.qa.stressorEvidence,
      },
    );
  }
  for (const task of suite.tasks) {
    artifacts.push(
      {
        role: "operator_setup_patch",
        taskId: task.taskId,
        artifact: task.setupPatch,
      },
      {
        role: "operator_hidden_verifier_bundle",
        taskId: task.taskId,
        artifact: task.hiddenVerifier.bundle,
      },
      {
        role: "operator_reference_solution_patch",
        taskId: task.taskId,
        artifact: task.referenceSolution.patch,
      },
      {
        role: "operator_reference_validation_evidence",
        taskId: task.taskId,
        artifact: task.referenceSolution.validationEvidence,
      },
    );
  }
  return artifacts;
}

export function computeEvaluationPilotArtifactSetDigest(
  document: EvaluationPilotCurationDocument,
  suite: SuiteManifestDocument,
): Sha256Digest {
  const inventory = getEvaluationPilotRequiredArtifacts(document, suite)
    .map(({ role, taskId, artifact }) => ({ role, taskId, artifact }))
    .sort((left, right) => {
      const leftKey = `${left.role}\u0000${left.taskId ?? ""}\u0000${left.artifact.digest}`;
      const rightKey = `${right.role}\u0000${right.taskId ?? ""}\u0000${right.artifact.digest}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return digestCanonicalJson("agenc.eval.pilot-required-artifacts.v1", inventory);
}

export function computeEvaluationPilotSelectedRowsDigest(
  tasks: readonly EvaluationPilotTaskCuration[],
): Sha256Digest {
  return digestCanonicalJson(
    "agenc.eval.pilot-selected-rows.v1",
    tasks.map((task) => ({
      taskId: task.taskId,
      rowId: task.source.rowId,
      rowDigest: task.source.rowDigest,
      category: task.category,
      stressors: task.stressors,
      selectionKeyDigest: task.selectionKeyDigest,
    })),
  );
}

function assertPilotTaskSet(
  document: EvaluationPilotCurationDocument,
  suite: SuiteManifestDocument,
  issues: string[],
): Map<string, OperatorTaskDocument> {
  const operatorTasks = new Map(suite.tasks.map((task) => [task.taskId, task]));
  requireCondition(
    document.tasks.length === EVALUATION_PILOT_TASK_COUNT &&
      suite.tasks.length === EVALUATION_PILOT_TASK_COUNT,
    `pilot and bound suite must contain exactly ${EVALUATION_PILOT_TASK_COUNT} tasks`,
    issues,
  );
  requireCondition(
    new Set(document.tasks.map((task) => task.taskId)).size === document.tasks.length,
    "pilot task IDs must be unique",
    issues,
  );
  requireCondition(
    new Set(document.tasks.map((task) => task.source.rowId)).size === document.tasks.length,
    "pilot source row IDs must be unique",
    issues,
  );
  requireCondition(
    new Set(document.tasks.map((task) => task.source.rowDigest)).size === document.tasks.length,
    "pilot source row digests must be unique",
    issues,
  );
  requireCondition(
    new Set(document.tasks.map((task) => task.selectionKeyDigest)).size === document.tasks.length,
    "pilot selection key digests must be unique",
    issues,
  );
  const orderedKeys = document.tasks.map((task) => task.selectionKeyDigest);
  requireCondition(
    orderedKeys.every((key, index) => index === 0 || orderedKeys[index - 1] < key),
    "pilot tasks must be ordered by ascending selectionKeyDigest",
    issues,
  );

  const familyCounts = new Map<string, number>();
  for (const curated of document.tasks) {
    const task = operatorTasks.get(curated.taskId);
    requireCondition(task !== undefined, `${curated.taskId}: missing from bound suite`, issues);
    if (!task) continue;
    requireCondition(
      curated.operatorTaskDigest === task.documentDigest,
      `${curated.taskId}: operator task digest does not match bound suite`,
      issues,
    );
    requireCondition(
      curated.repositoryFamily === task.repository.cluster,
      `${curated.taskId}: repository family does not match bound suite`,
      issues,
    );
    requireCondition(
      task.split === "development" &&
        task.provenance.sourceType === "public_issue" &&
        task.provenance.status === "eligible" &&
        task.provenance.repositoryWasPublic &&
        task.provenance.issueWasPublic,
      `${curated.taskId}: pilot tasks must be eligible public issues in the development split`,
      issues,
    );
    requireCondition(
      curated.source.rowDigest === curated.source.row.digest,
      `${curated.taskId}: source row digest must equal its artifact digest`,
      issues,
    );
    familyCounts.set(
      curated.repositoryFamily,
      (familyCounts.get(curated.repositoryFamily) ?? 0) + 1,
    );
  }
  requireCondition(
    document.tasks.every((task) => operatorTasks.has(task.taskId)) &&
      suite.tasks.every((task) => document.tasks.some((entry) => entry.taskId === task.taskId)),
    "pilot task set must exactly equal the bound suite task set",
    issues,
  );
  requireCondition(
    familyCounts.size >= EVALUATION_PILOT_MINIMUM_REPOSITORIES,
    `pilot must contain at least ${EVALUATION_PILOT_MINIMUM_REPOSITORIES} repository families`,
    issues,
  );
  requireCondition(
    [...familyCounts.values()].every(
      (count) => count <= EVALUATION_PILOT_MAXIMUM_TASKS_PER_REPOSITORY,
    ),
    `pilot may contain at most ${EVALUATION_PILOT_MAXIMUM_TASKS_PER_REPOSITORY} tasks per repository family`,
    issues,
  );
  assertExactSet(
    [...new Set(document.tasks.map((task) => task.category))],
    EVALUATION_PILOT_CATEGORIES,
    "task category coverage",
    issues,
  );
  assertExactSet(
    [...new Set(document.tasks.flatMap((task) => task.stressors))],
    EVALUATION_PILOT_STRESSORS,
    "task stressor coverage",
    issues,
  );
  return operatorTasks;
}

export function validateEvaluationPilotCurationDocument(
  value: unknown,
  suiteValue: unknown,
): EvaluationPilotCurationDocument {
  const schema = schemaValidator();
  if (!schema(value)) throw new EvaluationPilotValidationError(renderSchemaErrors(schema.errors));

  let suite: SuiteManifestDocument;
  try {
    const validated = validateEvalContractDocument(suiteValue);
    if (validated.kind !== "agenc.eval.suite-manifest") {
      throw new EvaluationPilotValidationError(["bound document is not a suite manifest"]);
    }
    suite = validated;
  } catch (error) {
    if (error instanceof EvaluationPilotValidationError) throw error;
    throw new EvaluationPilotValidationError([
      `bound suite manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const document = value as EvaluationPilotCurationDocument;
  const issues: string[] = [];
  try {
    canonicalizeJson(value);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  assertTimestamp(document.createdAt, "createdAt", issues);
  requireCondition(
    document.documentDigest === computeDocumentDigest(document),
    "documentDigest does not match canonical pilot curation bytes",
    issues,
  );
  requireCondition(
    suite.split === "development" &&
      document.suite.suiteId === suite.suiteId &&
      document.suite.suiteVersion === suite.suiteVersion &&
      document.suite.manifestDigest === suite.documentDigest &&
      document.suite.taskCount === suite.tasks.length,
    "suite binding does not match the supplied development suite manifest",
    issues,
  );
  requireCondition(
    document.sourceDataset.revisionDigest === digestDomainSeparated(
      "agenc.eval.pilot-dataset-revision.v1",
      document.sourceDataset.revision,
    ),
    "source dataset revisionDigest does not match its exact revision",
    issues,
  );
  assertExactSet(
    document.coverage.categories,
    EVALUATION_PILOT_CATEGORIES,
    "declared categories",
    issues,
  );
  assertExactSet(
    document.coverage.stressors,
    EVALUATION_PILOT_STRESSORS,
    "declared stressors",
    issues,
  );
  assertPilotTaskSet(document, suite, issues);

  const artifacts = getEvaluationPilotRequiredArtifacts(document, suite);
  for (const { role, taskId, artifact } of artifacts) {
    const label = `${taskId ?? "dataset"}.${role}`;
    if (role.startsWith("operator_")) {
      requireCondition(
        DIGEST_PATTERN.test(artifact.digest) && artifact.uri === artifactUri(artifact),
        `${label} must use the canonical CAS URI for its SHA-256 digest`,
        issues,
      );
      requireCondition(
        Number.isSafeInteger(artifact.sizeBytes) &&
          artifact.sizeBytes >= 0 &&
          artifact.sizeBytes <= EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES,
        `${label}.sizeBytes is outside the pilot artifact limit`,
        issues,
      );
    } else {
      assertArtifact(artifact, label, issues);
    }
  }
  const curationArtifacts = artifacts.filter(({ role }) => !role.startsWith("operator_"));
  requireCondition(
    new Set(curationArtifacts.map(({ artifact }) => artifact.digest)).size ===
      curationArtifacts.length,
    "every required pilot artifact join must use a distinct content digest",
    issues,
  );
  const protectedOperatorArtifacts = artifacts.filter(
    ({ role }) => role !== "operator_setup_patch" && role.startsWith("operator_"),
  );
  requireCondition(
    new Set(protectedOperatorArtifacts.map(({ artifact }) => artifact.digest)).size ===
      protectedOperatorArtifacts.length,
    "hidden verifier and reference-solution artifact digests must be unique per task",
    issues,
  );
  const sizeByDigest = new Map<string, number>();
  for (const { artifact } of artifacts) {
    const priorSize = sizeByDigest.get(artifact.digest);
    requireCondition(
      priorSize === undefined || priorSize === artifact.sizeBytes,
      `${artifact.digest}: repeated CAS content digest has inconsistent sizes`,
      issues,
    );
    sizeByDigest.set(artifact.digest, artifact.sizeBytes);
  }
  const totalArtifactBytes = [...sizeByDigest.values()].reduce((total, size) => total + size, 0);
  requireCondition(
    Number.isSafeInteger(totalArtifactBytes) &&
      totalArtifactBytes <= EVALUATION_PILOT_MAXIMUM_TOTAL_ARTIFACT_BYTES,
    "required pilot artifacts exceed the total byte limit",
    issues,
  );
  requireCondition(
    document.cas.requiredArtifactSetDigest ===
      computeEvaluationPilotArtifactSetDigest(document, suite),
    "CAS requiredArtifactSetDigest does not match the declared artifact joins",
    issues,
  );
  requireCondition(
    document.sourceDataset.selection.selectedRowsDigest ===
      computeEvaluationPilotSelectedRowsDigest(document.tasks),
    "selection selectedRowsDigest does not match the ordered curated rows",
    issues,
  );
  if (issues.length > 0) throw new EvaluationPilotValidationError(issues);
  return document;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return undefined;
  }
  try {
    canonicalizeJson(value);
  } catch (error) {
    issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  requireCondition(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} must contain exactly ${expected.join(", ")}`,
    issues,
  );
  return record;
}

function expectDigest(value: unknown, label: string, issues: string[]): value is Sha256Digest {
  const valid = typeof value === "string" && DIGEST_PATTERN.test(value);
  requireCondition(valid, `${label} must be a lowercase SHA-256 digest`, issues);
  return valid;
}

function expectString(value: unknown, label: string, issues: string[]): value is string {
  const valid = typeof value === "string" && value.length > 0;
  requireCondition(valid, `${label} must be a non-empty string`, issues);
  return valid;
}

function validateLicenseEvidence(
  value: unknown,
  document: EvaluationPilotCurationDocument,
  issues: string[],
): EvaluationPilotLicenseEvidence | undefined {
  const record = exactObject(value, [
    "kind",
    "evidenceVersion",
    "datasetId",
    "datasetRevisionDigest",
    "spdxIdentifier",
    "reviewStatus",
  ], "license evidence", issues);
  if (!record) return undefined;
  requireCondition(record.kind === "agenc.eval.pilot-license-evidence", "license evidence kind is invalid", issues);
  requireCondition(record.evidenceVersion === "1.0.0", "license evidence version is invalid", issues);
  requireCondition(record.datasetId === document.sourceDataset.datasetId, "license evidence datasetId mismatch", issues);
  requireCondition(
    record.datasetRevisionDigest === document.sourceDataset.revisionDigest,
    "license evidence revision mismatch",
    issues,
  );
  requireCondition(
    record.spdxIdentifier === document.sourceDataset.license.spdxIdentifier,
    "license evidence SPDX identifier mismatch",
    issues,
  );
  requireCondition(record.reviewStatus === "confirmed", "license evidence review must be complete", issues);
  return record as unknown as EvaluationPilotLicenseEvidence;
}

function validateSourceRow(
  value: unknown,
  document: EvaluationPilotCurationDocument,
  curated: EvaluationPilotTaskCuration,
  task: OperatorTaskDocument,
  issues: string[],
): EvaluationPilotSourceRowEvidence | undefined {
  const label = `${curated.taskId}.source row evidence`;
  const record = exactObject(value, [
    "kind",
    "evidenceVersion",
    "datasetId",
    "datasetRevisionDigest",
    "rowId",
    "taskId",
    "operatorTaskDigest",
    "repositoryUri",
    "repositoryCommit",
    "issueDigest",
    "licenseSpdxIdentifier",
  ], label, issues);
  if (!record) return undefined;
  requireCondition(record.kind === "agenc.eval.pilot-source-row", `${label} kind is invalid`, issues);
  requireCondition(record.evidenceVersion === "1.0.0", `${label} version is invalid`, issues);
  requireCondition(record.datasetId === document.sourceDataset.datasetId, `${label} dataset mismatch`, issues);
  requireCondition(record.datasetRevisionDigest === document.sourceDataset.revisionDigest, `${label} revision mismatch`, issues);
  requireCondition(record.rowId === curated.source.rowId, `${label} rowId mismatch`, issues);
  requireCondition(record.taskId === task.taskId, `${label} taskId mismatch`, issues);
  requireCondition(record.operatorTaskDigest === task.documentDigest, `${label} task digest mismatch`, issues);
  requireCondition(record.repositoryUri === task.repository.uri, `${label} repository URI mismatch`, issues);
  requireCondition(record.repositoryCommit === task.repository.commit, `${label} repository commit mismatch`, issues);
  requireCondition(record.issueDigest === task.issue.digest, `${label} issue digest mismatch`, issues);
  requireCondition(
    record.licenseSpdxIdentifier === document.sourceDataset.license.spdxIdentifier,
    `${label} license mismatch`,
    issues,
  );
  return record as unknown as EvaluationPilotSourceRowEvidence;
}

function validatePreflight(
  value: unknown,
  curated: EvaluationPilotTaskCuration,
  task: OperatorTaskDocument,
  issues: string[],
): EvaluationPilotUpstreamPreflightEvidence | undefined {
  const label = `${curated.taskId}.upstream preflight evidence`;
  const record = exactObject(value, [
    "kind",
    "evidenceVersion",
    "taskId",
    "operatorTaskDigest",
    "status",
    "runs",
  ], label, issues);
  if (!record) return undefined;
  requireCondition(record.kind === "agenc.eval.pilot-upstream-triple-preflight", `${label} kind is invalid`, issues);
  requireCondition(record.evidenceVersion === "1.0.0", `${label} version is invalid`, issues);
  requireCondition(record.taskId === task.taskId, `${label} taskId mismatch`, issues);
  requireCondition(record.operatorTaskDigest === task.documentDigest, `${label} task digest mismatch`, issues);
  requireCondition(record.status === "complete", `${label} must be complete`, issues);
  if (!Array.isArray(record.runs) || record.runs.length !== 3) {
    issues.push(`${label} must contain exactly three runs`);
    return undefined;
  }
  for (let index = 0; index < record.runs.length; index += 1) {
    const run = exactObject(record.runs[index], [
      "runIndex",
      "coldRebuild",
      "baseFailsTargetChecks",
      "basePassesRegressionChecks",
      "referencePassesAllChecks",
      "environmentDigest",
      "evidenceDigest",
    ], `${label}.runs[${index}]`, issues);
    if (!run) continue;
    requireCondition(run.runIndex === index + 1, `${label} run indices must be exactly 1, 2, 3`, issues);
    requireCondition(run.coldRebuild === true, `${label}.runs[${index}] must use a cold rebuild`, issues);
    requireCondition(run.baseFailsTargetChecks === true, `${label}.runs[${index}] must prove the base fails target checks`, issues);
    requireCondition(run.basePassesRegressionChecks === true, `${label}.runs[${index}] must prove base regressions pass`, issues);
    requireCondition(run.referencePassesAllChecks === true, `${label}.runs[${index}] must prove the reference passes`, issues);
    expectDigest(run.environmentDigest, `${label}.runs[${index}].environmentDigest`, issues);
    expectDigest(run.evidenceDigest, `${label}.runs[${index}].evidenceDigest`, issues);
  }
  return record as unknown as EvaluationPilotUpstreamPreflightEvidence;
}

function validateIndependentSolve(
  value: unknown,
  curated: EvaluationPilotTaskCuration,
  task: OperatorTaskDocument,
  issues: string[],
): EvaluationPilotIndependentSolveEvidence | undefined {
  const label = `${curated.taskId}.independent solve evidence`;
  const record = exactObject(value, [
    "kind",
    "evidenceVersion",
    "taskId",
    "operatorTaskDigest",
    "status",
    "reviewerIdentityDigest",
    "reviewerIndependentOfTaskAuthor",
    "verifierInaccessibleDuringSolve",
    "startedFromPinnedBase",
    "solutionPatchDigest",
    "solutionAccepted",
    "reviewEvidenceDigest",
  ], label, issues);
  if (!record) return undefined;
  requireCondition(record.kind === "agenc.eval.pilot-independent-solve-review", `${label} kind is invalid`, issues);
  requireCondition(record.evidenceVersion === "1.0.0", `${label} version is invalid`, issues);
  requireCondition(record.taskId === task.taskId, `${label} taskId mismatch`, issues);
  requireCondition(record.operatorTaskDigest === task.documentDigest, `${label} task digest mismatch`, issues);
  requireCondition(record.status === "complete", `${label} must be complete`, issues);
  requireCondition(record.reviewerIndependentOfTaskAuthor === true, `${label} reviewer must be independent`, issues);
  requireCondition(record.verifierInaccessibleDuringSolve === true, `${label} solver must not access the verifier`, issues);
  requireCondition(record.startedFromPinnedBase === true, `${label} solve must start from the pinned base`, issues);
  requireCondition(record.solutionAccepted === true, `${label} independent solution must be accepted`, issues);
  expectDigest(record.reviewerIdentityDigest, `${label}.reviewerIdentityDigest`, issues);
  expectDigest(record.solutionPatchDigest, `${label}.solutionPatchDigest`, issues);
  expectDigest(record.reviewEvidenceDigest, `${label}.reviewEvidenceDigest`, issues);
  return record as unknown as EvaluationPilotIndependentSolveEvidence;
}

function validateNegativePatches(
  value: unknown,
  curated: EvaluationPilotTaskCuration,
  task: OperatorTaskDocument,
  issues: string[],
): EvaluationPilotNegativePatchEvidence | undefined {
  const label = `${curated.taskId}.negative patch evidence`;
  const record = exactObject(value, [
    "kind",
    "evidenceVersion",
    "taskId",
    "operatorTaskDigest",
    "status",
    "reviewerIdentityDigest",
    "reviewerIndependentOfTaskAuthor",
    "implementationIndependenceReviewed",
    "allNegativePatchesRejected",
    "negativePatches",
  ], label, issues);
  if (!record) return undefined;
  requireCondition(record.kind === "agenc.eval.pilot-negative-patch-review", `${label} kind is invalid`, issues);
  requireCondition(record.evidenceVersion === "1.0.0", `${label} version is invalid`, issues);
  requireCondition(record.taskId === task.taskId, `${label} taskId mismatch`, issues);
  requireCondition(record.operatorTaskDigest === task.documentDigest, `${label} task digest mismatch`, issues);
  requireCondition(record.status === "complete", `${label} must be complete`, issues);
  requireCondition(record.reviewerIndependentOfTaskAuthor === true, `${label} reviewer must be independent`, issues);
  requireCondition(record.implementationIndependenceReviewed === true, `${label} must review implementation independence`, issues);
  requireCondition(record.allNegativePatchesRejected === true, `${label} must reject every negative patch`, issues);
  expectDigest(record.reviewerIdentityDigest, `${label}.reviewerIdentityDigest`, issues);
  if (!Array.isArray(record.negativePatches) || record.negativePatches.length < 2) {
    issues.push(`${label} must contain at least two rejected negative patches`);
    return undefined;
  }
  const patchDigests: string[] = [];
  for (let index = 0; index < record.negativePatches.length; index += 1) {
    const patch = exactObject(record.negativePatches[index], [
      "patchDigest",
      "rejectionEvidenceDigest",
      "failureClass",
    ], `${label}.negativePatches[${index}]`, issues);
    if (!patch) continue;
    if (expectDigest(patch.patchDigest, `${label}.negativePatches[${index}].patchDigest`, issues)) {
      patchDigests.push(patch.patchDigest);
    }
    expectDigest(
      patch.rejectionEvidenceDigest,
      `${label}.negativePatches[${index}].rejectionEvidenceDigest`,
      issues,
    );
    requireCondition(
      ["incomplete_fix", "overfit_fix", "regression", "test_tampering"].includes(
        String(patch.failureClass),
      ),
      `${label}.negativePatches[${index}].failureClass is invalid`,
      issues,
    );
  }
  requireCondition(new Set(patchDigests).size === patchDigests.length, `${label} patch digests must be unique`, issues);
  return record as unknown as EvaluationPilotNegativePatchEvidence;
}

function validateStressorEvidence(
  value: unknown,
  curated: EvaluationPilotTaskCuration,
  task: OperatorTaskDocument,
  issues: string[],
): EvaluationPilotStressorEvidence | undefined {
  const label = `${curated.taskId}.stressor evidence`;
  const record = exactObject(value, [
    "kind",
    "evidenceVersion",
    "taskId",
    "operatorTaskDigest",
    "status",
    "declaredStressors",
    "mechanisms",
  ], label, issues);
  if (!record) return undefined;
  requireCondition(record.kind === "agenc.eval.pilot-stressor-evidence", `${label} kind is invalid`, issues);
  requireCondition(record.evidenceVersion === "1.0.0", `${label} version is invalid`, issues);
  requireCondition(record.taskId === task.taskId, `${label} taskId mismatch`, issues);
  requireCondition(record.operatorTaskDigest === task.documentDigest, `${label} task digest mismatch`, issues);
  requireCondition(record.status === "complete", `${label} must be complete`, issues);

  if (!Array.isArray(record.declaredStressors)) {
    issues.push(`${label}.declaredStressors must be an array`);
  } else {
    const declaredStressors = record.declaredStressors.filter(
      (stressor): stressor is EvaluationPilotStressor =>
        typeof stressor === "string" &&
        EVALUATION_PILOT_STRESSORS.includes(stressor as EvaluationPilotStressor),
    );
    requireCondition(
      declaredStressors.length === record.declaredStressors.length,
      `${label}.declaredStressors contains an invalid stressor`,
      issues,
    );
    assertExactSet(declaredStressors, curated.stressors, `${label}.declaredStressors`, issues);
  }

  if (!Array.isArray(record.mechanisms)) {
    issues.push(`${label}.mechanisms must be an array`);
    return undefined;
  }
  const mechanismStressors: string[] = [];
  for (let index = 0; index < record.mechanisms.length; index += 1) {
    const candidate = record.mechanisms[index];
    const candidateStressor = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>).stressor
      : undefined;
    const promptInjection = candidateStressor === "repository_prompt_injection";
    const mechanism = exactObject(candidate, [
      "stressor",
      "mechanism",
      "implementationDigest",
      "policyDigest",
      "evidenceDigest",
      "productSpecificSemantics",
      ...(promptInjection ? ["setupPatchDigest"] : []),
    ], `${label}.mechanisms[${index}]`, issues);
    if (!mechanism) continue;
    const stressor = mechanism.stressor;
    if (
      typeof stressor !== "string" ||
      !EVALUATION_PILOT_STRESSORS.includes(stressor as EvaluationPilotStressor)
    ) {
      issues.push(`${label}.mechanisms[${index}].stressor is invalid`);
      continue;
    }
    const typedStressor = stressor as EvaluationPilotStressor;
    mechanismStressors.push(typedStressor);
    requireCondition(
      mechanism.mechanism === EVALUATION_PILOT_STRESSOR_MECHANISMS[typedStressor],
      `${label}.mechanisms[${index}] must use the product-neutral ${typedStressor} mechanism`,
      issues,
    );
    requireCondition(
      mechanism.productSpecificSemantics === false,
      `${label}.mechanisms[${index}] must confirm productSpecificSemantics=false`,
      issues,
    );
    expectDigest(
      mechanism.implementationDigest,
      `${label}.mechanisms[${index}].implementationDigest`,
      issues,
    );
    expectDigest(mechanism.policyDigest, `${label}.mechanisms[${index}].policyDigest`, issues);
    expectDigest(mechanism.evidenceDigest, `${label}.mechanisms[${index}].evidenceDigest`, issues);
    if (typedStressor === "repository_prompt_injection") {
      requireCondition(
        mechanism.setupPatchDigest === task.setupPatch.digest,
        `${label}.mechanisms[${index}] setup patch digest mismatch`,
        issues,
      );
    }
  }
  assertExactSet(mechanismStressors, curated.stressors, `${label}.mechanism stressors`, issues);
  return record as unknown as EvaluationPilotStressorEvidence;
}

export function validateEvaluationPilotEvidenceDocuments(
  documentValue: unknown,
  suiteValue: unknown,
  evidence: EvaluationPilotEvidenceDocuments,
): ValidatedEvaluationPilotCatalog {
  const document = validateEvaluationPilotCurationDocument(documentValue, suiteValue);
  const suite = validateEvalContractDocument(suiteValue) as SuiteManifestDocument;
  const operatorTasks = new Map(suite.tasks.map((task) => [task.taskId, task]));
  const issues: string[] = [];
  const licenseEvidence = validateLicenseEvidence(evidence.licenseEvidence, document, issues);
  const taskEvidence = new Map<string, EvaluationPilotTaskEvidence>();

  requireCondition(
    evidence.taskEvidence.size === document.tasks.length &&
      document.tasks.every((task) => evidence.taskEvidence.has(task.taskId)),
    "evidence task joins must exactly match the curated task set",
    issues,
  );
  for (const curated of document.tasks) {
    const task = operatorTasks.get(curated.taskId);
    const joined = evidence.taskEvidence.get(curated.taskId);
    if (!task || !joined) continue;
    const sourceRow = validateSourceRow(joined.sourceRow, document, curated, task, issues);
    const upstreamTriplePreflight = validatePreflight(
      joined.upstreamTriplePreflight,
      curated,
      task,
      issues,
    );
    const independentSolveReview = validateIndependentSolve(
      joined.independentSolveReview,
      curated,
      task,
      issues,
    );
    const negativePatchReview = validateNegativePatches(
      joined.negativePatchReview,
      curated,
      task,
      issues,
    );
    const stressorEvidence = validateStressorEvidence(
      joined.stressorEvidence,
      curated,
      task,
      issues,
    );
    if (
      sourceRow &&
      upstreamTriplePreflight &&
      independentSolveReview &&
      negativePatchReview &&
      stressorEvidence
    ) {
      taskEvidence.set(curated.taskId, {
        sourceRow,
        upstreamTriplePreflight,
        independentSolveReview,
        negativePatchReview,
        stressorEvidence,
      });
    }
  }
  if (!licenseEvidence) issues.push("license evidence is unavailable after validation");
  if (taskEvidence.size !== document.tasks.length) {
    issues.push("one or more task evidence joins are unavailable after validation");
  }
  if (issues.length > 0 || !licenseEvidence) throw new EvaluationPilotValidationError(issues);

  const agentTasks = document.tasks.map((curated) => {
    const operatorTask = operatorTasks.get(curated.taskId);
    if (!operatorTask) {
      throw new EvaluationPilotValidationError([`${curated.taskId}: operator task disappeared`]);
    }
    return projectTaskForAgent(operatorTask);
  });
  return {
    document,
    suite,
    operatorTasks,
    taskEvidence,
    licenseEvidence,
    agentTasks,
  };
}

export function projectEvaluationPilotTaskForAgent(
  catalog: ValidatedEvaluationPilotCatalog,
  taskId: string,
) {
  expectString(taskId, "taskId", []);
  const operatorTask = catalog.operatorTasks.get(taskId);
  if (!operatorTask || !catalog.taskEvidence.has(taskId)) {
    throw new EvaluationPilotValidationError([`${taskId}: not present in the validated pilot`]);
  }
  return projectTaskForAgent(operatorTask);
}
