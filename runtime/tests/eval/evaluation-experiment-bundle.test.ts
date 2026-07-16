import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  EVAL_CONTRACT_VERSION,
  appendEvidenceEvent,
  canonicalizeJson,
  computePairedTfrEffect,
  computeRepositoryClusteredPercentileInterval,
  computePlannedExecutionOrderDigest,
  createHoldoutAccessStatement,
  createInfrastructureClassificationStatement,
  createTrustAssessmentStatement,
  compareUtcTimestamps,
  deriveExperimentSummary,
  digestCanonicalJson,
  derivePlannedExecutionOrder,
  initializeEvidenceLedger,
  projectTaskForAgent,
  sha256Digest,
  sealEvidenceLedger,
  validateEvalContractDocument,
  validateDerivedSummaryAgainstBundle,
  validateEvaluationBundle,
  verifyEvidenceLedger,
  withDocumentDigest,
  type BlindedResultsSealDocument,
  type DerivedSummaryDocument,
  type ExpectedArtifact,
  type EvidenceEventType,
  type HoldoutAccessReceiptDocument,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type PreregistrationReceiptDocument,
  type RecordedRunArtifact,
  type RunRecordDocument,
  type SuiteManifestDocument,
  type UnblindingRecordDocument,
  type VerifiedEvidenceLedger,
} from "../../src/eval-contract/index.js";
import {
  GIT_COMMIT,
  digest,
  makeAnchorProvider,
  makeHoldoutDescriptor,
  makePreregistration,
  makeSuite,
  makeSystem,
} from "./evaluation-contract-fixtures.js";

let root: string;

const platformProtection = {
  verifierDigest: digest("test-platform-protection-verifier"),
  async verify() {
    return true;
  },
} as const;

function access() {
  return { root, platformProtection } as const;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agenc-eval-bundle-"));
  await chmod(root, 0o700);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function requiredArtifacts(
  runId: string,
  expected: ExpectedArtifact,
): Array<{ readonly record: RecordedRunArtifact; readonly bytes: Buffer }> {
  const roles = [
    "patch",
    "changed_files",
    "test_result",
    "independent_review",
    "cost_usage",
    "approval_log",
    "effect_log",
    "risk_register",
  ] as const;
  return roles.map((role) => {
    const bytes = Buffer.from(`${runId}:${role}`, "utf8");
    const artifactDigest = sha256Digest(bytes);
    return {
      bytes,
      record: {
        artifactId: `${runId}-${role}`,
        expectedArtifactId: role === "patch" ? expected.id : null,
        path: role === "patch" ? expected.path : null,
        role,
        digest: artifactDigest,
        sizeBytes: bytes.byteLength,
        mediaType: role === "patch" ? expected.mediaType : "application/json",
        uri: `cas://sha256/${artifactDigest.slice("sha256:".length)}`,
      },
    };
  });
}

function evidenceReference(verified: VerifiedEvidenceLedger): RunRecordDocument["evidence"] {
  const { inspection, seal } = verified;
  if (!inspection.genesisEventDigest || !inspection.headEventDigest) throw new Error("empty test ledger");
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
    statementDigest: seal.receipt.statementDigest,
    anchorPolicyDigest: seal.receipt.anchorPolicyDigest,
    signatureAlgorithm: seal.receipt.signatureAlgorithm,
    signatureDigest: seal.receipt.signatureDigest,
    verificationMaterialDigest: seal.receipt.verificationMaterialDigest,
    anchorUri: seal.receipt.anchorUri,
    signerIdentity: seal.receipt.signerIdentity,
    sealedAt: seal.statement.sealedAt,
  };
}

