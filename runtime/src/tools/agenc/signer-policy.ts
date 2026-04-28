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
  }
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
      ...(intent.jobSpecHash ? { jobSpecHash: intent.jobSpecHash } : {}),
      ...(intent.constraintHash ? { constraintHash: intent.constraintHash } : {}),
      ...(intent.rewardLamports ? { reward: intent.rewardLamports } : {}),
      ...(intent.rewardMint ? { rewardMint: intent.rewardMint } : { rewardMint: "SOL" }),
    },
  });
  if (!baseDecision.allowed) {
    return baseDecision;
  }

  for (const expected of policy.expectedAccountMetas ?? []) {
    const actual = intent.accountMetas.find(
      (account) => account.name === expected.name,
    );
    if (!actual) {
      return {
        allowed: false,
        code: "ACCOUNT_META_MISSING",
        reason: `Required account meta ${expected.name} is missing from transaction intent`,
        metadata: { accountName: expected.name },
      };
    }
    if (expected.pubkey && actual.pubkey !== expected.pubkey) {
      return {
        allowed: false,
        code: "ACCOUNT_META_PUBKEY_MISMATCH",
        reason: `Account meta ${expected.name} pubkey does not match signer policy`,
        metadata: {
          accountName: expected.name,
          expectedPubkey: expected.pubkey,
          actualPubkey: actual.pubkey,
        },
      };
    }
    if (
      expected.isSigner !== undefined &&
      actual.isSigner !== expected.isSigner
    ) {
      return {
        allowed: false,
        code: "ACCOUNT_META_SIGNER_MISMATCH",
        reason: `Account meta ${expected.name} signer flag does not match signer policy`,
        metadata: { accountName: expected.name },
      };
    }
    if (
      expected.isWritable !== undefined &&
      actual.isWritable !== expected.isWritable
    ) {
      return {
        allowed: false,
        code: "ACCOUNT_META_WRITABLE_MISMATCH",
        reason: `Account meta ${expected.name} writable flag does not match signer policy`,
        metadata: { accountName: expected.name },
      };
    }
  }

  return baseDecision;
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
    return tool;
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
