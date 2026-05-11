import type { MarketplaceTransactionIntent } from "../task/transaction-intent.js";
import type { TransactionGuardInput } from "./types.js";

export function transactionGuardInputFromMarketplaceIntent(
  source: string,
  intent: MarketplaceTransactionIntent,
  userText?: string | null,
  metadata?: Readonly<Record<string, unknown>>,
): TransactionGuardInput {
  return {
    source,
    kind: intent.kind,
    programId: intent.programId,
    signer: intent.signer,
    userText: userText ?? null,
    metadata: {
      ...(metadata ?? {}),
      taskPda: intent.taskPda,
      taskId: intent.taskId,
      claimPda: intent.claimPda,
      submissionPda: intent.submissionPda,
      workerPda: intent.workerPda,
      disputePda: intent.disputePda,
      disputeId: intent.disputeId,
      jobSpecHash: intent.jobSpecHash,
      rewardLamports: intent.rewardLamports,
      rewardMint: intent.rewardMint,
      taskType: intent.taskType,
      constraintHash: intent.constraintHash,
      validationMode: intent.validationMode,
      artifactSha256: intent.artifactSha256,
      evidenceHash: intent.evidenceHash,
      resolutionType: intent.resolutionType,
      requiresCreatorReview: intent.requiresCreatorReview,
      jobSpecVerified: intent.jobSpecVerified,
      hasArtifactDelivery: intent.hasArtifactDelivery,
    },
    accountMetas: intent.accountMetas,
  };
}
