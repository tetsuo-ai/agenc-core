/**
 * WebChat subsystem query handlers.
 *
 * Each handler processes a specific dotted-namespace message type
 * (e.g. 'status.get', 'skills.list') and returns structured data
 * from the Gateway's subsystems.
 *
 * Handlers that need async operations (memory, approvals) return
 * void | Promise<void> — the plugin awaits the result.
 *
 * Events handlers (events.subscribe/unsubscribe) are handled directly
 * in the plugin because they need clientId for per-client tracking.
 *
 * @module
 */

import type { ControlResponse } from '../../gateway/types.js';
import type {
  WebChatDeps,
  WebChatHookListEntry,
  WebChatSkillListEntry,
} from './types.js';
import type {
  BackgroundRunControlAction,
  BackgroundRunOperatorErrorPayload,
} from '../../gateway/background-run-operator.js';
import { createProgram, createReadOnlyProgram } from '../../idl.js';
import {
  buildMarketplaceReputationSummaryForAgent,
  buildMarketplaceUnregisteredSummary,
  serializeMarketplaceDisputeSummary,
  serializeMarketplaceProposalDetail,
  serializeMarketplaceProposalSummary,
  serializeMarketplaceSkill,
  serializeMarketplaceTaskEntry,
} from '../../marketplace/serialization.js';
import { TaskOperations } from '../../task/operations.js';
import { findEscrowPda } from '../../task/pda.js';
import { lamportsToSol } from '../../utils/encoding.js';
import { loadKeypairFromFile, getDefaultKeypairPath } from '../../types/wallet.js';
import { IDL } from '../../idl.js';
import {
  AgentStatus,
  agentStatusToString,
} from '../../agent/types.js';
import { getCapabilityNames } from '../../agent/capabilities.js';
import { silentLogger } from '../../utils/logger.js';
import { GovernanceOperations } from '../../governance/operations.js';
import { DisputeOperations } from '../../dispute/operations.js';
import { OnChainSkillRegistryClient } from '../../skills/registry/client.js';
import { SkillPurchaseManager } from '../../skills/registry/payment.js';
import { createCreateTaskTool } from '../../tools/agenc/tools.js';
import {
  createClaimTaskTool,
  createCompleteTaskTool,
  createDelegateReputationTool,
  createInitiateDisputeTool,
  createRateSkillTool,
  createStakeReputationTool,
  createVoteProposalTool,
} from '../../tools/agenc/mutation-tools.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SendFn = (response: ControlResponse) => void;
export interface HandlerRequestContext {
  /** Gateway-assigned websocket client id for this request. */
  clientId: string;
  /** Stable server-authenticated owner key for the connected web client. */
  ownerKey: string;
  /** Stable server-authenticated actor id for audit and approvals. */
  actorId: string;
  /** Logical channel name for the request. */
  channel: string;
  /** Active mapped chat session for this client, if any. */
  activeSessionId?: string;
  /** Session ids owned by the current client. */
  listOwnedSessionIds(): string[];
  /** True when the provided session id is owned by the current client. */
  isSessionOwned(sessionId: string): boolean;
}

const SOLANA_NOT_CONFIGURED =
  'On-chain task operations require Solana connection — configure connection.rpcUrl in config';
const DESKTOP_MEMORY_LIMIT_RE = /^\d+(?:[bkmg])?$/i;
const DESKTOP_CPU_LIMIT_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

function parseDesktopResourceOverride(
  value: unknown,
  field: 'maxMemory' | 'maxCpu',
): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') {
    return { error: `${field} must be a string` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return {};

  if (field === 'maxMemory') {
    if (!DESKTOP_MEMORY_LIMIT_RE.test(trimmed)) {
      return {
        error: 'maxMemory must look like 512m or 2g (plain integers default to GB)',
      };
    }
    const normalized = trimmed.toLowerCase();
    if (/^\d+$/.test(normalized)) {
      return { value: `${normalized}g` };
    }
    return { value: normalized };
  }

  if (!DESKTOP_CPU_LIMIT_RE.test(trimmed)) {
    return {
      error: 'maxCpu must be a positive number like 0.5 or 2.0',
    };
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: 'maxCpu must be greater than 0' };
  }
  return { value: trimmed };
}

/** Create an AnchorProvider from a Connection + Keypair. */
function createWalletProvider(
  connection: import('@solana/web3.js').Connection,
  keypair: import('@solana/web3.js').Keypair,
): AnchorProvider {
  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction>(tx: T): Promise<T> => {
      if ('sign' in tx) (tx as import('@solana/web3.js').Transaction).sign(keypair);
      return tx;
    },
    signAllTransactions: async <T extends import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction>(txs: T[]): Promise<T[]> => {
      for (const tx of txs) {
        if ('sign' in tx) (tx as import('@solana/web3.js').Transaction).sign(keypair);
      }
      return txs;
    },
  };
  return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
}

async function createProgramContext(deps: WebChatDeps): Promise<{
  keypair: import('@solana/web3.js').Keypair;
  provider: AnchorProvider;
  program: ReturnType<typeof createProgram>;
}> {
  if (!deps.connection) {
    throw new Error(SOLANA_NOT_CONFIGURED);
  }

  const keypairPath = deps.gateway.config.connection?.keypairPath ?? getDefaultKeypairPath();
  const keypair = await loadKeypairFromFile(keypairPath);
  const provider = createWalletProvider(deps.connection, keypair);
  return {
    keypair,
    provider,
    program: createProgram(provider),
  };
}

function createReadOnlyProgramContext(deps: WebChatDeps): ReturnType<typeof createReadOnlyProgram> {
  if (!deps.connection) {
    throw new Error(SOLANA_NOT_CONFIGURED);
  }
  return createReadOnlyProgram(deps.connection);
}

async function resolveSignerAgent(program: ReturnType<typeof createProgram>): Promise<{
  agentPda: PublicKey;
  agentId: Uint8Array;
  authority: PublicKey;
}> {
  const authority = program.provider.publicKey;
  if (!authority) {
    throw new Error('Signer-backed program context required');
  }

  const bs58 = await import('bs58');
  const matches = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_ACCT_DISCRIMINATOR) } },
      { memcmp: { offset: 40, bytes: authority.toBase58() } },
    ],
  });

  if (matches.length === 0) {
    throw new Error('No agent registration found for signer wallet');
  }
  if (matches.length > 1) {
    throw new Error('Multiple agent registrations found for signer wallet');
  }

  const agentData = matches[0].account.data as Buffer;
  if (agentData.length < 72) {
    throw new Error('Signer agent registration account is truncated');
  }

  return {
    agentPda: matches[0].pubkey,
    agentId: new Uint8Array(agentData.subarray(8, 40)),
    authority,
  };
}

interface TaskViewerContext {
  viewerAgentPda: string;
  claimedTaskIds: Set<string>;
}

