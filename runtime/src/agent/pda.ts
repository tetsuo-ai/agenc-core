/**
 * PDA derivation helpers for agent-related accounts
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "@tetsuo-ai/sdk";
import { AGENT_ID_LENGTH } from "./types.js";
import { derivePda, validateIdLength } from "../utils/pda.js";

// Re-export PdaWithBump from utils — existing consumers import from here
export type { PdaWithBump } from "../utils/pda.js";
import type { PdaWithBump } from "../utils/pda.js";

type OptionalSeedRecord = Partial<Record<string, Buffer>>;

// The runtime can be upgraded ahead of the published SDK package. Fall back to
// the raw seed bytes locally until the matching SDK release is available.
const optionalSeeds = SEEDS as OptionalSeedRecord;
const AUTHORITY_RATE_LIMIT_SEED =
  optionalSeeds.AUTHORITY_RATE_LIMIT ?? Buffer.from("authority_rate_limit");

/**
 * Derives the agent PDA and bump seed from an agent ID.
 * Seeds: ["agent", agent_id]
 *
 * @param agentId - 32-byte agent identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 * @throws Error if agentId is not 32 bytes
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveAgentPda(agentId);
 * console.log(`Agent PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveAgentPda(
  agentId: Uint8Array,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  validateIdLength(agentId, AGENT_ID_LENGTH, "agentId");
  return derivePda([SEEDS.AGENT, Buffer.from(agentId)], programId);
}

/**
 * Derives the protocol config PDA and bump seed.
 * Seeds: ["protocol"]
 *
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveProtocolPda();
 * console.log(`Protocol PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveProtocolPda(
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([SEEDS.PROTOCOL], programId);
}

/**
 * Finds the agent PDA address (without bump).
 * Convenience wrapper around deriveAgentPda for when only the address is needed.
 *
 * @param agentId - 32-byte agent identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 * @throws Error if agentId is not 32 bytes
 *
 * @example
 * ```typescript
 * const agentPda = findAgentPda(agentId);
 * const agentState = await program.account.agentRegistration.fetch(agentPda);
 * ```
 */
export function findAgentPda(
  agentId: Uint8Array,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveAgentPda(agentId, programId).address;
}

/**
 * Finds the protocol config PDA address (without bump).
 * Convenience wrapper around deriveProtocolPda for when only the address is needed.
 *
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const protocolPda = findProtocolPda();
 * const config = await program.account.protocolConfig.fetch(protocolPda);
 * ```
 */
export function findProtocolPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return deriveProtocolPda(programId).address;
}

/**
 * Derives the authority rate-limit PDA and bump seed.
 * Used by task creation and dispute initiation cooldown logic.
 * Seeds: ["authority_rate_limit", authority]
 *
 * @param authority - Authority (wallet) public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveAuthorityRateLimitPda(
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([AUTHORITY_RATE_LIMIT_SEED, authority.toBuffer()], programId);
}

/**
 * Finds the authority rate-limit PDA address (without bump).
 * Convenience wrapper around deriveAuthorityRateLimitPda for when only the
 * address is needed.
 *
 * @param authority - Authority (wallet) public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findAuthorityRateLimitPda(
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveAuthorityRateLimitPda(authority, programId).address;
}

/**
 * Derives the authority vote PDA and bump seed.
 * Used to prevent Sybil attacks on dispute voting (one vote per authority per dispute).
 * Seeds: ["authority_vote", dispute, authority]
 *
 * @param disputePda - Dispute account PDA
 * @param authority - Authority (wallet) public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveAuthorityVotePda(disputePda, authority);
 * console.log(`Authority vote PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveAuthorityVotePda(
  disputePda: PublicKey,
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [SEEDS.AUTHORITY_VOTE, disputePda.toBuffer(), authority.toBuffer()],
    programId,
  );
}

/**
 * Finds the authority vote PDA address (without bump).
 * Convenience wrapper around deriveAuthorityVotePda for when only the address is needed.
 *
 * @param disputePda - Dispute account PDA
 * @param authority - Authority (wallet) public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const authorityVotePda = findAuthorityVotePda(disputePda, authority);
 * const vote = await program.account.authorityDisputeVote.fetch(authorityVotePda);
 * ```
 */
export function findAuthorityVotePda(
  disputePda: PublicKey,
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveAuthorityVotePda(disputePda, authority, programId).address;
}
