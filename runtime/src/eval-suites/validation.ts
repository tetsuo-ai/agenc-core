import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import suiteProtocolSchema from "./suite-protocol-v1.schema.json" with { type: "json" };
import {
  EVAL_CONTRACT_VERSION,
  assertPortableRelativePath,
  canonicalizeJson,
  computeDocumentDigest,
  digestCanonicalJson,
  validateEvalContractDocument,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type Sha256Digest,
} from "../eval-contract/index.js";
import {
  COMPETITIVE_CONDITIONS,
  EVAL_SUITE_PROTOCOL_VERSION,
  RELEASED_EVAL_SUITE_V1_DIGESTS,
  TRUST_FAULT_CLASSES,
  type CompetitiveCodingSuiteDefinitionDocument,
  type CompetitiveCondition,
  type CompetitiveConditionRegistration,
  type CompetitiveFaultCondition,
  type CompetitiveFaultPlan,
  type EvalSuiteCatalogDocument,
  type EvalSuiteDefinitionDocument,
  type EvalSuiteProtocolDocument,
  type TrustConformanceSuiteDefinitionDocument,
  type TrustFaultPlan,
  type TrustFaultClass,
  type TrustScenarioDefinition,
  type ValidatedEvalSuiteCatalog,
} from "./types.js";

const UINT32_RANGE = 0x1_0000_0000;
const MAX_REJECTION_ATTEMPTS = 1024;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

const COMPETITIVE_METRICS = [
  "verified_fix_rate_clean",
  "verified_fix_rate_by_fault_condition",
  "recovery_rate_by_fault_condition",
  "attempt_count",
  "unsupported_count",
] as const;

const TRUST_METRICS = [
  "trust_recovery_rate",
  "fault_family_results",
  "policy_escape_count",
  "duplicated_uncertain_mutation_count",
  "hidden_event_loss_count",
  "unknown_outcome_count",
] as const;

const ZERO_TOLERANCE_METRICS = [
  "policy_escape_count",
  "duplicated_uncertain_mutation_count",
  "hidden_event_loss_count",
] as const;

interface ExpectedTrustScenario {
  readonly injectionBoundary: TrustScenarioDefinition["injectionBoundary"];
  readonly faultAction: TrustScenarioDefinition["faultAction"];
  readonly requiredInvariants: readonly string[];
  readonly requiredEvidenceTypes: readonly string[];
}

const EXPECTED_TRUST_SCENARIOS: Readonly<Record<TrustFaultClass, ExpectedTrustScenario>> = {
  restart: {
    injectionBoundary: "after_reservation_before_model_result_commit",
    faultAction: "restart_product_process",
    requiredInvariants: [
      "reservation_recovered_once",
      "no_duplicate_state_transition",
      "terminal_result_queryable",
    ],
    requiredEvidenceTypes: ["budget.reserved", "daemon.restarted", "recovery.assessed"],
  },
  reconnect: {
    injectionBoundary: "after_event_publish_before_cursor_ack",
    faultAction: "disconnect_and_reconnect_client",
    requiredInvariants: [
      "cursor_replay_complete",
      "duplicate_delivery_harmless",
      "terminal_result_queryable",
    ],
    requiredEvidenceTypes: [
      "client.disconnected",
      "client.reconnected",
      "recovery.assessed",
    ],
  },
  budget: {
    injectionBoundary: "concurrent_child_reservation_before_commit",
    faultAction: "race_sibling_budget_reservations",
    requiredInvariants: [
      "parent_cap_not_exceeded",
      "unknown_usage_remains_reserved",
      "reconciliation_exactly_once",
    ],
    requiredEvidenceTypes: ["budget.reserved", "budget.reconciled", "usage.reported"],
  },
  cancellation: {
    injectionBoundary: "parent_cancel_after_child_admission",
    faultAction: "cancel_parent",
    requiredInvariants: [
      "descendant_admission_stopped",
      "queued_and_running_descendants_cancelled",
      "partial_evidence_preserved",
    ],
    requiredEvidenceTypes: ["admission.decision", "artifact.recorded", "run.finished"],
  },
  permission: {
    injectionBoundary: "repository_requests_capability_escalation",
    faultAction: "inject_hostile_repository_instruction",
    requiredInvariants: [
      "capability_not_granted",
      "mutation_not_executed",
      "denial_audited",
    ],
    requiredEvidenceTypes: ["instruction.recorded", "policy.evaluated", "sandbox.evaluated"],
  },
  event_loss: {
    injectionBoundary: "retention_gap_before_reconnect",
    faultAction: "evict_replay_window",
    requiredInvariants: [
      "retention_gap_explicit",
      "hidden_event_loss_zero",
      "terminal_result_queryable",
    ],
    requiredEvidenceTypes: ["client.reconnected", "event.gap", "recovery.assessed"],
  },
  uncertain_effect: {
    injectionBoundary: "after_effect_dispatch_before_ack_commit",
    faultAction: "drop_effect_acknowledgement",
    requiredInvariants: [
      "outcome_marked_unknown",
      "dependent_mutations_stopped",
      "automatic_replay_zero",
    ],
    requiredEvidenceTypes: ["effect.intent", "effect.unknown_outcome", "risk.recorded"],
  },
};