describe("cross-document evaluation bundle", () => {
  test("fails closed with a typed error for structurally malformed bundles", async () => {
    const malformed = {
      suite: {},
      preregistration: {},
      preregistrationReceipt: {},
      blindedResultsSeal: {},
      unblindingRecord: {},
      runs: [],
      verifiedEvidence: [],
      lifecycleAnchors: {
        verifyPreregistrationReceipt: () => true,
      },
    } as unknown as Parameters<typeof validateEvaluationBundle>[0];

    await expect(validateEvaluationBundle(malformed)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("must have required property")]),
    });
    await expect(validateEvaluationBundle({
      ...malformed,
      suite: false,
    } as never)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("suite must be a document object")]),
    });
    await expect(validateEvaluationBundle({
      ...malformed,
      runs: [null],
    } as never)).rejects.toMatchObject({ name: "EvaluationBundleValidationError" });
    await expect(validateEvaluationBundle({
      ...malformed,
      runs: [undefined],
    } as never)).rejects.toMatchObject({ name: "EvaluationBundleValidationError" });
    await expect(validateEvaluationBundle({
      ...malformed,
      runs: new Array(1),
    } as never)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("runs must be a dense array")]),
    });
  });

  test("derives the complete equal-task scorecard from anchored planned cells", async () => {
    const suite = makeSuite("private_holdout");
    const holdoutDescriptor = makeHoldoutDescriptor(suite);
    const basePreregistration = makePreregistration(suite, holdoutDescriptor);
    const secondComparator = makeSystem("comparator-two");
    const seedSlots = [101, 202] as const;
    const preregistration = withDocumentDigest<PreregistrationDocument>({
      ...basePreregistration,
      systems: [...basePreregistration.systems, secondComparator],
      comparisons: [
        ...basePreregistration.comparisons,
        {
          comparisonId: "agenc-vs-two",
          primarySystemId: basePreregistration.primarySystemId,
          comparatorSystemId: secondComparator.systemId,
        },
      ],
      trialDesign: {
        ...basePreregistration.trialDesign,
        repetitionsPerSystemTask: seedSlots.length,
        seedSlots,
        plannedExecutionOrderDigest: computePlannedExecutionOrderDigest({
          systemIds: [...basePreregistration.systems, secondComparator]
            .map((system) => system.systemId),
          taskIds: suite.tasks.map((task) => task.taskId),
          seedSlots,
          orderSeed: basePreregistration.trialDesign.orderSeed,
        }),
      },
    });
    const provider = makeAnchorProvider();
    const preregistrationBytes = Buffer.from(canonicalizeJson(preregistration), "utf8");
    const preregistrationStatementDigest = digestCanonicalJson(
      "agenc.eval.preregistration-statement.v1",
      preregistration,
    );
    const preregistrationAnchor = await provider.anchor(
      preregistrationBytes,
      preregistrationStatementDigest,
    );
    const preregistrationReceipt = withDocumentDigest<PreregistrationReceiptDocument>({
      kind: "agenc.eval.preregistration-receipt",
      contractVersion: EVAL_CONTRACT_VERSION,
      preregistrationDigest: preregistration.documentDigest,
      ...preregistrationAnchor,
      anchoredAt: "2026-07-15T12:00:01Z",
    });

    const plannedOrder = derivePlannedExecutionOrder({
      systemIds: preregistration.systems.map((system) => system.systemId),
      taskIds: suite.tasks.map((task) => task.taskId),
      seedSlots: preregistration.trialDesign.seedSlots,
      orderSeed: preregistration.trialDesign.orderSeed,
    });
    const executionIndexByCell = new Map(plannedOrder.map((cell, index) => [
      `${cell.systemId}\u0000${cell.taskId}\u0000${cell.seedSlot}`,
      index,
    ]));
    const timestampAt = (executionIndex: number, offsetNanoseconds: number) =>
      `2026-07-15T12:00:02.${String(
        executionIndex * 1_000 + offsetNanoseconds,
      ).padStart(9, "0")}Z`;

    const runs: RunRecordDocument[] = [];
    const verifiedEvidence: VerifiedEvidenceLedger[] = [];
    for (const system of preregistration.systems) {
      const primary = system.systemId === preregistration.primarySystemId;
      for (const task of suite.tasks) {
        for (const seedSlot of preregistration.trialDesign.seedSlots) {
        const runId = `${system.systemId}-${task.taskId}-${seedSlot}`;
        const executionIndex = executionIndexByCell.get(
          `${system.systemId}\u0000${task.taskId}\u0000${seedSlot}`,
        );
        if (executionIndex === undefined) throw new Error("missing planned execution cell");
        const startedAt = timestampAt(executionIndex, 0);
        const evidenceAt = timestampAt(executionIndex, 2);
        const finishedAt = timestampAt(executionIndex, 10);
        const sealedAt = timestampAt(executionIndex, 12);
        const context = {
          runId,
          contractDigest: preregistration.documentDigest,
          taskId: task.taskId,
          systemId: system.systemId,
        } as const;
        const infrastructureInvalid =
          task.taskId === suite.tasks[0].taskId &&
          seedSlot === seedSlots[0] &&
          (system.systemId === preregistration.primarySystemId ||
            system.systemId === "comparator-one");
        const crossedSeedSuccess =
          system.systemId === "comparator-one" &&
          task.taskId === suite.tasks[0].taskId &&
          seedSlot === seedSlots[1];
        const successfulFix = !infrastructureInvalid && (primary || crossedSeedSuccess);
        await initializeEvidenceLedger(access(), runId);
        await appendEvidenceEvent({
          ...access(),
          event: {
            ...context,
            eventId: `${runId}-start`,
            occurredAt: startedAt,
            producer: {
              identity: "test-evaluator",
              version: "1.0.0",
              binaryDigest: preregistration.evaluator.analysisImplementation.digest,
            },
            type: "run.started",
            mediaType: "application/json",
            redactionPolicyDigest: preregistration.evidencePolicy.redactionPolicyDigest,
          },
          payloadBytes: Buffer.from(`{\"runId\":${JSON.stringify(runId)}}`),
        });
        const expectedArtifact = task.expectedArtifacts[0];
        if (!expectedArtifact) throw new Error("test task is missing its required artifact");
        const artifactEntries = requiredArtifacts(runId, expectedArtifact);
        const appendTypedEvidence = async (
          type: EvidenceEventType,
          label: string,
          payloadBytes: Buffer,
          mediaType = "application/json",
          binaryDigest = preregistration.evaluator.analysisImplementation.digest,
        ) => (await appendEvidenceEvent({
          ...access(),
          event: {
            ...context,
            eventId: `${runId}-${label}`,
            occurredAt: evidenceAt,
            producer: { identity: "test-evaluator", version: "1.0.0", binaryDigest },
            type,
            mediaType,
            redactionPolicyDigest: preregistration.evidencePolicy.redactionPolicyDigest,
          },
          payloadBytes,
        })).event.payload.digest;
        const artifactEvidence: Array<`sha256:${string}`> = [];
        for (const entry of artifactEntries) {
          const eventType = entry.record.role === "independent_review"
            ? "review.completed"
            : entry.record.role === "risk_register"
              ? "risk.recorded"
              : "artifact.recorded";
          artifactEvidence.push(await appendTypedEvidence(
            eventType,
            `artifact-${entry.record.role}`,
            entry.bytes,
            entry.record.mediaType,
          ));
        }
        const policyEvidence = [];
        for (const type of [
          "budget.reconciled",
          "policy.evaluated",
          "sandbox.evaluated",
          "usage.reported",
        ] as const) {
          policyEvidence.push(await appendTypedEvidence(type, type.replace(".", "-"), Buffer.from(type)));
        }
        const effectEvidence = await appendTypedEvidence(
          "effect.result",
          "effect-result",
          Buffer.from("{\"duplicated\":0,\"unknown\":0}"),
        );
        const unknownEffectEvidence = successfulFix
          ? null
          : await appendTypedEvidence(
            "effect.unknown_outcome",
            "effect-unknown-outcome",
            Buffer.from("{\"unresolved\":1}"),
          );
        const recoveryEvidence = await appendTypedEvidence(
          "recovery.assessed",
          "recovery-assessed",
          Buffer.from("{\"faults\":0,\"gaps\":0}"),
        );
        const eventGapEvidence = successfulFix
          ? null
          : await appendTypedEvidence(
            "event.gap",
            "event-gap",
            Buffer.from("{\"gaps\":1}"),
          );
        const interventionEvidence = await appendTypedEvidence(
          "intervention.recorded",
          "intervention-recorded",
          Buffer.from("{\"undeclared\":0}"),
        );
        const verifierEvidence = await appendTypedEvidence(
          "verifier.completed",
          "verifier-completed",
          Buffer.from(successfulFix ? "{\"passed\":true}" : "{\"passed\":false}"),
        );
        const counterpartRunId = primary
          ? `comparator-one-${task.taskId}-${seedSlot}`
          : `${preregistration.primarySystemId}-${task.taskId}-${seedSlot}`;
        const classifierStatement = infrastructureInvalid
          ? createInfrastructureClassificationStatement({
            comparisonId: "agenc-vs-one",
            taskId: task.taskId,
            seedSlot,
            incidentId: "evaluator-incident-one",
            reason: "evaluator_host_failure",
            classifierVersion: preregistration.exclusions.classifierVersion,
            classifierImplementationDigest:
              preregistration.exclusions.classifierImplementation.digest,
          })
          : null;
        const classifierEvidence = classifierStatement
          ? await appendTypedEvidence(
            "infrastructure.classified",
            "infrastructure-classified",
            Buffer.from(canonicalizeJson(classifierStatement)),
            "application/vnd.agenc.eval-infrastructure-classification+json",
            preregistration.exclusions.classifierImplementation.digest,
          )
          : null;
        const infrastructureInvalidPairs = classifierEvidence
          ? [{
            comparisonId: "agenc-vs-one",
            counterpartRunId,
            reason: "evaluator_host_failure" as const,
            incidentId: "evaluator-incident-one",
            evidenceDigest: classifierEvidence,
            classifierVersion: preregistration.exclusions.classifierVersion,
            classifierImplementationDigest:
              preregistration.exclusions.classifierImplementation.digest,
          }]
          : [];
        const hiddenVerifier = {
          status: successfulFix ? "passed" as const : "failed" as const,
          evidenceDigests: [verifierEvidence],
          inaccessibleDuringRun: true,
          deterministicAssertionsPassed: successfulFix,
        };
        const criteria = {
          hiddenVerifier,
          policyAndBudget: {
            status: "passed" as const,
            evidenceDigests: policyEvidence,
            permissionEscapes: 0,
            sandboxEscapes: 0,
            concurrencyEscapes: 0,
            budgetOverruns: 0,
            unresolvedUsageFullyReserved: true,
          },
          effectSafety: {
            status: successfulFix ? "passed" as const : "failed" as const,
            evidenceDigests: [effectEvidence, ...(unknownEffectEvidence ? [unknownEffectEvidence] : [])],
            duplicatedUncertainMutations: 0,
            unsafeAutomaticRetries: 0,
            unresolvedUnknownOutcomes: successfulFix ? 0 : 1,
          },
          recoveryIntegrity: {
            status: successfulFix ? "passed" as const : "failed" as const,
            evidenceDigests: [recoveryEvidence, ...(eventGapEvidence ? [eventGapEvidence] : [])],
            scheduledFaults: 0,
            successfulRecoveries: 0,
            eventGaps: successfulFix ? 0 : 1,
            hiddenEventLoss: 0,
          },
          evidenceBundle: {
            status: "passed" as const,
            evidenceDigests: artifactEvidence,
            schemaValid: true,
            hashesValid: true,
            unresolvedReviewBlockers: 0,
            missingRequiredArtifacts: 0,
          },
          interventionFree: {
            status: "passed" as const,
            evidenceDigests: [interventionEvidence],
            undeclaredInterventions: 0,
          },
        };
        const usage = {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 130,
          providerCost: {
            status: "reported" as const,
            amount: "0.01" as const,
            currency: "USD" as const,
            source: "provider_reported" as const,
          },
          toolCalls: 2,
          turns: 1,
          retries: 0,
        };
        const artifacts = artifactEntries.map((entry) => entry.record);
        const verifier = {
          verifierId: task.hiddenVerifier.id,
          verifierVersion: task.hiddenVerifier.version,
          bundleDigest: task.hiddenVerifier.bundle.digest,
          result: successfulFix ? "passed" as const : "failed" as const,
          assertionCount: 1,
          passedAssertions: successfulFix ? 1 : 0,
          evidenceDigest: verifierEvidence,
        };
        const trustAssessment = {
          status: "assessed" as const,
          trustedFix: successfulFix,
          assessmentImplementationDigest:
            preregistration.evaluator.trustAssessmentImplementation.digest,
          criteria,
        };
        const outcome = infrastructureInvalid
          ? "infrastructure_invalid" as const
          : successfulFix ? "pass" as const : "fail" as const;
        const attestationBytes = Buffer.from(canonicalizeJson(createTrustAssessmentStatement({
          runId,
          experimentId: preregistration.experimentId,
          taskId: task.taskId,
          systemId: system.systemId,
          startedAt,
          finishedAt,
          outcome,
          verifiedFix: successfulFix,
          usage,
          approvals: [],
          interventions: [],
          artifacts,
          verifier,
          trustAssessment,
          infrastructureInvalidPairs,
        })), "utf8");
        await appendTypedEvidence(
          "trust.assessed",
          "trust-assessed",
          attestationBytes,
          "application/vnd.agenc.eval-trust-assessment+json",
          preregistration.evaluator.trustAssessmentImplementation.digest,
        );
        await appendEvidenceEvent({
          ...access(),
          event: {
            ...context,
            eventId: `${runId}-finish`,
            occurredAt: finishedAt,
            producer: {
              identity: "test-evaluator",
              version: "1.0.0",
              binaryDigest: preregistration.evaluator.analysisImplementation.digest,
            },
            type: "run.finished",
            mediaType: "application/json",
            redactionPolicyDigest: preregistration.evidencePolicy.redactionPolicyDigest,
          },
          payloadBytes: Buffer.from(canonicalizeJson({ outcome })),
        });
        const seal = await sealEvidenceLedger({
          ...access(),
          context,
          sealedAt,
          anchorProvider: provider,
        });
        const verified = await verifyEvidenceLedger({
          ...access(),
          runId,
          expectedSealDigest: seal.sealDigest,
          anchorVerifier: provider,
        });
        verifiedEvidence.push(verified);
        const runEvidence = evidenceReference(verified);
        const agentTask = projectTaskForAgent(task);
        const run = withDocumentDigest<RunRecordDocument>({
          kind: "agenc.eval.run-record",
          contractVersion: EVAL_CONTRACT_VERSION,
          runId,
          experimentId: preregistration.experimentId,
          preregistrationDigest: preregistration.documentDigest,
          preregistrationReceiptDigest: preregistrationReceipt.documentDigest,
          suiteManifestDigest: suite.documentDigest,
          taskId: task.taskId,
          operatorTaskDigest: task.documentDigest,
          agentTaskDigest: agentTask.documentDigest,
          repositoryCluster: task.repository.cluster,
          systemId: system.systemId,
          trialIndex: preregistration.trialDesign.seedSlots.indexOf(seedSlot),
          seedSlot,
          executionIndex,
          startedAt,
          finishedAt,
          wallTimeMs: Date.parse(finishedAt) - Date.parse(startedAt),
          evaluator: {
            commit: preregistration.evaluator.commit,
            image: preregistration.evaluator.image,
            harnessConfigDigest: preregistration.evaluator.harnessConfigDigest,
            analysisImplementationDigest: preregistration.evaluator.analysisImplementation.digest,
            trustAssessmentImplementationDigest:
              preregistration.evaluator.trustAssessmentImplementation.digest,
          },
          system: {
            systemId: system.systemId,
            release: system.release,
            commit: system.commit,
            packageDigest: system.package.digest,
            image: system.image,
            agentConfigDigest: system.agentConfigDigest,
            publicConfigDigest: system.publicConfigDigest,
            redactedConfigFields: system.redactedConfigFields,
            systemPromptDigest: system.systemPromptDigest,
            toolManifestDigest: system.toolManifestDigest,
            installCommandDigest: system.installCommandDigest,
            environmentClassDigest: system.environmentClassDigest,
            provider: system.provider,
            requestedModelId: system.requestedModelId,
            immutableModelId: system.immutableModelId,
            providerReportedModelId: system.immutableModelId,
            generationParameters: system.generationParameters,
            retryPolicy: system.retryPolicy,
            approvalPolicy: system.approvalPolicy,
          },
          environment: {
            operatingSystem: "linux",
            architecture: "x64",
            kernel: "test-kernel",
            platform: task.environment.platform,
            hardwareClass: task.environment.hardwareClass,
            image: task.environment.image,
            toolchain: task.environment.toolchain,
            networkPolicy: task.networkPolicy,
            permissionPolicyDigest: task.permissionPolicy.policyDigest,
          },
          resetReceipt: {
            recipeDigest: preregistration.resetPolicy.digest,
            repositoryCommit: task.repository.commit,
            workspaceFingerprint: digest(`${runId}:workspace`),
            cacheEmpty: true,
            memoryEmpty: true,
            sessionFresh: true,
          },
          usage,
          approvals: [],
          interventions: [],
          artifacts,
          verifier,
          evidence: runEvidence,
          outcome,
          verifiedFix: successfulFix,
          trustAssessment,
          infrastructureInvalidPairs,
        });
        runs.push(run);
        }
      }
    }

    const verifiedButExposedSource = runs.find((run) => run.verifiedFix);
    if (!verifiedButExposedSource || verifiedButExposedSource.trustAssessment.status !== "assessed") {
      throw new Error("missing assessed verified run fixture");
    }
    const { documentDigest: _sourceDigest, ...verifiedButExposedBody } = verifiedButExposedSource;
    const verifiedButExposed = withDocumentDigest<RunRecordDocument>({
      ...verifiedButExposedBody,
      trustAssessment: {
        ...verifiedButExposedSource.trustAssessment,
        trustedFix: false,
        criteria: {
          ...verifiedButExposedSource.trustAssessment.criteria,
          hiddenVerifier: {
            ...verifiedButExposedSource.trustAssessment.criteria.hiddenVerifier,
            status: "failed",
            inaccessibleDuringRun: false,
          },
        },
      },
    });
    expect(validateEvalContractDocument(verifiedButExposed)).toMatchObject({
      verifiedFix: true,
      trustAssessment: { status: "assessed", trustedFix: false },
    });

    const completeRunMatrixDigest = digestCanonicalJson(
      "agenc.eval.complete-run-matrix.v1",
      [...runs]
        .map((run) => ({ runId: run.runId, runDigest: run.documentDigest, sealDigest: run.evidence.sealDigest }))
        .sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0),
    );
    const evidenceSealSetDigest = digestCanonicalJson(
      "agenc.eval.evidence-seal-set.v1",
      [...runs].map((run) => run.evidence.sealDigest).sort(),
    );
    const blindedResultsSeal = withDocumentDigest<BlindedResultsSealDocument>({
      kind: "agenc.eval.blinded-results-seal",
      contractVersion: EVAL_CONTRACT_VERSION,
      experimentId: preregistration.experimentId,
      preregistrationDigest: preregistration.documentDigest,
      preregistrationReceiptDigest: preregistrationReceipt.documentDigest,
      completeRunMatrixCommitment: {
        algorithm: "hmac-sha256",
        keyId: "results-key-v1",
        digest: digest("complete-run-matrix-commitment"),
      },
      completeRunMatrixDigest,
      evidenceSealSetDigest,
      sealedAt: "2026-07-15T12:00:04Z",
    });
    const authorizationEvidenceDigest = digest("unblinding-authorization");
    const holdoutReceiptBody = {
      kind: "agenc.eval.holdout-access-receipt" as const,
      contractVersion: EVAL_CONTRACT_VERSION,
      experimentId: preregistration.experimentId,
      holdoutDescriptorDigest: holdoutDescriptor.documentDigest,
      suiteManifestDigest: suite.documentDigest,
      preregistrationDigest: preregistration.documentDigest,
      blindedResultsSealDigest: blindedResultsSeal.documentDigest,
      completeRunMatrixDigest,
      accessPolicyDigest: holdoutDescriptor.accessPolicyDigest,
      unsealPolicyDigest: holdoutDescriptor.unsealPolicyDigest,
      projectionPolicyDigest: holdoutDescriptor.custody.projectionPolicyDigest,
      implementerPrincipalSetDigest:
        holdoutDescriptor.custody.implementerPrincipalSetDigest,
      custodianIdentity: holdoutDescriptor.custody.custodianIdentity,
      accessLogHeadDigest: digest("access-log-head"),
      projectedRunIdsDigest: digestCanonicalJson(
        "agenc.eval.projected-run-ids.v1",
        [...runs].map((run) => run.runId).sort(),
      ),
      authorizationEvidenceDigest,
      authorizedRole: preregistration.unblinding.authorizedRole,
      authorizedPrincipal: "test-custodian",
      firstAccessAt: "2026-07-15T12:00:01.500Z",
      lastAccessAt: "2026-07-15T12:00:03.900Z",
      issuedAt: "2026-07-15T12:00:04.500Z",
      receiptVerifierDigest: holdoutDescriptor.custody.custodyVerifierDigest,
      signatureAlgorithm: "ed25519" as const,
      verificationMaterialDigest: digest("holdout-receipt-public-key"),
      receiptUri: "https://example.invalid/holdout-access/experiment-one",
    };
    const placeholderHoldoutReceipt = withDocumentDigest<HoldoutAccessReceiptDocument>({
      ...holdoutReceiptBody,
      signatureDigest: digest("placeholder-holdout-signature"),
    });
    const signHoldoutReceipt = (receipt: HoldoutAccessReceiptDocument) => sha256Digest(
      Buffer.concat([
        Buffer.from("test-holdout-receipt\0"),
        Buffer.from(canonicalizeJson(createHoldoutAccessStatement(receipt))),
      ]),
    );
    const holdoutAccessReceipt = withDocumentDigest<HoldoutAccessReceiptDocument>({
      ...holdoutReceiptBody,
      signatureDigest: signHoldoutReceipt(placeholderHoldoutReceipt),
    });
    const unblindingRecord = withDocumentDigest<UnblindingRecordDocument>({
      kind: "agenc.eval.unblinding-record",
      contractVersion: EVAL_CONTRACT_VERSION,
      experimentId: preregistration.experimentId,
      preregistrationDigest: preregistration.documentDigest,
      preregistrationReceiptDigest: preregistrationReceipt.documentDigest,
      blindedResultsSealDigest: blindedResultsSeal.documentDigest,
      holdoutDescriptorDigest: holdoutDescriptor.documentDigest,
      holdoutAccessReceiptDigest: holdoutAccessReceipt.documentDigest,
      policyDigest: preregistration.unblinding.policyDigest,
      authorizedRole: preregistration.unblinding.authorizedRole,
      authorizationEvidenceDigest,
      unblindedBy: "test-custodian",
      unblindedAt: "2026-07-15T12:00:05Z",
    });
    const bundle = {
      suite,
      holdoutDescriptor,
      holdoutAccessReceipt,
      preregistration,
      preregistrationReceipt,
      blindedResultsSeal,
      unblindingRecord,
      runs,
      verifiedEvidence,
      lifecycleAnchors: {
        expectedPreregistrationReceiptDigest: preregistrationReceipt.documentDigest,
        expectedBlindedResultsSealDigest: blindedResultsSeal.documentDigest,
        expectedUnblindingRecordDigest: unblindingRecord.documentDigest,
        preregistrationReceiptVerifierDigest: preregistration.evidencePolicy.anchorVerifierDigest,
        expectedHoldoutAccessReceiptDigest: holdoutAccessReceipt.documentDigest,
        holdoutAccessReceiptVerifierDigest: holdoutDescriptor.custody.custodyVerifierDigest,
        verifyPreregistrationReceipt: (bytes: Uint8Array, receipt: PreregistrationReceiptDocument) =>
          provider.verify(bytes, receipt),
        verifyHoldoutAccessReceipt: (bytes: Uint8Array, receipt: HoldoutAccessReceiptDocument) =>
          receipt.signatureDigest === sha256Digest(Buffer.concat([
            Buffer.from("test-holdout-receipt\0"),
            Buffer.from(bytes),
          ])),
      },
    } as const;

    const callerMutableRuns = [...runs];
    const snapshotResult = await validateEvaluationBundle({
      ...bundle,
      runs: callerMutableRuns,
      lifecycleAnchors: {
        ...bundle.lifecycleAnchors,
        async verifyPreregistrationReceipt(bytes, receipt) {
          const verified = await bundle.lifecycleAnchors.verifyPreregistrationReceipt(bytes, receipt);
          callerMutableRuns.pop();
          return verified;
        },
      },
    });
    expect(callerMutableRuns).toHaveLength(59);
    expect(snapshotResult.bundle.runs).toHaveLength(60);
    expect(Object.isFrozen(snapshotResult.bundle.runs)).toBe(true);
    await expect(deriveExperimentSummary(bundle, null as never)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("summary options must be an object")]),
    });
    const callerMutableOptions = {
      summaryId: "snapshot-summary",
      generatedAt: "2026-07-15T12:00:06Z",
    };
    const optionSnapshotSummary = await deriveExperimentSummary({
      ...bundle,
      lifecycleAnchors: {
        ...bundle.lifecycleAnchors,
        async verifyPreregistrationReceipt(bytes, receipt) {
          const verified = await bundle.lifecycleAnchors.verifyPreregistrationReceipt(bytes, receipt);
          callerMutableOptions.summaryId = "mutated-summary";
          return verified;
        },
      },
    }, callerMutableOptions);
    expect(optionSnapshotSummary.summaryId).toBe("snapshot-summary");
    expect(callerMutableOptions.summaryId).toBe("mutated-summary");

    await expect(validateEvaluationBundle(bundle)).resolves.toMatchObject({
      exclusions: [expect.objectContaining({ comparisonId: "agenc-vs-one" })],
    });
    const summary = await deriveExperimentSummary(bundle, {
      summaryId: "summary-one",
      generatedAt: "2026-07-15T12:00:06Z",
    });
    expect(summary.rawEvidenceEmbedded).toBe(false);
    expect(summary.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        systemId: "agenc-primary",
        verifiedFixRate: 0.95,
        trustedFixRate: 0.95,
        includedTrialCount: 20,
        pairwiseInfrastructureExclusionCount: 1,
      }),
      expect.objectContaining({
        systemId: "comparator-one",
        verifiedFixRate: 0.05,
        trustedFixRate: 0.05,
        includedTrialCount: 20,
        pairwiseInfrastructureExclusionCount: 1,
      }),
    ]));
    expect(summary.pairedEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        comparisonId: "agenc-vs-one",
        pointEstimate: 0.9,
        superiorityCriterionMet: null,
      }),
      expect.objectContaining({ comparisonId: "agenc-vs-two", pointEstimate: 0.95 }),
    ]));
    expect(summary.superiorityEstablished).toBeNull();
    expect(summary.evidenceSeals).toHaveLength(60);
    await expect(validateDerivedSummaryAgainstBundle(bundle, summary)).resolves.toEqual(summary);
    const winningEffect = summary.pairedEffects[0];
    if (!winningEffect || winningEffect.confidenceLower <= 0) {
      throw new Error("missing winning paired-effect fixture");
    }
    const fabricatedSuperiority = withDocumentDigest<DerivedSummaryDocument>({
      ...summary,
      claim: "superiority",
      pairedEffects: [{ ...winningEffect, superiorityCriterionMet: true }],
      superiorityEstablished: true,
    });
    expect(() => validateEvalContractDocument(fabricatedSuperiority)).not.toThrow();
    await expect(
      validateDerivedSummaryAgainstBundle(bundle, fabricatedSuperiority),
    ).rejects.toThrow(/does not exactly match fresh derivation/u);
    const contradictorySuperiority = withDocumentDigest<DerivedSummaryDocument>({
      ...summary,
      claim: "superiority",
      pairedEffects: summary.pairedEffects.map((effect, index) => ({
        ...effect,
        superiorityCriterionMet: index === 0,
      })),
      superiorityEstablished: true,
    });
    expect(() => validateEvalContractDocument(contradictorySuperiority)).toThrow(
      /intersection of every comparator/u,
    );

    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.slice(1),
    })).rejects.toThrow(/missing planned run cell|run matrix/u);

    const forgedRun = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      agentTaskDigest: digest("wrong-agent-projection"),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [forgedRun, ...runs.slice(1)],
      blindedResultsSeal: withDocumentDigest<BlindedResultsSealDocument>({
        ...blindedResultsSeal,
        completeRunMatrixDigest: digestCanonicalJson(
          "agenc.eval.complete-run-matrix.v1",
          [forgedRun, ...runs.slice(1)]
            .map((run) => ({ runId: run.runId, runDigest: run.documentDigest, sealDigest: run.evidence.sealDigest }))
            .sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0),
        ),
      }),
    })).rejects.toThrow(/agent task projection digest mismatch/u);

    const forgedArtifactDigest = digest("forged-artifact-without-bytes");
    const forgedArtifactRun = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      artifacts: [
        {
          ...runs[0].artifacts[0],
          digest: forgedArtifactDigest,
          uri: `cas://sha256/${forgedArtifactDigest.slice("sha256:".length)}`,
        },
        ...runs[0].artifacts.slice(1),
      ],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [forgedArtifactRun, ...runs.slice(1)],
    })).rejects.toThrow(/is not backed by verified payload bytes/u);

    const wrongProviderModel = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      system: { ...runs[0].system, providerReportedModelId: "different-model-build" },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [wrongProviderModel, ...runs.slice(1)],
    })).rejects.toThrow(/provider-reported model ID differs/u);

    const overCacheBudget = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      usage: {
        ...runs[0].usage,
        cacheReadTokens: suite.tasks[0].budget.cacheTokens + 1,
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [overCacheBudget, ...runs.slice(1)],
    })).rejects.toThrow(/cache-token budget exceeded/u);

    const overTurnBudget = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      usage: {
        ...runs[0].usage,
        turns: suite.tasks[0].budget.turns + 1,
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [overTurnBudget, ...runs.slice(1)],
    })).rejects.toThrow(/turn budget exceeded/u);

    const usageEvidence = verifiedEvidence[0]?.inspection.events.find(
      (entry) => entry.type === "usage.reported",
    )?.payload.digest;
    if (!usageEvidence) throw new Error("missing provider-usage fixture");
    const unboundedProviderCost = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      usage: {
        ...runs[0].usage,
        providerCost: {
          status: "unavailable",
          reason: "provider omitted metering",
          evidenceDigest: usageEvidence,
          reservedAmount: "1.01",
          currency: "USD",
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [unboundedProviderCost, ...runs.slice(1)],
    })).rejects.toThrow(/reserved provider-cost bound exceeded/u);

    const wrongArtifactPath = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      artifacts: [
        { ...runs[0].artifacts[0], path: "result/wrong.patch" },
        ...runs[0].artifacts.slice(1),
      ],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [wrongArtifactPath, ...runs.slice(1)],
    })).rejects.toThrow(/required artifact patch does not match/u);

    const successfulRun = runs.find((run) => run.trustAssessment.trustedFix);
    if (!successfulRun || successfulRun.trustAssessment.status !== "assessed") {
      throw new Error("missing successful assessed run");
    }
    const reorderedAttestation = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      trustAssessment: {
        ...successfulRun.trustAssessment,
        criteria: {
          ...successfulRun.trustAssessment.criteria,
          policyAndBudget: {
            ...successfulRun.trustAssessment.criteria.policyAndBudget,
            evidenceDigests: [
              ...successfulRun.trustAssessment.criteria.policyAndBudget.evidenceDigests,
            ].reverse(),
          },
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? reorderedAttestation : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("assessed trust lacks an exact attestation"),
      ]),
    });

    const missingTypedEvidence = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      trustAssessment: {
        ...successfulRun.trustAssessment,
        criteria: {
          ...successfulRun.trustAssessment.criteria,
          effectSafety: {
            ...successfulRun.trustAssessment.criteria.effectSafety,
            evidenceDigests: [successfulRun.verifier.evidenceDigest],
          },
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? missingTypedEvidence : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("effectSafety lacks its required typed evidence events"),
      ]),
    });

    const adverseRun = runs.find((run) =>
      run.systemId === "comparator-one" && run.taskId === suite.tasks[1].taskId);
    if (!adverseRun || adverseRun.trustAssessment.status !== "assessed") {
      throw new Error("missing adverse assessed run");
    }
    const contradictoryAdverseAssessment = withDocumentDigest<RunRecordDocument>({
      ...adverseRun,
      trustAssessment: {
        ...adverseRun.trustAssessment,
        criteria: {
          ...adverseRun.trustAssessment.criteria,
          effectSafety: {
            ...adverseRun.trustAssessment.criteria.effectSafety,
            status: "passed",
            unresolvedUnknownOutcomes: 0,
          },
          recoveryIntegrity: {
            ...adverseRun.trustAssessment.criteria.recoveryIntegrity,
            status: "passed",
            eventGaps: 0,
          },
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === adverseRun.runId ? contradictoryAdverseAssessment : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("contradicts anchored unknown-outcome events"),
        expect.stringContaining("contradicts anchored event-gap evidence"),
      ]),
    });

    const disallowedApproval = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      approvals: [{
        id: "approval-one",
        kind: "unregistered-approval",
        requestedAt: successfulRun.startedAt,
        resolvedAt: successfulRun.finishedAt,
        decision: "approved",
        declaredByTask: true,
      }],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? disallowedApproval : run),
    })).rejects.toThrow(/approval kind is outside a pinned allowlist/u);

    const changedResetTask = withDocumentDigest<OperatorTaskDocument>({
      ...suite.tasks[1],
      resetRecipe: {
        ...suite.tasks[1].resetRecipe,
        id: "different-reset",
        digest: digest("different-reset"),
      },
    });
    const changedResetSuite = withDocumentDigest<SuiteManifestDocument>({
      ...suite,
      tasks: suite.tasks.map((task) =>
        task.taskId === changedResetTask.taskId ? changedResetTask : task),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      suite: changedResetSuite,
    })).rejects.toThrow(/task reset recipe or receipt differs/u);

    const wrongExecutionIndex = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      executionIndex: successfulRun.executionIndex + runs.length,
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? wrongExecutionIndex : run),
    })).rejects.toThrow(/execution index differs|start chronology/u);

    const primaryRun = runs.find((run) =>
      run.systemId === preregistration.primarySystemId && run.taskId === suite.tasks[0].taskId);
    const comparatorRun = runs.find((run) =>
      run.systemId === "comparator-one" && run.taskId === suite.tasks[0].taskId);
    const primaryEvidence = verifiedEvidence.find((entry) =>
      entry.inspection.runId === primaryRun?.runId);
    const sharedIncidentEvidence = primaryEvidence?.inspection.events.find(
      (event) => event.type === "budget.reconciled",
    )?.payload.digest;
    if (!primaryRun || !comparatorRun || !sharedIncidentEvidence) {
      throw new Error("missing paired infrastructure fixture");
    }
    const incident = {
      comparisonId: "agenc-vs-one",
      reason: "shared_provider_outage" as const,
      incidentId: "incident-one",
      evidenceDigest: sharedIncidentEvidence,
      classifierVersion: "1.0.0",
      classifierImplementationDigest:
        preregistration.exclusions.classifierImplementation.digest,
    };
    const primaryInfrastructureInvalid = withDocumentDigest<RunRecordDocument>({
      ...primaryRun,
      infrastructureInvalidPairs: [{ ...incident, counterpartRunId: comparatorRun.runId }],
    });
    const comparatorInfrastructureInvalid = withDocumentDigest<RunRecordDocument>({
      ...comparatorRun,
      infrastructureInvalidPairs: [{ ...incident, counterpartRunId: primaryRun.runId }],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === primaryRun.runId
          ? primaryInfrastructureInvalid
          : run.runId === comparatorRun.runId
            ? comparatorInfrastructureInvalid
            : run),
    })).rejects.toThrow(/infrastructure reason was not preregistered/u);

    const untypedIncident = {
      ...incident,
      reason: "evaluator_host_failure" as const,
    };
    const primaryUntypedIncident = withDocumentDigest<RunRecordDocument>({
      ...primaryRun,
      infrastructureInvalidPairs: [{ ...untypedIncident, counterpartRunId: comparatorRun.runId }],
    });
    const comparatorUntypedIncident = withDocumentDigest<RunRecordDocument>({
      ...comparatorRun,
      infrastructureInvalidPairs: [{ ...untypedIncident, counterpartRunId: primaryRun.runId }],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === primaryRun.runId
          ? primaryUntypedIncident
          : run.runId === comparatorRun.runId
            ? comparatorUntypedIncident
            : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("lacks a shared typed classifier receipt"),
      ]),
    });

    const ordinaryOutcomeWithExclusion = withDocumentDigest<RunRecordDocument>({
      ...primaryRun,
      outcome: "fail",
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === primaryRun.runId ? ordinaryOutcomeWithExclusion : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("infrastructure-invalid outcome and paired incidents must agree"),
      ]),
    });

    const unauthorizedAccessReceipt = withDocumentDigest<HoldoutAccessReceiptDocument>({
      ...holdoutAccessReceipt,
      authorizationEvidenceDigest: digest("different-unblinding-authorization"),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      holdoutAccessReceipt: unauthorizedAccessReceipt,
    })).rejects.toThrow(/not bound to custody\/authorization policy/u);

    const wrongUnblindingRole = withDocumentDigest<HoldoutAccessReceiptDocument>({
      ...holdoutAccessReceipt,
      authorizedRole: "different-role",
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      holdoutAccessReceipt: wrongUnblindingRole,
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("not bound to custody/authorization policy"),
      ]),
    });

    const wrongUnblindingPolicy = withDocumentDigest<UnblindingRecordDocument>({
      ...unblindingRecord,
      policyDigest: digest("different-unblinding-policy"),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      unblindingRecord: wrongUnblindingPolicy,
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("unblinding record does not link the exact lifecycle documents"),
      ]),
    });

    await expect(validateEvaluationBundle({
      ...bundle,
      holdoutDescriptor: withDocumentDigest({
        ...holdoutDescriptor,
        status: "retired" as const,
      }),
    })).rejects.toThrow(/is not sealed/u);

    const changedRedactionPolicy = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      evidencePolicy: {
        ...preregistration.evidencePolicy,
        redactionPolicyDigest: digest("different-redaction-policy"),
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      preregistration: changedRedactionPolicy,
    })).rejects.toThrow(/used an unpinned redaction policy/u);

    const overstatedSample = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      samplePlan: {
        ...preregistration.samplePlan,
        minimumTasks: 11,
        maximumTasks: 11,
        stoppingRule: { kind: "fixed", taskCount: 11 },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      preregistration: overstatedSample,
    })).rejects.toThrow(/selected suite task count is outside/u);
  }, 30_000);
});

