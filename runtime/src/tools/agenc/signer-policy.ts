import type { PublicKey } from "@solana/web3.js";

import type { MarketplaceTransactionIntent } from "../../task/transaction-intent.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { Logger } from "../../utils/logger.js";

export interface MarketplaceSignerPolicy {
  /**
   * Exact mutating tool names allowed to reach signer-backed execution.
   * When omitted or empty, all marketplace signing attempts are denied.
   */
  readonly allowedTools?: readonly string[];
  /** Restrict signing to one or more marketplace program IDs. */
  readonly allowedProgramIds?: readonly string[];
  /** Restrict task-scoped actions to specific task PDAs. */
  readonly allowedTaskPdas?: readonly string[];
  /** Restrict dispute-scoped actions to specific dispute PDAs. */
  readonly allowedDisputePdas?: readonly string[];
  /** Restrict task creation to specific approved template IDs. */
  readonly allowedTemplateIds?: readonly string[];
  /** Restrict task creation/claim paths to specific job spec hashes. */
  readonly allowedJobSpecHashes?: readonly string[];
  /** Restrict private ZK settlement paths to specific circuit/constraint hashes. */
  readonly allowedConstraintHashes?: readonly string[];
  /** Max task reward/rewardLamports accepted by local signer policy. */
  readonly maxRewardLamports?: string;
  /** Max stake/delegation/purchase amount accepted by local signer policy. */
  readonly maxStakeLamports?: string;
  /**
   * Reward mint allowlist. Use "SOL" for native SOL / omitted rewardMint.
   */
  readonly allowedRewardMints?: readonly string[];
  /**
   * Optional exact account-meta expectations for intent previews. This lets a
   * signer boundary reject a preview whose PDA set was mutated before signing.
   */
  readonly expectedAccountMetas?: readonly {
    readonly name: string;
    readonly pubkey?: string;
    readonly isSigner?: boolean;
    readonly isWritable?: boolean;
  }[];
  /**
   * When expectedAccountMetas is supplied, require the final intent account-meta
   * name set to match exactly. Defaults to true.
   */
  readonly strictAccountMetas?: boolean;
  /** Restrict task creation/completion to canary-safe task types, e.g. Exclusive. */
  readonly allowedTaskTypes?: readonly string[];
  /** Restrict validation modes, e.g. CreatorReview only for reviewed-public canary. */
  readonly allowedValidationModes?: readonly string[];
  /** Require artifact delivery intents to use CreatorReview/manual validation. */
  readonly requireCreatorReviewForArtifacts?: boolean;
  /** Require claim intents to prove verified job-spec metadata. */
  readonly requireJobSpecVerification?: boolean;
  /** Deny Private ZK completion intents by policy. */
  readonly denyPrivateZk?: boolean;
  /** Deny SPL/token reward intents by policy. */
  readonly denyTokenRewards?: boolean;
  /** Deny public auto-settle artifact completion intents by policy. */
  readonly denyPublicAutoSettleArtifacts?: boolean;
}