function mapTaskSummary(
  entry: Awaited<ReturnType<TaskOperations['fetchAllTasks']>>[number],
  viewerContext?: TaskViewerContext,
) {
  const task = serializeMarketplaceTaskEntry(entry);
  const summary = {
    id: task.taskPda,
    status: task.status,
    reward: lamportsToSol(BigInt(task.rewardLamports)),
    creator: task.creator,
    description: task.description,
    worker: task.currentWorkers > 0 ? `${task.currentWorkers} worker(s)` : undefined,
  };

  if (!viewerContext) {
    return summary;
  }

  const ownedBySigner = task.creator === viewerContext.viewerAgentPda;
  const assignedToSigner = viewerContext.claimedTaskIds.has(task.taskPda);

  return {
    ...summary,
    viewerAgentPda: viewerContext.viewerAgentPda,
    ownedBySigner,
    assignedToSigner,
    claimableBySigner: task.status === 'open' && !ownedBySigner && !assignedToSigner,
  };
}

function mapSkillSummary(
  entry: { publicKey: PublicKey; account: Record<string, unknown> },
) {
  return serializeMarketplaceSkill(entry);
}

function mapProposalSummary(
  entry: Awaited<ReturnType<GovernanceOperations['fetchAllProposals']>>[number],
) {
  return serializeMarketplaceProposalSummary(entry);
}

function mapDisputeSummary(
  entry: Awaited<ReturnType<DisputeOperations['fetchAllDisputes']>>[number],
) {
  return serializeMarketplaceDisputeSummary(entry);
}

function parseToolError(result: { content: string; isError?: boolean }): string {
  if (!result.isError) return 'Unknown tool failure';
  try {
    const parsed = JSON.parse(result.content) as { error?: string };
    return parsed.error ?? result.content;
  } catch {
    return result.content;
  }
}

// ============================================================================
// Status handlers
// ============================================================================

function handleStatusGet(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const status = deps.gateway.getStatus();
  const daemonStatus = deps.getDaemonStatus?.();
  send({
    type: 'status.update',
    payload: {
      ...status,
      agentName: deps.gateway.config.agent?.name,
      llmProvider: deps.gateway.config.llm?.provider,
      llmModel: deps.gateway.config.llm?.model,
      ...(daemonStatus
        ? {
            pid: daemonStatus.pid,
            memoryUsage: daemonStatus.memoryUsage,
          }
        : {}),
    },
    id,
  });
}

// ============================================================================
// Tool registry handlers
// ============================================================================

function listSkills(deps: WebChatDeps): WebChatSkillListEntry[] {
  return [...(deps.skills ?? [])];
}

function listHooks(deps: WebChatDeps): WebChatHookListEntry[] {
  const hooks = deps.hooks;
  if (!hooks) return [];

  const entries: WebChatHookListEntry[] = [];
  for (const [event, handlers] of hooks.listHandlers()) {
    for (const handler of handlers) {
      entries.push({
        event,
        ...handler,
      });
    }
  }

  return entries.sort((left, right) => {
    const eventOrder = left.event.localeCompare(right.event);
    if (eventOrder !== 0) return eventOrder;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.name.localeCompare(right.name);
  });
}

function sendToolList(
  deps: WebChatDeps,
  id: string | undefined,
  send: SendFn,
  responseType: 'skills.list' | 'tools.list',
): void {
  send({
    type: responseType,
    payload: listSkills(deps),
    id,
  });
}

function sendHookList(
  deps: WebChatDeps,
  id: string | undefined,
  send: SendFn,
): void {
  send({
    type: 'hooks.list',
    payload: listHooks(deps),
    id,
  });
}

function toggleTool(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  responseType: 'skills.list' | 'tools.list',
): void {
  const skillName = payload?.skillName;
  if (!skillName || typeof skillName !== 'string') {
    send({ type: 'error', error: 'Missing skillName in payload', id });
    return;
  }
  const enabled = payload?.enabled;
  if (typeof enabled !== 'boolean') {
    send({ type: 'error', error: 'Missing enabled (boolean) in payload', id });
    return;
  }
  if (!deps.skillToggle) {
    send({ type: 'error', error: 'Tool toggle not available', id });
    return;
  }
  deps.skillToggle(skillName, enabled);
  sendToolList(deps, id, send, responseType);
}

function handleSkillsList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  sendToolList(deps, id, send, 'skills.list');
}

function handleSkillsToggle(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  toggleTool(deps, payload, id, send, 'skills.list');
}

function handleToolsList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  sendToolList(deps, id, send, 'tools.list');
}

function handleHooksList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  sendHookList(deps, id, send);
}

function handleToolsToggle(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  toggleTool(deps, payload, id, send, 'tools.list');
}

// ============================================================================
// Marketplace handlers
// ============================================================================

async function handleMarketSkillsList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to list marketplace skills', async () => {
    const program = createReadOnlyProgramContext(deps);
    const query =
      typeof payload?.query === 'string' ? payload.query.trim().toLowerCase() : '';
    const activeOnly = payload?.activeOnly !== false;

    const accounts = await (program.account as any).skillRegistration.all();
    const items = (accounts
      .map((entry: { publicKey: PublicKey; account: Record<string, unknown> }) =>
        mapSkillSummary(entry),
      )
      .filter((entry: ReturnType<typeof mapSkillSummary>) => !activeOnly || entry.isActive)
      .filter((entry: ReturnType<typeof mapSkillSummary>) => {
        if (!query) return true;
        return (
          entry.name.toLowerCase().includes(query) ||
          entry.author.toLowerCase().includes(query) ||
          entry.tags.some((tag: string) => tag.toLowerCase().includes(query))
        );
      })
      .sort(
        (left: ReturnType<typeof mapSkillSummary>, right: ReturnType<typeof mapSkillSummary>) =>
          right.rating - left.rating ||
          right.downloads - left.downloads ||
          left.name.localeCompare(right.name),
      )) as ReturnType<typeof mapSkillSummary>[];

    send({ type: 'market.skills.list', payload: items, id });
  });
}

