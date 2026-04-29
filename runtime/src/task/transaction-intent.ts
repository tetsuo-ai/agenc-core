import { PublicKey, SystemProgram, type AccountMeta } from "@solana/web3.js";

import { findAuthorityRateLimitPda, findProtocolPda } from "../agent/pda.js";
import { buildCreateTaskTokenAccounts } from "../utils/token.js";
import { findEscrowPda, findTaskPda } from "./pda.js";

export type MarketplaceTransactionIntentKind =
  | "create_task"
  | "claim_task"
  | "claim_task_with_job_spec"
  | "complete_task"
  | "complete_task_private"
  | "submit_task_result";

export interface MarketplaceTransactionAccountMeta {
  readonly name: string;
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface MarketplaceTransactionIntent {
  readonly kind: MarketplaceTransactionIntentKind;
  readonly programId: string;
  readonly signer: string | null;
  readonly taskPda?: string;
  readonly taskId?: string;
  readonly jobSpecHash?: string | null;
  readonly rewardLamports?: string;
  readonly rewardMint?: string | null;
  readonly constraintHash?: string | null;
  readonly accountMetas: readonly MarketplaceTransactionAccountMeta[];
}

export interface CreateTaskIntentInput {
  readonly programId: PublicKey;
  readonly signer: PublicKey;
  readonly taskId: Uint8Array;
  readonly creatorAgentPda: PublicKey;
  readonly rewardLamports: bigint | string;
  readonly rewardMint?: PublicKey | null;
  readonly jobSpecHash?: string | null;
  readonly constraintHash?: Uint8Array | string | null;
}

export function hexBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function namedAccountMeta(
  name: string,
  pubkey: PublicKey,
  isWritable: boolean,
  isSigner = false,
): MarketplaceTransactionAccountMeta {
  return {
    name,
    pubkey: pubkey.toBase58(),
    isSigner,
    isWritable,
  };
}

export function accountMetaToIntentMeta(
  name: string,
  meta: AccountMeta,
): MarketplaceTransactionAccountMeta {
  return {
    name,
    pubkey: meta.pubkey.toBase58(),
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  };
}

export function buildCreateTaskIntent(
  input: CreateTaskIntentInput,
): MarketplaceTransactionIntent {
  const taskPda = findTaskPda(input.signer, input.taskId, input.programId);
  const escrowPda = findEscrowPda(taskPda, input.programId);
  const protocolPda = findProtocolPda(input.programId);
  const authorityRateLimitPda = findAuthorityRateLimitPda(
    input.signer,
    input.programId,
  );
  const tokenAccounts = buildCreateTaskTokenAccounts(
    input.rewardMint ?? null,
    escrowPda,
    input.signer,
  );
  const constraintHash =
    typeof input.constraintHash === "string"
      ? input.constraintHash
      : input.constraintHash
        ? hexBytes(input.constraintHash)
        : null;

  return {
    kind: "create_task",
    programId: input.programId.toBase58(),
    signer: input.signer.toBase58(),
    taskPda: taskPda.toBase58(),
    taskId: hexBytes(input.taskId),
    jobSpecHash: input.jobSpecHash ?? null,
    rewardLamports: input.rewardLamports.toString(),
    rewardMint: input.rewardMint?.toBase58() ?? null,
    constraintHash,
    accountMetas: [
      namedAccountMeta("task", taskPda, true),
      namedAccountMeta("escrow", escrowPda, true),
      namedAccountMeta("creatorAgent", input.creatorAgentPda, true),
      namedAccountMeta("protocolConfig", protocolPda, false),
      namedAccountMeta("authorityRateLimit", authorityRateLimitPda, true),
      namedAccountMeta("creator", input.signer, true, true),
      namedAccountMeta("systemProgram", SystemProgram.programId, false),
      ...Object.entries(tokenAccounts)
        .filter((entry): entry is [string, PublicKey] => entry[1] instanceof PublicKey)
        .map(([name, pubkey]) => namedAccountMeta(name, pubkey, true)),
    ],
  };
}
