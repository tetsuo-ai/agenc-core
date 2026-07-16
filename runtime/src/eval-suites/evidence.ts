import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import evidenceSchema from "./suite-evidence-v1.schema.json" with { type: "json" };
import {
  canonicalizeJson,
  compareUtcTimestamps,
  computeDocumentDigest,
  projectTaskForAgent,
  validateEvalContractDocument,
  type Sha256Digest,
} from "../eval-contract/index.js";
import {
  compileCompetitiveFaultPlan,
  compileTrustFaultPlans,
  computeCompetitiveHarnessConfigDigest,
  computeEvalSuiteResetPolicyDigest,
  EvalSuiteProtocolValidationError,
  validateEvalSuiteProtocolDocument,
} from "./validation.js";
import {
  EVAL_SUITE_PROTOCOL_VERSION,
  type CompetitiveCodingReportDocument,
  type EvalSuiteDefinitionDocument,
  type EvalSuiteEvidenceDocument,
  type EvalSuiteResetReceiptDocument,
  type TrustConformanceReportDocument,
} from "./types.js";

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

let compiledSchema: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (compiledSchema) return compiledSchema;
  compiledSchema = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true }).compile(
    evidenceSchema,
  );
  return compiledSchema;
}

function renderSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["document does not match suite evidence v1"];
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalizeJson(value)) as T);
}

function sameSuiteReference(
  report: CompetitiveCodingReportDocument | TrustConformanceReportDocument,
  definition: EvalSuiteDefinitionDocument,
): boolean {
  return report.suite.suiteClass === definition.suiteClass &&
    report.suite.suiteId === definition.suiteId &&
    report.suite.suiteVersion === definition.suiteVersion &&
    report.suite.definitionDigest === definition.documentDigest;
}

function assertResetBinding(
  definition: EvalSuiteDefinitionDocument,
  reset: EvalSuiteResetReceiptDocument,
  attemptId: string,
  receiptDigest: Sha256Digest,
  issues: string[],
): void {
  requireCondition(
    reset.suiteDefinitionDigest === definition.documentDigest,
    "reset receipt references the wrong suite definition",
    issues,
  );
  requireCondition(reset.attemptId === attemptId, "reset receipt attempt ID mismatch", issues);
  requireCondition(
    reset.documentDigest === receiptDigest,
    "report resetReceiptDigest does not match the supplied receipt",
    issues,
  );
  requireCondition(
    reset.resetPolicyDigest === computeEvalSuiteResetPolicyDigest(definition),
    "reset receipt does not bind the exact suite reset policy",
    issues,
  );
}

export function validateEvalSuiteEvidenceDocument(value: unknown): EvalSuiteEvidenceDocument {
  const schema = schemaValidator();
  if (!schema(value)) {
    throw new EvalSuiteProtocolValidationError(renderSchemaErrors(schema.errors));
  }
  const document = value as EvalSuiteEvidenceDocument;
  const issues: string[] = [];
  requireCondition(
    document.suiteProtocolVersion === EVAL_SUITE_PROTOCOL_VERSION,
    `unsupported suite evidence protocol ${String(document.suiteProtocolVersion)}`,
    issues,
  );
  assertTimestamp(document.createdAt, `${document.kind}.createdAt`, issues);
  requireCondition(
    document.documentDigest === computeDocumentDigest(document),
    "documentDigest does not match canonical suite evidence bytes",
    issues,
  );
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return canonicalSnapshot(document);
}

export function validateEvalSuiteResetReceipt(
  definitionValue: unknown,
  receiptValue: unknown,
): EvalSuiteResetReceiptDocument {
  const definition = validateEvalSuiteProtocolDocument(definitionValue);
  if (definition.kind === "agenc.eval.suite-catalog") {
    throw new EvalSuiteProtocolValidationError([
      "reset receipts require a suite definition",
    ]);
  }
  const document = validateEvalSuiteEvidenceDocument(receiptValue);
  if (document.kind !== "agenc.eval.suite-reset-receipt") {
    throw new EvalSuiteProtocolValidationError(["evidence input is not a reset receipt"]);
  }
  const issues: string[] = [];
  assertResetBinding(
    definition,
    document,
    document.attemptId,
    document.documentDigest,
    issues,
  );
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return document;
}

