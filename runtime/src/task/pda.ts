/**
 * PDA derivation helpers for task-related accounts
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "@tetsuo-ai/sdk";
import { derivePda, validateIdLength } from "../utils/pda.js";

// Re-export PdaWithBump from utils — existing consumers import from here
export type { PdaWithBump } from "../utils/pda.js";
import type { PdaWithBump } from "../utils/pda.js";

/** Length of task_id field (bytes) */
export const TASK_ID_LENGTH = 32;

type OptionalSeedRecord = Partial<Record<string, Buffer>>;

// The runtime can be upgraded ahead of the published SDK package. Fall back to
// the raw seed bytes locally until the matching SDK release is available.
const optionalSeeds = SEEDS as OptionalSeedRecord;
const TASK_VALIDATION_SEED =
  optionalSeeds.TASK_VALIDATION ?? Buffer.from("task_validation");
const TASK_ATTESTOR_SEED =
  optionalSeeds.TASK_ATTESTOR ?? Buffer.from("task_attestor");
const TASK_SUBMISSION_SEED =
  optionalSeeds.TASK_SUBMISSION ?? Buffer.from("task_submission");
const TASK_VALIDATION_VOTE_SEED =
  optionalSeeds.TASK_VALIDATION_VOTE ?? Buffer.from("task_validation_vote");

/**
 * Derives the task PDA and bump seed.
 * Seeds: ["task", creator, task_id]
 *
 * @param creator - Task creator's public key
 * @param taskId - 32-byte task identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 * @throws Error if taskId is not 32 bytes
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveTaskPda(creatorPubkey, taskId);
 * console.log(`Task PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveTaskPda(
  creator: PublicKey,
  taskId: Uint8Array,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  validateIdLength(taskId, TASK_ID_LENGTH, "taskId");
  return derivePda(
    [SEEDS.TASK, creator.toBuffer(), Buffer.from(taskId)],
    programId,
  );
}

/**
 * Finds the task PDA address (without bump).
 * Convenience wrapper around deriveTaskPda for when only the address is needed.
 *
 * @param creator - Task creator's public key
 * @param taskId - 32-byte task identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 * @throws Error if taskId is not 32 bytes
 *
 * @example
 * ```typescript
 * const taskPda = findTaskPda(creatorPubkey, taskId);
 * const task = await program.account.task.fetch(taskPda);
 * ```
 */
export function findTaskPda(
  creator: PublicKey,
  taskId: Uint8Array,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveTaskPda(creator, taskId, programId).address;
}

/**
 * Derives the claim PDA and bump seed.
 * Seeds: ["claim", task_pda, worker_agent_pda]
 *
 * @param taskPda - Task account PDA
 * @param workerAgentPda - Worker agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveClaimPda(taskPda, workerAgentPda);
 * console.log(`Claim PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [SEEDS.CLAIM, taskPda.toBuffer(), workerAgentPda.toBuffer()],
    programId,
  );
}

/**
 * Finds the claim PDA address (without bump).
 * Convenience wrapper around deriveClaimPda for when only the address is needed.
 *
 * @param taskPda - Task account PDA
 * @param workerAgentPda - Worker agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const claimPda = findClaimPda(taskPda, workerAgentPda);
 * const claim = await program.account.taskClaim.fetch(claimPda);
 * ```
 */
export function findClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveClaimPda(taskPda, workerAgentPda, programId).address;
}

/**
 * Derives the escrow PDA and bump seed.
 * Seeds: ["escrow", task_pda]
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveEscrowPda(taskPda);
 * console.log(`Escrow PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([SEEDS.ESCROW, taskPda.toBuffer()], programId);
}

/**
 * Finds the escrow PDA address (without bump).
 * Convenience wrapper around deriveEscrowPda for when only the address is needed.
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const escrowPda = findEscrowPda(taskPda);
 * const escrow = await program.account.taskEscrow.fetch(escrowPda);
 * ```
 */
export function findEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveEscrowPda(taskPda, programId).address;
}

/**
 * Derives the task validation config PDA and bump seed.
 * Seeds: ["task_validation", task_pda]
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveTaskValidationConfigPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([TASK_VALIDATION_SEED, taskPda.toBuffer()], programId);
}

/**
 * Finds the task validation config PDA address (without bump).
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
/**
 * Derives the task attestor config PDA and bump seed.
 * Seeds: ["task_attestor", task_pda]
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveTaskAttestorConfigPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([TASK_ATTESTOR_SEED, taskPda.toBuffer()], programId);
}

/**
 * Finds the task attestor config PDA address (without bump).
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
/**
 * Derives the task submission PDA and bump seed.
 * Seeds: ["task_submission", claim_pda]
 *
 * @param claimPda - Task claim PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveTaskSubmissionPda(
  claimPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([TASK_SUBMISSION_SEED, claimPda.toBuffer()], programId);
}

/**
 * Finds the task submission PDA address (without bump).
 *
 * @param claimPda - Task claim PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
/**
 * Derives the task validation vote PDA and bump seed.
 * Seeds: ["task_validation_vote", task_submission_pda, reviewer]
 *
 * @param taskSubmissionPda - Task submission PDA
 * @param reviewer - Reviewer wallet public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveTaskValidationVotePda(
  taskSubmissionPda: PublicKey,
  reviewer: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [
      TASK_VALIDATION_VOTE_SEED,
      taskSubmissionPda.toBuffer(),
      reviewer.toBuffer(),
    ],
    programId,
  );
}

/**
 * Finds the task validation vote PDA address (without bump).
 *
 * @param taskSubmissionPda - Task submission PDA
 * @param reviewer - Reviewer wallet public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
/**
 * Derives the bid book PDA and bump seed.
 * Seeds: ["bid_book", task_pda]
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveBidBookPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([Buffer.from("bid_book"), taskPda.toBuffer()], programId);
}

/**
 * Finds the bid book PDA address (without bump).
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findBidBookPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveBidBookPda(taskPda, programId).address;
}

/**
 * Derives the bid PDA and bump seed.
 * Seeds: ["bid", task_pda, bidder_agent_pda]
 *
 * @param taskPda - Task account PDA
 * @param bidderAgentPda - Bidder agent PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveBidPda(
  taskPda: PublicKey,
  bidderAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [Buffer.from("bid"), taskPda.toBuffer(), bidderAgentPda.toBuffer()],
    programId,
  );
}

/**
 * Finds the bid PDA address (without bump).
 *
 * @param taskPda - Task account PDA
 * @param bidderAgentPda - Bidder agent PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findBidPda(
  taskPda: PublicKey,
  bidderAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveBidPda(taskPda, bidderAgentPda, programId).address;
}

/**
 * Derives the bidder marketplace state PDA and bump seed.
 * Seeds: ["bidder_market", bidder_agent_pda]
 *
 * @param bidderAgentPda - Bidder agent PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveBidderMarketStatePda(
  bidderAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [Buffer.from("bidder_market"), bidderAgentPda.toBuffer()],
    programId,
  );
}

/**
 * Finds the bidder marketplace state PDA address (without bump).
 *
 * @param bidderAgentPda - Bidder agent PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findBidderMarketStatePda(
  bidderAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveBidderMarketStatePda(bidderAgentPda, programId).address;
}
