import {
  EVAL_CONTRACT_VERSION,
  computePlannedExecutionOrderDigest,
  digestCanonicalJson,
  digestIssueText,
  sha256Digest,
  withDocumentDigest,
  type ContentArtifact,
  type EvidenceAnchorProvider,
  type HoldoutDescriptorDocument,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type SuiteManifestDocument,
  type SystemConfigurationPin,
} from "../../src/eval-contract/index.js";

export const FIXED_TIME = "2026-07-15T12:00:00Z";
export const LATER_TIME = "2026-07-15T12:00:01Z";
export const GIT_COMMIT = "a".repeat(40);

export function digest(label: string): `sha256:${string}` {
  return sha256Digest(label);
}

export function artifact(label: string, mediaType = "application/octet-stream"): ContentArtifact {
  const artifactDigest = digest(label);
  return {
    digest: artifactDigest,
    sizeBytes: Buffer.byteLength(label),
    mediaType,
    uri: `cas://sha256/${artifactDigest.slice("sha256:".length)}`,
  };
}

export function image(label: string): string {
  return `example.invalid/agenc/${label}@${digest(`image:${label}`)}`;
}

export function makeAnchorProvider(): EvidenceAnchorProvider {
  const anchorPolicyDigest = digest("anchor-policy");
  const verifierDigest = digest("anchor-verifier");
  const verificationMaterialDigest = digest("test-public-key");
  const signatureFor = (bytes: Uint8Array) => sha256Digest(
    Buffer.concat([Buffer.from("test-signature\0"), Buffer.from(bytes)]),
  );
  return {
    anchorPolicyDigest,
    verifierDigest,
    async anchor(statementBytes, statementDigest) {
      return {
        statementDigest,
        anchorPolicyDigest,
        signatureAlgorithm: "ed25519",
        signatureDigest: signatureFor(statementBytes),
        verificationMaterialDigest,
        anchorUri: `https://example.invalid/evidence/${statementDigest.slice("sha256:".length)}`,
        signerIdentity: "test-anchor",
      };
    },
    verify(statementBytes, receipt) {
      return receipt.signatureDigest === signatureFor(statementBytes) &&
        receipt.verificationMaterialDigest === verificationMaterialDigest;
    },
  };
}

export function makeOperatorTask(
  index = 0,
  split: "development" | "private_holdout" = "development",
): OperatorTaskDocument {
  const taskId = `task-${index}`;
  const issueText = `Repair the pinned defect for ${taskId}.`;
  return withDocumentDigest<OperatorTaskDocument>({
    kind: "agenc.eval.operator-task",
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId,
    taskVersion: "1.0.0",
    split,
    repository: {
      uri: `https://example.invalid/repositories/repo-${index}`,
      commit: GIT_COMMIT,
      cluster: `repo-${index}`,
      solutionHistory: "stripped",
    },
    setupPatch: artifact(`${taskId}:setup`, "text/x-diff"),
    issue: { text: issueText, digest: digestIssueText(issueText) },
    allowedTools: [{
      name: "shell",
      version: "1.0.0",
      manifestDigest: digest("tool:shell"),
      capabilities: ["read", "write", "execute"],
    }],
    networkPolicy: { mode: "none", allowlist: [], dns: "disabled" },
    permissionPolicy: {
      mode: "deny_by_default",
      policyDigest: digest("permission-policy"),
      allowedApprovalKinds: ["shell_mutation"],
    },
    budget: {
      currency: "USD",
      usd: "1.00",
      inputTokens: 10_000,
      outputTokens: 2_000,
      reasoningTokens: 2_000,
      cacheTokens: 10_000,
      totalTokens: 14_000,
      toolCalls: 100,
      turns: 20,
      wallTimeMs: 60_000,
    },
    expectedArtifacts: [{
      id: "patch",
      path: "result/solution.patch",
      mediaType: "text/x-diff",
      required: true,
      maxBytes: 1_000_000,
    }],
    environment: {
      image: image("task"),
      platform: "linux-amd64",
      hardwareClass: "standard-4",
      toolchain: [{ name: "node", version: "25.9.0", digest: digest("node:25.9.0") }],
    },
    resetRecipe: {
      id: "fresh-reset",
      digest: digest("reset:fresh"),
      workspace: "fresh_clone",
      cache: "empty",
      memory: "empty",
      session: "new",
      clock: "real",
    },
    hiddenVerifier: {
      id: `verifier-${index}`,
      version: "1.0.0",
      bundle: artifact(`${taskId}:verifier`),
      image: image("verifier"),
      command: ["node", "verify.mjs"],
      timeoutMs: 30_000,
      network: "none",
      publicCommitment: {
        algorithm: "hmac-sha256",
        keyId: "holdout-key-v1",
        digest: digest(`${taskId}:verifier-commitment`),
      },
      outputPolicy: { mode: "result_only", maxBytes: 4096, revealAssertions: false },
    },
    referenceSolution: {
      patch: artifact(`${taskId}:gold`, "text/x-diff"),
      validationEvidence: artifact(`${taskId}:gold-validation`, "application/json"),
      baseFailsTargetChecks: true,
      basePassesRegressionChecks: true,
      solutionPassesAllChecks: true,
    },
    provenance: {
      sourceType: split === "private_holdout" ? "private_authored" : "public_issue",
      authoredAt: FIXED_TIME,
      cutoffAt: "2026-07-01T00:00:00Z",
      repositoryWasPublic: true,
      issueWasPublic: split === "development",
      setupPatchWasPublic: split === "development",
      verifierWasPublic: split === "development",
      goldPatchWasPublic: split === "development",
      contaminationAuditDigest: digest(`${taskId}:contamination-audit`),
      status: "eligible",
      retirementReason: null,
    },
  });
}

