import { createHash } from 'node:crypto';
import anchor, { type Program } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  SEEDS,
  TOKEN_PROGRAM_ID,
} from '@tetsuo-ai/sdk';
import type { AgencCoordination } from '../../types/agenc_coordination.js';
import { parseAgentState } from '../../agent/types.js';
import { findProtocolPda } from '../../agent/pda.js';
import { GovernanceOperations } from '../../governance/operations.js';
import { ProposalType } from '../../governance/types.js';
import { DisputeOperations } from '../../dispute/operations.js';
import { ResolutionType } from '../../dispute/types.js';
import { ReputationEconomyOperations } from '../../reputation/economy.js';
import {
  MIN_DELEGATION_AMOUNT,
  REPUTATION_MAX,
} from '../../reputation/types.js';
import { TaskOperations } from '../../task/operations.js';
import { TaskType } from '../../events/types.js';
import {
  findBidBookPda,
  findBidPda,
  findBidderMarketStatePda,
  findClaimPda,
} from '../../task/pda.js';
import type { Logger } from '../../utils/logger.js';
import { bytesToHex, generateAgentId, hexToBytes } from '../../utils/encoding.js';
import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';

const ZERO_AGENT_ID = new Uint8Array(32);
const MAX_U64 = (1n << 64n) - 1n;
const HASH_BYTES = 32;
const NAME_BYTES = 32;
const TAG_BYTES = 64;
const RESULT_BYTES = 64;
const PROPOSAL_PAYLOAD_BYTES = 64;

interface ResolvedSignerAgent {
  authority: PublicKey;
  agentPda: PublicKey;
  agentId: Uint8Array;
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function parseBase58(input: unknown, field: string): [PublicKey | null, ToolResult | null] {
  if (typeof input !== 'string' || input.length === 0) {
    return [null, errorResult(`Missing or invalid ${field}`)];
  }
  try {
    return [new PublicKey(input), null];
  } catch {
    return [null, errorResult(`Invalid ${field}: ${input}`)];
  }
}

function parseBigIntInput(value: unknown, field: string): [bigint | null, ToolResult | null] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return [null, errorResult(`${field} must be a non-negative integer`)];
    }
    return [BigInt(value), null];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return [null, errorResult(`${field} must be an integer string`)];
    }
    return [BigInt(trimmed), null];
  }
  return [null, errorResult(`Missing or invalid ${field}`)];
}

function validateU64(value: bigint, field: string): ToolResult | null {
  if (value > MAX_U64) {
    return errorResult(`${field} exceeds u64 max (${MAX_U64.toString()})`);
  }
  return null;
}

function parseBooleanInput(value: unknown, field: string): [boolean | null, ToolResult | null] {
  if (typeof value !== 'boolean') {
    return [null, errorResult(`${field} must be a boolean`)];
  }
  return [value, null];
}

function parseNumberInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  defaultValue?: number,
): [number | null, ToolResult | null] {
  if (value === undefined) {
    return defaultValue === undefined ? [null, errorResult(`Missing ${field}`)] : [defaultValue, null];
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return [null, errorResult(`${field} must be an integer`)];
  }
  if (value < min || value > max) {
    return [null, errorResult(`${field} must be between ${min} and ${max}`)];
  }
  return [value, null];
}

function parseFixedHexBytes(
  value: unknown,
  field: string,
  expectedLength: number,
  generateIfMissing = false,
): [Uint8Array | null, ToolResult | null] {
  if (value === undefined) {
    if (!generateIfMissing) {
      return [null, errorResult(`Missing ${field}`)];
    }
    const generated = generateAgentId();
    if (generated.length !== expectedLength) {
      return [null, errorResult(`Failed to generate ${field}`)];
    }
    return [generated, null];
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [null, errorResult(`${field} must be a hex string`)];
  }
  try {
    const bytes = hexToBytes(value);
    if (bytes.length !== expectedLength) {
      return [
        null,
        errorResult(`${field} must be ${expectedLength} bytes (${expectedLength * 2} hex chars)`),
      ];
    }
    return [bytes, null];
  } catch {
    return [null, errorResult(`${field} must be a valid hex string`)];
  }
}

function parseFixedUtf8Bytes(
  value: unknown,
  field: string,
  maxLength: number,
  defaultValue = '',
): [Uint8Array | null, ToolResult | null] {
  const input = value === undefined ? defaultValue : value;
  if (typeof input !== 'string') {
    return [null, errorResult(`${field} must be a string`)];
  }
  const encoded = new TextEncoder().encode(input);
  if (encoded.length > maxLength) {
    return [null, errorResult(`${field} exceeds ${maxLength} bytes`)];
  }
  const output = new Uint8Array(maxLength);
  output.set(encoded);
  return [output, null];
}

function parseTagBytes(value: unknown): [Uint8Array | null, ToolResult | null] {
  if (value === undefined) {
    return parseFixedUtf8Bytes('', 'tags', TAG_BYTES, '');
  }
  if (Array.isArray(value)) {
    const tags = value.every((item) => typeof item === 'string')
      ? value.join(',')
      : null;
    if (tags === null) {
      return [null, errorResult('tags must be a string or array of strings')];
    }
    return parseFixedUtf8Bytes(tags, 'tags', TAG_BYTES);
  }
  return parseFixedUtf8Bytes(value, 'tags', TAG_BYTES);
}

function hashString(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}

