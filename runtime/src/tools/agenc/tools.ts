/**
 * Built-in AgenC protocol tools.
 *
 * Query tools:
 * - agenc.listTasks — list tasks with optional status filter
 * - agenc.getTask — fetch a single task by PDA
 * - agenc.getJobSpec — resolve a task PDA to its verified off-chain marketplace job spec
 * - agenc.listApprovedTaskTemplates — list approved marketplace task templates
 * - agenc.getApprovedTaskTemplate — inspect an approved marketplace task template
 * - agenc.listSkills — list marketplace skills with optional filtering
 * - agenc.getSkill — fetch a single marketplace skill by PDA
 * - agenc.listGovernanceProposals — list governance proposals with optional status filter
 * - agenc.getGovernanceProposal — fetch a single governance proposal by PDA
 * - agenc.listDisputes — list marketplace disputes with optional status filter
 * - agenc.getDispute — fetch a single marketplace dispute by PDA
 * - agenc.getReputationSummary — fetch marketplace reputation for an agent or the connected signer
 * - agenc.inspectMarketplace — inspect a marketplace surface (overview, tasks, skills, governance, disputes, reputation)
 * - agenc.getAgent — fetch agent registration by PDA
 * - agenc.getProtocolConfig — fetch protocol configuration
 * - agenc.getTokenBalance — fetch token ATA balance for owner+mint
 *
 * Mutation tools:
 * - agenc.createTaskFromTemplate — create a marketplace task from an approved template
 * - agenc.submitTaskTemplateProposal — submit a draft template for admin review
 * - agenc.createTask — raw task creation, disabled by default for agent routing
 * - agenc.registerAgent — register signer wallet as an on-chain agent
 *
 * @module
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { BN, type Program } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@tetsuo-ai/sdk';
import type { AgencCoordination } from '../../types/agenc_coordination.js';
import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';
import { TaskOperations } from '../../task/operations.js';
import { GovernanceOperations } from '../../governance/operations.js';
import { DisputeOperations } from '../../dispute/operations.js';
import { findAgentPda, findProtocolPda } from '../../agent/pda.js';
import { findTaskPda, findEscrowPda } from '../../task/pda.js';
import {
  taskStatusToString,
  taskTypeToString,
  taskTypeToKey,
  isPrivateTask,
  OnChainTaskStatus,
  TaskType,
  TaskValidationMode,
  parseTaskTypeAlias,
} from '../../task/types.js';
import { parseAgentState, agentStatusToString } from '../../agent/types.js';
import { getCapabilityNames } from '../../agent/capabilities.js';
import {
  buildMarketplaceReputationSummaryForAgent,
  buildMarketplaceUnregisteredSummary,
  serializeMarketplaceDisputeDetail,
  serializeMarketplaceDisputeSummary,
  serializeMarketplaceProposalDetail,
  serializeMarketplaceProposalSummary,
  serializeMarketplaceSkill,
  serializeMarketplaceTaskEntry,
} from '../../marketplace/serialization.js';
import {
  buildMarketplaceInspectOverview,
  buildMarketplaceInspectSurface,
  buildMarketplaceReputationInspectPlaceholder,
  resolveMarketplaceInspectSurface,
} from '../../marketplace/surfaces.mjs';
import type {
  MarketplaceInspectOverview,
  MarketplaceInspectSurface,
} from '../../marketplace/surfaces.mjs';
import { parseProtocolConfig } from '../../types/protocol.js';
import { buildCreateTaskTokenAccounts } from '../../utils/token.js';
import {
  hasMarketplaceJobSpecInput,
  linkMarketplaceJobSpecToTask,
  persistMarketplaceJobSpec,
  readMarketplaceJobSpecPointerForTask,
  resolveMarketplaceJobSpecReference,
} from '../../marketplace/job-spec-store.js';
import {
  listApprovedTaskTemplates,
  getApprovedTaskTemplate,
  renderApprovedTaskTemplate,
  persistTaskTemplateProposal,
  type ApprovedTaskTemplateStatus,
  type RenderApprovedTaskTemplateInput,
} from '../../marketplace/approved-task-templates.js';
import {
  fetchTaskJobSpecPointer,
  resolveOnChainTaskJobSpecForTask,
  setTaskJobSpecPointer,
} from '../../marketplace/task-job-spec.js';
import {
  lamportsToSol,
  bytesToHex,
  generateAgentId,
  hexToBytes,
  toAnchorBytes,
} from '../../utils/encoding.js';
import type { Logger } from '../../utils/logger.js';
import type { OnChainTask } from '../../task/types.js';
import type { AgentState } from '../../agent/types.js';
import type { ProtocolConfig } from '../../types/protocol.js';
import type {
  SerializedAgent,
  SerializedDisputeDetail,
  SerializedDisputeSummary,
  SerializedGovernanceProposalDetail,
  SerializedGovernanceProposalSummary,
  SerializedProtocolConfig,
  SerializedReputationSummary,
  SerializedSkill,
  SerializedTask,
  SerializedTaskJobSpec,
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DESCRIPTION_BYTES = 64;
const TASK_ID_BYTES = 32;
const DEFAULT_CREATOR_REVIEW_WINDOW_SECS = 3600;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_REPUTATION = 10_000;
const TASK_TYPE_INPUT_ERROR =
  'taskType must be one of 0/exclusive, 1/collaborative, 2/competitive, or 3/bid-exclusive';
const DUMMY_AGENT_ID = new Uint8Array(32);
const AGENT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
const AGENT_ID_OFFSET = 8;
const AGENT_AUTHORITY_OFFSET = AGENT_ID_OFFSET + TASK_ID_BYTES;

/**
 * Dedup guard for createTask — prevents the LLM from calling createTask
 * multiple times with the same description in a single conversation turn.
 * Entries auto-expire after 30 seconds.  Keyed by `creator|description`.
 */
const recentCreateTaskCalls = new Map<string, number>();
const CREATE_TASK_DEDUP_TTL_MS = 30_000;

export interface CreateTaskToolOptions {
  readonly jobSpecStoreDir?: string;
  readonly allowRawTaskCreation?: boolean;
}

export interface TaskTemplateToolOptions extends CreateTaskToolOptions {
  readonly templateProposalStoreDir?: string;
}

export interface GetJobSpecToolOptions {
  readonly jobSpecStoreDir?: string;
}
export interface TaskJobSpecQueryToolOptions {
  readonly program?: Program<AgencCoordination>;
  readonly jobSpecStoreDir?: string;
}

const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
};

/**
 * Return a JSON error ToolResult without throwing.
 */
function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/**
 * Safely parse a base58 string into a PublicKey.
 * Returns null and an error result if invalid.
 */
function parseBase58(input: unknown): [PublicKey | null, ToolResult | null] {
  if (typeof input !== 'string' || input.length === 0) {
    return [null, errorResult('Missing or invalid address')];
  }
  try {
    return [new PublicKey(input), null];
  } catch {
    return [null, errorResult(`Invalid base58 address: ${input}`)];
  }
}

/**
 * Parse optional reward mint filter input.
 * Accepts base58 mint, "SOL", or omitted.
 */
function parseRewardMintFilter(input: unknown): [PublicKey | null | undefined, ToolResult | null] {
  if (input === undefined) return [undefined, null];
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [undefined, errorResult('Invalid rewardMint filter. Use mint base58 or "SOL".')];
  }
  if (input.toUpperCase() === 'SOL') return [null, null];
  const [mint, err] = parseBase58(input);
  if (err) return [undefined, errorResult('Invalid rewardMint filter. Use mint base58 or "SOL".')];
  return [mint, null];
}

function parseTaskTypeInput(
  input: unknown,
  defaultValue: TaskType,
): [TaskType, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [defaultValue, null];
  if (typeof input !== 'string' && typeof input !== 'number') {
    return [defaultValue, errorResult(TASK_TYPE_INPUT_ERROR)];
  }
  const parsed = parseTaskTypeAlias(input);
  if (parsed === null) return [defaultValue, errorResult(TASK_TYPE_INPUT_ERROR)];
  return [parsed, null];
}

function parseOptionalTaskTypeFilter(input: unknown): [TaskType | undefined, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [undefined, null];
  if (typeof input !== 'string' && typeof input !== 'number') {
    return [undefined, errorResult(TASK_TYPE_INPUT_ERROR)];
  }
  const parsed = parseTaskTypeAlias(input);
  if (parsed === null) return [undefined, errorResult(TASK_TYPE_INPUT_ERROR)];
  return [parsed, null];
}

function parseBigIntInput(value: unknown, field: string): [bigint | null, ToolResult | null] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return [null, errorResult(`${field} must be a non-negative integer`)];
    }
    return [BigInt(Math.trunc(value)), null];
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (!/^\d+$/.test(v)) {
      return [null, errorResult(`${field} must be an integer string`)];
    }
    return [BigInt(v), null];
  }
  return [null, errorResult(`Missing or invalid ${field}`)];
}

function parseBoundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  defaultValue: number,
): [number, ToolResult | null] {
  if (isOptionalPlaceholder(value)) return [defaultValue, null];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [defaultValue, errorResult(`${field} must be a number`)];
  }
  const v = Math.trunc(value);
  if (v < min || v > max) {
    return [defaultValue, errorResult(`${field} must be between ${min} and ${max}`)];
  }
  return [v, null];
}

function parseToolErrorMessage(result: ToolResult | null): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result.content) as { error?: string };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

function isNoRegistrationError(result: ToolResult | null): boolean {
  const message = parseToolErrorMessage(result);
  return message?.includes('No agent registration found') ?? false;
}

function validateU64(value: bigint, field: string): ToolResult | null {
  if (value > MAX_U64) {
    return errorResult(`${field} exceeds u64 max (${MAX_U64.toString()})`);
  }
  return null;
}

function isOptionalPlaceholder(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input !== 'string') return false;
  const normalized = input.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'none' ||
    normalized === 'null' ||
    normalized === 'undefined' ||
    normalized === 'n/a' ||
    normalized === 'na' ||
    normalized === 'omit' ||
    normalized === 'omitted'
  );
}

function parseOptionalHexBytes(
  input: unknown,
  field: string,
  expectedBytes: number,
): [Uint8Array | null, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [null, null];
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [null, errorResult(`${field} must be a ${expectedBytes}-byte hex string if provided`)];
  }
  try {
    const bytes = hexToBytes(input.trim());
    if (bytes.length !== expectedBytes) {
      return [null, errorResult(`${field} must be ${expectedBytes} bytes (${expectedBytes * 2} hex chars)`)];
    }
    return [bytes, null];
  } catch {
    return [null, errorResult(`${field} must be a valid hex string`)];
  }
}

function parseTaskValidationMode(input: unknown): [TaskValidationMode, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [TaskValidationMode.Auto, null];
  if (typeof input === 'number') {
    if (input === TaskValidationMode.Auto || input === TaskValidationMode.CreatorReview) {
      return [input, null];
    }
    return [
      TaskValidationMode.Auto,
      errorResult('validationMode must be "auto" or "creator-review"'),
    ];
  }
  if (typeof input !== 'string') {
    return [
      TaskValidationMode.Auto,
      errorResult('validationMode must be "auto" or "creator-review"'),
    ];
  }

  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized === '' || normalized === 'auto' || normalized === '0' || normalized.startsWith('auto-')) {
    return [TaskValidationMode.Auto, null];
  }
  if (
    normalized === 'creator-review' ||
    normalized === 'creatorreview' ||
    normalized.startsWith('creator-review-') ||
    normalized === 'manual' ||
    normalized === 'manual-validation' ||
    normalized.startsWith('manual-validation-') ||
    normalized === '1'
  ) {
    return [TaskValidationMode.CreatorReview, null];
  }

  return [
    TaskValidationMode.Auto,
    errorResult('validationMode must be "auto" or "creator-review"'),
  ];
}