async function handleMarketSkillsDetail(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const skillPda = payload?.skillPda;
  if (!skillPda || typeof skillPda !== 'string') {
    send({ type: 'error', error: 'Missing skillPda in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to inspect marketplace skill', async () => {
    const connection = deps.connection!;
    const program = createReadOnlyProgramContext(deps);
    const publicKey = new PublicKey(skillPda);
    const account = await (program.account as any).skillRegistration.fetchNullable(publicKey);
    if (!account) {
      send({ type: 'error', error: `Skill not found: ${skillPda}`, id });
      return;
    }

    const detail = mapSkillSummary({
      publicKey,
      account: account as Record<string, unknown>,
    });

    try {
      const { program: signerProgram } = await createProgramContext(deps);
      const signerAgent = await resolveSignerAgent(signerProgram);
      const registryClient = new OnChainSkillRegistryClient({
        connection,
        logger: silentLogger,
      });
      const purchaseManager = new SkillPurchaseManager({
        program: signerProgram,
        agentId: signerAgent.agentId,
        registryClient,
        logger: silentLogger,
      });
      send({
        type: 'market.skills.detail',
        payload: {
          ...detail,
          purchased: await purchaseManager.isPurchased(publicKey),
        },
        id,
      });
      return;
    } catch {
      // Fall through and return the skill without signer-specific purchase state.
    }

    send({ type: 'market.skills.detail', payload: detail, id });
  });
}

async function handleMarketSkillsPurchase(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const skillPda = payload?.skillPda;
  const skillId = payload?.skillId;
  if (!skillPda || typeof skillPda !== 'string') {
    send({ type: 'error', error: 'Missing skillPda in payload', id });
    return;
  }
  if (!skillId || typeof skillId !== 'string') {
    send({ type: 'error', error: 'Missing skillId in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const connection = deps.connection!;
    const { program } = await createProgramContext(deps);
    const signerAgent = await resolveSignerAgent(program);
    const registryClient = new OnChainSkillRegistryClient({
      connection,
      logger: silentLogger,
    });
    const purchaseManager = new SkillPurchaseManager({
      program,
      agentId: signerAgent.agentId,
      registryClient,
      logger: silentLogger,
    });
    const result = await purchaseManager.purchase(
      new PublicKey(skillPda),
      skillId,
      join(homedir(), '.agenc', 'skills', `${skillId}.md`),
    );
    send({
      type: 'market.skills.purchased',
      payload: {
        skillPda,
        skillId,
        paid: result.paid,
        pricePaid: result.pricePaid.toString(),
        protocolFee: result.protocolFee.toString(),
        transactionSignature: result.transactionSignature,
        contentPath: result.contentPath,
      },
      id,
    });
    deps.broadcastEvent?.('market.skill.purchased', {
      skillPda,
      skillId,
      paid: result.paid,
    });
  } catch (err) {
    send({ type: 'error', error: `Failed to purchase skill: ${(err as Error).message}`, id });
  }
}

async function handleMarketSkillsRate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const skillPda = payload?.skillPda;
  const rating = payload?.rating;
  if (!skillPda || typeof skillPda !== 'string') {
    send({ type: 'error', error: 'Missing skillPda in payload', id });
    return;
  }
  if (typeof rating !== 'number' || !Number.isInteger(rating)) {
    send({ type: 'error', error: 'Missing rating in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const tool = createRateSkillTool(program, silentLogger);
    const result = await tool.execute({
      skillPda,
      rating,
      ...(typeof payload?.review === 'string' ? { review: payload.review } : {}),
    });
    if (result.isError) {
      send({ type: 'error', error: `Failed to rate skill: ${parseToolError(result)}`, id });
      return;
    }
    send({ type: 'market.skills.rated', payload: { skillPda, rating }, id });
    deps.broadcastEvent?.('market.skill.rated', { skillPda, rating });
  } catch (err) {
    send({ type: 'error', error: `Failed to rate skill: ${(err as Error).message}`, id });
  }
}

async function handleMarketGovernanceList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to list governance proposals', async () => {
    const program = createReadOnlyProgramContext(deps);
    const ops = new GovernanceOperations({
      program,
      agentId: new Uint8Array(32),
      logger: silentLogger,
    });
    const statusFilter =
      typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : '';
    const proposals = (await ops.fetchAllProposals())
      .map(mapProposalSummary)
      .filter((proposal) => !statusFilter || proposal.status === statusFilter)
      .sort((left, right) => right.createdAt - left.createdAt);

    send({ type: 'market.governance.list', payload: proposals, id });
  });
}

async function handleMarketGovernanceDetail(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const proposalPda = payload?.proposalPda;
  if (!proposalPda || typeof proposalPda !== 'string') {
    send({ type: 'error', error: 'Missing proposalPda in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to inspect governance proposal', async () => {
    const program = createReadOnlyProgramContext(deps);
    const ops = new GovernanceOperations({
      program,
      agentId: new Uint8Array(32),
      logger: silentLogger,
    });
    const proposal = await ops.getProposal(new PublicKey(proposalPda));
    if (!proposal) {
      send({ type: 'error', error: `Proposal not found: ${proposalPda}`, id });
      return;
    }
    send({
      type: 'market.governance.detail',
      payload: serializeMarketplaceProposalDetail(
        proposal.proposalPda,
        proposal,
      ),
      id,
    });
  });
}

async function handleMarketGovernanceVote(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const proposalPda = payload?.proposalPda;
  const approve = payload?.approve;
  if (!proposalPda || typeof proposalPda !== 'string') {
    send({ type: 'error', error: 'Missing proposalPda in payload', id });
    return;
  }
  if (typeof approve !== 'boolean') {
    send({ type: 'error', error: 'Missing approve boolean in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const tool = createVoteProposalTool(program, silentLogger);
    const result = await tool.execute({ proposalPda, approve });
    if (result.isError) {
      send({ type: 'error', error: `Failed to vote on proposal: ${parseToolError(result)}`, id });
      return;
    }
    send({ type: 'market.governance.voted', payload: { proposalPda, approve }, id });
    deps.broadcastEvent?.('market.governance.voted', { proposalPda, approve });
  } catch (err) {
    send({ type: 'error', error: `Failed to vote on proposal: ${(err as Error).message}`, id });
  }
}

async function handleMarketDisputesList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to list disputes', async () => {
    const program = createReadOnlyProgramContext(deps);
    const ops = new DisputeOperations({
      program,
      agentId: new Uint8Array(32),
      logger: silentLogger,
    });
    const statusFilter =
      typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : '';
    const disputes = (await ops.fetchAllDisputes())
      .map(mapDisputeSummary)
      .filter((entry) => !statusFilter || entry.status === statusFilter)
      .sort((left, right) => right.createdAt - left.createdAt);

    send({ type: 'market.disputes.list', payload: disputes, id });
  });
}

async function handleMarketDisputesDetail(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const disputePda = payload?.disputePda;
  if (!disputePda || typeof disputePda !== 'string') {
    send({ type: 'error', error: 'Missing disputePda in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to inspect dispute', async () => {
    const program = createReadOnlyProgramContext(deps);
    const ops = new DisputeOperations({
      program,
      agentId: new Uint8Array(32),
      logger: silentLogger,
    });
    const dispute = await ops.fetchDispute(new PublicKey(disputePda));
    if (!dispute) {
      send({ type: 'error', error: `Dispute not found: ${disputePda}`, id });
      return;
    }
    send({
      type: 'market.disputes.detail',
      payload: serializeMarketplaceDisputeSummary({
        dispute,
        disputePda: new PublicKey(disputePda),
      }),
      id,
    });
  });
}

async function handleMarketReputationSummary(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  await safeAsync(send, id, 'error', 'Failed to load reputation summary', async () => {
    const { program } = await createProgramContext(deps);
    const authority = program.provider.publicKey?.toBase58() ?? '';

    let signerAgent: Awaited<ReturnType<typeof resolveSignerAgent>> | null = null;
    try {
      signerAgent = await resolveSignerAgent(program);
    } catch {
      send({
        type: 'market.reputation.summary',
        payload: buildMarketplaceUnregisteredSummary({ authority }),
        id,
      });
      return;
    }

    const summary = await buildMarketplaceReputationSummaryForAgent(
      program,
      signerAgent.agentPda,
      signerAgent.agentId,
    );
    if (!summary) {
      send({
        type: 'market.reputation.summary',
        payload: buildMarketplaceUnregisteredSummary({ authority }),
        id,
      });
      return;
    }
    const { agentId: _agentId, ...payload } = summary;

    send({
      type: 'market.reputation.summary',
      payload,
      id,
    });
  });
}

async function handleMarketReputationStake(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const amount = payload?.amount;
  if (!amount || typeof amount !== 'string') {
    send({ type: 'error', error: 'Missing amount in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const tool = createStakeReputationTool(program, silentLogger);
    const result = await tool.execute({ amount });
    if (result.isError) {
      send({ type: 'error', error: `Failed to stake reputation: ${parseToolError(result)}`, id });
      return;
    }
    send({ type: 'market.reputation.staked', payload: { amount }, id });
    deps.broadcastEvent?.('market.reputation.staked', { amount });
  } catch (err) {
    send({ type: 'error', error: `Failed to stake reputation: ${(err as Error).message}`, id });
  }
}

async function handleMarketReputationDelegate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const tool = createDelegateReputationTool(program, silentLogger);
    const args: Record<string, unknown> = {};
    if (typeof payload?.amount === 'number') args.amount = payload.amount;
    if (typeof payload?.delegateeAgentPda === 'string') args.delegateeAgentPda = payload.delegateeAgentPda;
    if (typeof payload?.delegateeAgentId === 'string') args.delegateeAgentId = payload.delegateeAgentId;
    if (typeof payload?.expiresAt === 'number') args.expiresAt = payload.expiresAt;
    const result = await tool.execute(args);
    if (result.isError) {
      send({ type: 'error', error: `Failed to delegate reputation: ${parseToolError(result)}`, id });
      return;
    }
    send({
      type: 'market.reputation.delegated',
      payload: {
        amount: args.amount,
        delegateeAgentPda: args.delegateeAgentPda,
        delegateeAgentId: args.delegateeAgentId,
      },
      id,
    });
    deps.broadcastEvent?.('market.reputation.delegated', {
      amount: args.amount,
      delegateeAgentPda: args.delegateeAgentPda,
      delegateeAgentId: args.delegateeAgentId,
    });
  } catch (err) {
    send({ type: 'error', error: `Failed to delegate reputation: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Tasks handlers — on-chain Solana task operations
// ============================================================================

/**
 * Task account binary layout offsets (devnet program).
 * Layout: 8 (discriminator) + 32 (task_id) + 32 (creator) + 8 (capabilities)
 *       + 64 (description) + 8 (reward_amount)
 *       + 1 (max_workers) + 1 (current_workers) + 1 (status)
 */
/** Helper: send a refreshed task list to the client using typed task operations. */
async function sendTaskList(deps: WebChatDeps, id: string | undefined, send: SendFn): Promise<void> {
  const program = createReadOnlyProgramContext(deps);
  const ops = new TaskOperations({
    program,
    agentId: new Uint8Array(32),
    logger: silentLogger,
  });
  const allTasks = await ops.fetchAllTasks();

  let viewerContext: TaskViewerContext | undefined;
  try {
    const { program: signerProgram } = await createProgramContext(deps);
    const signerAgent = await resolveSignerAgent(signerProgram);
    const signerTaskOps = new TaskOperations({
      program: signerProgram,
      agentId: signerAgent.agentId,
      logger: silentLogger,
    });
    const activeClaims = await signerTaskOps.fetchActiveClaims();
    viewerContext = {
      viewerAgentPda: signerAgent.agentPda.toBase58(),
      claimedTaskIds: new Set(activeClaims.map(({ taskPda }) => taskPda.toBase58())),
    };
  } catch {
    viewerContext = undefined;
  }

  const payload = allTasks
    .sort((left, right) => right.task.createdAt - left.task.createdAt)
    .map((entry) => mapTaskSummary(entry, viewerContext));
  send({ type: 'tasks.list', payload, id });
}

export async function handleTasksList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to list tasks', () => sendTaskList(deps, id, send));
}

async function handleTasksCreate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const params = payload?.params;
  if (!params || typeof params !== 'object') {
    send({ type: 'error', error: 'Missing params in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const descStr = typeof (params as Record<string, unknown>).description === 'string'
      ? (params as Record<string, unknown>).description as string
      : 'Task from WebUI';
    const rewardInput = typeof (params as Record<string, unknown>).reward === 'number'
      ? (params as Record<string, unknown>).reward as number
      : 0;
    const rewardLamports = BigInt(Math.max(Math.round(rewardInput * 1_000_000_000), 10_000_000));
    const { program } = await createProgramContext(deps);
    const tool = createCreateTaskTool(program, silentLogger);
    const result = await tool.execute({
      description: descStr,
      reward: rewardLamports.toString(),
      requiredCapabilities: '1',
    });
    if (result.isError) {
      send({ type: 'error', error: `Failed to create task: ${parseToolError(result)}`, id });
      return;
    }
    let createdTaskPda: string | undefined;
    try {
      createdTaskPda = (JSON.parse(result.content) as { taskPda?: string }).taskPda;
    } catch {
      createdTaskPda = undefined;
    }

    // Auto-refresh task list after creation
    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.created', { taskPda: createdTaskPda, description: descStr });
  } catch (err) {
    send({ type: 'error', error: `Failed to create task: ${(err as Error).message}`, id });
  }
}

async function handleTasksCancel(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const taskId = payload?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { keypair, program } = await createProgramContext(deps);
    const taskPda = new PublicKey(taskId);
    const escrowPda = findEscrowPda(taskPda, program.programId);

    // Devnet cancel_task: only 4 accounts (task, escrow, creator, system_program)
    await program.methods
      .cancelTask()
      .accountsPartial({
        authority: keypair.publicKey,
        task: taskPda,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Auto-refresh task list after cancellation
    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.cancelled', { taskPda: taskId });
  } catch (err) {
    send({ type: 'error', error: `Failed to cancel task: ${(err as Error).message}`, id });
  }
}

async function handleTasksClaim(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const taskId = payload?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const tool = createClaimTaskTool(program, silentLogger);
    const result = await tool.execute({ taskPda: taskId });
    if (result.isError) {
      send({ type: 'error', error: `Failed to claim task: ${parseToolError(result)}`, id });
      return;
    }

    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.claimed', { taskPda: taskId });
  } catch (err) {
    send({ type: 'error', error: `Failed to claim task: ${(err as Error).message}`, id });
  }
}

async function handleTasksComplete(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const taskId = payload?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  const resultData = typeof payload?.resultData === 'string' && payload.resultData.trim().length > 0
    ? payload.resultData.trim()
    : 'Task completed via dashboard';
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const proofHash = createHash('sha256').update(resultData).digest('hex');
    const tool = createCompleteTaskTool(program, silentLogger);
    const result = await tool.execute({
      taskPda: taskId,
      proofHash,
      resultData,
    });
    if (result.isError) {
      send({ type: 'error', error: `Failed to complete task: ${parseToolError(result)}`, id });
      return;
    }

    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.completed', { taskPda: taskId });
  } catch (err) {
    send({ type: 'error', error: `Failed to complete task: ${(err as Error).message}`, id });
  }
}

async function handleTasksDispute(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const taskId = payload?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  const evidence = typeof payload?.evidence === 'string' ? payload.evidence.trim() : '';
  if (!evidence) {
    send({ type: 'error', error: 'Missing evidence in payload', id });
    return;
  }
  const resolutionType = typeof payload?.resolutionType === 'string' ? payload.resolutionType : 'refund';
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  try {
    const { program } = await createProgramContext(deps);
    const tool = createInitiateDisputeTool(program, silentLogger);
    const result = await tool.execute({
      taskPda: taskId,
      evidence,
      resolutionType,
    });
    if (result.isError) {
      send({ type: 'error', error: `Failed to open dispute: ${parseToolError(result)}`, id });
      return;
    }

    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.disputed', { taskPda: taskId, resolutionType });
  } catch (err) {
    send({ type: 'error', error: `Failed to open dispute: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Memory handlers
// ============================================================================

type OwnedMemorySessionSummary = {
  id: string;
  messageCount: number;
  lastActiveAt: number;
};

async function listOwnedMemorySessions(
  deps: WebChatDeps,
  request: HandlerRequestContext,
  { limit = Number.POSITIVE_INFINITY }: { limit?: number } = {},
): Promise<OwnedMemorySessionSummary[]> {
  if (!deps.memoryBackend) {
    return [];
  }
  const cappedLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : Number.POSITIVE_INFINITY;
  const sessionIds = request.listOwnedSessionIds();
  const results: OwnedMemorySessionSummary[] = [];
  for (const sid of sessionIds.slice(0, cappedLimit)) {
    const thread = await deps.memoryBackend.getThread(sid);
    results.push({
      id: sid,
      messageCount: thread.length,
      lastActiveAt: thread.length > 0 ? thread[thread.length - 1].timestamp : 0,
    });
  }
  return results;
}

function summarizeMaintenanceSync(
  deps: WebChatDeps,
  request: HandlerRequestContext,
) {
  const activeSessionId =
    typeof request.activeSessionId === 'string' && request.activeSessionId.length > 0
      ? request.activeSessionId
      : undefined;
  const activeSessionOwned = Boolean(
    activeSessionId && request.isSessionOwned(activeSessionId),
  );
  const availability = deps.getBackgroundRunAvailability?.(
    activeSessionOwned ? activeSessionId : undefined,
  );
  const gatewayBackgroundRuns = deps.gateway.getStatus()?.backgroundRuns;
  return {
    ownerSessionCount: request.listOwnedSessionIds().length,
    activeSessionId,
    activeSessionOwned,
    durableRunsEnabled:
      typeof availability?.enabled === 'boolean'
        ? availability.enabled
        : typeof gatewayBackgroundRuns?.enabled === 'boolean'
          ? gatewayBackgroundRuns.enabled
        : Boolean(
            deps.listBackgroundRuns ||
              deps.inspectBackgroundRun ||
              deps.controlBackgroundRun,
          ),
    operatorAvailable:
      typeof availability?.operatorAvailable === 'boolean'
        ? availability.operatorAvailable
        : typeof gatewayBackgroundRuns?.operatorAvailable === 'boolean'
          ? gatewayBackgroundRuns.operatorAvailable
        : Boolean(deps.listBackgroundRuns),
    inspectAvailable:
      typeof availability?.inspectAvailable === 'boolean'
        ? availability.inspectAvailable
        : typeof gatewayBackgroundRuns?.inspectAvailable === 'boolean'
          ? gatewayBackgroundRuns.inspectAvailable
        : Boolean(deps.inspectBackgroundRun),
    controlAvailable:
      typeof availability?.controlAvailable === 'boolean'
        ? availability.controlAvailable
        : typeof gatewayBackgroundRuns?.controlAvailable === 'boolean'
          ? gatewayBackgroundRuns.controlAvailable
        : Boolean(deps.controlBackgroundRun),
    disabledCode:
      typeof availability?.disabledCode === 'string'
        ? availability.disabledCode
        : typeof gatewayBackgroundRuns?.disabledCode === 'string'
          ? gatewayBackgroundRuns.disabledCode
        : undefined,
    disabledReason:
      typeof availability?.disabledReason === 'string'
        ? availability.disabledReason
        : typeof gatewayBackgroundRuns?.disabledReason === 'string'
          ? gatewayBackgroundRuns.disabledReason
        : undefined,
  };
}

async function handleMemorySearch(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  const query = payload?.query;
  if (!query || typeof query !== 'string') {
    send({ type: 'error', error: 'Missing query in payload', id });
    return;
  }
  if (!deps.memoryBackend) {
    send({ type: 'error', error: 'Memory backend not configured', id });
    return;
  }
  try {
    const sessions = request.listOwnedSessionIds();
    if (sessions.length === 0) {
      send({ type: 'memory.results', payload: [], id });
      return;
    }
    let entries: Array<{ content: string; timestamp: number; role: string }> = [];

    const lowerQuery = query.toLowerCase();
    for (const sid of sessions.slice(0, 20)) {
      const thread = await deps.memoryBackend.getThread(sid, 50);
      const sidMatches = sid.toLowerCase().includes(lowerQuery);
      if (sidMatches) {
        entries.push(
          ...thread.slice(-20).map((e) => ({ content: e.content, timestamp: e.timestamp, role: e.role })),
        );
        continue;
      }
      const matching = thread.filter((e) => e.content.toLowerCase().includes(lowerQuery));
      entries.push(
        ...matching.map((e) => ({ content: e.content, timestamp: e.timestamp, role: e.role })),
      );
    }

    // Sort by timestamp descending, limit to 50
    entries.sort((a, b) => b.timestamp - a.timestamp);
    entries = entries.slice(0, 50);

    send({ type: 'memory.results', payload: entries, id });
  } catch (err) {
    send({ type: 'error', error: `Memory search failed: ${(err as Error).message}`, id });
  }
}

async function handleMemorySessions(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.memoryBackend) {
    send({ type: 'error', error: 'Memory backend not configured', id });
    return;
  }
  try {
    const limit = typeof payload?.limit === 'number' ? payload.limit : 50;
    const results = await listOwnedMemorySessions(deps, request, { limit });
    send({ type: 'memory.sessions', payload: results, id });
  } catch (err) {
    send({ type: 'error', error: `Memory sessions failed: ${(err as Error).message}`, id });
  }
}

async function handleMaintenanceStatus(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  try {
    const recentLimit = typeof payload?.limit === 'number'
      ? Math.max(0, Math.min(50, Math.floor(payload.limit)))
      : 8;
    const sync = summarizeMaintenanceSync(deps, request);
    const memorySessions = deps.memoryBackend
      ? await listOwnedMemorySessions(deps, request)
      : [];
    const recentSessions = [...memorySessions]
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, recentLimit);
    send({
      type: 'maintenance.status',
      payload: {
        generatedAt: Date.now(),
        sync,
        memory: {
          backendConfigured: Boolean(deps.memoryBackend),
          sessionCount: memorySessions.length,
          totalMessages: memorySessions.reduce(
            (total, session) => total + session.messageCount,
            0,
          ),
          lastActiveAt: memorySessions.reduce(
            (latest, session) => Math.max(latest, session.lastActiveAt),
            0,
          ),
          recentSessions,
        },
      },
      id,
    });
  } catch (err) {
    send({
      type: 'error',
      error: `Maintenance status failed: ${(err as Error).message}`,
      id,
    });
  }
}

// ============================================================================
// Approval handlers
// ============================================================================

async function handleApprovalRespond(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  const requestId = payload?.requestId;
  const approved = payload?.approved;
  if (!requestId || typeof requestId !== 'string') {
    send({ type: 'error', error: 'Missing requestId in payload', id });
    return;
  }
  if (typeof approved !== 'boolean') {
    send({ type: 'error', error: 'Missing approved (boolean) in payload', id });
    return;
  }
  if (!deps.approvalEngine) {
    send({ type: 'error', error: 'Approval engine not configured', id });
    return;
  }
  const resolved = await deps.approvalEngine.resolve(requestId, {
    requestId,
    disposition: approved ? 'yes' : 'no',
    approvedBy: request.actorId,
    resolver: {
      actorId: request.actorId,
      sessionId: request.activeSessionId,
      channel: request.channel,
      resolvedAt: Date.now(),
    },
  });
  if (!resolved) {
    send({
      type: 'error',
      error: `Approval response rejected for request ${requestId}`,
      id,
    });
    return;
  }
  send({
    type: 'approval.respond',
    payload: { requestId, approved, acknowledged: true },
    id,
  });
}

async function handlePolicySimulate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.policyPreview) {
    send({ type: 'error', error: 'Policy simulation is not configured', id });
    return;
  }
  const toolName = typeof payload?.toolName === 'string' ? payload.toolName.trim() : '';
  if (!toolName) {
    send({ type: 'error', error: 'Missing toolName in payload', id });
    return;
  }
  const targetSessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : request.activeSessionId;
  if (!targetSessionId) {
    send({ type: 'error', error: 'No active session available for policy simulation', id });
    return;
  }
  if (!request.isSessionOwned(targetSessionId)) {
    send({ type: 'error', error: 'Session is not owned by the current web client', id });
    return;
  }
  const args =
    payload?.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {};
  const result = await deps.policyPreview({
    sessionId: targetSessionId,
    toolName,
    args,
  });
  send({
    type: 'policy.simulate',
    payload: result,
    id,
  });
}

// ============================================================================
// Agents handlers — on-chain registered agents
// ============================================================================

/**
 * Agent account discriminator (first 8 bytes).
 * The struct contains variable-length Borsh strings (endpoint, metadata_uri)
 * so we parse sequentially rather than using fixed offsets.
 */
const AGENT_ACCT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
/** Minimum byte length for an agent account (all variable-length strings empty). */
const AGENT_ACCT_MIN_LENGTH = 132;

/** Parse agent data from a raw Borsh-serialized account buffer. */
function parseRawAgentAccount(data: Buffer): {
  agentId: string;
  authority: string;
  capabilities: bigint;
  status: AgentStatus;
  reputation: number;
  tasksCompleted: bigint;
  stake: bigint;
  endpoint: string;
  metadataUri: string;
  registeredAt: bigint;
  lastActive: bigint;
  totalEarned: bigint;
  activeTasks: number;
} | null {
  if (data.length < AGENT_ACCT_MIN_LENGTH) {
    console.warn(`[parseRawAgentAccount] data too short: ${data.length} bytes (min ${AGENT_ACCT_MIN_LENGTH})`);
    return null;
  }
  let off = 8; // skip discriminator

  // agent_id: [u8; 32]
  const agentId = data.subarray(off, off + 32);
  off += 32;

  // authority: Pubkey (32 bytes)
  const authority = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  // capabilities: u64 LE
  const capabilities = data.readBigUInt64LE(off);
  off += 8;

  // status: u8 enum
  const status = data[off] as AgentStatus;
  off += 1;

  // endpoint: Borsh String (u32 len prefix + variable bytes)
  const endpointLen = data.readUInt32LE(off);
  off += 4;
  const endpoint = data.subarray(off, off + endpointLen).toString('utf8');
  off += endpointLen;

  // metadata_uri: Borsh String (u32 len prefix + variable bytes)
  const metadataUriLen = data.readUInt32LE(off);
  off += 4;
  const metadataUri = data.subarray(off, off + metadataUriLen).toString('utf8');
  off += metadataUriLen;

  // registered_at: i64
  const registeredAt = data.readBigInt64LE(off);
  off += 8;

  // last_active: i64
  const lastActive = data.readBigInt64LE(off);
  off += 8;

  // tasks_completed: u64
  const tasksCompleted = data.readBigUInt64LE(off);
  off += 8;

  // total_earned: u64
  const totalEarned = data.readBigUInt64LE(off);
  off += 8;

  // reputation: u16
  const reputation = data.readUInt16LE(off);
  off += 2;

  // active_tasks: u8
  const activeTasks = data[off];
  off += 1;

  // stake: u64
  const stake = data.readBigUInt64LE(off);

  return {
    agentId: Buffer.from(agentId).toString('hex').slice(0, 16),
    authority: authority.toBase58(),
    capabilities,
    status,
    reputation,
    tasksCompleted,
    stake,
    endpoint,
    metadataUri,
    registeredAt,
    lastActive,
    totalEarned,
    activeTasks,
  };
}

async function handleAgentsList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'agents.list', payload: [], id });
    return;
  }

  try {
    const bs58 = await import('bs58');
    const programId = new PublicKey(IDL.address!);

    // Fetch all agent registration accounts
    const accounts = await deps.connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_ACCT_DISCRIMINATOR) } },
      ],
    });

    const payload = accounts.map((acc) => {
      try {
        const agent = parseRawAgentAccount(acc.account.data as Buffer);
        if (!agent) return null;
        return {
          pda: acc.pubkey.toBase58(),
          agentId: agent.agentId,
          authority: agent.authority,
          capabilities: getCapabilityNames(agent.capabilities),
          status: agentStatusToString(agent.status),
          reputation: agent.reputation,
          tasksCompleted: Number(agent.tasksCompleted),
          stake: lamportsToSol(agent.stake),
          endpoint: agent.endpoint ? agent.endpoint : undefined,
          metadataUri: agent.metadataUri ? agent.metadataUri : undefined,
          registeredAt: agent.registeredAt ? Number(agent.registeredAt) : undefined,
          lastActive: agent.lastActive ? Number(agent.lastActive) : undefined,
          totalEarned: lamportsToSol(agent.totalEarned),
          activeTasks: agent.activeTasks,
        };
      } catch (err) {
        console.warn(
          `[handleAgentsList] failed to parse agent account ${acc.pubkey.toBase58()} (${acc.account.data.length} bytes): ${(err as Error).message}`,
        );
        return null;
      }
    }).filter((a): a is NonNullable<typeof a> => a !== null);

    send({ type: 'agents.list', payload, id });
  } catch (err) {
    send({ type: 'error', error: `Failed to list agents: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Desktop sandbox handlers
// ============================================================================

async function handleDesktopList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.list', payload: [], id });
    return;
  }
  await safeAsync(send, id, 'desktop.error', 'Failed to list sandboxes', async () => {
    const ownedSessions = request.listOwnedSessionIds();
    const maxEntries = typeof payload?.limit === 'number' ? payload.limit : 50;
    const seen = new Set<string>();
    const sandboxes = [];
    for (const sessionId of ownedSessions) {
      const handle = deps.desktopManager!.getHandleBySession(sessionId);
      if (!handle || seen.has(handle.containerId)) continue;
      seen.add(handle.containerId);
      sandboxes.push({
        containerId: handle.containerId,
        sessionId: handle.sessionId,
        status: handle.status,
        createdAt: handle.createdAt,
        lastActivityAt: handle.lastActivityAt,
        vncUrl: `http://localhost:${handle.vncHostPort}/vnc.html`,
        uptimeMs: Date.now() - handle.createdAt,
        maxMemory: handle.maxMemory,
        maxCpu: handle.maxCpu,
      });
      if (sandboxes.length >= maxEntries) break;
    }
    send({ type: 'desktop.list', payload: sandboxes, id });
  });
}

