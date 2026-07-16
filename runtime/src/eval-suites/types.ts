import type {
  EvalContractVersion,
  PreregistrationDocument,
  Sha256Digest,
  SuiteManifestDocument,
} from "../eval-contract/index.js";

export const EVAL_SUITE_PROTOCOL_VERSION = "1.0.0" as const;

export const RELEASED_EVAL_SUITE_V1_DIGESTS = Object.freeze({
  catalog: "sha256:531627aec0c3a287ebd568494e1a9c0dc8116f01d324a61d571d1a200e2bde62",
  competitive:
    "sha256:e7214668c3bd9d9299afb61ade397232f3e060d8a45ee7bd26ac87675514f69b",
  trust: "sha256:e83ad76587b4e0fa8897f29a7148ac3c1823e560eff86ea43fc4fec7105db811",
} as const);

export const COMPETITIVE_CONDITIONS = [
  "clean",
  "coordinator_process_kill",
  "client_disconnect",
] as const;

export const TRUST_FAULT_CLASSES = [
  "restart",
  "reconnect",
  "budget",
  "cancellation",
  "permission",
  "event_loss",
  "uncertain_effect",
] as const;

export type EvalSuiteProtocolVersion = typeof EVAL_SUITE_PROTOCOL_VERSION;
export type EvalSuiteClass = "competitive_coding" | "trust_conformance";
export type CompetitiveCondition = (typeof COMPETITIVE_CONDITIONS)[number];
export type CompetitiveFaultCondition = Exclude<CompetitiveCondition, "clean">;
export type TrustFaultClass = (typeof TRUST_FAULT_CLASSES)[number];

export interface EvalSuiteArtifactDescriptor {
  readonly path: string;
  readonly digest: Sha256Digest;
  readonly sizeBytes: number;
  readonly mediaType: "application/json";
}

export interface TrustFixtureState {
  readonly facts: readonly string[];
}

export interface TrustFixtureBundleDocument {
  readonly kind: "agenc.eval.trust-fixture-bundle";
  readonly bundleVersion: "1.0.0";
  readonly documentDigest: Sha256Digest;
  readonly createdAt: string;
  readonly harness: {
    readonly implementationId: "agenc-trust-state-machine";
    readonly implementationVersion: "1.0.0";
    readonly clock: "virtual_monotonic_ms";
    readonly scheduler: "seeded_replayable";
    readonly injectionSemantics: "exact_scenario_boundary";
  };
  readonly fakeProvider: {
    readonly fixtureId: "agenc-offline-fake-provider";
    readonly fixtureVersion: "1.0.0";
    readonly network: "disabled";
    readonly responseStates: readonly string[];
  };
  readonly fakeTools: {
    readonly fixtureId: "agenc-offline-fake-tools";
    readonly fixtureVersion: "1.0.0";
    readonly network: "disabled";
    readonly resultStates: readonly string[];
  };
  readonly scenarios: readonly {
    readonly scenarioId: string;
    readonly fixture: { readonly steps: readonly string[] };
    readonly initialState: TrustFixtureState;
    readonly expectedState: TrustFixtureState;
  }[];
}

export interface EvalSuiteChangeControl {
  readonly publishedVersionMutation: "forbidden";
  readonly taskOrScenarioChange: "new_suite_version";
  readonly scheduleOrScoringChange: "new_suite_version";
  readonly compatibility: "exact_kind_id_version_digest";
  readonly rollback: "select_prior_immutable_digest";
}

export interface EvalSuiteResetPolicy {
  readonly workspace: "fresh_clone";
  readonly productState: "empty";
  readonly session: "new";
  readonly cache: "empty";
  readonly home: "isolated";
  readonly toolHome: "isolated";
  readonly temp: "isolated";
  readonly sockets: "isolated";
  readonly ports: "isolated";
  readonly environment: "sanitized";
  readonly processTreeBeforeAndAfter: "empty";
  readonly receipt: "content_addressed_required";
}

export interface CompetitiveFaultAction {
  readonly condition: CompetitiveFaultCondition;
  readonly target: "coordinator_process_group" | "client_transport";
  readonly operation: "sigkill" | "abrupt_close";
  readonly recovery: "adapter_restart_and_attach" | "adapter_reconnect";
}