export function makeSuite(
  split: "development" | "private_holdout" = "development",
): SuiteManifestDocument {
  const tasks = Array.from({ length: 10 }, (_, index) => makeOperatorTask(index, split));
  return withDocumentDigest<SuiteManifestDocument>({
    kind: "agenc.eval.suite-manifest",
    contractVersion: EVAL_CONTRACT_VERSION,
    suiteId: `${split}-suite`,
    suiteVersion: "1.0.0",
    split,
    createdAt: FIXED_TIME,
    repositoryFamilies: tasks.map((task) => ({
      cluster: task.repository.cluster,
      canonicalRepositoryUri: task.repository.uri,
      memberRepositoryUris: [task.repository.uri],
    })),
    tasks,
  });
}

export function makeHoldoutDescriptor(
  suite = makeSuite("private_holdout"),
): HoldoutDescriptorDocument {
  const repositoryCounts = new Map<string, number>();
  for (const task of suite.tasks) {
    repositoryCounts.set(
      task.repository.cluster,
      (repositoryCounts.get(task.repository.cluster) ?? 0) + 1,
    );
  }
  return withDocumentDigest<HoldoutDescriptorDocument>({
    kind: "agenc.eval.holdout-descriptor",
    contractVersion: EVAL_CONTRACT_VERSION,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    createdAt: FIXED_TIME,
    sealedAt: FIXED_TIME,
    taskCount: suite.tasks.length,
    repositoryCount: repositoryCounts.size,
    maximumTasksPerRepository: Math.max(...repositoryCounts.values()),
    taskManifestCommitment: {
      algorithm: "hmac-sha256",
      keyId: "selection-key-v1",
      digest: digest("task-selection"),
    },
    verifierRootCommitment: {
      algorithm: "hmac-sha256",
      keyId: "verifier-root-key-v1",
      digest: digest("verifier-root"),
    },
    repositoryFamilyMapCommitment: {
      algorithm: "hmac-sha256",
      keyId: "repository-family-key-v1",
      digest: digest("repository-family-map-commitment"),
    },
    accessPolicyDigest: digest("holdout-access-policy"),
    unsealPolicyDigest: digest("unblinding-policy"),
    custodianKeyId: "holdout-custodian-key-v1",
    custody: {
      mode: "separate_os_principal_or_remote_service",
      custodianIdentity: "test-holdout-custodian",
      implementerPrincipalSetDigest: digest("implementer-principals"),
      accessControlEvidenceDigest: digest("access-control-evidence"),
      custodyVerifierDigest: digest("holdout-custody-verifier"),
      accessLogRootCommitment: {
        algorithm: "hmac-sha256",
        keyId: "access-log-key-v1",
        digest: digest("access-log-root"),
      },
      projectionPolicyDigest: digest("projection-policy"),
    },
    status: "sealed",
  });
}

export function makeSystem(systemId: string): SystemConfigurationPin {
  return {
    systemId,
    name: systemId,
    lane: "matched_model",
    release: "1.0.0",
    repositoryUri: `https://example.invalid/systems/${systemId}`,
    commit: GIT_COMMIT,
    package: artifact(`system:${systemId}`),
    image: image(`system-${systemId}`),
    agentConfigDigest: digest(`${systemId}:agent-config`),
    publicConfigDigest: digest(`${systemId}:public-config`),
    redactedConfigFields: ["apiKey"],
    systemPromptDigest: digest(`${systemId}:system-prompt`),
    toolManifestDigest: digest("shared-tool-manifest"),
    provider: "test-provider",
    requestedModelId: "model-2026-07-01",
    immutableModelId: "model-2026-07-01-build-42",
    generationParameters: [{ name: "temperature", value: 0 }],
    retryPolicy: { maxAttempts: 1, retryableReasons: [], backoffDigest: digest("no-backoff") },
    approvalPolicy: {
      policyDigest: digest("approval-policy"),
      allowedKinds: ["shell_mutation"],
      undeclaredIntervention: "failure",
    },
    installCommandDigest: digest(`${systemId}:install-command`),
    environmentClassDigest: digest("shared-environment-class"),
    hardwareClass: "standard-4",
    networkPolicy: { mode: "none", allowlist: [], dns: "disabled" },
  };
}