async function handleDesktopCreate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.error', error: 'Desktop sandbox manager not available — enable desktop in config', id });
    return;
  }
  const requestedSessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (requestedSessionId && !request.isSessionOwned(requestedSessionId)) {
    send({ type: 'desktop.error', error: 'Not authorized for target session', id });
    return;
  }
  const sessionId = requestedSessionId ?? request.activeSessionId;
  if (!sessionId) {
    send({ type: 'desktop.error', error: 'Missing sessionId in payload', id });
    return;
  }
  const parsedMemory = parseDesktopResourceOverride(payload?.maxMemory, 'maxMemory');
  if (parsedMemory.error) {
    send({ type: 'desktop.error', error: parsedMemory.error, id });
    return;
  }
  const parsedCpu = parseDesktopResourceOverride(payload?.maxCpu, 'maxCpu');
  if (parsedCpu.error) {
    send({ type: 'desktop.error', error: parsedCpu.error, id });
    return;
  }

  await safeAsync(send, id, 'desktop.error', 'Failed to create sandbox', async () => {
    const handle = await deps.desktopManager!.getOrCreate(sessionId, {
      maxMemory: parsedMemory.value,
      maxCpu: parsedCpu.value,
    });
    send({
      type: 'desktop.created',
      payload: {
        containerId: handle.containerId,
        sessionId: handle.sessionId,
        status: handle.status,
        vncUrl: `http://localhost:${handle.vncHostPort}/vnc.html`,
        apiPort: handle.apiHostPort,
        vncPort: handle.vncHostPort,
        createdAt: handle.createdAt,
        maxMemory: handle.maxMemory,
        maxCpu: handle.maxCpu,
      },
      id,
    });
  });
}

