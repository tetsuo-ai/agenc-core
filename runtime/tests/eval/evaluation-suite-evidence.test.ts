import { describe, expect, it } from "vitest";
import competitiveJson from "../../eval/suites/competitive-coding/1.0.0/definition.json" with {
  type: "json",
};
import trustJson from "../../eval/suites/trust-conformance/1.0.0/definition.json" with {
  type: "json",
};
import {
  EVAL_CONTRACT_VERSION,
  projectTaskForAgent,
  withDocumentDigest,
  type Sha256Digest,
} from "../../src/eval-contract/index.js";
import {
  EVAL_SUITE_PROTOCOL_VERSION,
  EvalSuiteProtocolValidationError,
  compileCompetitiveFaultPlan,
  compileTrustFaultPlans,
  computeCompetitiveHarnessConfigDigest,
  computeEvalSuiteResetPolicyDigest,
  validateCompetitiveCodingReport,
  validateEvalSuiteEvidenceDocument,
  validateEvalSuiteResetReceipt,
  validateTrustConformanceReport,
  type CompetitiveCodingReportDocument,
  type CompetitiveCodingSuiteDefinitionDocument,
  type EvalSuiteDefinitionDocument,
  type EvalSuiteResetReceiptDocument,
  type TrustConformanceReportDocument,
  type TrustConformanceSuiteDefinitionDocument,
} from "../../src/eval-suites/index.js";
import { FIXED_TIME, GIT_COMMIT, digest, makeSuite } from "./evaluation-contract-fixtures.js";

const competitive = competitiveJson as unknown as CompetitiveCodingSuiteDefinitionDocument;
const trust = trustJson as unknown as TrustConformanceSuiteDefinitionDocument;

function resign<T extends { readonly documentDigest: Sha256Digest }>(
  value: T,
  transform: (draft: Record<string, unknown>) => void,
): T {
  const draft = structuredClone(value) as unknown as Record<string, unknown>;
  delete draft.documentDigest;
  transform(draft);
  return withDocumentDigest<T>(draft as Omit<T, "documentDigest">);
}

function makeResetReceipt(
  definition: EvalSuiteDefinitionDocument,
  attemptId: string,
  context: {
    suiteManifestDigest: Sha256Digest | null;
    taskDocumentDigest: Sha256Digest | null;
    taskResetRecipeDigest: Sha256Digest | null;
    condition: "clean" | "coordinator_process_kill" | "client_disconnect" | null;
    scenarioId: string | null;
    seedSlot: number;
    systemConfigurationDigest: Sha256Digest;
  },
): EvalSuiteResetReceiptDocument {
  return withDocumentDigest<EvalSuiteResetReceiptDocument>({
    kind: "agenc.eval.suite-reset-receipt",
    suiteProtocolVersion: EVAL_SUITE_PROTOCOL_VERSION,
    suiteDefinitionDigest: definition.documentDigest,
    attemptId,
    createdAt: FIXED_TIME,
    resetPolicyDigest: computeEvalSuiteResetPolicyDigest(definition),
    ...context,
    workspace: {
      state: "fresh_clone",
      repositoryCommit: GIT_COMMIT,
      workspaceFingerprint: digest(`${attemptId}:workspace`),
    },
    isolation: {
      productState: "empty",
      session: "new",
      cache: "empty",
      home: "isolated",
      toolHome: "isolated",
      temp: "isolated",
      sockets: "isolated",
      ports: "isolated",
      environment: "sanitized",
      evidenceDigest: digest(`${attemptId}:isolation`),
    },
    processTree: {
      before: "empty",
      after: "empty",
      evidenceDigest: digest(`${attemptId}:process-tree`),
    },
  });
}

