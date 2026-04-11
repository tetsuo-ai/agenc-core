import { SystemProgram, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import { bytesToHex, hexToBytes } from "../utils/encoding.js";
import {
  resolveMarketplaceJobSpecReference,
  type MarketplaceJobSpecStoreOptions,
  type ResolvedMarketplaceJobSpecReference,
} from "./job-spec-store.js";

const TASK_JOB_SPEC_SEED = Buffer.from("task_job_spec");
const TASK_JOB_SPEC_HASH_BYTES = 32;

export interface OnChainTaskJobSpecPointer {
  readonly taskPda: string;
  readonly taskJobSpecPda: string;
  readonly creator: string;
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly bump: number;
}

export interface ResolvedOnChainTaskJobSpec
  extends OnChainTaskJobSpecPointer,
    ResolvedMarketplaceJobSpecReference {}

interface TaskJobSpecAccountData {
  readonly task: PublicKey;
  readonly creator: PublicKey;
  readonly jobSpecHash: Uint8Array | number[];
  readonly jobSpecUri: string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly bump: number;
}

export function findTaskJobSpecPda(
  taskPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [TASK_JOB_SPEC_SEED, taskPda.toBuffer()],
    programId,
  )[0];
}

export async function fetchTaskJobSpecPointer(
  program: Program<AgencCoordination>,
  taskPda: PublicKey,
): Promise<OnChainTaskJobSpecPointer | null> {
  const taskJobSpecPda = findTaskJobSpecPda(taskPda, program.programId);
  try {
    const raw = (await (program.account as any).taskJobSpec.fetch(
      taskJobSpecPda,
    )) as TaskJobSpecAccountData;
    return parseTaskJobSpecAccountData(taskPda, taskJobSpecPda, raw);
  } catch (error) {
    if (isMissingAccountError(error)) return null;
    throw error;
  }
}

export async function resolveOnChainTaskJobSpecForTask(
  program: Program<AgencCoordination>,
  taskPda: PublicKey,
  options: MarketplaceJobSpecStoreOptions = {},
): Promise<ResolvedOnChainTaskJobSpec | null> {
  const pointer = await fetchTaskJobSpecPointer(program, taskPda);
  if (!pointer) return null;

  const resolved = await resolveMarketplaceJobSpecReference(pointer, options);
  return {
    ...pointer,
    ...resolved,
  };
}

export async function setTaskJobSpecPointer(
  program: Program<AgencCoordination>,
  creator: PublicKey,
  taskPda: PublicKey,
  jobSpecHash: string | Uint8Array | number[],
  jobSpecUri: string,
): Promise<{ taskJobSpecPda: PublicKey; transactionSignature: string }> {
  const taskJobSpecPda = findTaskJobSpecPda(taskPda, program.programId);
  const jobSpecHashBytes = normalizeJobSpecHash(jobSpecHash);
  const transactionSignature = await (program.methods as any)
    .setTaskJobSpec(Array.from(jobSpecHashBytes), jobSpecUri)
    .accountsPartial({
      task: taskPda,
      taskJobSpec: taskJobSpecPda,
      creator,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { taskJobSpecPda, transactionSignature };
}

function parseTaskJobSpecAccountData(
  taskPda: PublicKey,
  taskJobSpecPda: PublicKey,
  raw: TaskJobSpecAccountData,
): OnChainTaskJobSpecPointer {
  const hashBytes = normalizeJobSpecHash(raw.jobSpecHash);
  return {
    taskPda: taskPda.toBase58(),
    taskJobSpecPda: taskJobSpecPda.toBase58(),
    creator: raw.creator.toBase58(),
    jobSpecHash: bytesToHex(hashBytes),
    jobSpecUri: raw.jobSpecUri,
    createdAt: numberFromAnchorValue(raw.createdAt),
    updatedAt: numberFromAnchorValue(raw.updatedAt),
    bump: raw.bump,
  };
}

function normalizeJobSpecHash(
  jobSpecHash: string | Uint8Array | number[],
): Uint8Array {
  const bytes =
    typeof jobSpecHash === "string"
      ? hexToBytes(jobSpecHash)
      : Uint8Array.from(jobSpecHash);
  if (bytes.length !== TASK_JOB_SPEC_HASH_BYTES) {
    throw new Error(
      `jobSpecHash must be ${TASK_JOB_SPEC_HASH_BYTES} bytes`,
    );
  }
  return bytes;
}

function numberFromAnchorValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    return Number((value as { toString: () => string }).toString());
  }
  throw new Error(`Unsupported anchor numeric value: ${String(value)}`);
}

function isMissingAccountError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("account does not exist") ||
    lower.includes("could not find account") ||
    lower.includes("invalid param") ||
    lower.includes("not found")
  );
}