function parseTaskDescription(input: unknown): [Uint8Array | null, ToolResult | null] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [null, errorResult('description must be a non-empty string')];
  }
  const encoded = new TextEncoder().encode(input);
  if (encoded.length > DESCRIPTION_BYTES) {
    return [null, errorResult(`description exceeds ${DESCRIPTION_BYTES} bytes`)];
  }
  const out = new Uint8Array(DESCRIPTION_BYTES);
  out.set(encoded);
  return [out, null];
}

function parseTaskId(input: unknown): [Uint8Array | null, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [generateAgentId(), null];
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [null, errorResult('taskId must be a 64-char hex string if provided')];
  }
  try {
    const bytes = hexToBytes(input);
    if (bytes.length !== TASK_ID_BYTES) {
      return [null, errorResult(`taskId must be ${TASK_ID_BYTES} bytes (64 hex chars)`)];
    }
    return [bytes, null];
  } catch {
    return [null, errorResult('taskId must be a valid hex string')];
  }
}

function parseAgentId(input: unknown): [Uint8Array | null, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [generateAgentId(), null];
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [null, errorResult('agentId must be a 64-char hex string if provided')];
  }
  try {
    const bytes = hexToBytes(input);
    if (bytes.length !== TASK_ID_BYTES) {
      return [null, errorResult(`agentId must be ${TASK_ID_BYTES} bytes (64 hex chars)`)];
    }
    return [bytes, null];
  } catch {
    return [null, errorResult('agentId must be a valid hex string')];
  }
}

function parseKnownRewardMint(input: unknown): [PublicKey | null, ToolResult | null] {
  if (isOptionalPlaceholder(input)) return [null, null];
  const [mint, err] = parseBase58(input);
  if (err || !mint) return [null, errorResult('Invalid rewardMint address')];
  if (!KNOWN_MINTS[mint.toBase58()]) {
    return [null, errorResult(`Unsupported rewardMint: ${mint.toBase58()}`)];
  }
  return [mint, null];
}

interface SignerAgentChoice {
  registered: true;
  authority: string;
  agentPda: string;
  agentId: string;
}

function ambiguousSignerAgentsResult(authority: PublicKey, agents: SignerAgentChoice[]): ToolResult {
  return {
    content: safeStringify({
      error:
        'Multiple agent registrations found for signer wallet. Provide creatorAgentPda with one of the listed agentPda values.',
      code: 'MULTIPLE_AGENT_REGISTRATIONS',
      status: 'requires_input',
      authority: authority.toBase58(),
      count: agents.length,
      agents,
    }),
    isError: true,
  };
}

async function findSignerAgentChoices(
  program: Program<AgencCoordination>,
  authority: PublicKey,
): Promise<SignerAgentChoice[]> {
  // Use raw getProgramAccounts to bypass Anchor deserialization bug with enum repr.
  const bs58 = await import('bs58');
  const matches = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_DISCRIMINATOR) } },
      { memcmp: { offset: AGENT_AUTHORITY_OFFSET, bytes: authority.toBase58() } },
    ],
  });

  return matches
    .map((match) => ({
      registered: true as const,
      authority: authority.toBase58(),
      agentPda: match.pubkey.toBase58(),
      agentId: bytesToHex(match.account.data.subarray(AGENT_ID_OFFSET, AGENT_AUTHORITY_OFFSET)),
    }))
    .sort((left, right) => left.agentPda.localeCompare(right.agentPda));
}

function buildAmbiguousSignerAgentsSurface(
  authority: PublicKey,
  agents: SignerAgentChoice[],
): MarketplaceInspectSurface {
  return buildMarketplaceInspectSurface({
    surface: 'reputation',
    status: 'requires_input',
    subject: authority.toBase58(),
    message:
      'Multiple agent registrations found for signer wallet. Provide one of the listed agentPda values to inspect reputation deterministically.',
    items: agents,
    count: agents.length,
  });
}

async function resolveCreatorAgentPda(
  program: Program<AgencCoordination>,
  creator: PublicKey,
  providedCreatorAgentPda?: unknown,
): Promise<[PublicKey | null, ToolResult | null]> {
  const matches = await findSignerAgentChoices(program, creator);

  if (!isOptionalPlaceholder(providedCreatorAgentPda)) {
    const [pda, err] = parseBase58(providedCreatorAgentPda);
    if (pda && matches.some((match) => match.agentPda === pda.toBase58())) {
      return [pda, null];
    }

    if (matches.length === 1) {
      return [new PublicKey(matches[0]!.agentPda), null];
    }

    if (matches.length > 1) {
      return [null, ambiguousSignerAgentsResult(creator, matches)];
    }

    if (err) return [null, err];
    return [null, errorResult('creatorAgentPda is not registered for signer wallet. Run `agenc-runtime agent register --rpc <url>` first, or provide one of this signer wallet\'s agent PDA values.')];
  }

  if (matches.length === 0) {
    return [null, errorResult('No agent registration found for signer wallet. Run `agenc-runtime agent register --rpc <url>` first, or provide creatorAgentPda.')];
  }
  if (matches.length > 1) {
    return [null, ambiguousSignerAgentsResult(creator, matches)];
  }

  return [new PublicKey(matches[0]!.agentPda), null];
}

function isMissingAccountError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('account does not exist') ||
    lower.includes('could not find account') ||
    lower.includes('invalid param') ||
    lower.includes('not found')
  );
}


function getJobSpecStoreOptions(rootDir?: string): { rootDir: string } | undefined {
  return rootDir ? { rootDir } : undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedJobSpecMetadataInstructionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('instructionfallbacknotfound') ||
    normalized.includes('fallback functions are not supported')
  );
}

function formatJobSpecPublishWarning(error: unknown): string {
  const message = formatUnknownError(error);
  if (isUnsupportedJobSpecMetadataInstructionError(message)) {
    return (
      'Task was created, but the deployed marketplace program does not support ' +
      `job spec metadata publishing: ${message}`
    );
  }

  return `Task was created, but job spec metadata publishing failed: ${message}`;
}

function buildVerifiedTaskJobSpec(
  source: SerializedTaskJobSpec['source'],
  base: Omit<SerializedTaskJobSpec, 'source' | 'verified' | 'jobSpecPath' | 'integrity' | 'payload' | 'error'>,
  resolved: {
    jobSpecPath: string;
    integrity: {
      algorithm: string;
      canonicalization: string;
      payloadHash: string;
      uri: string;
    };
    payload: unknown;
  },
): SerializedTaskJobSpec {
  return {
    source,
    ...base,
    verified: true,
    jobSpecPath: resolved.jobSpecPath,
    integrity: resolved.integrity,
    payload: resolved.payload,
  };
}

async function buildTaskJobSpecView(
  taskPda: PublicKey,
  options: TaskJobSpecQueryToolOptions,
  includePayload: boolean,
): Promise<SerializedTaskJobSpec | null> {
  const storeOptions = getJobSpecStoreOptions(options.jobSpecStoreDir);

  if (options.program) {
    const onChainPointer = await fetchTaskJobSpecPointer(options.program, taskPda);
    if (onChainPointer) {
      const base: Omit<SerializedTaskJobSpec, 'source' | 'verified' | 'jobSpecPath' | 'integrity' | 'payload' | 'error'> = {
        taskJobSpecPda: onChainPointer.taskJobSpecPda,
        creator: onChainPointer.creator,
        jobSpecHash: onChainPointer.jobSpecHash,
        jobSpecUri: onChainPointer.jobSpecUri,
        createdAt: onChainPointer.createdAt,
        updatedAt: onChainPointer.updatedAt,
      };

      if (!includePayload) {
        return { source: 'on-chain', ...base, verified: false };
      }

      try {
        const resolved = await resolveOnChainTaskJobSpecForTask(
          options.program,
          taskPda,
          storeOptions ?? {},
        );
        if (!resolved) {
          return { source: 'on-chain', ...base, verified: false };
        }
        return buildVerifiedTaskJobSpec('on-chain', base, resolved);
      } catch (error) {
        return {
          source: 'on-chain',
          ...base,
          verified: false,
          error: formatUnknownError(error),
        };
      }
    }
  }

  const localPointer = await readMarketplaceJobSpecPointerForTask(
    taskPda.toBase58(),
    storeOptions,
  );
  if (!localPointer) return null;

  const base: Omit<SerializedTaskJobSpec, 'source' | 'verified' | 'jobSpecPath' | 'integrity' | 'payload' | 'error'> = {
    taskJobSpecPda: null,
    creator: null,
    jobSpecHash: localPointer.jobSpecHash,
    jobSpecUri: localPointer.jobSpecUri,
    jobSpecTaskLinkPath: localPointer.jobSpecTaskLinkPath,
    transactionSignature: localPointer.transactionSignature,
  };

  if (!includePayload) {
    return { source: 'local-task-link', ...base, verified: false };
  }

  try {
    const resolved = await resolveMarketplaceJobSpecReference(
      localPointer,
      storeOptions,
    );
    return buildVerifiedTaskJobSpec('local-task-link', base, resolved);
  } catch (error) {
    return {
      source: 'local-task-link',
      ...base,
      verified: false,
      error: formatUnknownError(error),
    };
  }
}

async function resolveTaskJobSpecPayloadOrThrow(
  taskPda: PublicKey,
  options: TaskJobSpecQueryToolOptions,
): Promise<Record<string, unknown>> {
  const storeOptions = getJobSpecStoreOptions(options.jobSpecStoreDir);
  const taskAddress = taskPda.toBase58();
  const localPointer = await readMarketplaceJobSpecPointerForTask(
    taskAddress,
    storeOptions,
  );

  if (options.program) {
    const onChainPointer = await fetchTaskJobSpecPointer(options.program, taskPda);
    if (onChainPointer) {
      const resolved = await resolveOnChainTaskJobSpecForTask(
        options.program,
        taskPda,
        storeOptions ?? {},
      );
      if (!resolved) {
        throw new Error(`No verified task job spec metadata found for task ${taskAddress}`);
      }
      return {
        taskPda: taskAddress,
        taskId: localPointer?.taskId ?? null,
        source: 'on-chain',
        taskJobSpecPda: resolved.taskJobSpecPda,
        creator: resolved.creator,
        jobSpecHash: resolved.jobSpecHash,
        jobSpecUri: resolved.jobSpecUri,
        createdAt: resolved.createdAt,
        updatedAt: resolved.updatedAt,
        verified: true,
        jobSpecPath: resolved.jobSpecPath,
        jobSpecTaskLinkPath: localPointer?.jobSpecTaskLinkPath ?? null,
        transactionSignature: localPointer?.transactionSignature ?? null,
        integrity: resolved.integrity,
        payload: resolved.payload,
      };
    }
  }

  if (localPointer) {
    const resolved = await resolveMarketplaceJobSpecReference(
      localPointer,
      storeOptions,
    );
    return {
      taskPda: taskAddress,
      taskId: localPointer.taskId,
      source: 'local-task-link',
      taskJobSpecPda: null,
      creator: null,
      jobSpecHash: resolved.jobSpecHash,
      jobSpecUri: resolved.jobSpecUri,
      verified: true,
      jobSpecPath: resolved.jobSpecPath,
      jobSpecTaskLinkPath: localPointer.jobSpecTaskLinkPath,
      transactionSignature: localPointer.transactionSignature,
      integrity: resolved.integrity,
      payload: resolved.payload,
    };
  }

  throw new Error(`No task job spec metadata found for task ${taskAddress}`);
}