function parseProposalType(value: unknown): [ProposalType | null, ToolResult | null] {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return [value as ProposalType, null];
  }
  if (typeof value !== 'string') {
    return [null, errorResult('proposalType must be a string or enum value')];
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'protocol_upgrade':
    case 'protocolupgrade':
      return [ProposalType.ProtocolUpgrade, null];
    case 'fee_change':
    case 'feechange':
      return [ProposalType.FeeChange, null];
    case 'treasury_spend':
    case 'treasuryspend':
      return [ProposalType.TreasurySpend, null];
    case 'rate_limit_change':
    case 'ratelimitchange':
      return [ProposalType.RateLimitChange, null];
    default:
      return [null, errorResult(`Unsupported proposalType: ${value}`)];
  }
}

function proposalTypeToString(value: ProposalType): string {
  switch (value) {
    case ProposalType.ProtocolUpgrade:
      return 'protocol_upgrade';
    case ProposalType.FeeChange:
      return 'fee_change';
    case ProposalType.TreasurySpend:
      return 'treasury_spend';
    case ProposalType.RateLimitChange:
      return 'rate_limit_change';
    default:
      return 'unknown';
  }
}

function parseResolutionType(value: unknown): [number | null, ToolResult | null] {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2) {
    return [value, null];
  }
  if (typeof value !== 'string') {
    return [null, errorResult('resolutionType must be a string or enum value')];
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'refund':
      return [ResolutionType.Refund, null];
    case 'complete':
      return [ResolutionType.Complete, null];
    case 'split':
      return [ResolutionType.Split, null];
    default:
      return [null, errorResult(`Unsupported resolutionType: ${value}`)];
  }
}

function resolutionTypeToString(value: number): string {
  switch (value) {
    case ResolutionType.Refund:
      return 'refund';
    case ResolutionType.Complete:
      return 'complete';
    case ResolutionType.Split:
      return 'split';
    default:
      return 'unknown';
  }
}

async function resolveAuthorityAgentPda(
  program: Program<AgencCoordination>,
  authority: PublicKey,
  providedAgentPda?: unknown,
): Promise<[PublicKey | null, ToolResult | null]> {
  if (providedAgentPda !== undefined) {
    return parseBase58(providedAgentPda, 'agentPda');
  }

  const bs58 = await import('bs58');
  const AGENT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
  const AGENT_AUTHORITY_OFFSET = 40;
  const matches = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_DISCRIMINATOR) } },
      { memcmp: { offset: AGENT_AUTHORITY_OFFSET, bytes: authority.toBase58() } },
    ],
  });

  if (matches.length === 0) {
    return [null, errorResult('No agent registration found for signer wallet. Run `agenc-runtime agent register --rpc <url>` first, or provide the explicit agent PDA.')];
  }
  if (matches.length > 1) {
    return [null, errorResult('Multiple agent registrations found for signer wallet. Provide the explicit agent PDA.')];
  }

  return [matches[0].pubkey, null];
}

async function resolveSignerAgentContext(
  program: Program<AgencCoordination>,
  providedAgentPda: unknown,
): Promise<[ResolvedSignerAgent | null, ToolResult | null]> {
  const authority = program.provider.publicKey;
  if (!authority) {
    return [null, errorResult('This action requires a signer-backed program context')];
  }

  const [agentPda, agentErr] = await resolveAuthorityAgentPda(program, authority, providedAgentPda);
  if (agentErr || !agentPda) return [null, agentErr ?? errorResult('Unable to resolve signer agent')];

  try {
    const raw = await (program.account as any).agentRegistration.fetch(agentPda);
    const agent = parseAgentState(raw as Record<string, unknown>);
    if (!agent.authority.equals(authority)) {
      return [null, errorResult(`Agent ${agentPda.toBase58()} does not belong to the connected signer`)];
    }
    return [
      {
        authority,
        agentPda,
        agentId: agent.agentId,
      },
      null,
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [null, errorResult(message)];
  }
}

async function fetchAgentAuthority(
  program: Program<AgencCoordination>,
  agentPda: PublicKey,
): Promise<[PublicKey | null, ToolResult | null]> {
  try {
    const raw = await (program.account as any).agentRegistration.fetch(agentPda);
    const agent = parseAgentState(raw as Record<string, unknown>);
    return [agent.authority, null];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [null, errorResult(message)];
  }
}

async function fetchAgentId(
  program: Program<AgencCoordination>,
  agentPda: PublicKey,
): Promise<[Uint8Array | null, ToolResult | null]> {
  try {
    const raw = await (program.account as any).agentRegistration.fetch(agentPda);
    const agent = parseAgentState(raw as Record<string, unknown>);
    return [agent.agentId, null];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [null, errorResult(message)];
  }
}

async function fetchProtocolTreasury(
  program: Program<AgencCoordination>,
  action: string,
): Promise<[PublicKey | null, ToolResult | null]> {
  const protocolPda = findProtocolPda(program.programId);
  try {
    const accountInfo = await program.provider.connection.getAccountInfo(protocolPda);
    if (!accountInfo) {
      return [
        null,
        errorResult(
          `Protocol config is not initialized for this program/network. Cannot ${action}.`,
        ),
      ];
    }
    return [new PublicKey(accountInfo.data.subarray(40, 72)), null];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [null, errorResult(message)];
  }
}

function deriveAcceptedBidSettlementAccounts(
  taskPda: PublicKey,
  bidderAgentPda: PublicKey,
  programId: PublicKey,
) {
  return {
    bidBook: findBidBookPda(taskPda, programId),
    acceptedBid: findBidPda(taskPda, bidderAgentPda, programId),
    bidderMarketState: findBidderMarketStatePda(bidderAgentPda, programId),
  };
}

function deriveSkillPda(
  authorAgentPda: PublicKey,
  skillId: Uint8Array,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SKILL, authorAgentPda.toBuffer(), Buffer.from(skillId)],
    programId,
  )[0];
}