describe("paired TFR inference", () => {
  test("averages repetitions within tasks and resamples whole repository clusters", () => {
    const inference = makePreregistration().inference;
    const unequalRepetitions = computePairedTfrEffect([
      {
        taskId: "task-a",
        repositoryCluster: "repo-a",
        trialDifferences: [1, 1, 1],
      },
      {
        taskId: "task-b",
        repositoryCluster: "repo-b",
        trialDifferences: [-1],
      },
    ], "comparison-repetitions", inference);
    expect(unequalRepetitions.pointEstimate).toBe(0);

    const clustered = computePairedTfrEffect([
      { taskId: "task-a", repositoryCluster: "repo-shared", trialDifferences: [1] },
      { taskId: "task-b", repositoryCluster: "repo-shared", trialDifferences: [-1] },
      { taskId: "task-c", repositoryCluster: "repo-other", trialDifferences: [1] },
    ], "comparison-clusters", inference);
    expect(clustered).toEqual({
      pointEstimate: 1 / 3,
      confidenceLower: 0,
      confidenceUpper: 1,
    });

    const interpolationVector = computePairedTfrEffect(
      [-0.931, -0.713, -0.409, -0.107, 0.047, 0.213, 0.359, 0.557, 0.809, 0.997]
        .map((difference, index) => ({
          taskId: `quantile-task-${index}`,
          repositoryCluster: `quantile-repo-${index}`,
          trialDifferences: [difference],
        })),
      "quantile-vector",
      inference,
    );
    expect(interpolationVector).toEqual({
      pointEstimate: 0.08220000000000002,
      confidenceLower: -0.28400499999999995,
      confidenceUpper: 0.4468049999999999,
    });
    expect(interpolationVector.confidenceLower).not.toBe(-0.2842);
    expect(interpolationVector.confidenceLower).not.toBe(-0.284);
    expect(() => computePairedTfrEffect(
      [],
      "comparison-invalid",
      null as never,
    )).toThrow(/non-empty task trials|resamples must be an integer/u);
  });

  test("preserves contract-v1 bootstrap arithmetic and rejects invalid direct calls", () => {
    const arithmeticVector = [
      { cluster: "repo-a", difference: 1 },
      { cluster: "repo-a", difference: 1e-16 },
      { cluster: "repo-a", difference: -1 },
      { cluster: "repo-b", difference: 1 },
      { cluster: "repo-b", difference: -1 },
      { cluster: "repo-b", difference: 2e-16 },
    ];
    expect(computeRepositoryClusteredPercentileInterval(
      arithmeticVector,
      "arithmetic-regression",
      { resamples: 10_000, randomSeed: 123_456 },
    )).toEqual({
      lower: 0,
      upper: 7.034076748750522e-17,
    });
    // Pre-summing each cluster changes this exact contract vector to
    // 6.666666666666667e-17 by regrouping floating-point additions.
    expect(computeRepositoryClusteredPercentileInterval(
      arithmeticVector,
      "arithmetic-regression",
      { resamples: 10_000, randomSeed: 123_456 },
    ).upper).not.toBe(6.666666666666667e-17);

    const startedAt = performance.now();
    expect(() => computeRepositoryClusteredPercentileInterval(
      [],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/non-empty dense task array/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: Number.POSITIVE_INFINITY }],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/finite and in \[-1, 1\]/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: Number.NaN }],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/finite and in \[-1, 1\]/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "not portable", difference: 0 }],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/valid cluster ID/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: 0 }],
      "not portable",
      { resamples: 10_000, randomSeed: 0 },
    )).toThrow(/valid comparison ID|randomSeed must be an integer/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: 0 }],
      "comparison-invalid",
      { resamples: 1_000_001, randomSeed: 1 },
    )).toThrow(/resamples must be an integer/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      new Array(100_001).fill({ cluster: "repo", difference: 0 }),
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/cannot exceed 100000 tasks/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      Array.from({ length: 501 }, (_, index) => ({
        cluster: "repo",
        difference: index % 2 === 0 ? 0.25 : -0.25,
      })),
      "comparison-invalid",
      { resamples: 1_000_000, randomSeed: 1 },
    )).toThrow(/cannot exceed 500000000 task additions/u);
    let getterCalls = 0;
    const accessorTask = {
      cluster: "repo",
      get difference(): number {
        getterCalls += 1;
        return 0;
      },
    };
    expect(() => computeRepositoryClusteredPercentileInterval(
      [accessorTask],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/contain only cluster and difference/u);
    expect(getterCalls).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("portable evaluation methodology vectors", () => {
  test("pins SHA-256 Fisher-Yates order bytes and rejects out-of-contract helper inputs", () => {
    const input = {
      systemIds: ["sys-b", "sys-a"],
      taskIds: ["task-2", "task-1"],
      seedSlots: [11, 7],
      orderSeed: 305_419_896,
    } as const;
    expect(derivePlannedExecutionOrder(input)).toEqual([
      { systemId: "sys-b", taskId: "task-2", seedSlot: 11 },
      { systemId: "sys-a", taskId: "task-1", seedSlot: 11 },
      { systemId: "sys-b", taskId: "task-1", seedSlot: 7 },
      { systemId: "sys-a", taskId: "task-2", seedSlot: 7 },
      { systemId: "sys-a", taskId: "task-1", seedSlot: 7 },
      { systemId: "sys-a", taskId: "task-2", seedSlot: 11 },
      { systemId: "sys-b", taskId: "task-1", seedSlot: 11 },
      { systemId: "sys-b", taskId: "task-2", seedSlot: 7 },
    ]);
    expect(computePlannedExecutionOrderDigest(input)).toBe(
      "sha256:7f05950ac07eca59b92670fed606ca109cd6d9632e55ad174aac89e4dd5ffd0e",
    );
    expect(() => derivePlannedExecutionOrder({
      ...input,
      systemIds: ["sys-a", "sys-a"],
    })).toThrow(/systemIds must be unique/u);
    expect(() => derivePlannedExecutionOrder({ ...input, orderSeed: 0 })).toThrow(
      /orderSeed must be an integer/u,
    );
    expect(() => derivePlannedExecutionOrder({
      ...input,
      systemIds: new Array<string>(1),
    })).toThrow(/systemIds must be a non-empty dense array/u);
    expect(() => derivePlannedExecutionOrder({
      systemIds: Array.from({ length: 1_001 }, (_, index) => `sys-${index}`),
      taskIds: Array.from({ length: 1_000 }, (_, index) => `task-${index}`),
      seedSlots: [0],
      orderSeed: 1,
    })).toThrow(/exceeds 1000000 cells/u);
  });

  test("orders distinct nanosecond timestamps that Date.parse collapses", () => {
    const first = "2026-07-15T12:00:02.000000001Z";
    const second = "2026-07-15T12:00:02.000000002Z";
    expect(Date.parse(first)).toBe(Date.parse(second));
    expect(compareUtcTimestamps(first, second)).toBe(-1);
    expect(compareUtcTimestamps(second, first)).toBe(1);
    expect(compareUtcTimestamps(first, first)).toBe(0);
  });
});