async function fetchProtocolConfigForAction(
  program: Program<AgencCoordination>,
  action: string,
): Promise<[PublicKey, ProtocolConfig | null, ToolResult | null]> {
  const protocolPda = findProtocolPda(program.programId);
  try {
    // Use raw account fetch to avoid IDL mismatch with devnet program
    const accountInfo = await program.provider.connection.getAccountInfo(protocolPda);
    if (!accountInfo) {
      return [
        protocolPda,
        null,
        errorResult(
          `Protocol config is not initialized for this program/network (expected account: ${protocolPda.toBase58()}). ` +
          `Cannot ${action}. Initialize protocol first or switch to the correct cluster/program.`,
        ),
      ];
    }
    // Parse treasury from raw data: offset 8 (discriminator) + 32 (authority) = 40
    const data = accountInfo.data;
    const treasury = new PublicKey(data.subarray(40, 72));
    const config: ProtocolConfig = {
      authority: new PublicKey(data.subarray(8, 40)),
      treasury,
      disputeThreshold: data[72],
      protocolFeeBps: data.readUInt16LE(73),
      minArbiterStake: 0n,
      minAgentStake: 0n,
      maxClaimDuration: 0,
      maxDisputeDuration: 0,
      totalAgents: 0n,
      totalTasks: 0n,
      completedTasks: 0n,
      totalValueDistributed: 0n,
      bump: 0,
      multisigThreshold: 0,
      multisigOwnersLen: 0,
      multisigOwners: [],
      taskCreationCooldown: 0,
      maxTasksPer24h: 0,
      disputeInitiationCooldown: 0,
      maxDisputesPer24h: 0,
      minStakeForDispute: 0n,
      slashPercentage: 0,
      stateUpdateCooldown: 0,
      votingPeriod: 0,
      protocolVersion: 0,
      minSupportedVersion: 0,
    };
    return [protocolPda, config, null];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [protocolPda, null, errorResult(msg)];
  }
}

// ============================================================================
// Serialization Helpers
// ============================================================================

function getRewardSymbol(rewardMint: PublicKey | null): string | undefined {
  if (!rewardMint) return 'SOL';
  return KNOWN_MINTS[rewardMint.toBase58()]?.symbol;
}

function decodeFixedBytes(bytes: Uint8Array): string {
  const nullIndex = bytes.indexOf(0);
  const slice = nullIndex === -1 ? bytes : bytes.subarray(0, nullIndex);
  return new TextDecoder().decode(slice).trim();
}

function serializeTask(
  task: OnChainTask,
  taskPda: PublicKey,
  extras?: Partial<Pick<SerializedTask, 'escrowTokenAccount' | 'escrowTokenBalance' | 'jobSpec'>>,
): SerializedTask {
  const descriptionText = decodeFixedBytes(task.description);
  const resultText = decodeFixedBytes(task.result);

  return {
    taskPda: taskPda.toBase58(),
    taskId: bytesToHex(task.taskId),
    creator: task.creator.toBase58(),
    status: taskStatusToString(task.status),
    taskType: taskTypeToString(task.taskType),
    taskTypeId: task.taskType,
    taskTypeKey: taskTypeToKey(task.taskType),
    rewardAmount: task.rewardAmount.toString(),
    rewardSol: lamportsToSol(task.rewardAmount),
    requiredCapabilities: getCapabilityNames(task.requiredCapabilities),
    maxWorkers: task.maxWorkers,
    currentWorkers: task.currentWorkers,
    deadline: task.deadline,
    isPrivate: isPrivateTask(task),
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    completions: task.completions,
    requiredCompletions: task.requiredCompletions,
    description: descriptionText || 'untitled task',
    descriptionHex: bytesToHex(task.description),
    constraintHash: bytesToHex(task.constraintHash),
    result: bytesToHex(task.result),
    resultText: resultText || null,
    rewardMint: task.rewardMint?.toBase58() ?? null,
    rewardSymbol: getRewardSymbol(task.rewardMint),
    ...extras,
  };
}

function serializeAgent(agent: AgentState, agentPda: PublicKey): SerializedAgent {
  return {
    agentPda: agentPda.toBase58(),
    agentId: bytesToHex(agent.agentId),
    authority: agent.authority.toBase58(),
    status: agentStatusToString(agent.status),
    capabilities: getCapabilityNames(agent.capabilities),
    endpoint: agent.endpoint,
    stake: agent.stake.toString(),
    activeTasks: agent.activeTasks,
    reputation: agent.reputation,
    tasksCompleted: agent.tasksCompleted.toString(),
    totalEarned: agent.totalEarned.toString(),
  };
}

function serializeProtocolConfig(config: ProtocolConfig): SerializedProtocolConfig {
  return {
    authority: config.authority.toBase58(),
    treasury: config.treasury.toBase58(),
    protocolFeeBps: config.protocolFeeBps,
    disputeThreshold: config.disputeThreshold,
    minAgentStake: config.minAgentStake.toString(),
    minArbiterStake: config.minArbiterStake.toString(),
    maxClaimDuration: config.maxClaimDuration,
    maxDisputeDuration: config.maxDisputeDuration,
    totalAgents: config.totalAgents.toString(),
    totalTasks: config.totalTasks.toString(),
    completedTasks: config.completedTasks.toString(),
    totalValueDistributed: config.totalValueDistributed.toString(),
    taskCreationCooldown: config.taskCreationCooldown,
    maxTasksPer24h: config.maxTasksPer24h,
    disputeInitiationCooldown: config.disputeInitiationCooldown,
    maxDisputesPer24h: config.maxDisputesPer24h,
    minStakeForDispute: config.minStakeForDispute.toString(),
    slashPercentage: config.slashPercentage,
    stateUpdateCooldown: config.stateUpdateCooldown,
    votingPeriod: config.votingPeriod,
    protocolVersion: config.protocolVersion,
    minSupportedVersion: config.minSupportedVersion,
  };
}

function parseOptionalString(value: unknown, field: string): [string | undefined, ToolResult | null] {
  if (value === undefined || value === null) return [undefined, null];
  if (typeof value !== 'string') {
    return [undefined, errorResult(`${field} must be a string`)];
  }
  const normalized = value.trim();
  return [normalized.length > 0 ? normalized : undefined, null];
}

function parseOptionalStringArray(value: unknown, field: string): [string[] | undefined, ToolResult | null] {
  if (value === undefined || value === null) return [undefined, null];
  if (!Array.isArray(value)) {
    return [undefined, errorResult(`${field} must be an array of strings`)];
  }
  const normalized = value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  return [normalized, null];
}

function parseMarketplaceStatusFilter(value: unknown): [string[] | undefined, ToolResult | null] {
  if (value === undefined || value === null) return [undefined, null];
  if (typeof value !== 'string') {
    return [undefined, errorResult('status must be a string')];
  }
  const normalized = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0 || normalized.includes('all')) {
    return [undefined, null];
  }
  return [normalized, null];
}