async function handleDesktopAttach(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.error', error: 'Desktop sandbox manager not available — enable desktop in config', id });
    return;
  }
  const containerId = payload?.containerId;
  if (!containerId || typeof containerId !== 'string') {
    send({ type: 'desktop.error', error: 'Missing containerId in payload', id });
    return;
  }
  const sessionId = payload?.sessionId;
  if (!sessionId || typeof sessionId !== 'string') {
    send({ type: 'desktop.error', error: 'Missing sessionId in payload', id });
    return;
  }
  if (!request.isSessionOwned(sessionId)) {
    send({ type: 'desktop.error', error: 'Not authorized for target session', id });
    return;
  }
  const ownsContainer = request
    .listOwnedSessionIds()
    .some((sid) => deps.desktopManager!.getHandleBySession(sid)?.containerId === containerId);
  if (!ownsContainer) {
    send({ type: 'desktop.error', error: 'Not authorized for target container', id });
    return;
  }

  await safeAsync(send, id, 'desktop.error', 'Failed to attach sandbox', async () => {
    deps.onDesktopSessionRebound?.(sessionId);
    const handle = deps.desktopManager!.assignSession(containerId, sessionId);
    send({
      type: 'desktop.attached',
      payload: {
        containerId: handle.containerId,
        sessionId,
        status: handle.status,
        vncUrl: `http://localhost:${handle.vncHostPort}/vnc.html`,
      },
      id,
    });
  });
}