export function validateCompetitiveCodingReport(
  definitionValue: unknown,
  suiteValue: unknown,
  resetReceiptValue: unknown,
  reportValue: unknown,
): CompetitiveCodingReportDocument {
  const definition = validateEvalSuiteProtocolDocument(definitionValue);
  if (definition.kind !== "agenc.eval.competitive-suite-definition") {
    throw new EvalSuiteProtocolValidationError([
      "competitive reports require a competitive suite definition",
    ]);
  }
  const suite = validateEvalContractDocument(suiteValue);
  if (suite.kind !== "agenc.eval.suite-manifest") {
    throw new EvalSuiteProtocolValidationError([
      "competitive reports require an evaluation-contract v1 suite manifest",
    ]);
  }
  const reset = validateEvalSuiteEvidenceDocument(resetReceiptValue);
  if (reset.kind !== "agenc.eval.suite-reset-receipt") {
    throw new EvalSuiteProtocolValidationError([
      "competitive report reset evidence is not a reset receipt",
    ]);
  }
  const report = validateEvalSuiteEvidenceDocument(reportValue);
  if (report.kind !== "agenc.eval.competitive-coding-report") {
    throw new EvalSuiteProtocolValidationError([
      "evidence input is not a competitive coding report",
    ]);
  }
  const issues: string[] = [];
  requireCondition(sameSuiteReference(report, definition), "competitive suite reference mismatch", issues);
  requireCondition(
    report.suiteManifestDigest === suite.documentDigest,
    "competitive report suite manifest digest mismatch",
    issues,
  );
  const task = suite.tasks.find((candidate) => candidate.taskId === report.task.taskId);
  requireCondition(task !== undefined, "competitive report task is not in the suite", issues);
  if (task) {
    requireCondition(
      task.provenance.sourceType !== "synthetic_diagnostic",
      "competitive reports require a real-repository task",
      issues,
    );
    requireCondition(
      report.task.taskVersion === task.taskVersion &&
        report.task.taskDocumentDigest === task.documentDigest,
      "competitive report task version or digest mismatch",
      issues,
    );
    requireCondition(
      report.deliveryReceipt.agentTaskDigest === projectTaskForAgent(task).documentDigest,
      "delivery receipt does not bind the exact agent-task bytes",
      issues,
    );
    requireCondition(
      reset.workspace.repositoryCommit === task.repository.commit &&
        reset.taskResetRecipeDigest === task.resetRecipe.digest,
      "reset receipt does not bind the exact task repository and reset recipe",
      issues,
    );
    requireCondition(
      reset.suiteManifestDigest === suite.documentDigest &&
        reset.taskDocumentDigest === task.documentDigest &&
        reset.condition === report.condition &&
        reset.scenarioId === null &&
        reset.seedSlot === report.seedSlot &&
        reset.systemConfigurationDigest === report.systemConfigurationDigest,
      "reset receipt does not bind the exact competitive evaluation cell",
      issues,
    );
  }
  requireCondition(
    report.harnessConfigDigest ===
      computeCompetitiveHarnessConfigDigest(definition, report.condition),
    "competitive report harness config digest mismatch",
    issues,
  );
  assertResetBinding(
    definition,
    reset,
    report.attemptId,
    report.resetReceiptDigest,
    issues,
  );
  requireCondition(
    compareUtcTimestamps(reset.createdAt, report.createdAt) <= 0,
    "competitive reset receipt must not postdate its report",
    issues,
  );
  if (report.condition === "clean") {
    requireCondition(
      report.faultPlanDigest === null &&
        report.fault.scheduled === false &&
        report.fault.injected === false &&
        report.fault.scheduledDelayAfterAcceptanceMs === null &&
        report.fault.observedInjectedAtMonotonicMs === null &&
        report.fault.evidenceDigest === null,
      "clean reports must not contain scheduled or injected fault evidence",
      issues,
    );
    requireCondition(
      report.outcome !== "fault_not_injected",
      "clean reports cannot use the fault_not_injected outcome",
      issues,
    );
  } else if (task) {
    const plan = compileCompetitiveFaultPlan(definition, suite, {
      condition: report.condition,
      taskId: task.taskId,
      seedSlot: report.seedSlot,
    });
    requireCondition(
      report.faultPlanDigest === plan.planDigest,
      "competitive report fault plan digest mismatch",
      issues,
    );
    requireCondition(report.fault.scheduled === true, "competitive fault was not scheduled", issues);
    requireCondition(
      report.fault.scheduledDelayAfterAcceptanceMs === plan.delayAfterAcceptanceMs,
      "competitive report scheduled delay does not match its deterministic plan",
      issues,
    );
    if (report.fault.injected) {
      const earliest = report.deliveryReceipt.acceptedAtMonotonicMs + plan.delayAfterAcceptanceMs;
      requireCondition(
        report.fault.observedInjectedAtMonotonicMs !== null &&
          report.fault.observedInjectedAtMonotonicMs >= earliest &&
          report.fault.observedInjectedAtMonotonicMs <=
            earliest + plan.maximumInjectionJitterMs &&
          report.fault.evidenceDigest !== null,
        "competitive observed fault time is outside the deterministic plan jitter window",
        issues,
      );
    } else {
      requireCondition(
        report.fault.observedInjectedAtMonotonicMs === null &&
          report.fault.evidenceDigest !== null &&
          (report.outcome === "fault_not_injected" ||
            report.outcome === "infrastructure_invalid" ||
            report.outcome === "unsupported"),
        "a non-injected competitive fault must be fault_not_injected, infrastructure_invalid, or unsupported",
        issues,
      );
    }
    requireCondition(
      !report.fault.injected || report.outcome !== "fault_not_injected",
      "an injected competitive fault cannot use the fault_not_injected outcome",
      issues,
    );
  }
  requireCondition(
    report.outcome !== "verified_fix" ||
      (report.verifier.result === "passed" &&
        (report.condition === "clean" || report.fault.injected)),
    "verified_fix requires verifier success and any scheduled fault to be injected",
    issues,
  );
  requireCondition(
    report.outcome !== "verification_failure" || report.verifier.result !== "passed",
    "verification_failure cannot carry a passing verifier result",
    issues,
  );
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return report;
}

