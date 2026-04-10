/**
 * Built-in AgenC protocol tools.
 *
 * Query tools:
 * - agenc.listTasks — list tasks with optional status filter
 * - agenc.getTask — fetch a single task by PDA
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
 * - agenc.createTask — create a task with SOL or known SPL token rewards
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
import { findAgentPda, findAuthorityRateLimitPda, findProtocolPda } from '../../agent/pda.js';
import { findTaskPda, findEscrowPda } from '../../task/pda.js';
import {
  taskStatusToString,
  taskTypeToString,
  isPrivateTask,
  OnChainTaskStatus,
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
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DESCRIPTION_BYTES = 64;
const TASK_ID_BYTES = 32;
const MAX_U64 = (1n << 64n) - 1n;
const DUMMY_AGENT_ID = new Uint8Array(32);

/**
 * Dedup guard for createTask — prevents the LLM from calling createTask
 * multiple times with the same description in a single conversation turn.
 * Entries auto-expire after 30 seconds.  Keyed by `creator|description`.
 */
const recentCreateTaskCalls = new Map<string, number>();
const CREATE_TASK_DEDUP_TTL_MS = 30_000;

/** @internal Exposed for testing only. */
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
  if (value === undefined) return [defaultValue, null];
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
  if (input === undefined) return [generateAgentId(), null];
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
  if (input === undefined) return [generateAgentId(), null];
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
  if (input === undefined || input === null) return [null, null];
  const [mint, err] = parseBase58(input);
  if (err || !mint) return [null, errorResult('Invalid rewardMint address')];
  if (!KNOWN_MINTS[mint.toBase58()]) {
    return [null, errorResult(`Unsupported rewardMint: ${mint.toBase58()}`)];
  }
  return [mint, null];
}

async function resolveCreatorAgentPda(
  program: Program<AgencCoordination>,
  creator: PublicKey,
  providedCreatorAgentPda?: unknown,
): Promise<[PublicKey | null, ToolResult | null]> {
  if (providedCreatorAgentPda !== undefined) {
    const [pda, err] = parseBase58(providedCreatorAgentPda);
    return [pda, err];
  }

  // Use raw getProgramAccounts to bypass Anchor deserialization bug with enum repr
  const bs58 = await import('bs58');
  const AGENT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
  const AGENT_AUTHORITY_OFFSET = 40; // 8 (disc) + 32 (agent_id)
  const matches = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_DISCRIMINATOR) } },
      { memcmp: { offset: AGENT_AUTHORITY_OFFSET, bytes: creator.toBase58() } },
    ],
  });

  if (matches.length === 0) {
    return [null, errorResult('No agent registration found for signer wallet. Run `agenc-runtime agent register --rpc <url>` first, or provide creatorAgentPda.')];
  }
  if (matches.length > 1) {
    return [null, errorResult('Multiple agent registrations found for signer wallet. Provide creatorAgentPda.')];
  }

  return [matches[0].pubkey, null];
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