function filterMarketplaceItemsByStatus<T extends { status: string }>(items: T[], statuses?: string[]): T[] {
  if (!statuses || statuses.length === 0) {
    return items;
  }
  const allowed = new Set(statuses.map((status) => status.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) {
    return items;
  }
  return items.filter((item) => allowed.has(String(item.status ?? '').trim().toLowerCase()));
}

function queryTaskOperations(program: Program<AgencCoordination>, logger: Logger): TaskOperations {
  return new TaskOperations({
    program,
    agentId: DUMMY_AGENT_ID,
    logger,
  });
}

function queryGovernanceOperations(program: Program<AgencCoordination>, logger: Logger): GovernanceOperations {
  return new GovernanceOperations({
    program,
    agentId: DUMMY_AGENT_ID,
    logger,
  });
}

function queryDisputeOperations(program: Program<AgencCoordination>, logger: Logger): DisputeOperations {
  return new DisputeOperations({
    program,
    agentId: DUMMY_AGENT_ID,
    logger,
  });
}

async function enrichSerializedDisputeSummary(
  entry: Awaited<ReturnType<DisputeOperations['fetchAllDisputes']>>[number],
  taskOps: TaskOperations,
): Promise<SerializedDisputeSummary> {
  const summary = serializeMarketplaceDisputeSummary(entry) as Omit<
    SerializedDisputeSummary,
    'claimant' | 'respondent' | 'amountAtStake' | 'amountAtStakeSol' | 'amountAtStakeMint'
  >;
  const relatedTask = await taskOps.fetchTask(entry.dispute.task);
  return {
    ...summary,
    claimant: summary.initiator,
    respondent: summary.defendant,
    amountAtStake: relatedTask?.rewardAmount?.toString() ?? summary.workerStakeAtDispute,
    amountAtStakeSol: relatedTask && !relatedTask.rewardMint
      ? lamportsToSol(relatedTask.rewardAmount)
      : undefined,
    amountAtStakeMint: relatedTask?.rewardMint?.toBase58() ?? summary.rewardMint,
  };
}

async function enrichSerializedDisputeDetail(
  disputePda: PublicKey,
  dispute: Awaited<ReturnType<DisputeOperations['fetchDispute']>>,
  taskOps: TaskOperations,
): Promise<SerializedDisputeDetail> {
  const detail = serializeMarketplaceDisputeDetail(disputePda, dispute!) as Omit<
    SerializedDisputeDetail,
    'claimant' | 'respondent' | 'amountAtStake' | 'amountAtStakeSol' | 'amountAtStakeMint' | 'relatedTask'
  >;
  const relatedTask = await taskOps.fetchTask(dispute!.task);
  return {
    ...detail,
    claimant: detail.initiator,
    respondent: detail.defendant,
    amountAtStake: relatedTask?.rewardAmount?.toString() ?? detail.workerStakeAtDispute,
    amountAtStakeSol: relatedTask && !relatedTask.rewardMint
      ? lamportsToSol(relatedTask.rewardAmount)
      : undefined,
    amountAtStakeMint: relatedTask?.rewardMint?.toBase58() ?? detail.rewardMint,
    relatedTask: relatedTask ? serializeTask(relatedTask, dispute!.task) : null,
  };
}

async function loadReputationSummary(
  program: Program<AgencCoordination>,
  requestedAgentPda: unknown,
): Promise<[SerializedReputationSummary | null, ToolResult | null]> {
  if (requestedAgentPda !== undefined && requestedAgentPda !== null) {
    const [agentPda, agentErr] = parseBase58(requestedAgentPda);
    if (agentErr || !agentPda) return [null, agentErr ?? errorResult('Invalid agentPda')];
    const summary = await buildMarketplaceReputationSummaryForAgent(program, agentPda, DUMMY_AGENT_ID);
    return [summary ?? buildMarketplaceUnregisteredSummary({ agentPda: agentPda.toBase58() }), null];
  }

  const authority = program.provider.publicKey;
  if (!authority) {
    return [null, errorResult('agentPda is required when no signer-backed agent context is available')];
  }

  const [agentPda, agentErr] = await resolveCreatorAgentPda(program, authority);
  if (agentPda) {
    const summary = await buildMarketplaceReputationSummaryForAgent(program, agentPda, DUMMY_AGENT_ID);
    return [
      summary ??
        buildMarketplaceUnregisteredSummary({
          authority: authority.toBase58(),
          agentPda: agentPda.toBase58(),
        }),
      null,
    ];
  }

  if (isNoRegistrationError(agentErr)) {
    return [
      buildMarketplaceUnregisteredSummary({
        authority: authority.toBase58(),
      }),
      null,
    ];
  }

  return [null, agentErr ?? errorResult('Unable to resolve reputation summary target')];
}

async function buildMarketplaceTasksSurface(
  program: Program<AgencCoordination>,
  logger: Logger,
  options: { statuses?: string[]; limit: number },
): Promise<MarketplaceInspectSurface> {
  const taskOps = queryTaskOperations(program, logger);
  const items = filterMarketplaceItemsByStatus(
    (await taskOps.fetchAllTasks()).map((entry) => serializeMarketplaceTaskEntry(entry)),
    options.statuses,
  );
  items.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
  const total = items.length;
  const limited = items.slice(0, options.limit);
  return buildMarketplaceInspectSurface({
    surface: 'tasks',
    items: limited,
    count: total,
    filters: { statuses: options.statuses },
  });
}

async function buildMarketplaceSkillsSurface(
  program: Program<AgencCoordination>,
  options: { query?: string; tags?: string[]; activeOnly: boolean; limit: number },
): Promise<MarketplaceInspectSurface> {
  const rawSkills = await (program.account as any).skillRegistration.all();
  let items = rawSkills.map((entry: { publicKey: PublicKey; account: Record<string, unknown> }) =>
    serializeMarketplaceSkill(entry),
  ) as SerializedSkill[];

  if (options.activeOnly) {
    items = items.filter((skill) => skill.isActive);
  }
  if (options.query) {
    const query = options.query.toLowerCase();
    items = items.filter((skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.author.toLowerCase().includes(query) ||
      skill.skillId.toLowerCase().includes(query) ||
      skill.tags.some((tag) => tag.toLowerCase().includes(query)),
    );
  }
  if (options.tags && options.tags.length > 0) {
    const requiredTags = new Set(options.tags.map((tag) => tag.toLowerCase()));
    items = items.filter((skill) =>
      skill.tags.some((tag) => requiredTags.has(tag.toLowerCase())),
    );
  }

  items.sort((left, right) =>
    right.rating - left.rating ||
    right.downloads - left.downloads ||
    left.name.localeCompare(right.name),
  );
  const total = items.length;
  const limited = items.slice(0, options.limit);
  return buildMarketplaceInspectSurface({
    surface: 'skills',
    items: limited,
    count: total,
    filters: {
      query: options.query,
      tags: options.tags,
      activeOnly: options.activeOnly,
      limit: options.limit,
    },
  });
}

async function buildMarketplaceGovernanceSurface(
  program: Program<AgencCoordination>,
  logger: Logger,
  options: { statuses?: string[]; limit: number },
): Promise<MarketplaceInspectSurface> {
  const governance = queryGovernanceOperations(program, logger);
  const items = filterMarketplaceItemsByStatus(
    (await governance.fetchAllProposals()).map((entry) => serializeMarketplaceProposalSummary(entry)),
    options.statuses,
  ) as SerializedGovernanceProposalSummary[];
  items.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
  const total = items.length;
  const limited = items.slice(0, options.limit);
  return buildMarketplaceInspectSurface({
    surface: 'governance',
    items: limited,
    count: total,
    filters: { statuses: options.statuses },
  });
}

async function buildMarketplaceDisputesSurface(
  program: Program<AgencCoordination>,
  logger: Logger,
  options: { statuses?: string[]; limit: number },
): Promise<MarketplaceInspectSurface> {
  const disputeOps = queryDisputeOperations(program, logger);
  const taskOps = queryTaskOperations(program, logger);
  const summaries = await Promise.all(
    (await disputeOps.fetchAllDisputes()).map((entry) => enrichSerializedDisputeSummary(entry, taskOps)),
  );
  const items = filterMarketplaceItemsByStatus(summaries, options.statuses);
  items.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
  const total = items.length;
  const limited = items.slice(0, options.limit);
  return buildMarketplaceInspectSurface({
    surface: 'disputes',
    items: limited,
    count: total,
    filters: { statuses: options.statuses },
  });
}

async function buildMarketplaceReputationSurface(
  program: Program<AgencCoordination>,
  requestedAgentPda: unknown,
): Promise<MarketplaceInspectSurface> {
  const requestedSubject =
    typeof requestedAgentPda === 'string' ? requestedAgentPda.trim() : requestedAgentPda;
  if (requestedSubject === undefined || requestedSubject === null || requestedSubject === '') {
    const authority = program.provider.publicKey;
    if (!authority) {
      return buildMarketplaceReputationInspectPlaceholder();
    }

    const matches = await findSignerAgentChoices(program, authority);
    if (matches.length === 0) {
      return buildMarketplaceInspectSurface({
        surface: 'reputation',
        status: 'not_found',
        subject: authority.toBase58(),
        message: 'No agent registration found for signer wallet.',
        items: [buildMarketplaceUnregisteredSummary({ authority: authority.toBase58() })],
        count: 0,
      });
    }
    if (matches.length > 1) {
      return buildAmbiguousSignerAgentsSurface(authority, matches);
    }

    const [summary, summaryErr] = await loadReputationSummary(program, matches[0]!.agentPda);
    if (summaryErr || !summary) {
      throw new Error(parseToolErrorMessage(summaryErr) ?? 'Unable to inspect marketplace reputation');
    }
    return buildMarketplaceInspectSurface({
      surface: 'reputation',
      subject: summary.agentPda ?? summary.authority ?? null,
      items: [summary],
      count: 1,
    });
  }
  const [summary, summaryErr] = await loadReputationSummary(program, requestedSubject);
  if (summaryErr || !summary) {
    throw new Error(parseToolErrorMessage(summaryErr) ?? 'Unable to inspect marketplace reputation');
  }
  return buildMarketplaceInspectSurface({
    surface: 'reputation',
    subject: summary.agentPda ?? summary.authority ?? null,
    items: [summary],
    count: 1,
  });
}

// ============================================================================
// Tool Factory Functions
// ============================================================================

/**
 * Create the agenc.listTasks tool.
 */
export function createListTasksTool(
  ops: TaskOperations,
  logger: Logger,
  options: TaskJobSpecQueryToolOptions = {},
): Tool {
  return {
    name: 'agenc.listTasks',
    description:
      'List tasks on the AgenC protocol. Filter by status (open, in_progress, all). Returns task details including reward, capabilities, deadline, and any published marketplace job spec metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'all'],
          description: 'Filter by task status (default: open)',
        },
        limit: {
          type: 'number',
          description: `Maximum tasks to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
        rewardMint: {
          type: 'string',
          description: 'Optional reward mint filter (base58), or "SOL" for native SOL rewards',
        },
        taskType: {
          anyOf: [
            { type: 'number', enum: [0, 1, 2, 3] },
            { type: 'string' },
          ],
          description:
            'Optional task type filter: 0/exclusive, 1/collaborative, 2/competitive, or 3/bid-exclusive',
        },
        includeJobSpecPayload: {
          type: 'boolean',
          description:
            'When true, verify and include the full off-chain marketplace job spec payload for each listed task.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const status = (args.status as string) || 'open';
        const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
        const [rewardMintFilter, rewardMintErr] = parseRewardMintFilter(args.rewardMint);
        if (rewardMintErr) return rewardMintErr;
        const [taskTypeFilter, taskTypeFilterErr] = parseOptionalTaskTypeFilter(args.taskType);
        if (taskTypeFilterErr) return taskTypeFilterErr;
        const includeJobSpecPayload = args.includeJobSpecPayload === true;

        let tasks: Array<{ task: OnChainTask; taskPda: PublicKey }>;

        if (status === 'all') {
          tasks = await ops.fetchAllTasks();
        } else {
          const claimable = await ops.fetchClaimableTasks();
          if (status === 'open') {
            tasks = claimable.filter((t) => t.task.status === OnChainTaskStatus.Open);
          } else {
            tasks = claimable.filter((t) => t.task.status === OnChainTaskStatus.InProgress);
          }
        }

        if (rewardMintFilter !== undefined) {
          tasks = tasks.filter(({ task }) => {
            if (rewardMintFilter === null) return task.rewardMint === null;
            return task.rewardMint?.equals(rewardMintFilter) ?? false;
          });
        }

        if (taskTypeFilter !== undefined) {
          tasks = tasks.filter(({ task }) => task.taskType === taskTypeFilter);
        }

        const limited = tasks.slice(0, limit);
        const serialized = await Promise.all(
          limited.map(async ({ task, taskPda }) => {
            const jobSpec = await buildTaskJobSpecView(
              taskPda,
              options,
              includeJobSpecPayload,
            );
            return serializeTask(task, taskPda, jobSpec ? { jobSpec } : undefined);
          }),
        );

        return {
          content: safeStringify({
            count: serialized.length,
            total: tasks.length,
            tasks: serialized,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`agenc.listTasks failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getTask tool.
 */
export function createGetTaskTool(
  ops: TaskOperations,
  logger: Logger,
  options: TaskJobSpecQueryToolOptions = {},
): Tool {
  return {
    name: 'agenc.getTask',
    description:
      'Get details for a specific AgenC task by its PDA address (base58), including verified marketplace job spec metadata when available.',
    inputSchema: {
      type: 'object',
      properties: {
        taskPda: {
          type: 'string',
          description: 'Task account PDA address (base58)',
        },
      },
      required: ['taskPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.taskPda);
      if (err) return err;

      try {
        const task = await ops.fetchTask(pda!);
        if (!task) {
          return errorResult(`Task not found: ${pda!.toBase58()}`);
        }

        const jobSpec = await buildTaskJobSpecView(pda!, options, true);
        if (task.rewardMint) {
          const escrowTokenAccount = getAssociatedTokenAddressSync(task.rewardMint, task.escrow, true);
          const escrowTokenBalance = await ops.fetchEscrowTokenBalance(pda!, task.rewardMint);
          return {
            content: safeStringify(
              serializeTask(task, pda!, {
                escrowTokenAccount: escrowTokenAccount.toBase58(),
                escrowTokenBalance: escrowTokenBalance.toString(),
                jobSpec,
              }),
            ),
          };
        }
        return {
          content: safeStringify(
            serializeTask(task, pda!, {
              escrowTokenAccount: null,
              escrowTokenBalance: null,
              jobSpec,
            }),
          ),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getTask failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getJobSpec tool.
 */
export function createGetJobSpecTool(
  logger: Logger,
  options: TaskJobSpecQueryToolOptions = {},
): Tool {
  return {
    name: 'agenc.getJobSpec',
    description:
      'Resolve and verify the off-chain marketplace job spec for a task PDA. Prefers the on-chain task_job_spec pointer and falls back to the local task-link cache when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskPda: {
          type: 'string',
          description: 'Task account PDA address (base58)',
        },
      },
      required: ['taskPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.taskPda);
      if (err) return err;

      try {
        const resolved = await resolveTaskJobSpecPayloadOrThrow(pda!, options);
        return {
          content: safeStringify(resolved),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getJobSpec failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getTokenBalance tool.
 */
export function createGetTokenBalanceTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getTokenBalance',
    description:
      'Get SPL token ATA balance for an owner and mint. Owner defaults to the connected signer wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        mint: {
          type: 'string',
          description: 'SPL token mint address (base58)',
        },
        owner: {
          type: 'string',
          description: 'Owner wallet address (base58). Defaults to connected signer.',
        },
      },
      required: ['mint'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [mint, mintErr] = parseBase58(args.mint);
      if (mintErr) return mintErr;

      let owner: PublicKey;
      if (args.owner === undefined) {
        if (!program.provider.publicKey) {
          return errorResult('No default owner available. Provide owner explicitly.');
        }
        owner = program.provider.publicKey;
      } else {
        const [parsedOwner, ownerErr] = parseBase58(args.owner);
        if (ownerErr || !parsedOwner) return ownerErr ?? errorResult('Invalid owner address');
        owner = parsedOwner;
      }

      try {
        const ata = getAssociatedTokenAddressSync(mint!, owner);
        let amount = '0';
        let decimals = KNOWN_MINTS[mint!.toBase58()]?.decimals ?? 0;
        let uiAmountString = '0';
        try {
          const balance = await program.provider.connection.getTokenAccountBalance(ata);
          amount = balance.value.amount;
          decimals = balance.value.decimals;
          uiAmountString = balance.value.uiAmountString ?? '0';
        } catch (err) {
          if (!isMissingAccountError(err)) {
            throw err;
          }
        }
        return {
          content: safeStringify({
            mint: mint!.toBase58(),
            symbol: KNOWN_MINTS[mint!.toBase58()]?.symbol,
            owner: owner.toBase58(),
            tokenAccount: ata.toBase58(),
            amount,
            decimals,
            uiAmountString,
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getTokenBalance failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.listSkills tool.
 */
export function createListSkillsTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.listSkills',
    description:
      'List marketplace skills registered on AgenC. Filter by query text and optionally only show active skills.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search text matched against skill name, tags, author, or skill id.',
        },
        activeOnly: {
          type: 'boolean',
          description: 'When true, only return active marketplace skills.',
        },
        limit: {
          type: 'number',
          description: `Maximum skills to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [limit, limitErr] = parseBoundedNumber(
        args.limit,
        'limit',
        1,
        MAX_LIMIT,
        DEFAULT_LIMIT,
      );
      if (limitErr) return limitErr;

      if (args.query !== undefined && typeof args.query !== 'string') {
        return errorResult('query must be a string');
      }
      if (args.activeOnly !== undefined && typeof args.activeOnly !== 'boolean') {
        return errorResult('activeOnly must be a boolean');
      }

      const query = String(args.query ?? '').trim().toLowerCase();
      const activeOnly = Boolean(args.activeOnly ?? false);

      try {
        const rawSkills = await (program.account as any).skillRegistration.all();
        let skills = rawSkills.map((entry: { publicKey: PublicKey; account: Record<string, unknown> }) =>
          serializeMarketplaceSkill(entry),
        ) as SerializedSkill[];

        if (activeOnly) {
          skills = skills.filter((skill) => skill.isActive);
        }

        if (query) {
          skills = skills.filter((skill) =>
            skill.name.toLowerCase().includes(query) ||
            skill.author.toLowerCase().includes(query) ||
            skill.skillId.toLowerCase().includes(query) ||
            skill.tags.some((tag) => tag.toLowerCase().includes(query)),
          );
        }

        skills.sort(
          (left, right) =>
            right.rating - left.rating ||
            right.downloads - left.downloads ||
            left.name.localeCompare(right.name),
        );

        return {
          content: safeStringify({
            count: Math.min(skills.length, limit),
            total: skills.length,
            skills: skills.slice(0, limit),
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.listSkills failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getSkill tool.
 */
export function createGetSkillTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getSkill',
    description:
      'Get details for a specific marketplace skill by its PDA address (base58).',
    inputSchema: {
      type: 'object',
      properties: {
        skillPda: {
          type: 'string',
          description: 'Skill registration PDA address (base58)',
        },
      },
      required: ['skillPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.skillPda);
      if (err) return err;

      try {
        const fetchNullable = (program.account as any).skillRegistration.fetchNullable;
        const raw =
          typeof fetchNullable === 'function'
            ? await fetchNullable(pda!)
            : await program.account.skillRegistration.fetch(pda!);
        if (!raw) {
          return errorResult(`Skill not found: ${pda!.toBase58()}`);
        }

        const skill = serializeMarketplaceSkill({
          publicKey: pda!,
          account: raw as Record<string, unknown>,
        }) as SerializedSkill;
        return { content: safeStringify(skill) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Account does not exist') || msg.includes('could not find')) {
          return errorResult(`Skill not found: ${pda!.toBase58()}`);
        }
        logger.error(`agenc.getSkill failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.listGovernanceProposals tool.
 */
export function createListGovernanceProposalsTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.listGovernanceProposals',
    description:
      'List governance proposals on AgenC. Filter by proposal status to inspect active or historical governance state.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'executed', 'defeated', 'cancelled', 'all'],
          description: 'Proposal status filter (default: all)',
        },
        limit: {
          type: 'number',
          description: `Maximum proposals to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [limit, limitErr] = parseBoundedNumber(
        args.limit,
        'limit',
        1,
        MAX_LIMIT,
        DEFAULT_LIMIT,
      );
      if (limitErr) return limitErr;

      const status = String(args.status ?? 'all').trim().toLowerCase();
      if (!['active', 'executed', 'defeated', 'cancelled', 'all'].includes(status)) {
        return errorResult('status must be one of: active, executed, defeated, cancelled, all');
      }

      try {
        const governance = new GovernanceOperations({
          program,
          agentId: DUMMY_AGENT_ID,
          logger,
        });
        const rawProposals =
          status === 'active'
            ? await governance.fetchActiveProposals()
            : await governance.fetchAllProposals();

        let proposals = rawProposals.map((entry) =>
          serializeMarketplaceProposalSummary(entry),
        ) as SerializedGovernanceProposalSummary[];

        if (status !== 'all' && status !== 'active') {
          proposals = proposals.filter((proposal) => proposal.status === status);
        }

        proposals.sort(
          (left, right) =>
            right.createdAt - left.createdAt ||
            left.proposalPda.localeCompare(right.proposalPda),
        );

        return {
          content: safeStringify({
            count: Math.min(proposals.length, limit),
            total: proposals.length,
            proposals: proposals.slice(0, limit),
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.listGovernanceProposals failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getGovernanceProposal tool.
 */
export function createGetGovernanceProposalTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getGovernanceProposal',
    description:
      'Get details for a specific governance proposal by its PDA address (base58), including recorded votes.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalPda: {
          type: 'string',
          description: 'Proposal PDA address (base58)',
        },
      },
      required: ['proposalPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.proposalPda);
      if (err) return err;

      try {
        const governance = new GovernanceOperations({
          program,
          agentId: DUMMY_AGENT_ID,
          logger,
        });
        const proposal = await governance.getProposal(pda!);
        if (!proposal) {
          return errorResult(`Governance proposal not found: ${pda!.toBase58()}`);
        }

        const serialized = serializeMarketplaceProposalDetail(
          pda!,
          proposal,
        ) as SerializedGovernanceProposalDetail;
        return { content: safeStringify(serialized) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getGovernanceProposal failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.inspectMarketplace tool.
 */
export function createInspectMarketplaceTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.inspectMarketplace',
    description:
      'Inspect a marketplace surface on AgenC. Use this first for prompts like "inspect the marketplace disputes surface", "show the top skills", "review governance proposals", "marketplace overview", or "inspect reputation".',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Marketplace surface to inspect. Aliases accepted: market|overview, task|tasks, skill|skills, governance|gov|proposal|proposals, dispute|disputes, reputation|rep.',
        },
        subject: {
          type: 'string',
          description: 'Optional subject for the surface, primarily an agent PDA for reputation inspection.',
        },
        agentPda: {
          type: 'string',
          description: 'Optional alias for subject when inspecting reputation.',
        },
        status: {
          type: 'string',
          description: 'Optional comma-separated status filter. Applies to tasks, governance, and disputes surfaces.',
        },
        query: {
          type: 'string',
          description: 'Optional search text for skills.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag filter for skills.',
        },
        activeOnly: {
          type: 'boolean',
          description: 'Optional active-only filter for skills. Defaults to false.',
        },
        limit: {
          type: 'number',
          description: `Maximum items to include per surface (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [limit, limitErr] = parseBoundedNumber(
        args.limit,
        'limit',
        1,
        MAX_LIMIT,
        DEFAULT_LIMIT,
      );
      if (limitErr) return limitErr;

      const surface = resolveMarketplaceInspectSurface(args.surface ?? 'marketplace', null);
      if (!surface) {
        return errorResult(
          'surface must be one of: marketplace, tasks, skills, governance, disputes, reputation',
        );
      }

      const [statuses, statusesErr] = parseMarketplaceStatusFilter(args.status);
      if (statusesErr) return statusesErr;
      const [query, queryErr] = parseOptionalString(args.query, 'query');
      if (queryErr) return queryErr;
      const [tags, tagsErr] = parseOptionalStringArray(args.tags, 'tags');
      if (tagsErr) return tagsErr;
      if (args.activeOnly !== undefined && typeof args.activeOnly !== 'boolean') {
        return errorResult('activeOnly must be a boolean');
      }

      const activeOnly = Boolean(args.activeOnly ?? false);
      const subject = args.subject ?? args.agentPda;

      try {
        let inspectSurface: MarketplaceInspectOverview | MarketplaceInspectSurface;
        switch (surface) {
          case 'tasks':
            inspectSurface = await buildMarketplaceTasksSurface(program, logger, {
              statuses,
              limit,
            });
            break;
          case 'skills':
            inspectSurface = await buildMarketplaceSkillsSurface(program, {
              query,
              tags,
              activeOnly,
              limit,
            });
            break;
          case 'governance':
            inspectSurface = await buildMarketplaceGovernanceSurface(program, logger, {
              statuses,
              limit,
            });
            break;
          case 'disputes':
            inspectSurface = await buildMarketplaceDisputesSurface(program, logger, {
              statuses,
              limit,
            });
            break;
          case 'reputation':
            inspectSurface = await buildMarketplaceReputationSurface(program, subject);
            break;
          case 'marketplace': {
            const surfaces = await Promise.all([
              buildMarketplaceTasksSurface(program, logger, {
                statuses,
                limit,
              }),
              buildMarketplaceSkillsSurface(program, {
                query,
                tags,
                activeOnly,
                limit,
              }),
              buildMarketplaceGovernanceSurface(program, logger, {
                statuses,
                limit,
              }),
              buildMarketplaceDisputesSurface(program, logger, {
                statuses,
                limit,
              }),
              buildMarketplaceReputationSurface(program, subject),
            ]);
            inspectSurface = buildMarketplaceInspectOverview({
              surfaces,
              subject: typeof subject === 'string' ? subject.trim() || null : null,
            });
            break;
          }
        }

        return { content: safeStringify(inspectSurface) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.inspectMarketplace failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.listDisputes tool.
 */
export function createListDisputesTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.listDisputes',
    description:
      'List marketplace disputes on AgenC. Use this for claimant/respondent summaries, dispute status review, and dispute queue inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional comma-separated dispute status filter (active, resolved, expired, cancelled, or all).',
        },
        limit: {
          type: 'number',
          description: `Maximum disputes to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [limit, limitErr] = parseBoundedNumber(
        args.limit,
        'limit',
        1,
        MAX_LIMIT,
        DEFAULT_LIMIT,
      );
      if (limitErr) return limitErr;

      const [statuses, statusesErr] = parseMarketplaceStatusFilter(args.status);
      if (statusesErr) return statusesErr;

      try {
        const disputeOps = queryDisputeOperations(program, logger);
        const taskOps = queryTaskOperations(program, logger);
        let disputes = await Promise.all(
          (await disputeOps.fetchAllDisputes()).map((entry) =>
            enrichSerializedDisputeSummary(entry, taskOps),
          ),
        );
        disputes = filterMarketplaceItemsByStatus(disputes, statuses);
        disputes.sort(
          (left, right) =>
            Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0) ||
            left.disputePda.localeCompare(right.disputePda),
        );
        const limited = disputes.slice(0, limit);

        return {
          content: safeStringify({
            count: limited.length,
            total: disputes.length,
            disputes: limited,
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.listDisputes failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getDispute tool.
 */
export function createGetDisputeTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getDispute',
    description:
      'Get details for a specific marketplace dispute by its PDA address (base58), including claimant/respondent aliases and amount at stake when available.',
    inputSchema: {
      type: 'object',
      properties: {
        disputePda: {
          type: 'string',
          description: 'Dispute PDA address (base58)',
        },
      },
      required: ['disputePda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.disputePda);
      if (err) return err;

      try {
        const disputeOps = queryDisputeOperations(program, logger);
        const taskOps = queryTaskOperations(program, logger);
        const dispute = await disputeOps.fetchDispute(pda!);
        if (!dispute) {
          return errorResult(`Dispute not found: ${pda!.toBase58()}`);
        }
        const serialized = await enrichSerializedDisputeDetail(pda!, dispute, taskOps);
        return { content: safeStringify(serialized) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getDispute failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getReputationSummary tool.
 */
export function createGetReputationSummaryTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getReputationSummary',
    description:
      "Get marketplace reputation for a specific agent PDA or, when signer-backed context is available, for the connected signer's agent.",
    inputSchema: {
      type: 'object',
      properties: {
        agentPda: {
          type: 'string',
          description: 'Optional agent PDA address (base58). Required when no signer-backed context is available.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [summary, summaryErr] = await loadReputationSummary(program, args.agentPda);
        if (summaryErr || !summary) {
          return summaryErr ?? errorResult('Unable to load reputation summary');
        }
        return { content: safeStringify(summary) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getReputationSummary failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.registerAgent tool.
 */
export function createRegisterAgentTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.registerAgent',
    description:
      'Register the signer wallet as an on-chain AgenC agent. This stakes SOL according to protocol minimums.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilities: {
          type: 'string',
          description: 'Capability bitmask as integer string (u64). Must be > 0. Default: "1".',
        },
        endpoint: {
          type: 'string',
          description: 'Public endpoint URL (must start with http:// or https://). Default: https://agenc.local',
        },
        metadataUri: {
          type: 'string',
          description: 'Optional metadata URI (max 128 chars).',
        },
        stakeAmount: {
          type: 'string',
          description: 'Optional stake amount in lamports. Defaults to protocol minAgentStake.',
        },
        agentId: {
          type: 'string',
          description: 'Optional 32-byte agent id as 64-char hex. Random when omitted.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        if (!program.provider.publicKey) {
          return errorResult('agenc.registerAgent requires a signer-backed program context');
        }
        const authority = program.provider.publicKey;

        const [existingAgentPda, existingErr] = await resolveCreatorAgentPda(program, authority);
        if (existingAgentPda) {
          return {
            content: safeStringify({
              agentPda: existingAgentPda.toBase58(),
              alreadyRegistered: true,
            }),
          };
        }
        if (existingErr && !isNoRegistrationError(existingErr)) {
          return existingErr;
        }

        const [capabilities, capabilitiesErr] = parseBigIntInput(args.capabilities ?? '1', 'capabilities');
        if (capabilitiesErr || capabilities === null) {
          return capabilitiesErr ?? errorResult('Invalid capabilities');
        }
        if (capabilities <= 0n) {
          return errorResult('capabilities must be greater than zero');
        }
        const capabilityRangeErr = validateU64(capabilities, 'capabilities');
        if (capabilityRangeErr) return capabilityRangeErr;

        const endpointInput = args.endpoint ?? 'https://agenc.local';
        if (typeof endpointInput !== 'string') {
          return errorResult('endpoint must be a string');
        }
        const endpoint = endpointInput.trim();
        if (endpoint.length === 0) {
          return errorResult('endpoint must not be empty');
        }
        if (!(endpoint.startsWith('http://') || endpoint.startsWith('https://'))) {
          return errorResult('endpoint must start with http:// or https://');
        }
        if (endpoint.length > 128) {
          return errorResult('endpoint must be at most 128 characters');
        }

        let metadataUri: string | null = null;
        if (args.metadataUri !== undefined && args.metadataUri !== null) {
          if (typeof args.metadataUri !== 'string') {
            return errorResult('metadataUri must be a string');
          }
          metadataUri = args.metadataUri.trim();
          if (metadataUri.length > 128) {
            return errorResult('metadataUri must be at most 128 characters');
          }
        }

        const protocolPda = findProtocolPda(program.programId);
        let protocolConfig: ProtocolConfig;
        try {
          const rawProtocolConfig = await program.account.protocolConfig.fetch(protocolPda);
          protocolConfig = parseProtocolConfig(rawProtocolConfig);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return errorResult(`Failed to fetch protocol config: ${msg}`);
        }

        let stakeAmount = protocolConfig.minAgentStake;
        if (args.stakeAmount !== undefined) {
          const [parsedStakeAmount, stakeAmountErr] = parseBigIntInput(args.stakeAmount, 'stakeAmount');
          if (stakeAmountErr || parsedStakeAmount === null) {
            return stakeAmountErr ?? errorResult('Invalid stakeAmount');
          }
          stakeAmount = parsedStakeAmount;
        }
        const stakeAmountRangeErr = validateU64(stakeAmount, 'stakeAmount');
        if (stakeAmountRangeErr) return stakeAmountRangeErr;
        if (stakeAmount < protocolConfig.minAgentStake) {
          return errorResult(
            `stakeAmount must be at least protocol minAgentStake (${protocolConfig.minAgentStake.toString()})`,
          );
        }

        const [agentId, agentIdErr] = parseAgentId(args.agentId);
        if (agentIdErr || !agentId) {
          return agentIdErr ?? errorResult('Invalid agentId');
        }
        const agentPda = findAgentPda(agentId, program.programId);

        const txSignature = await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(capabilities.toString()),
            endpoint,
            metadataUri,
            new BN(stakeAmount.toString()),
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority,
          })
          .rpc();

        return {
          content: safeStringify({
            agentPda: agentPda.toBase58(),
            agentId: bytesToHex(agentId),
            capabilities: capabilities.toString(),
            endpoint,
            metadataUri,
            stakeAmount: stakeAmount.toString(),
            transactionSignature: txSignature,
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.registerAgent failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.listApprovedTaskTemplates tool.
 */
export function createListApprovedTaskTemplatesTool(logger: Logger): Tool {
  return {
    name: 'agenc.listApprovedTaskTemplates',
    description:
      'List approved marketplace task templates. Use this before creating any marketplace task.',
    inputSchema: {
      type: 'object',
      properties: {
        includeNonApproved: {
          type: 'boolean',
          description:
            'When true, include draft/deprecated/disabled templates for admin inspection. Defaults to false.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const includeStatuses: readonly ApprovedTaskTemplateStatus[] =
          args.includeNonApproved === true
            ? ['draft', 'approved', 'deprecated', 'disabled']
            : ['approved'];
        return {
          content: safeStringify({
            templates: listApprovedTaskTemplates({ includeStatuses }).map((template) => ({
              id: template.id,
              version: template.version,
              status: template.status,
              title: template.title,
              shortDescription: template.shortDescription,
              requiredCapabilities: template.requiredCapabilities,
              reward: template.reward,
              taskType: template.taskType,
              validationMode: template.validationMode,
              maxWorkers: template.maxWorkers ?? null,
              minReputation: template.minReputation ?? null,
              reviewWindowSecs: template.reviewWindowSecs ?? null,
              attachmentPolicy: template.attachmentPolicy,
            })),
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.listApprovedTaskTemplates failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getApprovedTaskTemplate tool.
 */
export function createGetApprovedTaskTemplateTool(logger: Logger): Tool {
  return {
    name: 'agenc.getApprovedTaskTemplate',
    description:
      'Inspect an approved marketplace task template and its accepted variables before creating a task.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'Approved template id.' },
        templateVersion: {
          type: 'number',
          description: 'Optional template version. Latest approved version is used when omitted.',
        },
      },
      required: ['templateId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [templateId, templateIdErr] = parseRequiredString(args.templateId, 'templateId');
        if (templateIdErr || !templateId) return templateIdErr ?? errorResult('Invalid templateId');
        const [templateVersion, templateVersionErr] = parseOptionalSafeInteger(
          args.templateVersion,
          'templateVersion',
        );
        if (templateVersionErr) return templateVersionErr;

        const template = getApprovedTaskTemplate(templateId, templateVersion);
        if (!template) return errorResult('Approved task template not found');

        return { content: safeStringify({ template }) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getApprovedTaskTemplate failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.createTaskFromTemplate tool.
 */
export function createCreateTaskFromTemplateTool(
  program: Program<AgencCoordination>,
  logger: Logger,
  options: TaskTemplateToolOptions = {},
): Tool {
  return {
    name: 'agenc.createTaskFromTemplate',
    description:
      'Create a marketplace task from an approved template. User values are stored as untrusted variables and bounded by the template policy.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'Approved template id.' },
        templateVersion: {
          type: 'number',
          description: 'Optional template version. Latest approved version is used when omitted.',
        },
        variables: {
          type: 'object',
          description: 'Template variables. These are treated as untrusted data, not instructions.',
        },
        rewardLamports: {
          type: 'string',
          description:
            'Optional reward in lamports. Must stay within the selected template reward bounds.',
        },
        deadline: {
          type: 'number',
          description: 'Optional unix timestamp seconds. Defaults to raw createTask default.',
        },
      },
      required: ['templateId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [templateId, templateIdErr] = parseRequiredString(args.templateId, 'templateId');
        if (templateIdErr || !templateId) return templateIdErr ?? errorResult('Invalid templateId');
        const [templateVersion, templateVersionErr] = parseOptionalSafeInteger(
          args.templateVersion,
          'templateVersion',
        );
        if (templateVersionErr) return templateVersionErr;
        const [deadline, deadlineErr] = parseOptionalSafeInteger(args.deadline, 'deadline');
        if (deadlineErr) return deadlineErr;
        const [variables, variablesErr] = parseOptionalObject(args.variables, 'variables');
        if (variablesErr) return variablesErr;

        const renderInput: RenderApprovedTaskTemplateInput = {
          templateId,
          ...(templateVersion !== undefined ? { templateVersion } : {}),
          variables: variables ?? {},
          ...(typeof args.rewardLamports === 'string' || typeof args.rewardLamports === 'number'
            ? { rewardLamports: args.rewardLamports }
            : {}),
          ...(deadline !== undefined ? { deadline } : {}),
        };
        const rendered = renderApprovedTaskTemplate(renderInput);
        const rawCreateTaskTool = createCreateTaskTool(program, logger, {
          ...options,
          allowRawTaskCreation: true,
        });
        const rawArgs: Record<string, unknown> = {
          description: rendered.description,
          fullDescription: rendered.fullDescription,
          jobSpec: rendered.jobSpec,
          reward: rendered.rewardLamports,
          requiredCapabilities: rendered.requiredCapabilities,
          taskType: rendered.taskType,
          validationMode: rendered.validationMode,
          templateAudit: rendered.audit,
        };
        if (rendered.deadline !== undefined) rawArgs.deadline = rendered.deadline;
        if (rendered.maxWorkers !== undefined) rawArgs.maxWorkers = rendered.maxWorkers;
        if (rendered.minReputation !== undefined) rawArgs.minReputation = rendered.minReputation;
        if (rendered.reviewWindowSecs !== undefined) rawArgs.reviewWindowSecs = rendered.reviewWindowSecs;

        const result = await rawCreateTaskTool.execute(rawArgs);
        if (result.isError) return result;
        const rawPayload = parseToolResultContent(result.content);
        return {
          ...result,
          content: safeStringify({
            ...rawPayload,
            approvedTemplate: {
              id: rendered.template.id,
              version: rendered.template.version,
              title: rendered.template.title,
            },
            templateAudit: rendered.audit,
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.createTaskFromTemplate failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.submitTaskTemplateProposal tool.
 */
export function createSubmitTaskTemplateProposalTool(
  logger: Logger,
  options: TaskTemplateToolOptions = {},
): Tool {
  return {
    name: 'agenc.submitTaskTemplateProposal',
    description:
      'Submit a draft marketplace task template proposal for admin/security review. This does not create an on-chain task.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'object',
          description: 'Draft task template proposal object for admin review.',
        },
        rationale: {
          type: 'string',
          description: 'Optional reason this template should be approved.',
        },
        submittedBy: {
          type: 'string',
          description: 'Optional submitter identifier.',
        },
      },
      required: ['template'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const persisted = await persistTaskTemplateProposal(
          {
            template: args.template,
            rationale: args.rationale,
            submittedBy: args.submittedBy,
          },
          options.templateProposalStoreDir
            ? { proposalStoreDir: options.templateProposalStoreDir }
            : undefined,
        );
        return {
          content: safeStringify({
            ...persisted,
            message:
              'Template proposal saved as draft. An admin/security reviewer must approve it before it can create marketplace tasks.',
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.submitTaskTemplateProposal failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

function parseRequiredString(input: unknown, field: string): [string | null, ToolResult | null] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [null, errorResult(`${field} must be a non-empty string`)];
  }
  return [input.trim(), null];
}

function parseOptionalSafeInteger(
  input: unknown,
  field: string,
): [number | undefined, ToolResult | null] {
  if (isOptionalPlaceholder(input)) {
    return [undefined, null];
  }
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    return [undefined, errorResult(`${field} must be a non-negative safe integer`)];
  }
  return [input, null];
}

function parseOptionalObject(
  input: unknown,
  field: string,
): [Record<string, unknown> | undefined, ToolResult | null] {
  if (isOptionalPlaceholder(input)) {
    return [undefined, null];
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return [undefined, errorResult(`${field} must be an object`)];
  }
  return [input as Record<string, unknown>, null];
}

function parseToolResultContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep the raw result available when a downstream tool returns non-JSON content.
  }
  return { rawContent: content };
}

function normalizeCreateTaskTemplateAudit(input: unknown): Record<string, string | number> | null {
  if (isOptionalPlaceholder(input)) {
    return null;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('templateAudit must be an object when provided');
  }
  const audit = input as Record<string, unknown>;
  const templateId = audit.templateId;
  const templateVersion = audit.templateVersion;
  const templateHash = audit.templateHash;
  const variableHash = audit.variableHash;
  const renderedAt = audit.renderedAt;
  if (typeof templateId !== 'string' || templateId.trim().length === 0) {
    throw new Error('templateAudit.templateId must be a string');
  }
  if (typeof templateVersion !== 'number' || !Number.isSafeInteger(templateVersion) || templateVersion <= 0) {
    throw new Error('templateAudit.templateVersion must be a positive safe integer');
  }
  if (typeof templateHash !== 'string' || !/^[0-9a-f]{64}$/i.test(templateHash)) {
    throw new Error('templateAudit.templateHash must be a sha256 hex string');
  }
  if (typeof variableHash !== 'string' || !/^[0-9a-f]{64}$/i.test(variableHash)) {
    throw new Error('templateAudit.variableHash must be a sha256 hex string');
  }
  if (typeof renderedAt !== 'number' || !Number.isSafeInteger(renderedAt) || renderedAt < 0) {
    throw new Error('templateAudit.renderedAt must be a non-negative safe integer');
  }
  return {
    templateId,
    templateVersion,
    templateHash: templateHash.toLowerCase(),
    variableHash: variableHash.toLowerCase(),
    renderedAt,
  };
}

/**
 * Create the agenc.createTask tool.
 */
export function createCreateTaskTool(
  program: Program<AgencCoordination>,
  logger: Logger,
  options: CreateTaskToolOptions = {},
): Tool {
  return {
    name: 'agenc.createTask',
    description:
      'Raw AgenC marketplace task creation. Disabled by default for agent routing; prefer agenc.createTaskFromTemplate.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: `Short on-chain task title/summary (max ${DESCRIPTION_BYTES} UTF-8 bytes). Put the long marketplace job details in jobSpec/fullDescription.`,
        },
        jobSpec: {
          anyOf: [{ type: 'object' }, { type: 'string' }],
          description:
            'Optional full marketplace job spec. Stored off-chain as canonical JSON with a sha256 integrity hash; use for long requirements, scope, examples, and notes.',
        },
        fullDescription: {
          type: 'string',
          description: 'Optional long-form job description stored in the marketplace jobSpec object.',
        },
        acceptanceCriteria: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
          description: 'Optional acceptance criteria stored in the marketplace jobSpec object.',
        },
        deliverables: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
          description: 'Optional expected deliverables stored in the marketplace jobSpec object.',
        },
        constraints: {
          anyOf: [{ type: 'object' }, { type: 'array' }, { type: 'string' }],
          description: 'Optional constraints for the jobSpec, such as prohibited actions, required tooling, or security requirements.',
        },
        attachments: {
          anyOf: [
            { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
            { type: 'string' },
          ],
          description: 'Optional external attachment URLs. Only https, ipfs, ar, or arweave URLs are accepted; local file paths and insecure http URLs are rejected.',
        },
        reward: {
          type: 'string',
          description: 'Reward in lamports (1 SOL = 1000000000 lamports). E.g. for 0.05 SOL pass "50000000".',
        },
        requiredCapabilities: {
          type: 'string',
          description: 'Required capability bitmask as integer string (u64, must be > 0).',
        },
        rewardMint: {
          type: 'string',
          description: 'Optional reward mint (base58). Must be in known mint registry.',
        },
        maxWorkers: {
          type: 'number',
          description: 'Max workers (1-100). Default 1.',
        },
        deadline: {
          type: 'number',
          description: 'Unix timestamp seconds. Default now + 1 hour.',
        },
        taskType: {
          anyOf: [
            { type: 'number', enum: [0, 1, 2, 3] },
            { type: 'string' },
          ],
          description:
            'Task type: 0/exclusive, 1/collaborative, 2/competitive, or 3/bid-exclusive (default exclusive)',
        },
        minReputation: {
          type: 'number',
          description: 'Minimum worker reputation (0-10000). Default 0.',
        },
        constraintHash: {
          type: 'string',
          description:
            'Optional 32-byte hex string for private tasks. Omit when validationMode="creator-review".',
        },
        validationMode: {
          type: 'string',
          enum: ['auto', 'creator-review'],
          description: 'Task validation mode. Use "creator-review" to hold payout until creator approval.',
        },
        reviewWindowSecs: {
          type: 'number',
          description:
            `Creator review window in seconds for validationMode="creator-review" (default ${DEFAULT_CREATOR_REVIEW_WINDOW_SECS}).`,
        },
        taskId: {
          type: 'string',
          description: 'Optional 32-byte task id as 64-char hex. Random when omitted.',
        },
        creatorAgentPda: {
          type: 'string',
          description: 'Optional creator agent PDA (base58). Auto-resolved when omitted.',
        },
      },
      required: ['description', 'reward', 'requiredCapabilities'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        if (options.allowRawTaskCreation !== true) {
          return errorResult(
            'Raw agenc.createTask is disabled by default. Use agenc.createTaskFromTemplate for approved marketplace tasks or agenc.submitTaskTemplateProposal for new task shapes.',
          );
        }
        if (!program.provider.publicKey) {
          return errorResult('agenc.createTask requires a signer-backed program context');
        }
        const creator = program.provider.publicKey;

        // Dedup guard — prevent LLM from calling createTask multiple times
        const dedupKey = `${creator.toBase58()}|${String(args.description ?? '').trim().toLowerCase()}`;
        const dedupNow = Date.now();
        const lastCall = recentCreateTaskCalls.get(dedupKey);
        if (lastCall && dedupNow - lastCall < CREATE_TASK_DEDUP_TTL_MS) {
          return errorResult(
            'Task with this description was already created moments ago. ' +
            'Do NOT call createTask again. Report the previous result to the user.',
          );
        }

        const [taskId, taskIdErr] = parseTaskId(args.taskId);
        if (taskIdErr || !taskId) return taskIdErr ?? errorResult('Invalid taskId');

        const [descBytes, descErr] = parseTaskDescription(args.description);
        if (descErr || !descBytes) return descErr ?? errorResult('Invalid description');

        const [reward, rewardErr] = parseBigIntInput(args.reward, 'reward');
        if (rewardErr || reward === null) return rewardErr ?? errorResult('Invalid reward');
        if (reward <= 0n) return errorResult('reward must be greater than zero');
        const rewardRangeErr = validateU64(reward, 'reward');
        if (rewardRangeErr) return rewardRangeErr;

        const [requiredCapabilities, capabilitiesErr] = parseBigIntInput(
          args.requiredCapabilities,
          'requiredCapabilities',
        );
        if (capabilitiesErr || requiredCapabilities === null) {
          return capabilitiesErr ?? errorResult('Invalid requiredCapabilities');
        }
        if (requiredCapabilities <= 0n) {
          return errorResult('requiredCapabilities must be greater than zero (e.g. "1")');
        }
        const requiredCapabilitiesRangeErr = validateU64(requiredCapabilities, 'requiredCapabilities');
        if (requiredCapabilitiesRangeErr) return requiredCapabilitiesRangeErr;

        const [taskType, taskTypeErr] = parseTaskTypeInput(args.taskType, TaskType.Exclusive);
        if (taskTypeErr) return taskTypeErr;
        const [maxWorkers, maxWorkersErr] = parseBoundedNumber(args.maxWorkers, 'maxWorkers', 1, 100, 1);
        if (maxWorkersErr) return maxWorkersErr;

        const [minReputation, minReputationErr] = parseBoundedNumber(
          args.minReputation,
          'minReputation',
          0,
          MAX_REPUTATION,
          0,
        );
        if (minReputationErr) return minReputationErr;

        const [validationMode, validationModeErr] = parseTaskValidationMode(args.validationMode);
        if (validationModeErr) return validationModeErr;
        if (
          validationMode === TaskValidationMode.CreatorReview &&
          taskType !== TaskType.Exclusive
        ) {
          return errorResult(
            'validationMode="creator-review" is only supported when taskType is 0/exclusive',
          );
        }

        const now = Math.floor(Date.now() / 1000);
        const [deadline, deadlineErr] = parseBoundedNumber(
          args.deadline,
          'deadline',
          now + 1,
          Number.MAX_SAFE_INTEGER,
          now + 3600,
        );
        if (deadlineErr) return deadlineErr;

        const [reviewWindowSecs, reviewWindowSecsErr] = parseBoundedNumber(
          args.reviewWindowSecs,
          'reviewWindowSecs',
          1,
          Number.MAX_SAFE_INTEGER,
          DEFAULT_CREATOR_REVIEW_WINDOW_SECS,
        );
        if (reviewWindowSecsErr) return reviewWindowSecsErr;
        if (
          !isOptionalPlaceholder(args.reviewWindowSecs) &&
          validationMode !== TaskValidationMode.CreatorReview
        ) {
          return errorResult('reviewWindowSecs is only valid when validationMode is "creator-review"');
        }

        const [customConstraintHash, constraintHashErr] = parseOptionalHexBytes(
          args.constraintHash,
          'constraintHash',
          TASK_ID_BYTES,
        );
        if (constraintHashErr) return constraintHashErr;
        if (
          validationMode === TaskValidationMode.CreatorReview &&
          customConstraintHash !== null
        ) {
          return errorResult(
            'Do not provide constraintHash with validationMode="creator-review"; creator-review tasks are configured through validation settings',
          );
        }
        const constraintHash = customConstraintHash;

        const [rewardMint, rewardMintErr] = parseKnownRewardMint(args.rewardMint);
        if (rewardMintErr) return rewardMintErr;
        const [creatorAgentPda, creatorAgentErr] = await resolveCreatorAgentPda(
          program,
          creator,
          args.creatorAgentPda,
        );
        if (creatorAgentErr || !creatorAgentPda) {
          return (
            creatorAgentErr ?? errorResult("Unable to resolve creatorAgentPda")
          );
        }

        let storedJobSpec: Awaited<ReturnType<typeof persistMarketplaceJobSpec>> | null = null;
        if (hasMarketplaceJobSpecInput(args)) {
          try {
            storedJobSpec = await persistMarketplaceJobSpec(
              {
                description: args.description as string,
                jobSpec: args.jobSpec,
                fullDescription: args.fullDescription,
                acceptanceCriteria: args.acceptanceCriteria,
                deliverables: args.deliverables,
                constraints: args.constraints,
                attachments: args.attachments,
                context: {
                  rewardLamports: reward.toString(),
                  requiredCapabilities: requiredCapabilities.toString(),
                  templateAudit: normalizeCreateTaskTemplateAudit(args.templateAudit),
                  rewardMint: rewardMint?.toBase58() ?? null,
                  maxWorkers,
                  deadline,
                  taskType,
                  minReputation,
                  validationMode:
                    validationMode === TaskValidationMode.CreatorReview
                      ? 'creator-review'
                      : 'auto',
                  reviewWindowSecs:
                    validationMode === TaskValidationMode.CreatorReview
                      ? reviewWindowSecs
                      : null,
                  creatorAgentPda: creatorAgentPda.toBase58(),
                },
              },
              options.jobSpecStoreDir
                ? { rootDir: options.jobSpecStoreDir }
                : undefined,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return errorResult(`Invalid jobSpec metadata: ${message}`);
          }
        }

        const taskPda = findTaskPda(creator, taskId, program.programId);
        const escrowPda = findEscrowPda(taskPda, program.programId);
        const protocolPda = findProtocolPda(program.programId);
        const tokenAccounts = buildCreateTaskTokenAccounts(
          rewardMint,
          escrowPda,
          creator,
        );

        const txSignature = await (program.methods as any)
          .createTask(
            toAnchorBytes(taskId),
            new BN(requiredCapabilities.toString()),
            toAnchorBytes(descBytes),
            new BN(reward.toString()),
            maxWorkers,
            new BN(deadline),
            taskType,
            constraintHash ? toAnchorBytes(constraintHash) : null,
            minReputation,
            rewardMint,
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator,
            creator,
            systemProgram: SystemProgram.programId,
            ...tokenAccounts,
          })
          .rpc();

        let validationTransactionSignature: string | null = null;
        let taskValidationConfigPda: string | null = null;
        let taskAttestorConfigPda: string | null = null;
        if (validationMode === TaskValidationMode.CreatorReview) {
          try {
            const ops = new TaskOperations({
              program,
              agentId: new Uint8Array(TASK_ID_BYTES),
              logger,
            });
            const validationResult = await ops.configureTaskValidation(
              taskPda,
              { taskId } as OnChainTask,
              TaskValidationMode.CreatorReview,
              reviewWindowSecs,
            );
            validationTransactionSignature =
              validationResult.transactionSignature ?? null;
            taskValidationConfigPda =
              validationResult.taskValidationConfigPda.toBase58();
            taskAttestorConfigPda =
              validationResult.taskAttestorConfigPda?.toBase58() ?? null;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return errorResult(
              `Task was created at ${taskPda.toBase58()} but creator-review validation configuration failed: ${message}`,
            );
          }
        }

        let taskJobSpecPda: string | null = null;
        let jobSpecTransactionSignature: string | null = null;
        let jobSpecPublishWarning: string | null = null;
        if (storedJobSpec) {
          try {
            const published = await setTaskJobSpecPointer(
              program,
              creator,
              taskPda,
              storedJobSpec.hash,
              storedJobSpec.uri,
            );
            taskJobSpecPda = published.taskJobSpecPda.toBase58();
            jobSpecTransactionSignature = published.transactionSignature;
          } catch (error) {
            jobSpecPublishWarning = formatJobSpecPublishWarning(error);
          }
        }

        let jobSpecTaskLinkPath: string | null = null;
        let jobSpecLinkWarning: string | null = null;
        if (storedJobSpec) {
          try {
            jobSpecTaskLinkPath = await linkMarketplaceJobSpecToTask(
              {
                hash: storedJobSpec.hash,
                uri: storedJobSpec.uri,
                taskPda: taskPda.toBase58(),
                taskId: bytesToHex(taskId),
                transactionSignature: jobSpecTransactionSignature ?? txSignature,
              },
              options.jobSpecStoreDir
                ? { rootDir: options.jobSpecStoreDir }
                : undefined,
            );
          } catch (error) {
            jobSpecLinkWarning =
              error instanceof Error ? error.message : String(error);
          }
        }

        // Mark as created to prevent LLM from calling again
        recentCreateTaskCalls.set(dedupKey, Date.now());
        // Clean up old entries
        for (const [key, ts] of recentCreateTaskCalls) {
          if (Date.now() - ts > CREATE_TASK_DEDUP_TTL_MS) recentCreateTaskCalls.delete(key);
        }

        return {
          content: safeStringify({
            taskPda: taskPda.toBase58(),
            escrowPda: escrowPda.toBase58(),
            taskId: bytesToHex(taskId),
            taskType: taskTypeToString(taskType),
            taskTypeId: taskType,
            taskTypeKey: taskTypeToKey(taskType),
            creatorAgentPda: creatorAgentPda.toBase58(),
            rewardMint: rewardMint?.toBase58() ?? null,
            rewardSymbol: getRewardSymbol(rewardMint),
            constraintHash: constraintHash ? bytesToHex(constraintHash) : null,
            minReputation,
            validationMode:
              validationMode === TaskValidationMode.CreatorReview
                ? 'creator-review'
                : 'auto',
            reviewWindowSecs:
              validationMode === TaskValidationMode.CreatorReview
                ? reviewWindowSecs
                : null,
            validationConfigured:
              validationMode === TaskValidationMode.CreatorReview,
            taskValidationConfigPda,
            taskAttestorConfigPda,
            taskJobSpecPda,
            jobSpecHash: storedJobSpec?.hash ?? null,
            jobSpecUri: storedJobSpec?.uri ?? null,
            jobSpecPath: storedJobSpec?.path ?? null,
            jobSpecTaskLinkPath,
            jobSpecIntegrity: storedJobSpec
              ? { algorithm: 'sha256', canonicalization: 'json-stable-v1' }
              : null,
            jobSpecTransactionSignature,
            jobSpecPublishWarning,
            jobSpecLinkWarning,
            transactionSignature: txSignature,
            validationTransactionSignature,
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.createTask failed: ${msg}`);

        // Detect on-chain rate-limit cooldown — non-retriable, tell the LLM to wait
        if (msg.includes('CooldownNotElapsed') || msg.includes('6072')) {
          return errorResult(
            'RATE LIMITED: The on-chain 60-second cooldown between task creations has not elapsed. ' +
            'Do NOT retry — wait at least 60 seconds before creating the next task. ' +
            'Tell the user to try again in about a minute.',
          );
        }

        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getAgent tool.
 */
export function createGetAgentTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getAgent',
    description:
      'Get details for an AgenC agent by its PDA address (base58). Returns status, capabilities, stake, and performance metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        agentPda: {
          type: 'string',
          description: 'Agent registration PDA address (base58)',
        },
      },
      required: ['agentPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.agentPda);
      if (err) return err;

      try {
        const raw = await program.account.agentRegistration.fetch(pda!);
        const agent = parseAgentState(raw);
        return { content: safeStringify(serializeAgent(agent, pda!)) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Account does not exist') || msg.includes('could not find')) {
          return errorResult(`Agent not found: ${pda!.toBase58()}`);
        }
        logger.error(`agenc.getAgent failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getProtocolConfig tool.
 */
export function createGetProtocolConfigTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getProtocolConfig',
    description:
      'Get AgenC protocol fees, thresholds, rate limits, and versioning. Do not use this for marketplace tasks, skills, governance, disputes, or reputation surfaces.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const protocolPda = findProtocolPda(program.programId);
        let config: ProtocolConfig;
        try {
          // Try Anchor deserialization first (works when IDL matches)
          const raw = await program.account.protocolConfig.fetch(protocolPda);
          config = parseProtocolConfig(raw);
        } catch {
          // Fall back to raw account parsing (handles devnet IDL mismatch)
          const [, rawConfig, configErr] = await fetchProtocolConfigForAction(
            program,
            'read protocol configuration',
          );
          if (configErr || !rawConfig) {
            return configErr ?? errorResult('Unable to load protocol config');
          }
          config = rawConfig;
        }
        return { content: safeStringify(serializeProtocolConfig(config)) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getProtocolConfig failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}