export interface MarketplaceSignerPolicyEvaluation {
  readonly allowed: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

function errorResult(
  message: string,
  metadata: Record<string, unknown>,
): ToolResult {
  return {
    content: safeStringify({
      error: message,
      code: "MARKETPLACE_SIGNER_POLICY_DENIED",
      ...metadata,
    }),
    isError: true,
  };
}

function normalizeList(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function readString(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readBigInt(args: Record<string, unknown>, keys: readonly string[]): bigint | null {
  const value = readString(args, keys);
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

function parseLimit(value: string | undefined, field: string): bigint | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${field} must be a non-negative integer string`);
  }
  return BigInt(trimmed);
}

function deny(
  code: string,
  reason: string,
  metadata?: Record<string, unknown>,
): MarketplaceSignerPolicyEvaluation {
  return { allowed: false, code, reason, ...(metadata ? { metadata } : {}) };
}

function fieldAllowed(
  allowedValues: readonly string[] | undefined,
  actual: string | null | undefined,
): boolean {
  const allowed = normalizeList(allowedValues);
  return allowed.size === 0 || (actual !== undefined && actual !== null && allowed.has(actual));
}

function optionalFieldAllowed(
  allowedValues: readonly string[] | undefined,
  actual: string | null | undefined,
): boolean {
  const allowed = normalizeList(allowedValues);
  return allowed.size === 0 || actual === undefined || actual === null || allowed.has(actual);
}

function duplicateNames(values: readonly { readonly name: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.name)) {
      duplicates.add(value.name);
    }
    seen.add(value.name);
  }
  return [...duplicates];
}

function evaluateMarketplaceSignerPolicy(params: {
  readonly policy: MarketplaceSignerPolicy;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly programId: PublicKey;
  readonly signer?: PublicKey | null;
}): MarketplaceSignerPolicyEvaluation {
  const allowedTools = normalizeList(params.policy.allowedTools);
  if (!allowedTools.has(params.toolName)) {
    return {
      allowed: false,
      code: "TOOL_NOT_ALLOWED",
      reason: `${params.toolName} is not allowed by marketplace signer policy`,
    };
  }

  const allowedProgramIds = normalizeList(params.policy.allowedProgramIds);
  const programId = params.programId.toBase58();
  if (allowedProgramIds.size > 0 && !allowedProgramIds.has(programId)) {
    return {
      allowed: false,
      code: "PROGRAM_NOT_ALLOWED",
      reason: `Program ${programId} is not allowed by marketplace signer policy`,
      metadata: { programId },
    };
  }

  const allowedTaskPdas = normalizeList(params.policy.allowedTaskPdas);
  const taskPda = readString(params.args, ["taskPda"]);
  if (allowedTaskPdas.size > 0 && taskPda && !allowedTaskPdas.has(taskPda)) {
    return {
      allowed: false,
      code: "TASK_NOT_ALLOWED",
      reason: `Task ${taskPda} is not allowed by marketplace signer policy`,
      metadata: { taskPda },
    };
  }

  const allowedDisputePdas = normalizeList(params.policy.allowedDisputePdas);
  const disputePda = readString(params.args, ["disputePda"]);
  if (
    allowedDisputePdas.size > 0 &&
    disputePda &&
    !allowedDisputePdas.has(disputePda)
  ) {
    return {
      allowed: false,
      code: "DISPUTE_NOT_ALLOWED",
      reason: `Dispute ${disputePda} is not allowed by marketplace signer policy`,
      metadata: { disputePda },
    };
  }

  const allowedTemplateIds = normalizeList(params.policy.allowedTemplateIds);
  const templateId = readString(params.args, ["templateId"]);
  if (allowedTemplateIds.size > 0 && templateId && !allowedTemplateIds.has(templateId)) {
    return {
      allowed: false,
      code: "TEMPLATE_NOT_ALLOWED",
      reason: `Template ${templateId} is not allowed by marketplace signer policy`,
      metadata: { templateId },
    };
  }

  const allowedJobSpecHashes = normalizeList(params.policy.allowedJobSpecHashes);
  const jobSpecHash = readString(params.args, ["jobSpecHash"]);
  if (
    allowedJobSpecHashes.size > 0 &&
    jobSpecHash &&
    !allowedJobSpecHashes.has(jobSpecHash)
  ) {
    return {
      allowed: false,
      code: "JOB_SPEC_HASH_NOT_ALLOWED",
      reason: `Job spec hash ${jobSpecHash} is not allowed by marketplace signer policy`,
      metadata: { jobSpecHash },
    };
  }

  const allowedConstraintHashes = normalizeList(params.policy.allowedConstraintHashes);
  const constraintHash = readString(params.args, ["constraintHash"]);
  if (
    allowedConstraintHashes.size > 0 &&
    constraintHash &&
    !allowedConstraintHashes.has(constraintHash)
  ) {
    return {
      allowed: false,
      code: "CONSTRAINT_HASH_NOT_ALLOWED",
      reason: `Constraint hash ${constraintHash} is not allowed by marketplace signer policy`,
      metadata: { constraintHash },
    };
  }

  const reward = readBigInt(params.args, ["reward", "rewardLamports"]);
  const maxReward = parseLimit(params.policy.maxRewardLamports, "maxRewardLamports");
  if (reward !== null && maxReward !== null && reward > maxReward) {
    return {
      allowed: false,
      code: "REWARD_LIMIT_EXCEEDED",
      reason: `Reward ${reward.toString()} exceeds signer policy max ${maxReward.toString()}`,
      metadata: { rewardLamports: reward.toString(), maxRewardLamports: maxReward.toString() },
    };
  }

  const stakeAmount = readBigInt(params.args, [
    "stakeAmount",
    "amount",
    "price",
    "delegationAmount",
  ]);
  const maxStake = parseLimit(params.policy.maxStakeLamports, "maxStakeLamports");
  if (stakeAmount !== null && maxStake !== null && stakeAmount > maxStake) {
    return {
      allowed: false,
      code: "STAKE_LIMIT_EXCEEDED",
      reason: `Amount ${stakeAmount.toString()} exceeds signer policy max ${maxStake.toString()}`,
      metadata: { amountLamports: stakeAmount.toString(), maxStakeLamports: maxStake.toString() },
    };
  }

  const allowedRewardMints = normalizeList(params.policy.allowedRewardMints);
  const rewardMint = readString(params.args, ["rewardMint"]) ?? "SOL";
  if (allowedRewardMints.size > 0 && !allowedRewardMints.has(rewardMint)) {
    return {
      allowed: false,
      code: "REWARD_MINT_NOT_ALLOWED",
      reason: `Reward mint ${rewardMint} is not allowed by marketplace signer policy`,
      metadata: { rewardMint },
    };
  }

  return {
    allowed: true,
    metadata: {
      toolName: params.toolName,
      programId,
      signer: params.signer?.toBase58() ?? null,
    },
  };
}

function toolNameForIntent(kind: MarketplaceTransactionIntent["kind"]): string {
  switch (kind) {
    case "create_task":
      return "agenc.createTask";
    case "claim_task":
    case "claim_task_with_job_spec":
      return "agenc.claimTask";
    case "complete_task":
    case "complete_task_private":
    case "submit_task_result":
      return "agenc.completeTask";
    case "configure_task_validation":
      return "agenc.configureTaskValidation";
    case "accept_task_result":
      return "agenc.acceptTaskResult";
    case "reject_task_result":
      return "agenc.rejectTaskResult";
    case "auto_accept_task_result":
      return "agenc.autoAcceptTaskResult";
    case "validate_task_result":
      return "agenc.validateTaskResult";
    case "initiate_dispute":
      return "agenc.initiateDispute";
    case "vote_dispute":
      return "agenc.voteDispute";
    case "resolve_dispute":
      return "agenc.resolveDispute";
    case "cancel_dispute":
      return "agenc.cancelDispute";
    case "expire_dispute":
      return "agenc.expireDispute";
    case "apply_dispute_slash":
      return "agenc.applyDisputeSlash";
  }
}

function evaluateMarketplaceIntentPolicy(
  policy: MarketplaceSignerPolicy,
  intent: MarketplaceTransactionIntent,
): MarketplaceSignerPolicyEvaluation {
  const allowedTaskPdas = normalizeList(policy.allowedTaskPdas);
  if (
    allowedTaskPdas.size > 0 &&
    (intent.taskPda === undefined || intent.taskPda === null || !allowedTaskPdas.has(intent.taskPda))
  ) {
    return deny("TASK_NOT_ALLOWED", `Task ${intent.taskPda ?? "<missing>"} is not allowed`, {
      taskPda: intent.taskPda ?? null,
    });
  }

  if (!fieldAllowed(policy.allowedDisputePdas, intent.disputePda)) {
    return deny(
      "DISPUTE_NOT_ALLOWED",
      `Dispute ${intent.disputePda ?? "<missing>"} is not allowed`,
      { disputePda: intent.disputePda ?? null },
    );
  }

  if (!optionalFieldAllowed(policy.allowedJobSpecHashes, intent.jobSpecHash)) {
    return deny(
      "JOB_SPEC_HASH_NOT_ALLOWED",
      `Job spec hash ${intent.jobSpecHash ?? "<missing>"} is not allowed`,
      { jobSpecHash: intent.jobSpecHash ?? null },
    );
  }

  if (!optionalFieldAllowed(policy.allowedConstraintHashes, intent.constraintHash)) {
    return deny(
      "CONSTRAINT_HASH_NOT_ALLOWED",
      `Constraint hash ${intent.constraintHash ?? "<missing>"} is not allowed`,
      { constraintHash: intent.constraintHash ?? null },
    );
  }

  const maxReward = parseLimit(policy.maxRewardLamports, "maxRewardLamports");
  if (intent.kind === "create_task" && intent.rewardLamports !== undefined && maxReward === null) {
    return deny(
      "REWARD_LIMIT_REQUIRED",
      "Task creation policy must set maxRewardLamports before approving reward escrow",
    );
  }
  if (intent.rewardLamports !== undefined && maxReward !== null) {
    const reward = BigInt(intent.rewardLamports);
    if (reward > maxReward) {
      return deny("REWARD_LIMIT_EXCEEDED", "Reward exceeds signer policy maximum", {
        rewardLamports: reward.toString(),
        maxRewardLamports: maxReward.toString(),
      });
    }
  }

  const rewardMint = intent.rewardMint ?? "SOL";
  if (!fieldAllowed(policy.allowedRewardMints, rewardMint)) {
    return deny("REWARD_MINT_NOT_ALLOWED", `Reward mint ${rewardMint} is not allowed`, {
      rewardMint,
    });
  }

  if (policy.denyTokenRewards && rewardMint !== "SOL") {
    return deny("TOKEN_REWARD_DENIED", "Token rewards are denied by policy", { rewardMint });
  }

  if (!optionalFieldAllowed(policy.allowedTaskTypes, intent.taskType)) {
    return deny("TASK_TYPE_NOT_ALLOWED", `Task type ${intent.taskType ?? "<missing>"} is not allowed`, {
      taskType: intent.taskType ?? null,
    });
  }

  if (
    intent.validationMode !== undefined &&
    intent.validationMode !== null &&
    !fieldAllowed(policy.allowedValidationModes, intent.validationMode)
  ) {
    return deny(
      "VALIDATION_MODE_NOT_ALLOWED",
      `Validation mode ${intent.validationMode} is not allowed`,
      { validationMode: intent.validationMode },
    );
  }

  if (policy.denyPrivateZk && intent.kind === "complete_task_private") {
    return deny("PRIVATE_ZK_DENIED", "Private ZK completion is out of scope");
  }

  if (
    policy.requireCreatorReviewForArtifacts &&
    intent.hasArtifactDelivery &&
    !intent.requiresCreatorReview
  ) {
    return deny(
      "CREATOR_REVIEW_REQUIRED_FOR_ARTIFACT",
      "Artifact delivery requires CreatorReview/manual validation",
    );
  }

  if (
    policy.denyPublicAutoSettleArtifacts &&
    intent.hasArtifactDelivery &&
    intent.kind === "complete_task"
  ) {
    return deny(
      "PUBLIC_AUTO_SETTLE_ARTIFACT_DENIED",
      "Public auto-settle artifact completion is denied",
    );
  }

  if (
    policy.requireJobSpecVerification &&
    (intent.kind === "claim_task" || intent.kind === "claim_task_with_job_spec") &&
    intent.jobSpecVerified !== true
  ) {
    return deny(
      "JOB_SPEC_VERIFICATION_REQUIRED",
      "Claim requires verified job-spec metadata",
    );
  }

  const expectedAccountMetas = policy.expectedAccountMetas ?? [];
  const strictAccountMetas =
    expectedAccountMetas.length > 0 && policy.strictAccountMetas !== false;

  if (expectedAccountMetas.length > 0) {
    const duplicateExpected = duplicateNames(expectedAccountMetas);
    if (duplicateExpected.length > 0) {
      return deny(
        "ACCOUNT_META_DUPLICATE_EXPECTED",
        "Signer policy contains duplicate expected account meta names",
        { accountNames: duplicateExpected },
      );
    }

    const duplicateActual = duplicateNames(intent.accountMetas);
    if (duplicateActual.length > 0) {
      return deny("ACCOUNT_META_DUPLICATE", "Transaction intent contains duplicate account metas", {
        accountNames: duplicateActual,
      });
    }
  }

  if (strictAccountMetas) {
    const expectedNames = new Set(expectedAccountMetas.map((account) => account.name));
    const unexpectedAccounts = intent.accountMetas.filter((account) => !expectedNames.has(account.name));
    if (unexpectedAccounts.length > 0) {
      return deny(
        "ACCOUNT_META_UNEXPECTED",
        "Transaction intent includes account metas outside the signer policy",
        {
          accounts: unexpectedAccounts.map((account) => ({
            name: account.name,
            pubkey: account.pubkey,
            isSigner: account.isSigner,
            isWritable: account.isWritable,
          })),
        },
      );
    }
  }

  for (const expected of expectedAccountMetas) {
    const actual = intent.accountMetas.find((account) => account.name === expected.name);
    if (!actual) {
      return deny("ACCOUNT_META_MISSING", `Required account meta ${expected.name} is missing`, {
        accountName: expected.name,
      });
    }
    if (expected.pubkey && actual.pubkey !== expected.pubkey) {
      return deny(
        "ACCOUNT_META_PUBKEY_MISMATCH",
        `Account meta ${expected.name} pubkey does not match`,
        { accountName: expected.name, expectedPubkey: expected.pubkey, actualPubkey: actual.pubkey },
      );
    }
    const expectedIsSigner = expected.isSigner ?? false;
    if (actual.isSigner !== expectedIsSigner) {
      return deny(
        "ACCOUNT_META_SIGNER_MISMATCH",
        `Account meta ${expected.name} signer flag does not match`,
        { accountName: expected.name },
      );
    }
    const expectedIsWritable = expected.isWritable ?? false;
    if (actual.isWritable !== expectedIsWritable) {
      return deny(
        "ACCOUNT_META_WRITABLE_MISMATCH",
        `Account meta ${expected.name} writable flag does not match`,
        { accountName: expected.name },
      );
    }
  }

  return {
    allowed: true,
    code: "ALLOWED",
    reason: "Transaction intent satisfies marketplace signer policy",
    metadata: {
      toolName: toolNameForIntent(intent.kind),
      programId: intent.programId,
      signer: intent.signer,
    },
  };
}

export function evaluateMarketplaceSignerPolicyForIntent(
  policy: MarketplaceSignerPolicy,
  intent: MarketplaceTransactionIntent,
): MarketplaceSignerPolicyEvaluation {
  const programId = { toBase58: () => intent.programId } as PublicKey;
  const signer = intent.signer
    ? ({ toBase58: () => intent.signer } as PublicKey)
    : null;
  const baseDecision = evaluateMarketplaceSignerPolicy({
    policy,
    toolName: toolNameForIntent(intent.kind),
    programId,
    signer,
    args: {
      ...(intent.taskPda ? { taskPda: intent.taskPda } : {}),
      ...(intent.disputePda ? { disputePda: intent.disputePda } : {}),
      ...(intent.jobSpecHash ? { jobSpecHash: intent.jobSpecHash } : {}),
      ...(intent.constraintHash ? { constraintHash: intent.constraintHash } : {}),
      ...(intent.rewardLamports ? { reward: intent.rewardLamports } : {}),
      ...(intent.rewardMint ? { rewardMint: intent.rewardMint } : { rewardMint: "SOL" }),
    },
  });
  if (!baseDecision.allowed) {
    return baseDecision;
  }

  return evaluateMarketplaceIntentPolicy(policy, intent);
}

export function wrapMarketplaceSignerPolicy(
  tool: Tool,
  params: {
    readonly policy?: MarketplaceSignerPolicy;
    readonly programId: PublicKey;
    readonly signer?: PublicKey | null;
    readonly logger: Logger;
  },
): Tool {
  if (!params.policy) {
    return {
      ...tool,
      async execute(_args: Record<string, unknown>): Promise<ToolResult> {
        params.logger.warn?.(
          `Marketplace signer policy denied ${tool.name}: signer policy is required`,
        );
        return errorResult("Marketplace signer policy is required for mutation tools", {
          toolName: tool.name,
          denialCode: "POLICY_REQUIRED",
        });
      },
    };
  }
  return {
    ...tool,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      let decision: MarketplaceSignerPolicyEvaluation;
      try {
        decision = evaluateMarketplaceSignerPolicy({
          policy: params.policy!,
          toolName: tool.name,
          args,
          programId: params.programId,
          signer: params.signer,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { toolName: tool.name });
      }
      if (!decision.allowed) {
        params.logger.warn?.(
          `Marketplace signer policy denied ${tool.name}: ${decision.reason ?? decision.code ?? "denied"}`,
        );
        return errorResult(decision.reason ?? `${tool.name} denied by signer policy`, {
          toolName: tool.name,
          denialCode: decision.code ?? "DENIED",
          ...(decision.metadata ?? {}),
        });
      }
      params.logger.info?.(`Marketplace signer policy approved ${tool.name}`);
      return tool.execute(args);
    },
  };
}