export function makePreregistration(
  suite = makeSuite(),
  holdoutDescriptor?: HoldoutDescriptorDocument,
): PreregistrationDocument {
  const primary = makeSystem("agenc-primary");
  const comparator = makeSystem("comparator-one");
  const orderSeed = 424_242;
  return withDocumentDigest<PreregistrationDocument>({
    kind: "agenc.eval.preregistration",
    contractVersion: EVAL_CONTRACT_VERSION,
    experimentId: "experiment-one",
    claim: "diagnostic",
    createdAt: FIXED_TIME,
    lane: "matched_model",
    suite: {
      suiteId: suite.suiteId,
      suiteVersion: suite.suiteVersion,
      split: suite.split,
      manifestDigest: suite.documentDigest,
      holdoutDescriptorDigest: holdoutDescriptor?.documentDigest ?? null,
      taskSelectionCommitment: {
        algorithm: "hmac-sha256",
        keyId: "selection-key-v1",
        digest: digest("task-selection"),
      },
      repositoryFamilyMapDigest: digestCanonicalJson(
        "agenc.eval.repository-family-map.v1",
        suite.repositoryFamilies,
      ),
    },
    evaluator: {
      repositoryUri: "https://example.invalid/evaluator",
      commit: GIT_COMMIT,
      image: image("evaluator"),
      harnessConfigDigest: digest("harness-config"),
      toolchain: [{ name: "node", version: "25.9.0", digest: digest("node:25.9.0") }],
      analysisImplementation: artifact("analysis-implementation", "application/javascript"),
      trustAssessmentImplementation: artifact("trust-assessment", "application/javascript"),
    },
    primarySystemId: primary.systemId,
    systems: [primary, comparator],
    comparisons: [{
      comparisonId: "agenc-vs-one",
      primarySystemId: primary.systemId,
      comparatorSystemId: comparator.systemId,
    }],
    trialDesign: {
      repetitionsPerSystemTask: 1,
      seedSlots: [101],
      order: "randomized_interleave",
      orderAlgorithm: "sha256_fisher_yates_v1",
      orderSeed,
      plannedExecutionOrderDigest: computePlannedExecutionOrderDigest({
        systemIds: [primary.systemId, comparator.systemId],
        taskIds: suite.tasks.map((task) => task.taskId),
        seedSlots: [101],
        orderSeed,
      }),
    },
    resetPolicy: suite.tasks[0].resetRecipe,
    scoring: {
      primaryMetric: "trusted_fix_rate",
      taskWeighting: "equal",
      repetitionAggregation: "mean_within_task",
      repositoryCapPercent: 10,
      deterministicOutcomeOnly: true,
    },
    inference: {
      estimand: "paired_tfr_difference",
      targetPopulation: "preregistered_repository_task_population",
      pairKey: "task_id_and_seed_slot",
      trialAggregation: "mean_within_task_before_resampling",
      resamplingUnit: "whole_repository_cluster",
      clusterSampling: "uniform_with_replacement",
      trialResampling: "none",
      taskWeightingWithinResample: "equal",
      interval: "two_sided_percentile",
      lowerQuantile: "0.025",
      upperQuantile: "0.975",
      quantileMethod: "linear_type_7",
      randomStreamDerivation: "sha256_seed_and_comparison_id_first_u32_then_xorshift32_v1",
      multipleComparators: "intersection_union",
      successRule: "point_at_least_0.10_and_lower_above_0_for_every_comparator",
      method: "repository_clustered_paired_percentile_bootstrap",
      confidenceLevel: "0.95",
      alpha: "0.05",
      resamples: 10_000,
      randomSeed: 123_456,
      minimumEffectPercentagePoints: 10,
      targetPower: "0.80",
      powerAnalysisDigest: digest("power-analysis"),
    },
    samplePlan: {
      minimumTasks: 10,
      maximumTasks: 10,
      minimumRepositories: 10,
      stoppingRule: { kind: "fixed", taskCount: 10 },
    },
    exclusions: {
      allowedInfrastructureReasons: ["evaluator_host_failure"],
      classifierImplementation: artifact(
        "infrastructure-classifier",
        "application/javascript",
      ),
      classifierVersion: "1.0.0",
      infrastructureEvidenceRequired: true,
      infrastructurePairing: "comparison_pair_same_task_trial",
      unpairedInfrastructureInvalid: "reject_experiment",
      unsupported: "count_failure",
      timeout: "count_failure",
      crash: "count_failure",
      providerError: "count_failure",
      permissionDenial: "count_failure",
      budgetExhaustion: "count_failure",
    },
    evidencePolicy: {
      ledgerFormat: "jcs-ndjson-v1",
      maximumEventBytes: 1024 * 1024,
      maximumPayloadBytes: 16 * 1024 * 1024,
      maximumLedgerBytes: 64 * 1024 * 1024,
      maximumEvents: 100_000,
      redactionPolicyDigest: digest("redaction-policy"),
      anchorPolicyDigest: digest("anchor-policy"),
      anchorVerifierDigest: digest("anchor-verifier"),
      platformProtectionVerifierDigest: digest("test-platform-protection-verifier"),
    },
    unblinding: {
      state: "sealed",
      policyDigest: digest("unblinding-policy"),
      authorizedRole: "holdout-custodian",
    },
  });
}