function deriveSkillRatingPda(
  skillPda: PublicKey,
  raterAgentPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SKILL_RATING, skillPda.toBuffer(), raterAgentPda.toBuffer()],
    programId,
  )[0];
}

function deriveSkillPurchasePda(
  skillPda: PublicKey,
  buyerAgentPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SKILL_PURCHASE, skillPda.toBuffer(), buyerAgentPda.toBuffer()],
    programId,
  )[0];
}

function buildSkillTokenAccounts(
  mint: PublicKey | null,
  buyerWallet: PublicKey,
  authorWallet: PublicKey,
  treasury: PublicKey,
): Record<string, PublicKey | null> {
  if (!mint) {
    return {
      priceMint: null,
      buyerTokenAccount: null,
      authorTokenAccount: null,
      treasuryTokenAccount: null,
      tokenProgram: null,
    };
  }

  return {
    priceMint: mint,
    buyerTokenAccount: getAssociatedTokenAddressSync(mint, buyerWallet),
    authorTokenAccount: getAssociatedTokenAddressSync(mint, authorWallet),
    treasuryTokenAccount: getAssociatedTokenAddressSync(mint, treasury),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

function parseVotePairs(
  value: unknown,
  field: string,
): [Array<{ votePda: PublicKey; arbiterAgentPda: PublicKey }> | null, ToolResult | null] {
  if (!Array.isArray(value) || value.length === 0) {
    return [null, errorResult(`${field} must be a non-empty array`)];
  }
  const pairs: Array<{ votePda: PublicKey; arbiterAgentPda: PublicKey }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return [null, errorResult(`${field} entries must be objects`)];
    }
    const [votePda, voteErr] = parseBase58((entry as Record<string, unknown>).votePda, `${field}.votePda`);
    if (voteErr || !votePda) return [null, voteErr ?? errorResult(`Invalid ${field}.votePda`)];
    const [arbiterAgentPda, arbiterErr] = parseBase58(
      (entry as Record<string, unknown>).arbiterAgentPda,
      `${field}.arbiterAgentPda`,
    );
    if (arbiterErr || !arbiterAgentPda) {
      return [null, arbiterErr ?? errorResult(`Invalid ${field}.arbiterAgentPda`)];
    }
    pairs.push({ votePda, arbiterAgentPda });
  }
  return [pairs, null];
}

function parseWorkerPairs(
  value: unknown,
  field: string,
): [Array<{ claimPda: PublicKey; workerPda: PublicKey }> | null, ToolResult | null] {
  if (value === undefined) return [[], null];
  if (!Array.isArray(value)) {
    return [null, errorResult(`${field} must be an array`)];
  }
  const pairs: Array<{ claimPda: PublicKey; workerPda: PublicKey }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return [null, errorResult(`${field} entries must be objects`)];
    }
    const [claimPda, claimErr] = parseBase58((entry as Record<string, unknown>).claimPda, `${field}.claimPda`);
    if (claimErr || !claimPda) return [null, claimErr ?? errorResult(`Invalid ${field}.claimPda`)];
    const [workerPda, workerErr] = parseBase58((entry as Record<string, unknown>).workerPda, `${field}.workerPda`);
    if (workerErr || !workerPda) return [null, workerErr ?? errorResult(`Invalid ${field}.workerPda`)];
    pairs.push({ claimPda, workerPda });
  }
  return [pairs, null];
}