describe("evaluation suite evidence protocol", () => {
  it("binds a competitive report to exact task bytes, budget, reset, and fault plan", () => {
    expect(EVAL_CONTRACT_VERSION).toBe("1.0.0");
    const suite = makeSuite();
    const task = suite.tasks[0];
    const attemptId = "competitive-attempt-1";
    const systemConfigurationDigest = digest("competitive-system-configuration");
    const reset = makeResetReceipt(competitive, attemptId, {
      suiteManifestDigest: suite.documentDigest,
      taskDocumentDigest: task.documentDigest,
      taskResetRecipeDigest: task.resetRecipe.digest,
      condition: "client_disconnect",
      scenarioId: null,
      seedSlot: 7,
      systemConfigurationDigest,
    });
    const plan = compileCompetitiveFaultPlan(competitive, suite, {
      condition: "client_disconnect",
      taskId: task.taskId,
      seedSlot: 7,
    });
    const report = withDocumentDigest<CompetitiveCodingReportDocument>({
      kind: "agenc.eval.competitive-coding-report",
      suiteProtocolVersion: EVAL_SUITE_PROTOCOL_VERSION,
      reportVersion: "1.0.0",
      createdAt: FIXED_TIME,
      attemptId,
      suite: {
        suiteClass: "competitive_coding",
        suiteId: competitive.suiteId,
        suiteVersion: competitive.suiteVersion,
        definitionDigest: competitive.documentDigest,
      },
      suiteManifestDigest: suite.documentDigest,
      condition: "client_disconnect",
      task: {
        taskId: task.taskId,
        taskVersion: task.taskVersion,
        taskDocumentDigest: task.documentDigest,
      },
      seedSlot: 7,
      harnessConfigDigest: computeCompetitiveHarnessConfigDigest(
        competitive,
        "client_disconnect",
      ),
      resetReceiptDigest: reset.documentDigest,
      runRecordDigest: digest("competitive-run-record"),
      systemConfigurationDigest,
      deliveryReceipt: {
        agentTaskDigest: projectTaskForAgent(task).documentDigest,
        acceptedAtMonotonicMs: 1_000,
        processGroupEvidenceDigest: digest("competitive-process-group"),
        transportEvidenceDigest: digest("competitive-transport"),
      },
      faultPlanDigest: plan.planDigest,
      fault: {
        scheduled: true,
        injected: true,
        scheduledDelayAfterAcceptanceMs: plan.delayAfterAcceptanceMs,
        observedInjectedAtMonotonicMs: 1_000 + plan.delayAfterAcceptanceMs + 10,
        evidenceDigest: digest("competitive-fault"),
      },
      verifier: { result: "passed", evidenceDigest: digest("competitive-verifier") },
      outcome: "verified_fix",
    });

    expect(validateEvalSuiteResetReceipt(competitive, reset)).toEqual(reset);
    expect(validateCompetitiveCodingReport(competitive, suite, reset, report)).toEqual(report);

    const wrongRepositoryReset = resign(reset, (draft) => {
      const workspace = draft.workspace as Record<string, unknown>;
      workspace.repositoryCommit = "b".repeat(40);
    });
    const wrongRepositoryReport = resign(report, (draft) => {
      draft.resetReceiptDigest = wrongRepositoryReset.documentDigest;
    });
    expect(() => validateCompetitiveCodingReport(
      competitive,
      suite,
      wrongRepositoryReset,
      wrongRepositoryReport,
    )).toThrow(/exact task repository and reset recipe/u);

    const wrongRecipeReset = resign(reset, (draft) => {
      draft.taskResetRecipeDigest = digest("wrong-reset-recipe");
    });
    const wrongRecipeReport = resign(report, (draft) => {
      draft.resetReceiptDigest = wrongRecipeReset.documentDigest;
    });
    expect(() => validateCompetitiveCodingReport(
      competitive,
      suite,
      wrongRecipeReset,
      wrongRecipeReport,
    )).toThrow(/exact task repository and reset recipe/u);

    const wrongCellReset = resign(reset, (draft) => {
      draft.seedSlot = 8;
    });
    const wrongCellReport = resign(report, (draft) => {
      draft.resetReceiptDigest = wrongCellReset.documentDigest;
    });
    expect(() => validateCompetitiveCodingReport(
      competitive,
      suite,
      wrongCellReset,
      wrongCellReport,
    )).toThrow(/exact competitive evaluation cell/u);

    const wrongTask = resign(report, (draft) => {
      const taskReference = draft.task as Record<string, unknown>;
      taskReference.taskDocumentDigest = digest("wrong-task");
    });
    expect(() =>
      validateCompetitiveCodingReport(competitive, suite, reset, wrongTask)
    ).toThrow(/task version or digest mismatch/u);

    const hiddenFault = resign(report, (draft) => {
      const fault = draft.fault as Record<string, unknown>;
      fault.injected = false;
      fault.observedInjectedAtMonotonicMs = null;
    });
    expect(() =>
      validateCompetitiveCodingReport(competitive, suite, reset, hiddenFault)
    ).toThrow(/fault_not_injected/u);
    const infrastructureInvalid = resign(hiddenFault, (draft) => {
      draft.outcome = "infrastructure_invalid";
    });
    expect(
      validateCompetitiveCodingReport(competitive, suite, reset, infrastructureInvalid),
    ).toEqual(infrastructureInvalid);

    const syntheticTask = resign(task, (draft) => {
      const provenance = draft.provenance as Record<string, unknown>;
      provenance.sourceType = "synthetic_diagnostic";
    });
    const syntheticSuite = resign(suite, (draft) => {
      const tasks = draft.tasks as unknown[];
      tasks[0] = syntheticTask;
    });
    const syntheticReport = resign(report, (draft) => {
      draft.suiteManifestDigest = syntheticSuite.documentDigest;
      draft.condition = "clean";
      draft.harnessConfigDigest = computeCompetitiveHarnessConfigDigest(competitive, "clean");
      const taskReference = draft.task as Record<string, unknown>;
      taskReference.taskDocumentDigest = syntheticTask.documentDigest;
      const delivery = draft.deliveryReceipt as Record<string, unknown>;
      delivery.agentTaskDigest = projectTaskForAgent(syntheticTask).documentDigest;
      draft.faultPlanDigest = null;
      draft.fault = {
        scheduled: false,
        injected: false,
        scheduledDelayAfterAcceptanceMs: null,
        observedInjectedAtMonotonicMs: null,
        evidenceDigest: null,
      };
    });
    expect(() =>
      validateCompetitiveCodingReport(competitive, syntheticSuite, reset, syntheticReport)
    ).toThrow(/real-repository task/u);
  });

  it("enforces trust plans, required evidence, exact invariants, and expected state", () => {
    const attemptId = "trust-attempt-1";
    const plan = compileTrustFaultPlans(trust, 11)[0];
    const systemConfigurationDigest = digest("trust-system-configuration");
    const reset = makeResetReceipt(trust, attemptId, {
      suiteManifestDigest: null,
      taskDocumentDigest: null,
      taskResetRecipeDigest: null,
      condition: null,
      scenarioId: plan.scenarioId,
      seedSlot: plan.seedSlot,
      systemConfigurationDigest,
    });
    const report = withDocumentDigest<TrustConformanceReportDocument>({
      kind: "agenc.eval.trust-conformance-report",
      suiteProtocolVersion: EVAL_SUITE_PROTOCOL_VERSION,
      reportVersion: "1.0.0",
      createdAt: FIXED_TIME,
      attemptId,
      suite: {
        suiteClass: "trust_conformance",
        suiteId: trust.suiteId,
        suiteVersion: trust.suiteVersion,
        definitionDigest: trust.documentDigest,
      },
      scenarioId: plan.scenarioId,
      faultClass: plan.faultClass,
      seedSlot: plan.seedSlot,
      faultPlanDigest: plan.planDigest,
      resetReceiptDigest: reset.documentDigest,
      runRecordDigest: digest("trust-run-record"),
      systemConfigurationDigest,
      harnessReceiptDigest: digest("trust-harness-receipt"),
      fault: {
        injected: true,
        injectedAtVirtualMs: 1,
        evidenceDigest: digest("trust-fault"),
      },
      durationMs: 1_000,
      invariantResults: plan.requiredInvariants.map((invariant) => ({
        invariant,
        passed: true,
        evidenceDigest: digest(`trust-invariant:${invariant}`),
      })),
      observedEvidenceTypes: plan.requiredEvidenceTypes,
      actualStateDigest: plan.expectedStateDigest,
      outcome: "passed",
    });

    expect(validateTrustConformanceReport(trust, reset, report)).toEqual(report);

    const missingEvidence = resign(report, (draft) => {
      const observed = draft.observedEvidenceTypes as string[];
      observed.pop();
    });
    expect(() => validateTrustConformanceReport(trust, reset, missingEvidence)).toThrow(
      /missing required evidence/u,
    );

    const wrongState = resign(report, (draft) => {
      draft.actualStateDigest = digest("wrong-final-state");
    });
    expect(() => validateTrustConformanceReport(trust, reset, wrongState)).toThrow(
      /expected state/u,
    );

    const failedInvariant = resign(report, (draft) => {
      const results = draft.invariantResults as Array<Record<string, unknown>>;
      results[0].passed = false;
    });
    expect(() => validateTrustConformanceReport(trust, reset, failedInvariant)).toThrow(
      /every invariant/u,
    );

    const missingFault = resign(report, (draft) => {
      const fault = draft.fault as Record<string, unknown>;
      fault.injected = false;
      fault.injectedAtVirtualMs = null;
    });
    expect(() => validateTrustConformanceReport(trust, reset, missingFault)).toThrow(
      /injected fault/u,
    );

    const retainedFailure = resign(report, (draft) => {
      draft.outcome = "failed";
      const fault = draft.fault as Record<string, unknown>;
      fault.injected = false;
      fault.injectedAtVirtualMs = null;
      draft.observedEvidenceTypes = [];
      const results = draft.invariantResults as Array<Record<string, unknown>>;
      results[0].passed = false;
    });
    expect(validateTrustConformanceReport(trust, reset, retainedFailure)).toEqual(
      retainedFailure,
    );

    const timedOutPass = resign(report, (draft) => {
      draft.durationMs = plan.timeoutMs + 1;
    });
    expect(() => validateTrustConformanceReport(trust, reset, timedOutPass)).toThrow(
      /timeout/u,
    );
  });

  it("rejects cross-kind and mixed report shapes", () => {
    const plan = compileTrustFaultPlans(trust, 1)[0];
    const reset = makeResetReceipt(trust, "trust-attempt-mixed", {
      suiteManifestDigest: null,
      taskDocumentDigest: null,
      taskResetRecipeDigest: null,
      condition: null,
      scenarioId: plan.scenarioId,
      seedSlot: plan.seedSlot,
      systemConfigurationDigest: digest("mixed-system-configuration"),
    });
    expect(() => validateEvalSuiteEvidenceDocument({
      ...reset,
      competitiveMetric: "verified_fix_rate_clean",
    })).toThrow(/unknown property competitiveMetric/u);

    expect(() => validateCompetitiveCodingReport(competitive, makeSuite(), reset, reset)).toThrow(
      EvalSuiteProtocolValidationError,
    );
  });
});