export function validateTrustConformanceReport(
  definitionValue: unknown,
  resetReceiptValue: unknown,
  reportValue: unknown,
): TrustConformanceReportDocument {
  const definition = validateEvalSuiteProtocolDocument(definitionValue);
  if (definition.kind !== "agenc.eval.trust-suite-definition") {
    throw new EvalSuiteProtocolValidationError([
      "trust reports require a trust-conformance suite definition",
    ]);
  }
  const reset = validateEvalSuiteEvidenceDocument(resetReceiptValue);
  if (reset.kind !== "agenc.eval.suite-reset-receipt") {
    throw new EvalSuiteProtocolValidationError([
      "trust report reset evidence is not a reset receipt",
    ]);
  }
  const report = validateEvalSuiteEvidenceDocument(reportValue);
  if (report.kind !== "agenc.eval.trust-conformance-report") {
    throw new EvalSuiteProtocolValidationError([
      "evidence input is not a trust-conformance report",
    ]);
  }
  const issues: string[] = [];
  requireCondition(sameSuiteReference(report, definition), "trust suite reference mismatch", issues);
  const plan = compileTrustFaultPlans(definition, report.seedSlot).find(
    (candidate) => candidate.scenarioId === report.scenarioId,
  );
  requireCondition(plan !== undefined, "trust report scenario is not in the suite", issues);
  if (plan) {
    requireCondition(
      report.faultClass === plan.faultClass && report.faultPlanDigest === plan.planDigest,
      "trust report fault class or plan digest mismatch",
      issues,
    );
    const invariantNames = report.invariantResults.map((result) => result.invariant);
    requireCondition(
      invariantNames.length === new Set(invariantNames).size &&
        invariantNames.length === plan.requiredInvariants.length &&
        plan.requiredInvariants.every((invariant) => invariantNames.includes(invariant)),
      "trust report must contain exactly the planned invariant results",
      issues,
    );
    requireCondition(
      report.outcome !== "passed" ||
        plan.requiredEvidenceTypes.every((eventType) =>
          report.observedEvidenceTypes.includes(eventType)),
      "passing trust report is missing required evidence event types",
      issues,
    );
    requireCondition(
      report.outcome !== "passed" ||
        (report.fault.injected &&
          report.actualStateDigest === plan.expectedStateDigest &&
          report.durationMs <= plan.timeoutMs &&
          report.invariantResults.every((result) => result.passed)),
      "passing trust reports require the injected fault, timeout, expected state, and every invariant",
      issues,
    );
    requireCondition(
      !report.fault.injected ||
        (report.fault.injectedAtVirtualMs !== null &&
          report.fault.injectedAtVirtualMs <= report.durationMs),
      "trust fault injection timestamp exceeds attempt duration",
      issues,
    );
  }
  requireCondition(
    report.fault.injected
      ? report.fault.injectedAtVirtualMs !== null
      : report.fault.injectedAtVirtualMs === null && report.outcome !== "passed",
    "trust fault injection timestamp/outcome is inconsistent",
    issues,
  );
  assertResetBinding(
    definition,
    reset,
    report.attemptId,
    report.resetReceiptDigest,
    issues,
  );
  requireCondition(
    reset.suiteManifestDigest === null &&
      reset.taskDocumentDigest === null &&
      reset.taskResetRecipeDigest === null &&
      reset.condition === null &&
      reset.scenarioId === report.scenarioId &&
      reset.seedSlot === report.seedSlot &&
      reset.systemConfigurationDigest === report.systemConfigurationDigest,
    "trust reset receipt does not bind the exact trust evaluation cell",
    issues,
  );
  requireCondition(
    compareUtcTimestamps(reset.createdAt, report.createdAt) <= 0,
    "trust reset receipt must not postdate its report",
    issues,
  );
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return report;
}