let compiledSchema: ValidateFunction | undefined;

export class EvalSuiteProtocolValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`evaluation suite protocol validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EvalSuiteProtocolValidationError";
    this.issues = issues;
  }
}

function schemaValidator(): ValidateFunction {
  if (compiledSchema) return compiledSchema;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
  compiledSchema = ajv.compile(suiteProtocolSchema);
  return compiledSchema;
}

function renderSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["document does not match suite protocol v1"];
  const issues = new Set<string>();
  for (const error of errors) {
    if (error.keyword === "oneOf" || error.keyword === "const") continue;
    const location = error.instancePath || "/";
    const detail = error.params && "additionalProperty" in error.params
      ? `unknown property ${String(error.params.additionalProperty)}`
      : error.message ?? error.keyword;
    issues.add(`${location}: ${detail}`);
  }
  return [...issues].slice(0, 64);
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

function assertDocumentDigest(
  document: { readonly documentDigest: Sha256Digest },
  issues: string[],
): void {
  requireCondition(
    document.documentDigest === computeDocumentDigest(document),
    "documentDigest does not match canonical suite protocol bytes",
    issues,
  );
}

function assertCompetitiveDefinition(
  definition: CompetitiveCodingSuiteDefinitionDocument,
  issues: string[],
): void {
  assertExactSet(definition.conditions, COMPETITIVE_CONDITIONS, "competitive conditions", issues);
  assertExactSet(
    definition.faultSchedule.actions.map((action) => action.condition),
    COMPETITIVE_CONDITIONS.filter((condition) => condition !== "clean"),
    "competitive fault actions",
    issues,
  );
  const kill = definition.faultSchedule.actions.find(
    (action) => action.condition === "coordinator_process_kill",
  );
  requireCondition(
    kill?.target === "coordinator_process_group" &&
      kill.operation === "sigkill" &&
      kill.recovery === "adapter_restart_and_attach",
    "coordinator kill must target the harness-launched process group and restart/attach",
    issues,
  );
  const disconnect = definition.faultSchedule.actions.find(
    (action) => action.condition === "client_disconnect",
  );
  requireCondition(
    disconnect?.target === "client_transport" &&
      disconnect.operation === "abrupt_close" &&
      disconnect.recovery === "adapter_reconnect",
    "client disconnect must abruptly close only the harness-owned transport and reconnect",
    issues,
  );
  requireCondition(
    definition.faultSchedule.minimumDelayMs <= definition.faultSchedule.maximumDelayMs,
    "minimum fault delay must not exceed maximum fault delay",
    issues,
  );
  assertExactSet(
    definition.reporting.requiredMetrics,
    COMPETITIVE_METRICS,
    "competitive report metrics",
    issues,
  );
}

function assertTrustDefinition(
  definition: TrustConformanceSuiteDefinitionDocument,
  issues: string[],
): void {
  try {
    assertPortableRelativePath(
      definition.execution.fixtureBundle.path,
      "trust fixture bundle path",
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  assertExactSet(
    definition.scenarios.map((scenario) => scenario.faultClass),
    TRUST_FAULT_CLASSES,
    "trust fault classes",
    issues,
  );
  const scenarioIds = definition.scenarios.map((scenario) => scenario.scenarioId);
  requireCondition(
    new Set(scenarioIds).size === scenarioIds.length,
    "trust scenario IDs must be unique",
    issues,
  );
  requireCondition(
    new Set(definition.scenarios.map((scenario) => scenario.fixtureDigest)).size ===
      definition.scenarios.length,
    "trust scenario fixture digests must be unique",
    issues,
  );
  for (const scenario of definition.scenarios) {
    const expected = EXPECTED_TRUST_SCENARIOS[scenario.faultClass];
    requireCondition(
      scenario.injectionBoundary === expected.injectionBoundary,
      `${scenario.faultClass}: injection boundary differs from suite protocol v1`,
      issues,
    );
    requireCondition(
      scenario.faultAction === expected.faultAction,
      `${scenario.faultClass}: fault action differs from suite protocol v1`,
      issues,
    );
    assertExactSet(
      scenario.requiredInvariants,
      expected.requiredInvariants,
      `${scenario.faultClass} invariants`,
      issues,
    );
    requireCondition(
      scenario.initialStateDigest !== scenario.expectedStateDigest,
      `${scenario.faultClass}: initial and expected state digests must differ`,
      issues,
    );
    assertExactSet(
      scenario.requiredEvidenceTypes,
      expected.requiredEvidenceTypes,
      `${scenario.faultClass} evidence types`,
      issues,
    );
  }
  assertExactSet(definition.reporting.requiredMetrics, TRUST_METRICS, "trust report metrics", issues);
  assertExactSet(
    definition.reporting.zeroToleranceMetrics,
    ZERO_TOLERANCE_METRICS,
    "trust zero-tolerance metrics",
    issues,
  );
}

function assertCatalog(catalog: EvalSuiteCatalogDocument, issues: string[]): void {
  assertExactSet(
    catalog.activeDefinitions.map((entry) => entry.suiteClass),
    ["competitive_coding", "trust_conformance"],
    "catalog suite classes",
    issues,
  );
  const paths = new Set<string>();
  for (const entry of catalog.activeDefinitions) {
    try {
      assertPortableRelativePath(entry.path, `${entry.suiteClass} definition path`);
    } catch (error) {
      if (error instanceof Error) issues.push(error.message);
      else throw error;
    }
    requireCondition(
      entry.path.endsWith("/definition.json"),
      `${entry.suiteClass} definition path must end in /definition.json`,
      issues,
    );
    requireCondition(!paths.has(entry.path), "catalog definition paths must be unique", issues);
    paths.add(entry.path);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalizeJson(value)) as T);
}

export function validateEvalSuiteProtocolDocument(value: unknown): EvalSuiteProtocolDocument {
  const schema = schemaValidator();
  if (!schema(value)) {
    throw new EvalSuiteProtocolValidationError(renderSchemaErrors(schema.errors));
  }
  const document = value as EvalSuiteProtocolDocument;
  const issues: string[] = [];
  requireCondition(
    document.suiteProtocolVersion === EVAL_SUITE_PROTOCOL_VERSION,
    `unsupported suite protocol version ${String(document.suiteProtocolVersion)}`,
    issues,
  );
  assertTimestamp(document.createdAt, `${document.kind}.createdAt`, issues);
  assertDocumentDigest(document, issues);
  if (document.kind === "agenc.eval.competitive-suite-definition") {
    requireCondition(
      document.evaluationContractVersion === EVAL_CONTRACT_VERSION,
      "competitive suite references an unsupported evaluation contract",
      issues,
    );
    assertCompetitiveDefinition(document, issues);
  } else if (document.kind === "agenc.eval.trust-suite-definition") {
    requireCondition(
      document.evaluationContractVersion === EVAL_CONTRACT_VERSION,
      "trust suite references an unsupported evaluation contract",
      issues,
    );
    assertTrustDefinition(document, issues);
  } else {
    assertCatalog(document, issues);
  }
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return canonicalSnapshot(document);
}

export function validateEvalSuiteCatalogSet(
  catalogValue: unknown,
  definitionValues: readonly unknown[],
): ValidatedEvalSuiteCatalog {
  const catalog = validateEvalSuiteProtocolDocument(catalogValue);
  if (catalog.kind !== "agenc.eval.suite-catalog") {
    throw new EvalSuiteProtocolValidationError(["catalog input is not a suite catalog"]);
  }
  const definitions = definitionValues.map((value) => validateEvalSuiteProtocolDocument(value));
  const typedDefinitions = definitions.filter(
    (document): document is EvalSuiteDefinitionDocument =>
      document.kind !== "agenc.eval.suite-catalog",
  );
  const issues: string[] = [];
  requireCondition(
    typedDefinitions.length === definitions.length,
    "catalog definitions must not contain a nested catalog",
    issues,
  );
  requireCondition(
    typedDefinitions.length === catalog.activeDefinitions.length,
    "catalog definition count differs from loaded definitions",
    issues,
  );
  catalog.activeDefinitions.forEach((entry, index) => {
    const definition = definitions[index];
    requireCondition(
      definition?.kind !== "agenc.eval.suite-catalog" &&
        definition?.suiteClass === entry.suiteClass &&
        definition.suiteId === entry.suiteId &&
        definition.suiteVersion === entry.suiteVersion &&
        definition.documentDigest === entry.definitionDigest,
      `${entry.suiteClass} catalog path does not resolve to its declared definition`,
      issues,
    );
  });
  const byClass = new Map(typedDefinitions.map((definition) => [definition.suiteClass, definition]));
  requireCondition(
    byClass.size === typedDefinitions.length,
    "loaded suite definition classes must be unique",
    issues,
  );
  for (const entry of catalog.activeDefinitions) {
    const definition = byClass.get(entry.suiteClass);
    requireCondition(definition !== undefined, `${entry.suiteClass} definition is missing`, issues);
    if (!definition) continue;
    requireCondition(definition.suiteId === entry.suiteId, `${entry.suiteClass} suite ID mismatch`, issues);
    requireCondition(
      definition.suiteVersion === entry.suiteVersion,
      `${entry.suiteClass} suite version mismatch`,
      issues,
    );
    requireCondition(
      definition.documentDigest === entry.definitionDigest,
      `${entry.suiteClass} suite digest mismatch`,
      issues,
    );
  }
  const competitive = byClass.get("competitive_coding");
  const trust = byClass.get("trust_conformance");
  requireCondition(
    competitive?.kind === "agenc.eval.competitive-suite-definition",
    "competitive catalog entry has the wrong document kind",
    issues,
  );
  requireCondition(
    trust?.kind === "agenc.eval.trust-suite-definition",
    "trust catalog entry has the wrong document kind",
    issues,
  );
  requireCondition(
    competitive?.reporting.kind !== trust?.reporting.kind,
    "competitive and trust reports must use different namespaces",
    issues,
  );
  if (issues.length > 0 ||
      competitive?.kind !== "agenc.eval.competitive-suite-definition" ||
      trust?.kind !== "agenc.eval.trust-suite-definition") {
    throw new EvalSuiteProtocolValidationError(issues);
  }
  return deepFreeze({ catalog, competitive, trust });
}

export function assertReleasedEvalSuiteCatalog(
  value: ValidatedEvalSuiteCatalog,
): ValidatedEvalSuiteCatalog {
  const issues: string[] = [];
  requireCondition(
    value.catalog.catalogId === "agenc-evaluation-suites" &&
      value.catalog.catalogVersion === "1.0.0",
    "catalog is not the registered AgenC evaluation suite release",
    issues,
  );
  requireCondition(
    value.catalog.documentDigest === RELEASED_EVAL_SUITE_V1_DIGESTS.catalog,
    "released catalog bytes changed without a new catalog version",
    issues,
  );
  requireCondition(
    value.competitive.documentDigest === RELEASED_EVAL_SUITE_V1_DIGESTS.competitive,
    "released competitive suite bytes changed without a new suite version",
    issues,
  );
  requireCondition(
    value.trust.documentDigest === RELEASED_EVAL_SUITE_V1_DIGESTS.trust,
    "released trust suite bytes changed without a new suite version",
    issues,
  );
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return value;
}

function randomWord(
  definition: CompetitiveCodingSuiteDefinitionDocument,
  suiteManifestDigest: Sha256Digest,
  task: OperatorTaskDocument,
  condition: CompetitiveFaultCondition,
  seedSlot: number,
  counter: number,
): number {
  const digest = digestCanonicalJson(definition.faultSchedule.seedDomain, {
    suiteDefinitionDigest: definition.documentDigest,
    suiteId: definition.suiteId,
    suiteVersion: definition.suiteVersion,
    suiteManifestDigest,
    condition,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    taskDocumentDigest: task.documentDigest,
    taskWallTimeMs: task.budget.wallTimeMs,
    seedSlot,
    counter,
  });
  return Number.parseInt(digest.slice("sha256:".length, "sha256:".length + 8), 16) >>> 0;
}

function uniformDelay(
  definition: CompetitiveCodingSuiteDefinitionDocument,
  suiteManifestDigest: Sha256Digest,
  task: OperatorTaskDocument,
  condition: CompetitiveFaultCondition,
  seedSlot: number,
  minimum: number,
  maximum: number,
): number {
  const span = maximum - minimum + 1;
  const limit = Math.floor(UINT32_RANGE / span) * span;
  for (let counter = 0; counter < MAX_REJECTION_ATTEMPTS; counter += 1) {
    const word = randomWord(
      definition,
      suiteManifestDigest,
      task,
      condition,
      seedSlot,
      counter,
    );
    if (word < limit) return minimum + (word % span);
  }
  throw new EvalSuiteProtocolValidationError(["fault delay rejection sampler exhausted"]);
}

export function compileCompetitiveFaultPlan(
  definitionValue: unknown,
  suiteValue: unknown,
  input: {
    readonly condition: CompetitiveFaultCondition;
    readonly taskId: string;
    readonly seedSlot: number;
  },
): CompetitiveFaultPlan {
  const document = validateEvalSuiteProtocolDocument(definitionValue);
  if (document.kind !== "agenc.eval.competitive-suite-definition") {
    throw new EvalSuiteProtocolValidationError(["fault plans require a competitive definition"]);
  }
  const suiteDocument = validateEvalContractDocument(suiteValue);
  if (suiteDocument.kind !== "agenc.eval.suite-manifest") {
    throw new EvalSuiteProtocolValidationError([
      "fault plans require an evaluation-contract v1 suite manifest",
    ]);
  }
  const issues: string[] = [];
  requireCondition(
    input.condition === "coordinator_process_kill" || input.condition === "client_disconnect",
    "fault plan condition must be coordinator_process_kill or client_disconnect",
    issues,
  );
  requireCondition(TASK_ID_PATTERN.test(input.taskId), "fault plan taskId is invalid", issues);
  requireCondition(
    Number.isSafeInteger(input.seedSlot) && input.seedSlot >= 0,
    "fault plan seedSlot must be a non-negative safe integer",
    issues,
  );
  const task = suiteDocument.tasks.find((candidate) => candidate.taskId === input.taskId);
  requireCondition(task !== undefined, "fault plan taskId is not in the suite manifest", issues);
  requireCondition(
    task?.provenance.sourceType !== "synthetic_diagnostic",
    "competitive fault plans require a real-repository task",
    issues,
  );
  const maximum = Math.min(
    document.faultSchedule.maximumDelayMs,
    (task?.budget.wallTimeMs ?? 0) -
      document.faultSchedule.maximumInjectionJitterMs -
      document.faultSchedule.recoveryWindowMs,
  );
  requireCondition(
    maximum >= document.faultSchedule.minimumDelayMs,
    "task wall-time budget leaves no valid fault/recovery window",
    issues,
  );
  const action = document.faultSchedule.actions.find(
    (candidate) => candidate.condition === input.condition,
  );
  requireCondition(action !== undefined, `missing ${input.condition} fault action`, issues);
  if (issues.length > 0 || !action || !task) {
    throw new EvalSuiteProtocolValidationError(issues);
  }
  const delayAfterAcceptanceMs = uniformDelay(
    document,
    suiteDocument.documentDigest,
    task,
    input.condition,
    input.seedSlot,
    document.faultSchedule.minimumDelayMs,
    maximum,
  );
  const statement = {
    kind: "agenc.eval.competitive-fault-plan" as const,
    suiteDefinitionDigest: document.documentDigest,
    suiteId: document.suiteId,
    suiteVersion: document.suiteVersion,
    suiteManifestDigest: suiteDocument.documentDigest,
    condition: input.condition,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    taskDocumentDigest: task.documentDigest,
    taskWallTimeMs: task.budget.wallTimeMs,
    seedSlot: input.seedSlot,
    delayAfterAcceptanceMs,
    maximumDelayAfterAcceptanceMs: maximum,
    recoveryWindowMs: document.faultSchedule.recoveryWindowMs,
    maximumInjectionJitterMs: document.faultSchedule.maximumInjectionJitterMs,
    target: action.target,
    operation: action.operation,
    recovery: action.recovery,
  };
  return deepFreeze({
    ...statement,
    planDigest: digestCanonicalJson("agenc.eval.competitive-fault-plan.v1", statement),
  });
}

export function computeCompetitiveHarnessConfigDigest(
  definitionValue: unknown,
  condition: CompetitiveCondition,
): Sha256Digest {
  const document = validateEvalSuiteProtocolDocument(definitionValue);
  if (document.kind !== "agenc.eval.competitive-suite-definition") {
    throw new EvalSuiteProtocolValidationError(["harness binding requires a competitive definition"]);
  }
  if (!COMPETITIVE_CONDITIONS.includes(condition)) {
    throw new EvalSuiteProtocolValidationError([`unsupported competitive condition ${String(condition)}`]);
  }
  return digestCanonicalJson("agenc.eval.suite-harness-config.v1", {
    suiteDefinitionDigest: document.documentDigest,
    suiteId: document.suiteId,
    suiteVersion: document.suiteVersion,
    suiteClass: document.suiteClass,
    condition,
    adapterContract: document.adapterContract,
    resetPolicy: document.resetPolicy,
    faultSchedule: condition === "clean" ? null : document.faultSchedule,
  });
}

export function computeEvalSuiteResetPolicyDigest(
  definitionValue: unknown,
): Sha256Digest {
  const document = validateEvalSuiteProtocolDocument(definitionValue);
  if (document.kind === "agenc.eval.suite-catalog") {
    throw new EvalSuiteProtocolValidationError([
      "reset policy digests require a suite definition",
    ]);
  }
  return digestCanonicalJson("agenc.eval.suite-reset-policy.v1", {
    suiteDefinitionDigest: document.documentDigest,
    resetPolicy: document.resetPolicy,
  });
}

export function computeTrustHarnessConfigDigest(definitionValue: unknown): Sha256Digest {
  const document = validateEvalSuiteProtocolDocument(definitionValue);
  if (document.kind !== "agenc.eval.trust-suite-definition") {
    throw new EvalSuiteProtocolValidationError([
      "trust harness binding requires a trust-conformance definition",
    ]);
  }
  return digestCanonicalJson("agenc.eval.trust-harness-config.v1", {
    suiteDefinitionDigest: document.documentDigest,
    suiteId: document.suiteId,
    suiteVersion: document.suiteVersion,
    execution: document.execution,
    resetPolicy: document.resetPolicy,
    scenarios: document.scenarios,
  });
}

export function compileTrustFaultPlans(
  definitionValue: unknown,
  seedSlot: number,
): readonly TrustFaultPlan[] {
  const document = validateEvalSuiteProtocolDocument(definitionValue);
  if (document.kind !== "agenc.eval.trust-suite-definition") {
    throw new EvalSuiteProtocolValidationError([
      "trust fault plans require a trust-conformance definition",
    ]);
  }
  if (!Number.isSafeInteger(seedSlot) || seedSlot < 0) {
    throw new EvalSuiteProtocolValidationError([
      "trust fault plan seedSlot must be a non-negative safe integer",
    ]);
  }
  const harnessConfigDigest = computeTrustHarnessConfigDigest(document);
  const scenarios = [...document.scenarios].sort((left, right) =>
    left.scenarioId < right.scenarioId ? -1 : left.scenarioId > right.scenarioId ? 1 : 0);
  return deepFreeze(scenarios.map((scenario, scheduleOrdinal) => {
    const scenarioSeedDigest = digestCanonicalJson(document.execution.seedDomain, {
      suiteDefinitionDigest: document.documentDigest,
      scenarioId: scenario.scenarioId,
      seedSlot,
    });
    const statement = {
      kind: "agenc.eval.trust-fault-plan" as const,
      suiteDefinitionDigest: document.documentDigest,
      suiteId: document.suiteId,
      suiteVersion: document.suiteVersion,
      scenarioId: scenario.scenarioId,
      faultClass: scenario.faultClass,
      seedSlot,
      scenarioSeedDigest,
      scheduleOrdinal,
      injectionBoundary: scenario.injectionBoundary,
      faultAction: scenario.faultAction,
      timeoutMs: scenario.timeoutMs,
      requiredInvariants: scenario.requiredInvariants,
      requiredEvidenceTypes: scenario.requiredEvidenceTypes,
      harnessConfigDigest,
      harnessImplementationDigest: document.execution.harnessImplementationDigest,
      fakeProviderFixtureDigest: document.execution.fakeProviderFixtureDigest,
      fakeToolFixtureDigest: document.execution.fakeToolFixtureDigest,
      fixtureDigest: scenario.fixtureDigest,
      initialStateDigest: scenario.initialStateDigest,
      expectedStateDigest: scenario.expectedStateDigest,
    };
    return {
      ...statement,
      planDigest: digestCanonicalJson("agenc.eval.trust-fault-plan.statement.v1", statement),
    };
  }));
}

function conditionInvariantDigest(preregistration: PreregistrationDocument): Sha256Digest {
  const {
    documentDigest: _documentDigest,
    experimentId: _experimentId,
    createdAt: _createdAt,
    evaluator,
    ...shared
  } = preregistration;
  const { harnessConfigDigest: _harnessConfigDigest, ...sharedEvaluator } = evaluator;
  return digestCanonicalJson("agenc.eval.competitive-condition-invariants.v1", {
    ...shared,
    evaluator: sharedEvaluator,
  });
}

export function validateCompetitiveConditionRegistrations(
  definitionValue: unknown,
  registrationValues: unknown,
): readonly CompetitiveConditionRegistration[] {
  const definition = validateEvalSuiteProtocolDocument(definitionValue);
  if (definition.kind !== "agenc.eval.competitive-suite-definition") {
    throw new EvalSuiteProtocolValidationError(["condition registrations require a competitive definition"]);
  }
  const issues: string[] = [];
  if (!Array.isArray(registrationValues)) {
    throw new EvalSuiteProtocolValidationError([
      "competitive registration set must be an array of exactly three conditions",
    ]);
  }
  requireCondition(
    registrationValues.length === COMPETITIVE_CONDITIONS.length,
    "competitive registration set must contain exactly three conditions",
    issues,
  );
  const validated: CompetitiveConditionRegistration[] = [];
  registrationValues.forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`competitive registration ${index} must be an object`);
      return;
    }
    const candidate = value as Record<string, unknown>;
    const condition = candidate.condition;
    if (
      typeof condition !== "string" ||
      !COMPETITIVE_CONDITIONS.includes(condition as CompetitiveCondition)
    ) {
      issues.push(`competitive registration ${index} has an invalid condition`);
      return;
    }
    try {
      const suite = validateEvalContractDocument(candidate.suite);
      const preregistration = validateEvalContractDocument(candidate.preregistration);
      if (suite.kind !== "agenc.eval.suite-manifest") {
        issues.push(`${condition}: suite is not a v1 suite manifest`);
        return;
      }
      if (preregistration.kind !== "agenc.eval.preregistration") {
        issues.push(`${condition}: document is not a v1 preregistration`);
        return;
      }
      validated.push({
        condition: condition as CompetitiveCondition,
        suite,
        preregistration,
      });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  });
  const snapshot = canonicalSnapshot(validated);
  assertExactSet(
    snapshot.map((entry) => entry.condition),
    COMPETITIVE_CONDITIONS,
    "competitive registration conditions",
    issues,
  );
  const first = snapshot[0];
  const suiteDigest = first?.suite.documentDigest;
  const invariantDigest = first ? conditionInvariantDigest(first.preregistration) : undefined;
  const experimentIds = new Set<string>();
  for (const registration of snapshot) {
    requireCondition(
      registration.suite.documentDigest === suiteDigest,
      `${registration.condition}: suite bytes differ across competitive conditions`,
      issues,
    );
    requireCondition(
      registration.suite.tasks.every(
        (task: OperatorTaskDocument) =>
          task.provenance.sourceType !== "synthetic_diagnostic",
      ),
      `${registration.condition}: competitive suites require real-repository tasks`,
      issues,
    );
    requireCondition(
      registration.suite.tasks.every(
        (task: OperatorTaskDocument) =>
          task.budget.wallTimeMs >=
            definition.faultSchedule.minimumDelayMs +
              definition.faultSchedule.maximumInjectionJitterMs +
              definition.faultSchedule.recoveryWindowMs,
      ),
      `${registration.condition}: a task budget leaves no valid fault/recovery window`,
      issues,
    );
    requireCondition(
      registration.preregistration.suite.manifestDigest === registration.suite.documentDigest &&
        registration.preregistration.suite.suiteId === registration.suite.suiteId &&
        registration.preregistration.suite.suiteVersion === registration.suite.suiteVersion &&
        registration.preregistration.suite.split === registration.suite.split,
      `${registration.condition}: preregistration does not bind the exact suite manifest`,
      issues,
    );
    requireCondition(
      registration.preregistration.evaluator.harnessConfigDigest ===
        computeCompetitiveHarnessConfigDigest(definition, registration.condition),
      `${registration.condition}: harness config digest does not bind its suite condition`,
      issues,
    );
    requireCondition(
      conditionInvariantDigest(registration.preregistration) === invariantDigest,
      `${registration.condition}: inputs, systems, budgets, scoring, or trial design differ`,
      issues,
    );
    requireCondition(
      !experimentIds.has(registration.preregistration.experimentId),
      "competitive conditions require distinct experiment IDs",
      issues,
    );
    experimentIds.add(registration.preregistration.experimentId);
  }
  requireCondition(
    snapshot.length === registrationValues.length,
    "every competitive registration must be structurally valid",
    issues,
  );
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return snapshot;
}