async function handleDesktopDestroy(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.error', error: 'Desktop sandbox manager not available — enable desktop in config', id });
    return;
  }
  const containerId = payload?.containerId;
  if (!containerId || typeof containerId !== 'string') {
    send({ type: 'desktop.error', error: 'Missing containerId in payload', id });
    return;
  }
  const ownsContainer = request
    .listOwnedSessionIds()
    .some((sid) => deps.desktopManager!.getHandleBySession(sid)?.containerId === containerId);
  if (!ownsContainer) {
    send({ type: 'desktop.error', error: 'Not authorized for target container', id });
    return;
  }
  await safeAsync(send, id, 'desktop.error', 'Failed to destroy sandbox', async () => {
    await deps.desktopManager!.destroy(containerId);
    send({ type: 'desktop.destroyed', payload: { containerId }, id });
  });
}

function resolveOwnedRunSessionId(
  payload: Record<string, unknown> | undefined,
  request: HandlerRequestContext,
): string | undefined {
  const explicit =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (explicit) {
    return request.isSessionOwned(explicit) ? explicit : undefined;
  }
  return request.activeSessionId && request.isSessionOwned(request.activeSessionId)
    ? request.activeSessionId
    : undefined;
}

function buildBackgroundRunErrorPayload(
  deps: WebChatDeps,
  code: BackgroundRunOperatorErrorPayload['code'],
  sessionId?: string,
): BackgroundRunOperatorErrorPayload {
  const availability = deps.getBackgroundRunAvailability?.(sessionId);
  return availability
    ? { code, sessionId, backgroundRunAvailability: availability }
    : { code, sessionId };
}