export interface CompetitiveCodingSuiteDefinitionDocument {
  readonly kind: "agenc.eval.competitive-suite-definition";
  readonly suiteProtocolVersion: EvalSuiteProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly suiteClass: "competitive_coding";
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly createdAt: string;
  readonly status: "active";
  readonly evaluationContractVersion: EvalContractVersion;
  readonly taskProtocol: {
    readonly taskKind: "real_repository_change";
    readonly operatorTaskKind: "agenc.eval.operator-task";
    readonly agentTaskKind: "agenc.eval.agent-task";
    readonly agentInputEquality: "exact_canonical_agent_task_bytes";
    readonly hiddenVerification: "out_of_workspace_result_only";
    readonly outputTruth: "external_workspace_patch_and_declared_artifacts";
    readonly containerReferences: "digest_only";
    readonly productSpecificTaskSemantics: "forbidden";
    readonly unsupportedCapability: "count_failure";
  };
  readonly adapterContract: {
    readonly version: "1.0.0";
    readonly operations: readonly [
      "start",
      "deliver_task_and_record_receipt",
      "disconnect_client_transport",
      "reconnect_client_transport",
      "kill_coordinator_process_group",
      "collect_result",
    ];
    readonly acceptanceSource: "harness_task_delivery_receipt";
    readonly resultTruth: "external_workspace_and_hidden_verifier";
    readonly productReportedCompletion: "diagnostic_only";
  };
  readonly resetPolicy: EvalSuiteResetPolicy;
  readonly conditions: readonly [
    "clean",
    "coordinator_process_kill",
    "client_disconnect",
  ];
  readonly faultSchedule: {
    readonly kind: "product_neutral_black_box_v1";
    readonly scheduleVersion: "1.0.0";
    readonly triggerSource: "harness_delivery_receipt_monotonic";
    readonly delayAlgorithm: "sha256_rejection_u32_v1";
    readonly seedDomain: "agenc.eval.competitive-fault-delay.v1";
    readonly minimumDelayMs: number;
    readonly maximumDelayMs: number;
    readonly recoveryWindowMs: number;
    readonly maximumInjectionJitterMs: number;
    readonly actions: readonly CompetitiveFaultAction[];
    readonly productProtocolObservation: "forbidden";
    readonly systemSpecificTriggerFields: "forbidden";
    readonly faultNotInjected: "count_failure";
  };
  readonly reporting: {
    readonly kind: "agenc.eval.competitive-coding-report";
    readonly version: "1.0.0";
    readonly primaryMetric: "verified_fix_rate_clean";
    readonly requiredMetrics: readonly string[];
    readonly allAttemptsInDenominator: true;
    readonly mixedSuiteAggregation: "forbidden";
    readonly separateFrom: "agenc.eval.trust-conformance-report";
    readonly trustConformanceMetrics: "forbidden";
  };
  readonly changeControl: EvalSuiteChangeControl;
}

export interface TrustScenarioDefinition {
  readonly scenarioId: string;
  readonly faultClass: TrustFaultClass;
  readonly injectionBoundary:
    | "after_reservation_before_model_result_commit"
    | "after_event_publish_before_cursor_ack"
    | "concurrent_child_reservation_before_commit"
    | "parent_cancel_after_child_admission"
    | "repository_requests_capability_escalation"
    | "retention_gap_before_reconnect"
    | "after_effect_dispatch_before_ack_commit";
  readonly faultAction:
    | "restart_product_process"
    | "disconnect_and_reconnect_client"
    | "race_sibling_budget_reservations"
    | "cancel_parent"
    | "inject_hostile_repository_instruction"
    | "evict_replay_window"
    | "drop_effect_acknowledgement";
  readonly requiredInvariants: readonly string[];
  readonly requiredEvidenceTypes: readonly string[];
  readonly fixtureDigest: Sha256Digest;
  readonly initialStateDigest: Sha256Digest;
  readonly expectedStateDigest: Sha256Digest;
  readonly timeoutMs: number;
}