export function createClaimTaskTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.claimTask',
    description: 'Claim an AgenC task as the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        taskPda: {
          type: 'string',
          description: 'Task account PDA (base58)',
        },
        workerAgentPda: {
          type: 'string',
          description: 'Optional explicit worker agent PDA when the signer controls multiple agents',
        },
      },
      required: ['taskPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [taskPda, taskErr] = parseBase58(args.taskPda, 'taskPda');
      if (taskErr || !taskPda) return taskErr ?? errorResult('Invalid taskPda');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.workerAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve worker agent');

      try {
        const ops = new TaskOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const task = await ops.fetchTask(taskPda);
        if (!task) return errorResult(`Task not found: ${taskPda.toBase58()}`);

        const result = await ops.claimTask(taskPda, task);
        return {
          content: safeStringify({
            success: result.success,
            taskPda: taskPda.toBase58(),
            taskId: bytesToHex(result.taskId),
            workerAgentPda: signerAgent.agentPda.toBase58(),
            claimPda: result.claimPda.toBase58(),
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.claimTask failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createCompleteTaskTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.completeTask',
    description: 'Complete an AgenC task with a public proof hash.',
    inputSchema: {
      type: 'object',
      properties: {
        taskPda: {
          type: 'string',
          description: 'Task account PDA (base58)',
        },
        proofHash: {
          type: 'string',
          description: 'Proof hash as a 32-byte hex string',
        },
        resultData: {
          type: 'string',
          description: 'Optional UTF-8 result data, padded to the fixed 64-byte on-chain field',
        },
        workerAgentPda: {
          type: 'string',
          description: 'Optional explicit worker agent PDA when the signer controls multiple agents',
        },
      },
      required: ['taskPda', 'proofHash'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [taskPda, taskErr] = parseBase58(args.taskPda, 'taskPda');
      if (taskErr || !taskPda) return taskErr ?? errorResult('Invalid taskPda');

      const [proofHash, proofErr] = parseFixedHexBytes(args.proofHash, 'proofHash', HASH_BYTES);
      if (proofErr || !proofHash) return proofErr ?? errorResult('Invalid proofHash');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.workerAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve worker agent');

      let resultData: Uint8Array | null = null;
      let resultErr: ToolResult | null = null;
      if (args.resultData !== undefined) {
        [resultData, resultErr] = parseFixedUtf8Bytes(args.resultData, 'resultData', RESULT_BYTES);
      }
      if (resultErr) return resultErr;

      try {
        const ops = new TaskOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const task = await ops.fetchTask(taskPda);
        if (!task) return errorResult(`Task not found: ${taskPda.toBase58()}`);

        const completionOptions =
          task.taskType === TaskType.BidExclusive
            ? {
                acceptedBidSettlement: deriveAcceptedBidSettlementAccounts(
                  taskPda,
                  signerAgent.agentPda,
                  program.programId,
                ),
                bidderAuthority: signerAgent.authority,
              }
            : undefined;

        const result = await ops.completeTask(
          taskPda,
          task,
          proofHash,
          resultData,
          completionOptions,
        );
        return {
          content: safeStringify({
            success: result.success,
            taskPda: taskPda.toBase58(),
            taskId: bytesToHex(result.taskId),
            workerAgentPda: signerAgent.agentPda.toBase58(),
            proofHash: bytesToHex(proofHash),
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.completeTask failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createRegisterSkillTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.registerSkill',
    description: 'Register a marketplace skill owned by the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable skill name (max 32 bytes on-chain)',
        },
        contentHash: {
          type: 'string',
          description: 'Skill content hash as a 32-byte hex string',
        },
        price: {
          type: 'string',
          description: 'Skill price in lamports or raw mint units as an integer string',
        },
        tags: {
          description: 'Optional tag string or array of strings; joined and padded into the fixed 64-byte tag field',
        },
        skillId: {
          type: 'string',
          description: 'Optional 32-byte skill id as a hex string. Random when omitted.',
        },
        priceMint: {
          type: 'string',
          description: 'Optional SPL mint used for pricing. Omit for SOL pricing.',
        },
        authorAgentPda: {
          type: 'string',
          description: 'Optional explicit author agent PDA when the signer controls multiple agents',
        },
      },
      required: ['name', 'contentHash', 'price'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.authorAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve author agent');

      const [skillId, skillIdErr] = parseFixedHexBytes(args.skillId, 'skillId', HASH_BYTES, true);
      if (skillIdErr || !skillId) return skillIdErr ?? errorResult('Invalid skillId');

      const [name, nameErr] = parseFixedUtf8Bytes(args.name, 'name', NAME_BYTES);
      if (nameErr || !name) return nameErr ?? errorResult('Invalid name');

      const [contentHash, contentHashErr] = parseFixedHexBytes(args.contentHash, 'contentHash', HASH_BYTES);
      if (contentHashErr || !contentHash) return contentHashErr ?? errorResult('Invalid contentHash');

      const [price, priceErr] = parseBigIntInput(args.price, 'price');
      if (priceErr || price === null) return priceErr ?? errorResult('Invalid price');
      const priceRangeErr = validateU64(price, 'price');
      if (priceRangeErr) return priceRangeErr;

      const [tags, tagsErr] = parseTagBytes(args.tags);
      if (tagsErr || !tags) return tagsErr ?? errorResult('Invalid tags');

      let priceMint: PublicKey | null = null;
      if (args.priceMint !== undefined) {
        const [parsedMint, mintErr] = parseBase58(args.priceMint, 'priceMint');
        if (mintErr || !parsedMint) return mintErr ?? errorResult('Invalid priceMint');
        priceMint = parsedMint;
      }

      const skillPda = deriveSkillPda(signerAgent.agentPda, skillId, program.programId);
      const protocolPda = findProtocolPda(program.programId);

      try {
        const transactionSignature = await (program.methods as any)
          .registerSkill(
            Array.from(skillId),
            Array.from(name),
            Array.from(contentHash),
            new anchor.BN(price.toString()),
            priceMint,
            Array.from(tags),
          )
          .accountsPartial({
            skill: skillPda,
            author: signerAgent.agentPda,
            protocolConfig: protocolPda,
            authority: signerAgent.authority,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        return {
          content: safeStringify({
            skillPda: skillPda.toBase58(),
            skillId: bytesToHex(skillId),
            authorAgentPda: signerAgent.agentPda.toBase58(),
            price: price.toString(),
            priceMint: priceMint?.toBase58() ?? null,
            transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.registerSkill failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createPurchaseSkillTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.purchaseSkill',
    description: 'Purchase a marketplace skill as the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        skillPda: {
          type: 'string',
          description: 'Skill registration PDA (base58)',
        },
        expectedPrice: {
          type: 'string',
          description: 'Optional expected price guard. The purchase fails early if the on-chain price differs.',
        },
        buyerAgentPda: {
          type: 'string',
          description: 'Optional explicit buyer agent PDA when the signer controls multiple agents',
        },
      },
      required: ['skillPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [skillPda, skillErr] = parseBase58(args.skillPda, 'skillPda');
      if (skillErr || !skillPda) return skillErr ?? errorResult('Invalid skillPda');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.buyerAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve buyer agent');

      let expectedPrice: bigint | null = null;
      let expectedPriceErr: ToolResult | null = null;
      if (args.expectedPrice !== undefined) {
        [expectedPrice, expectedPriceErr] = parseBigIntInput(args.expectedPrice, 'expectedPrice');
      }
      if (expectedPriceErr) return expectedPriceErr;

      try {
        const skill = await (program.account as any).skillRegistration.fetch(skillPda);
        const authorAgentPda = (skill.author ?? skill.authority) as PublicKey;
        const price = BigInt((skill.price as { toString(): string }).toString());
        const priceMint = ((skill.priceMint ?? skill.price_mint) as PublicKey | null) ?? null;
        if (expectedPrice !== null && expectedPrice !== price) {
          return errorResult(
            `Expected price ${expectedPrice.toString()} does not match on-chain price ${price.toString()}`,
          );
        }
        const [authorWallet, authorErr] = await fetchAgentAuthority(program, authorAgentPda);
        if (authorErr || !authorWallet) return authorErr ?? errorResult('Unable to resolve author wallet');
        const [treasury, treasuryErr] = await fetchProtocolTreasury(program, 'purchase this skill');
        if (treasuryErr || !treasury) return treasuryErr ?? errorResult('Unable to resolve protocol treasury');

        const purchaseRecordPda = deriveSkillPurchasePda(
          skillPda,
          signerAgent.agentPda,
          program.programId,
        );
        const protocolPda = findProtocolPda(program.programId);
        const tokenAccounts = buildSkillTokenAccounts(
          priceMint,
          signerAgent.authority,
          authorWallet,
          treasury,
        );

        const transactionSignature = await (program.methods as any)
          .purchaseSkill(new anchor.BN(price.toString()))
          .accountsPartial({
            skill: skillPda,
            purchaseRecord: purchaseRecordPda,
            buyer: signerAgent.agentPda,
            authorAgent: authorAgentPda,
            authorWallet,
            protocolConfig: protocolPda,
            treasury,
            authority: signerAgent.authority,
            systemProgram: SystemProgram.programId,
            ...tokenAccounts,
          })
          .rpc();

        return {
          content: safeStringify({
            skillPda: skillPda.toBase58(),
            purchaseRecordPda: purchaseRecordPda.toBase58(),
            buyerAgentPda: signerAgent.agentPda.toBase58(),
            pricePaid: price.toString(),
            priceMint: priceMint?.toBase58() ?? null,
            transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.purchaseSkill failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createRateSkillTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.rateSkill',
    description: 'Rate a purchased marketplace skill as the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        skillPda: {
          type: 'string',
          description: 'Skill registration PDA (base58)',
        },
        rating: {
          type: 'number',
          description: 'Rating value between 1 and 5',
        },
        review: {
          type: 'string',
          description: 'Optional review text. The tool hashes it into the 32-byte on-chain review hash.',
        },
        raterAgentPda: {
          type: 'string',
          description: 'Optional explicit rater agent PDA when the signer controls multiple agents',
        },
      },
      required: ['skillPda', 'rating'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [skillPda, skillErr] = parseBase58(args.skillPda, 'skillPda');
      if (skillErr || !skillPda) return skillErr ?? errorResult('Invalid skillPda');

      const [rating, ratingErr] = parseNumberInRange(args.rating, 'rating', 1, 5);
      if (ratingErr || rating === null) return ratingErr ?? errorResult('Invalid rating');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.raterAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve rater agent');

      const ratingPda = deriveSkillRatingPda(skillPda, signerAgent.agentPda, program.programId);
      const purchaseRecordPda = deriveSkillPurchasePda(skillPda, signerAgent.agentPda, program.programId);
      const protocolPda = findProtocolPda(program.programId);
      const reviewHash =
        typeof args.review === 'string' && args.review.length > 0 ? hashString(args.review) : null;

      try {
        const transactionSignature = await (program.methods as any)
          .rateSkill(rating, reviewHash ? Array.from(reviewHash) : null)
          .accountsPartial({
            skill: skillPda,
            ratingAccount: ratingPda,
            rater: signerAgent.agentPda,
            purchaseRecord: purchaseRecordPda,
            protocolConfig: protocolPda,
            authority: signerAgent.authority,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        return {
          content: safeStringify({
            skillPda: skillPda.toBase58(),
            ratingPda: ratingPda.toBase58(),
            raterAgentPda: signerAgent.agentPda.toBase58(),
            rating,
            reviewHash: reviewHash ? bytesToHex(reviewHash) : null,
            transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.rateSkill failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createCreateProposalTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.createProposal',
    description: 'Create an on-chain governance proposal as the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalType: {
          description:
            'Proposal type. Accepts protocol_upgrade, fee_change, treasury_spend, or rate_limit_change.',
        },
        title: {
          type: 'string',
          description: 'Proposal title. The tool hashes this into the 32-byte on-chain title hash.',
        },
        description: {
          type: 'string',
          description: 'Optional proposal description. The tool hashes this into the 32-byte on-chain description hash.',
        },
        payload: {
          type: 'string',
          description: 'Optional UTF-8 payload text, padded into the fixed 64-byte payload field.',
        },
        votingPeriod: {
          type: 'number',
          description: 'Voting period in seconds. Defaults to 86400.',
        },
        nonce: {
          type: 'string',
          description: 'Optional proposal nonce as an integer string. Defaults to the current timestamp.',
        },
        proposerAgentPda: {
          type: 'string',
          description: 'Optional explicit proposer agent PDA when the signer controls multiple agents',
        },
      },
      required: ['proposalType', 'title'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.proposerAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve proposer agent');

      const [proposalType, typeErr] = parseProposalType(args.proposalType);
      if (typeErr || proposalType === null) return typeErr ?? errorResult('Invalid proposalType');

      if (typeof args.title !== 'string' || args.title.trim().length === 0) {
        return errorResult('title must be a non-empty string');
      }
      const titleHash = hashString(args.title);
      const descriptionHash = hashString(typeof args.description === 'string' ? args.description : '');

      const [payload, payloadErr] = parseFixedUtf8Bytes(
        args.payload,
        'payload',
        PROPOSAL_PAYLOAD_BYTES,
        '',
      );
      if (payloadErr || !payload) return payloadErr ?? errorResult('Invalid payload');

      const [votingPeriod, votingPeriodErr] = parseNumberInRange(
        args.votingPeriod,
        'votingPeriod',
        1,
        31_536_000,
        86_400,
      );
      if (votingPeriodErr || votingPeriod === null) {
        return votingPeriodErr ?? errorResult('Invalid votingPeriod');
      }

      let nonce: bigint | null = BigInt(Math.floor(Date.now() / 1000));
      let nonceErr: ToolResult | null = null;
      if (args.nonce !== undefined) {
        [nonce, nonceErr] = parseBigIntInput(args.nonce, 'nonce');
      }
      if (nonceErr || nonce === null) return nonceErr ?? errorResult('Invalid nonce');
      const nonceRangeErr = validateU64(nonce, 'nonce');
      if (nonceRangeErr) return nonceRangeErr;

      try {
        const ops = new GovernanceOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const result = await ops.createProposal({
          nonce,
          proposalType,
          titleHash,
          descriptionHash,
          payload,
          votingPeriod,
        });

        return {
          content: safeStringify({
            proposalPda: result.proposalPda.toBase58(),
            proposerAgentPda: signerAgent.agentPda.toBase58(),
            nonce: nonce.toString(),
            proposalType: proposalTypeToString(proposalType),
            titleHash: bytesToHex(titleHash),
            descriptionHash: bytesToHex(descriptionHash),
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.createProposal failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createVoteProposalTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.voteProposal',
    description: 'Vote on an active governance proposal as the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalPda: {
          type: 'string',
          description: 'Proposal PDA (base58)',
        },
        approve: {
          type: 'boolean',
          description: 'Whether to vote for (true) or against (false) the proposal',
        },
        voterAgentPda: {
          type: 'string',
          description: 'Optional explicit voter agent PDA when the signer controls multiple agents',
        },
      },
      required: ['proposalPda', 'approve'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [proposalPda, proposalErr] = parseBase58(args.proposalPda, 'proposalPda');
      if (proposalErr || !proposalPda) return proposalErr ?? errorResult('Invalid proposalPda');

      const [approve, approveErr] = parseBooleanInput(args.approve, 'approve');
      if (approveErr || approve === null) return approveErr ?? errorResult('Invalid approve value');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.voterAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve voter agent');

      try {
        const ops = new GovernanceOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const result = await ops.vote({ proposalPda, approve });

        return {
          content: safeStringify({
            proposalPda: proposalPda.toBase58(),
            votePda: result.votePda.toBase58(),
            voterAgentPda: signerAgent.agentPda.toBase58(),
            approve,
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.voteProposal failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createInitiateDisputeTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.initiateDispute',
    description: 'Initiate a dispute for a task as the connected signer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        taskPda: {
          type: 'string',
          description: 'Task PDA (base58)',
        },
        evidence: {
          type: 'string',
          description: 'Plain-text evidence. The tool hashes it into the fixed 32-byte evidence hash.',
        },
        resolutionType: {
          description: 'Desired resolution: refund, complete, or split.',
        },
        disputeId: {
          type: 'string',
          description: 'Optional 32-byte dispute id as hex. Random when omitted.',
        },
        workerAgentPda: {
          type: 'string',
          description: 'Optional worker agent PDA when the task creator is disputing a specific worker claim.',
        },
        workerClaimPda: {
          type: 'string',
          description: 'Optional explicit worker claim PDA. Derived automatically from taskPda + workerAgentPda when omitted.',
        },
        defendantWorkers: {
          type: 'array',
          description: 'Optional additional worker claim/agent pairs for collaborative tasks.',
          items: {
            type: 'object',
            properties: {
              claimPda: { type: 'string' },
              workerPda: { type: 'string' },
            },
            required: ['claimPda', 'workerPda'],
          },
        },
        initiatorAgentPda: {
          type: 'string',
          description: 'Optional explicit initiator agent PDA when the signer controls multiple agents',
        },
      },
      required: ['taskPda', 'evidence', 'resolutionType'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [taskPda, taskErr] = parseBase58(args.taskPda, 'taskPda');
      if (taskErr || !taskPda) return taskErr ?? errorResult('Invalid taskPda');

      if (typeof args.evidence !== 'string' || args.evidence.trim().length === 0) {
        return errorResult('evidence must be a non-empty string');
      }
      const evidenceHash = hashString(args.evidence);

      const [resolutionType, resolutionErr] = parseResolutionType(args.resolutionType);
      if (resolutionErr || resolutionType === null) {
        return resolutionErr ?? errorResult('Invalid resolutionType');
      }

      const [disputeId, disputeIdErr] = parseFixedHexBytes(args.disputeId, 'disputeId', HASH_BYTES, true);
      if (disputeIdErr || !disputeId) return disputeIdErr ?? errorResult('Invalid disputeId');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.initiatorAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve initiator agent');

      let workerAgentPda: PublicKey | null = null;
      let workerAgentErr: ToolResult | null = null;
      if (args.workerAgentPda !== undefined) {
        [workerAgentPda, workerAgentErr] = parseBase58(args.workerAgentPda, 'workerAgentPda');
      }
      if (workerAgentErr) return workerAgentErr;

      let workerClaimPda: PublicKey | null = null;
      let workerClaimErr: ToolResult | null = null;
      if (args.workerClaimPda !== undefined) {
        [workerClaimPda, workerClaimErr] = parseBase58(args.workerClaimPda, 'workerClaimPda');
      }
      if (workerClaimErr) return workerClaimErr;

      const [defendantWorkers, defendantWorkersErr] = parseWorkerPairs(
        args.defendantWorkers,
        'defendantWorkers',
      );
      if (defendantWorkersErr || !defendantWorkers) {
        return defendantWorkersErr ?? errorResult('Invalid defendantWorkers');
      }

      try {
        const taskOps = new TaskOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const task = await taskOps.fetchTask(taskPda);
        if (!task) return errorResult(`Task not found: ${taskPda.toBase58()}`);
        const initiatedByCreator = task.creator.equals(signerAgent.authority);
        const initiatorClaimPda = initiatedByCreator
          ? null
          : findClaimPda(taskPda, signerAgent.agentPda, program.programId);

        const derivedWorkerClaimPda =
          workerClaimPda ?? (workerAgentPda ? findClaimPda(taskPda, workerAgentPda, program.programId) : undefined);

        const ops = new DisputeOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const result = await ops.initiateDispute({
          disputeId,
          taskPda,
          taskId: task.taskId,
          evidenceHash,
          resolutionType,
          evidence: args.evidence,
          initiatorClaimPda,
          workerAgentPda: workerAgentPda ?? undefined,
          workerClaimPda: derivedWorkerClaimPda,
          defendantWorkers,
        });

        return {
          content: safeStringify({
            disputePda: result.disputePda.toBase58(),
            disputeId: bytesToHex(disputeId),
            taskPda: taskPda.toBase58(),
            evidenceHash: bytesToHex(evidenceHash),
            resolutionType: resolutionTypeToString(resolutionType),
            initiatorAgentPda: signerAgent.agentPda.toBase58(),
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.initiateDispute failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createResolveDisputeTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.resolveDispute',
    description: 'Resolve an active dispute using the supplied arbiter vote accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        disputePda: {
          type: 'string',
          description: 'Dispute PDA (base58)',
        },
        arbiterVotes: {
          type: 'array',
          description: 'Arbiter vote PDA / arbiter agent PDA pairs required by the resolve instruction.',
          items: {
            type: 'object',
            properties: {
              votePda: { type: 'string' },
              arbiterAgentPda: { type: 'string' },
            },
            required: ['votePda', 'arbiterAgentPda'],
          },
        },
        extraWorkers: {
          type: 'array',
          description: 'Optional extra worker claim/agent pairs for collaborative tasks.',
          items: {
            type: 'object',
            properties: {
              claimPda: { type: 'string' },
              workerPda: { type: 'string' },
            },
            required: ['claimPda', 'workerPda'],
          },
        },
      },
      required: ['disputePda', 'arbiterVotes'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (!program.provider.publicKey) {
        return errorResult('agenc.resolveDispute requires a signer-backed program context');
      }

      const [disputePda, disputeErr] = parseBase58(args.disputePda, 'disputePda');
      if (disputeErr || !disputePda) return disputeErr ?? errorResult('Invalid disputePda');

      const [arbiterVotes, arbiterVotesErr] = parseVotePairs(args.arbiterVotes, 'arbiterVotes');
      if (arbiterVotesErr || !arbiterVotes) return arbiterVotesErr ?? errorResult('Invalid arbiterVotes');

      const [extraWorkers, extraWorkersErr] = parseWorkerPairs(args.extraWorkers, 'extraWorkers');
      if (extraWorkersErr || !extraWorkers) return extraWorkersErr ?? errorResult('Invalid extraWorkers');

      try {
        const ops = new DisputeOperations({
          program,
          agentId: ZERO_AGENT_ID,
          logger,
        });
        const dispute = await ops.fetchDispute(disputePda);
        if (!dispute) return errorResult(`Dispute not found: ${disputePda.toBase58()}`);

        const taskOps = new TaskOperations({
          program,
          agentId: ZERO_AGENT_ID,
          logger,
        });
        const task = await taskOps.fetchTask(dispute.task);
        if (!task) return errorResult(`Task not found: ${dispute.task.toBase58()}`);

        const [workerAuthority, workerAuthorityErr] = await fetchAgentAuthority(program, dispute.defendant);
        if (workerAuthorityErr || !workerAuthority) {
          return workerAuthorityErr ?? errorResult('Unable to resolve defendant worker authority');
        }

        const acceptedBidSettlement =
          task.taskType === TaskType.BidExclusive
            ? deriveAcceptedBidSettlementAccounts(
                dispute.task,
                dispute.defendant,
                program.programId,
              )
            : undefined;

        const result = await ops.resolveDispute({
          disputePda,
          taskPda: dispute.task,
          creatorPubkey: task.creator,
          workerClaimPda: findClaimPda(dispute.task, dispute.defendant, program.programId),
          workerAgentPda: dispute.defendant,
          workerAuthority,
          arbiterVotes,
          extraWorkers,
          acceptedBidSettlement,
        });

        return {
          content: safeStringify({
            disputePda: disputePda.toBase58(),
            taskPda: dispute.task.toBase58(),
            creator: task.creator.toBase58(),
            defendant: dispute.defendant.toBase58(),
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.resolveDispute failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createStakeReputationTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.stakeReputation',
    description: 'Stake SOL on the connected signer agent reputation.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'string',
          description: 'Lamports to stake as an integer string',
        },
        stakerAgentPda: {
          type: 'string',
          description: 'Optional explicit staker agent PDA when the signer controls multiple agents',
        },
      },
      required: ['amount'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [amount, amountErr] = parseBigIntInput(args.amount, 'amount');
      if (amountErr || amount === null) return amountErr ?? errorResult('Invalid amount');
      const amountRangeErr = validateU64(amount, 'amount');
      if (amountRangeErr) return amountRangeErr;

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.stakerAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve staker agent');

      try {
        const ops = new ReputationEconomyOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const result = await ops.stakeReputation({ amount });
        return {
          content: safeStringify({
            stakePda: result.stakePda.toBase58(),
            agentPda: signerAgent.agentPda.toBase58(),
            amount: amount.toString(),
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.stakeReputation failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}

export function createDelegateReputationTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.delegateReputation',
    description: 'Delegate reputation points from the connected signer agent to another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        delegateeAgentId: {
          type: 'string',
          description: 'Delegatee agent id as a 32-byte hex string',
        },
        delegateeAgentPda: {
          type: 'string',
          description: 'Alternative to delegateeAgentId. The tool fetches the agent id from this PDA.',
        },
        amount: {
          type: 'number',
          description: `Reputation points to delegate (${MIN_DELEGATION_AMOUNT}-${REPUTATION_MAX})`,
        },
        expiresAt: {
          type: 'number',
          description: 'Optional Unix timestamp when the delegation expires',
        },
        delegatorAgentPda: {
          type: 'string',
          description: 'Optional explicit delegator agent PDA when the signer controls multiple agents',
        },
      },
      required: ['amount'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [amount, amountErr] = parseNumberInRange(
        args.amount,
        'amount',
        MIN_DELEGATION_AMOUNT,
        REPUTATION_MAX,
      );
      if (amountErr || amount === null) return amountErr ?? errorResult('Invalid amount');

      const [signerAgent, signerErr] = await resolveSignerAgentContext(program, args.delegatorAgentPda);
      if (signerErr || !signerAgent) return signerErr ?? errorResult('Unable to resolve delegator agent');

      let delegateeAgentId: Uint8Array | null = null;
      let delegateeAgentPda: PublicKey | null = null;
      if (args.delegateeAgentId !== undefined) {
        const [parsedAgentId, agentIdErr] = parseFixedHexBytes(
          args.delegateeAgentId,
          'delegateeAgentId',
          HASH_BYTES,
        );
        if (agentIdErr || !parsedAgentId) return agentIdErr ?? errorResult('Invalid delegateeAgentId');
        delegateeAgentId = parsedAgentId;
        delegateeAgentPda = PublicKey.findProgramAddressSync(
          [SEEDS.AGENT, Buffer.from(delegateeAgentId)],
          program.programId,
        )[0];
      } else if (args.delegateeAgentPda !== undefined) {
        const [parsedAgentPda, agentPdaErr] = parseBase58(args.delegateeAgentPda, 'delegateeAgentPda');
        if (agentPdaErr || !parsedAgentPda) return agentPdaErr ?? errorResult('Invalid delegateeAgentPda');
        delegateeAgentPda = parsedAgentPda;
        const [parsedAgentId, fetchErr] = await fetchAgentId(program, parsedAgentPda);
        if (fetchErr || !parsedAgentId) return fetchErr ?? errorResult('Unable to resolve delegatee agent id');
        delegateeAgentId = parsedAgentId;
      } else {
        return errorResult('Provide delegateeAgentId or delegateeAgentPda');
      }

      if (!delegateeAgentId || !delegateeAgentPda) {
        return errorResult('Unable to resolve delegatee agent');
      }

      let expiresAt: number | undefined;
      if (args.expiresAt !== undefined) {
        const [parsedExpiresAt, parsedExpiresAtErr] = parseNumberInRange(
          args.expiresAt,
          'expiresAt',
          0,
          Number.MAX_SAFE_INTEGER,
        );
        if (parsedExpiresAtErr || parsedExpiresAt === null) {
          return parsedExpiresAtErr ?? errorResult('Invalid expiresAt');
        }
        expiresAt = parsedExpiresAt;
      }

      try {
        const ops = new ReputationEconomyOperations({
          program,
          agentId: signerAgent.agentId,
          logger,
        });
        const result = await ops.delegateReputation({
          delegateeId: delegateeAgentId,
          amount,
          expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined,
        });
        return {
          content: safeStringify({
            delegationPda: result.delegationPda.toBase58(),
            delegatorAgentPda: signerAgent.agentPda.toBase58(),
            delegateeAgentPda: delegateeAgentPda.toBase58(),
            amount,
            expiresAt: expiresAt ?? null,
            transactionSignature: result.transactionSignature,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.delegateReputation failed: ${message}`);
        return errorResult(message);
      }
    },
  };
}