async function handleRunsList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.listBackgroundRuns) {
    send({
      type: 'error',
      error: 'Durable background run operator is not available for this runtime.',
      payload: buildBackgroundRunErrorPayload(
        deps,
        'background_run_unavailable',
      ),
      id,
    });
    return;
  }
  const explicitSessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (explicitSessionId && !request.isSessionOwned(explicitSessionId)) {
    send({ type: 'error', error: 'Not authorized for target run session', id });
    return;
  }
  const sessionIds = explicitSessionId
    ? [explicitSessionId]
    : request.listOwnedSessionIds();
  await safeAsync(send, id, 'error', 'Failed to list background runs', async () => {
    const runs = await deps.listBackgroundRuns!(sessionIds);
    send({ type: 'runs.list', payload: runs, id });
  });
}

async function handleRunInspect(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  const sessionId = resolveOwnedRunSessionId(payload, request);
  if (!sessionId) {
    send({ type: 'error', error: 'Missing or unauthorized run sessionId', id });
    return;
  }
  const availability = deps.getBackgroundRunAvailability?.(sessionId);
  if (!deps.inspectBackgroundRun || availability?.inspectAvailable === false) {
    send({
      type: 'error',
      error:
        availability?.disabledReason ??
        'Durable background run inspection is not available for this runtime.',
      payload: buildBackgroundRunErrorPayload(
        deps,
        'background_run_unavailable',
        sessionId,
      ),
      id,
    });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to inspect background run', async () => {
    const detail = await deps.inspectBackgroundRun!(sessionId);
    if (!detail) {
      send({
        type: 'error',
        error: `No active durable background run for session "${sessionId}"`,
        payload: buildBackgroundRunErrorPayload(
          deps,
          'background_run_missing',
          sessionId,
        ),
        id,
      });
      return;
    }
    send({ type: 'run.inspect', payload: detail, id });
  });
}