export interface TrustConformanceSuiteDefinitionDocument {
  readonly kind: "agenc.eval.trust-suite-definition";
  readonly suiteProtocolVersion: EvalSuiteProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly suiteClass: "trust_conformance";
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly createdAt: string;
  readonly status: "active";
  readonly evaluationContractVersion: EvalContractVersion;
  readonly subject: "agenc_only";
  readonly execution: {
    readonly provider: "deterministic_offline_fake";
    readonly liveProviderCalls: "forbidden";
    readonly scheduler: "seeded_replayable";
    readonly seedAlgorithm: "sha256_domain_separated_v1";
    readonly seedDomain: "agenc.eval.trust-fault-plan.v1";
    readonly scenarioOrder: "lexicographic_scenario_id";
    readonly retries: "new_attempt_preserve_failed_evidence";
    readonly clock: "virtual_monotonic_ms";
    readonly network: "disabled";
    readonly harnessImplementationDigest: Sha256Digest;
    readonly fakeProviderFixtureDigest: Sha256Digest;
    readonly fakeToolFixtureDigest: Sha256Digest;
    readonly fixtureBundle: EvalSuiteArtifactDescriptor;
  };
  readonly resetPolicy: EvalSuiteResetPolicy;
  readonly scenarios: readonly TrustScenarioDefinition[];
  readonly reporting: {
    readonly kind: "agenc.eval.trust-conformance-report";
    readonly version: "1.0.0";
    readonly primaryMetric: "trust_recovery_rate";
    readonly requiredMetrics: readonly string[];
    readonly zeroToleranceMetrics: readonly string[];
    readonly allAttemptsInDenominator: true;
    readonly mixedSuiteAggregation: "forbidden";
    readonly separateFrom: "agenc.eval.competitive-coding-report";
    readonly codingQualityMetrics: "forbidden";
  };
  readonly changeControl: EvalSuiteChangeControl;
}

export type EvalSuiteDefinitionDocument =
  | CompetitiveCodingSuiteDefinitionDocument
  | TrustConformanceSuiteDefinitionDocument;

export interface EvalSuiteCatalogEntry {
  readonly suiteClass: EvalSuiteClass;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly definitionDigest: Sha256Digest;
  readonly path: string;
}

export interface EvalSuiteCatalogDocument {
  readonly kind: "agenc.eval.suite-catalog";
  readonly suiteProtocolVersion: EvalSuiteProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly createdAt: string;
  readonly activeDefinitions: readonly EvalSuiteCatalogEntry[];
}

export type EvalSuiteProtocolDocument = EvalSuiteDefinitionDocument | EvalSuiteCatalogDocument;

export interface CompetitiveFaultPlan {
  readonly kind: "agenc.eval.competitive-fault-plan";
  readonly suiteDefinitionDigest: Sha256Digest;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly suiteManifestDigest: Sha256Digest;
  readonly condition: CompetitiveFaultCondition;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly taskDocumentDigest: Sha256Digest;
  readonly taskWallTimeMs: number;
  readonly seedSlot: number;
  readonly delayAfterAcceptanceMs: number;
  readonly maximumDelayAfterAcceptanceMs: number;
  readonly recoveryWindowMs: number;
  readonly maximumInjectionJitterMs: number;
  readonly target: CompetitiveFaultAction["target"];
  readonly operation: CompetitiveFaultAction["operation"];
  readonly recovery: CompetitiveFaultAction["recovery"];
  readonly planDigest: Sha256Digest;
}

export interface TrustFaultPlan {
  readonly kind: "agenc.eval.trust-fault-plan";
  readonly suiteDefinitionDigest: Sha256Digest;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly scenarioId: string;
  readonly faultClass: TrustFaultClass;
  readonly seedSlot: number;
  readonly scenarioSeedDigest: Sha256Digest;
  readonly scheduleOrdinal: number;
  readonly injectionBoundary: TrustScenarioDefinition["injectionBoundary"];
  readonly faultAction: TrustScenarioDefinition["faultAction"];
  readonly timeoutMs: number;
  readonly requiredInvariants: readonly string[];
  readonly requiredEvidenceTypes: readonly string[];
  readonly harnessConfigDigest: Sha256Digest;
  readonly harnessImplementationDigest: Sha256Digest;
  readonly fakeProviderFixtureDigest: Sha256Digest;
  readonly fakeToolFixtureDigest: Sha256Digest;
  readonly fixtureDigest: Sha256Digest;
  readonly initialStateDigest: Sha256Digest;
  readonly expectedStateDigest: Sha256Digest;
  readonly planDigest: Sha256Digest;
}

export interface EvalSuiteResetReceiptDocument {
  readonly kind: "agenc.eval.suite-reset-receipt";
  readonly suiteProtocolVersion: EvalSuiteProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly suiteDefinitionDigest: Sha256Digest;
  readonly attemptId: string;
  readonly createdAt: string;
  readonly resetPolicyDigest: Sha256Digest;
  readonly suiteManifestDigest: Sha256Digest | null;
  readonly taskDocumentDigest: Sha256Digest | null;
  readonly taskResetRecipeDigest: Sha256Digest | null;
  readonly condition: CompetitiveCondition | null;
  readonly scenarioId: string | null;
  readonly seedSlot: number;
  readonly systemConfigurationDigest: Sha256Digest;
  readonly workspace: {
    readonly state: "fresh_clone";
    readonly repositoryCommit: string;
    readonly workspaceFingerprint: Sha256Digest;
  };
  readonly isolation: {
    readonly productState: "empty";
    readonly session: "new";
    readonly cache: "empty";
    readonly home: "isolated";
    readonly toolHome: "isolated";
    readonly temp: "isolated";
    readonly sockets: "isolated";
    readonly ports: "isolated";
    readonly environment: "sanitized";
    readonly evidenceDigest: Sha256Digest;
  };
  readonly processTree: {
    readonly before: "empty";
    readonly after: "empty";
    readonly evidenceDigest: Sha256Digest;
  };
}