function serializeTask(
  task: OnChainTask,
  taskPda: PublicKey,
  extras?: Partial<Pick<SerializedTask, 'escrowTokenAccount' | 'escrowTokenBalance'>>,
): SerializedTask {
  return {
    taskPda: taskPda.toBase58(),
    taskId: bytesToHex(task.taskId),
    creator: task.creator.toBase58(),
    status: taskStatusToString(task.status),
    taskType: taskTypeToString(task.taskType),
    rewardAmount: task.rewardAmount.toString(),
    rewardSol: lamportsToSol(task.rewardAmount),
    requiredCapabilities: getCapabilityNames(task.requiredCapabilities),
    maxWorkers: task.maxWorkers,
    currentWorkers: task.currentWorkers,
    deadline: task.deadline,
    isPrivate: isPrivateTask(task),
    createdAt: task.createdAt,
    completions: task.completions,
    requiredCompletions: task.requiredCompletions,
    description: bytesToHex(task.description),
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
    return buildMarketplaceReputationInspectPlaceholder();
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
): Tool {
  return {
    name: 'agenc.listTasks',
    description:
      'List tasks on the AgenC protocol. Filter by status (open, in_progress, all). Returns task details including reward, capabilities, and deadline.',
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
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const status = (args.status as string) || 'open';
        const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
        const [rewardMintFilter, rewardMintErr] = parseRewardMintFilter(args.rewardMint);
        if (rewardMintErr) return rewardMintErr;

        let tasks: Array<{ task: OnChainTask; taskPda: PublicKey }>;

        if (status === 'all') {
          tasks = await ops.fetchAllTasks();
        } else {
          // fetchClaimableTasks uses memcmp filters (scalable)
          const claimable = await ops.fetchClaimableTasks();
          if (status === 'open') {
            tasks = claimable.filter((t) => t.task.status === OnChainTaskStatus.Open);
          } else {
            // in_progress
            tasks = claimable.filter((t) => t.task.status === OnChainTaskStatus.InProgress);
          }
        }

        if (rewardMintFilter !== undefined) {
          tasks = tasks.filter(({ task }) => {
            if (rewardMintFilter === null) return task.rewardMint === null;
            return task.rewardMint?.equals(rewardMintFilter) ?? false;
          });
        }

        const limited = tasks.slice(0, limit);
        const serialized = limited.map((t) => serializeTask(t.task, t.taskPda));

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
): Tool {
  return {
    name: 'agenc.getTask',
    description:
      'Get details for a specific AgenC task by its PDA address (base58).',
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
        if (task.rewardMint) {
          const escrowTokenAccount = getAssociatedTokenAddressSync(task.rewardMint, task.escrow, true);
          const escrowTokenBalance = await ops.fetchEscrowTokenBalance(pda!, task.rewardMint);
          return {
            content: safeStringify(
              serializeTask(task, pda!, {
                escrowTokenAccount: escrowTokenAccount.toBase58(),
                escrowTokenBalance: escrowTokenBalance.toString(),
              }),
            ),
          };
        }
        return {
          content: safeStringify(
            serializeTask(task, pda!, {
              escrowTokenAccount: null,
              escrowTokenBalance: null,
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
 * Create the agenc.createTask tool.
 */
export function createCreateTaskTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.createTask',
    description:
      'Create a new AgenC task with SOL rewards or supported SPL reward mints. Requires signer-backed program context.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: `Task description (max ${DESCRIPTION_BYTES} UTF-8 bytes)`,
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
          type: 'number',
          enum: [0, 1, 2, 3],
          description: '0=Exclusive, 1=Collaborative, 2=Competitive, 3=BidExclusive (default 0)',
        },
        minReputation: {
          type: 'number',
          description: 'Minimum worker reputation (0-10000). Default 0.',
        },
        constraintHash: {
          type: 'string',
          description: 'Optional 32-byte hex string for private tasks',
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

        const [taskType, taskTypeErr] = parseBoundedNumber(args.taskType, 'taskType', 0, 3, 0);
        if (taskTypeErr) return taskTypeErr;
        const [maxWorkers, maxWorkersErr] = parseBoundedNumber(args.maxWorkers, 'maxWorkers', 1, 100, 1);
        if (maxWorkersErr) return maxWorkersErr;

        const now = Math.floor(Date.now() / 1000);
        const [deadline, deadlineErr] = parseBoundedNumber(
          args.deadline,
          'deadline',
          now + 1,
          Number.MAX_SAFE_INTEGER,
          now + 3600,
        );
        if (deadlineErr) return deadlineErr;

        // The public CLI surface still restricts creation to public tasks with
        // default reputation gating. We pass null/default values for the extra
        // canonical fields unless the caller opts into a known public reward mint.
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

        const taskPda = findTaskPda(creator, taskId, program.programId);
        const escrowPda = findEscrowPda(taskPda, program.programId);
        const protocolPda = findProtocolPda(program.programId);
        const authorityRateLimitPda = findAuthorityRateLimitPda(creator, program.programId);
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
            null,
            0,
            rewardMint,
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authorityRateLimit: authorityRateLimitPda,
            authority: creator,
            creator,
            systemProgram: SystemProgram.programId,
            ...tokenAccounts,
          })
          .rpc();

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
            creatorAgentPda: creatorAgentPda.toBase58(),
            rewardMint: rewardMint?.toBase58() ?? null,
            rewardSymbol: getRewardSymbol(rewardMint),
            transactionSignature: txSignature,
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