async function handleRunControl(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!payload || typeof payload !== 'object') {
    send({ type: 'error', error: 'Missing run control payload', id });
    return;
  }
  const sessionId =
    typeof payload.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : request.activeSessionId;
  if (!sessionId || !request.isSessionOwned(sessionId)) {
    send({ type: 'error', error: 'Missing or unauthorized run sessionId', id });
    return;
  }
  const availability = deps.getBackgroundRunAvailability?.(sessionId);
  if (!deps.controlBackgroundRun || availability?.controlAvailable === false) {
    send({
      type: 'error',
      error:
        availability?.disabledReason ??
        'Durable background run controls are not available for this runtime.',
      payload: buildBackgroundRunErrorPayload(
        deps,
        'background_run_unavailable',
        sessionId,
      ),
      id,
    });
    return;
  }
  const action = {
    ...payload,
    sessionId,
  } as BackgroundRunControlAction;
  await safeAsync(send, id, 'error', 'Failed to control background run', async () => {
    const detail = await deps.controlBackgroundRun!({
      action,
      actor: request.actorId,
      channel: request.channel,
    });
    if (!detail) {
      send({
        type: 'error',
        error: `No active durable background run for session "${sessionId}"`,
        payload: buildBackgroundRunErrorPayload(
          deps,
          'background_run_missing',
          sessionId,
        ),
        id,
      });
      return;
    }
    send({ type: 'run.updated', payload: detail, id });
  });
}

async function handleObservabilitySummary(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  _request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilitySummary) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const windowMs =
    typeof payload?.windowMs === 'number' && Number.isFinite(payload.windowMs)
      ? payload.windowMs
      : undefined;
  await safeAsync(send, id, 'error', 'Failed to load observability summary', async () => {
    const summary = await deps.getObservabilitySummary!({
      windowMs,
    });
    if (!summary) {
      send({ type: 'error', error: 'Observability summary unavailable', id });
      return;
    }
    send({ type: 'observability.summary', payload: summary, id });
  });
}

async function handleObservabilityTraces(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  _request: HandlerRequestContext,
): Promise<void> {
  if (!deps.listObservabilityTraces) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const sessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  await safeAsync(send, id, 'error', 'Failed to list observability traces', async () => {
    const traces = await deps.listObservabilityTraces!({
      limit:
        typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? payload.limit
          : undefined,
      offset:
        typeof payload?.offset === 'number' && Number.isFinite(payload.offset)
          ? payload.offset
          : undefined,
      search: typeof payload?.search === 'string' ? payload.search : undefined,
      status:
        payload?.status === 'open' ||
        payload?.status === 'completed' ||
        payload?.status === 'error' ||
        payload?.status === 'all'
          ? payload.status
          : undefined,
      sessionId,
    });
    send({ type: 'observability.traces', payload: traces ?? [], id });
  });
}

async function handleObservabilityTrace(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  _request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilityTrace) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId.trim() : '';
  if (!traceId) {
    send({ type: 'error', error: 'Missing traceId in payload', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to inspect observability trace', async () => {
    const detail = await deps.getObservabilityTrace!(traceId);
    if (!detail) {
      send({ type: 'error', error: `Observability trace "${traceId}" not found`, id });
      return;
    }
    send({ type: 'observability.trace', payload: detail, id });
  });
}

async function handleObservabilityArtifact(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  _request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilityArtifact || !deps.getObservabilityTrace) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId.trim() : '';
  const path = typeof payload?.path === 'string' ? payload.path.trim() : '';
  if (!traceId || !path) {
    send({ type: 'error', error: 'Missing traceId or path in payload', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to read trace artifact', async () => {
    const detail = await deps.getObservabilityTrace!(traceId);
    if (!detail) {
      send({ type: 'error', error: `Observability trace "${traceId}" not found`, id });
      return;
    }
    const allowed = detail.events.some((event) => event.artifact?.path === path);
    if (!allowed) {
      send({ type: 'error', error: 'Artifact does not belong to the requested trace', id });
      return;
    }
    const artifact = await deps.getObservabilityArtifact!(path);
    if (!artifact) {
      send({ type: 'error', error: `Trace artifact "${path}" not found`, id });
      return;
    }
    send({ type: 'observability.artifact', payload: artifact, id });
  });
}

async function handleObservabilityLogs(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  _request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilityLogTail || !deps.getObservabilityTrace) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId.trim() : '';
  if (!traceId) {
    send({ type: 'error', error: 'Missing traceId in payload', id });
    return;
  }
  const detail = await deps.getObservabilityTrace(traceId);
  if (!detail) {
    send({ type: 'error', error: `Observability trace "${traceId}" not found`, id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to read daemon logs', async () => {
    const logs = await deps.getObservabilityLogTail!({
      lines:
        typeof payload?.lines === 'number' && Number.isFinite(payload.lines)
          ? payload.lines
          : undefined,
      traceId,
    });
    if (!logs) {
      send({ type: 'error', error: 'Daemon logs unavailable', id });
      return;
    }
    send({ type: 'observability.logs', payload: logs, id });
  });
}

// ============================================================================
// Shared handler utilities
// ============================================================================

/** Wrap an async handler body in try/catch with consistent error response. */
async function safeAsync(
  send: SendFn,
  id: string | undefined,
  errorType: string,
  errorPrefix: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    send({ type: errorType, error: `${errorPrefix}: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Handler map
// ============================================================================

type HandlerFn = (
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
) => void | Promise<void>;

/** Map of dotted-namespace message types to their handler functions. */
export const HANDLER_MAP: Readonly<Record<string, HandlerFn>> = {
  'status.get': handleStatusGet,
  'skills.list': handleSkillsList,
  'skills.toggle': handleSkillsToggle,
  'tools.list': handleToolsList,
  'hooks.list': handleHooksList,
  'tools.toggle': handleToolsToggle,
  'market.skills.list': handleMarketSkillsList,
  'market.skills.detail': handleMarketSkillsDetail,
  'market.skills.purchase': handleMarketSkillsPurchase,
  'market.skills.rate': handleMarketSkillsRate,
  'market.governance.list': handleMarketGovernanceList,
  'market.governance.detail': handleMarketGovernanceDetail,
  'market.governance.vote': handleMarketGovernanceVote,
  'market.disputes.list': handleMarketDisputesList,
  'market.disputes.detail': handleMarketDisputesDetail,
  'market.reputation.summary': handleMarketReputationSummary,
  'market.reputation.stake': handleMarketReputationStake,
  'market.reputation.delegate': handleMarketReputationDelegate,
  'tasks.list': handleTasksList,
  'tasks.create': handleTasksCreate,
  'tasks.claim': handleTasksClaim,
  'tasks.complete': handleTasksComplete,
  'tasks.dispute': handleTasksDispute,
  'tasks.cancel': handleTasksCancel,
  'memory.search': handleMemorySearch,
  'memory.sessions': handleMemorySessions,
  'maintenance.status': handleMaintenanceStatus,
  'approval.respond': handleApprovalRespond,
  'policy.simulate': handlePolicySimulate,
  'runs.list': handleRunsList,
  'run.inspect': handleRunInspect,
  'run.control': handleRunControl,
  'observability.summary': handleObservabilitySummary,
  'observability.traces': handleObservabilityTraces,
  'observability.trace': handleObservabilityTrace,
  'observability.artifact': handleObservabilityArtifact,
  'observability.logs': handleObservabilityLogs,
  'agents.list': handleAgentsList,
  'desktop.list': handleDesktopList,
  'desktop.create': handleDesktopCreate,
  'desktop.attach': handleDesktopAttach,
  'desktop.destroy': handleDesktopDestroy,
};