export interface EvalSuiteReference {
  readonly suiteClass: EvalSuiteClass;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly definitionDigest: Sha256Digest;
}

export interface CompetitiveCodingReportDocument {
  readonly kind: "agenc.eval.competitive-coding-report";
  readonly suiteProtocolVersion: EvalSuiteProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly reportVersion: "1.0.0";
  readonly createdAt: string;
  readonly attemptId: string;
  readonly suite: EvalSuiteReference & { readonly suiteClass: "competitive_coding" };
  readonly suiteManifestDigest: Sha256Digest;
  readonly condition: CompetitiveCondition;
  readonly task: {
    readonly taskId: string;
    readonly taskVersion: string;
    readonly taskDocumentDigest: Sha256Digest;
  };
  readonly seedSlot: number;
  readonly harnessConfigDigest: Sha256Digest;
  readonly resetReceiptDigest: Sha256Digest;
  readonly runRecordDigest: Sha256Digest;
  readonly systemConfigurationDigest: Sha256Digest;
  readonly deliveryReceipt: {
    readonly agentTaskDigest: Sha256Digest;
    readonly acceptedAtMonotonicMs: number;
    readonly processGroupEvidenceDigest: Sha256Digest;
    readonly transportEvidenceDigest: Sha256Digest;
  };
  readonly faultPlanDigest: Sha256Digest | null;
  readonly fault: {
    readonly scheduled: boolean;
    readonly injected: boolean;
    readonly scheduledDelayAfterAcceptanceMs: number | null;
    readonly observedInjectedAtMonotonicMs: number | null;
    readonly evidenceDigest: Sha256Digest | null;
  };
  readonly verifier: {
    readonly result: "passed" | "failed" | "error";
    readonly evidenceDigest: Sha256Digest;
  };
  readonly outcome:
    | "verified_fix"
    | "verification_failure"
    | "unsupported"
    | "fault_not_injected"
    | "infrastructure_invalid";
}

export interface TrustConformanceReportDocument {
  readonly kind: "agenc.eval.trust-conformance-report";
  readonly suiteProtocolVersion: EvalSuiteProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly reportVersion: "1.0.0";
  readonly createdAt: string;
  readonly attemptId: string;
  readonly suite: EvalSuiteReference & { readonly suiteClass: "trust_conformance" };
  readonly scenarioId: string;
  readonly faultClass: TrustFaultClass;
  readonly seedSlot: number;
  readonly faultPlanDigest: Sha256Digest;
  readonly resetReceiptDigest: Sha256Digest;
  readonly runRecordDigest: Sha256Digest;
  readonly systemConfigurationDigest: Sha256Digest;
  readonly harnessReceiptDigest: Sha256Digest;
  readonly fault: {
    readonly injected: boolean;
    readonly injectedAtVirtualMs: number | null;
    readonly evidenceDigest: Sha256Digest;
  };
  readonly durationMs: number;
  readonly invariantResults: readonly {
    readonly invariant: string;
    readonly passed: boolean;
    readonly evidenceDigest: Sha256Digest;
  }[];
  readonly observedEvidenceTypes: readonly string[];
  readonly actualStateDigest: Sha256Digest;
  readonly outcome: "passed" | "failed" | "infrastructure_invalid";
}

export type EvalSuiteEvidenceDocument =
  | EvalSuiteResetReceiptDocument
  | CompetitiveCodingReportDocument
  | TrustConformanceReportDocument;

export interface CompetitiveConditionRegistration {
  readonly condition: CompetitiveCondition;
  readonly suite: SuiteManifestDocument;
  readonly preregistration: PreregistrationDocument;
}

export interface ValidatedEvalSuiteCatalog {
  readonly catalog: EvalSuiteCatalogDocument;
  readonly competitive: CompetitiveCodingSuiteDefinitionDocument;
  readonly trust: TrustConformanceSuiteDefinitionDocument;
}
