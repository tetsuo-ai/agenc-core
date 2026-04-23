import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnchorProvider, type Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { parseAgentState } from "../agent/types.js";
import { findProtocolPda } from "../agent/pda.js";
import { DisputeOperations } from "../dispute/operations.js";
import { GovernanceOperations } from "../governance/operations.js";
import {
  createProgram,
  createReadOnlyProgram,
  type AgencCoordination,
} from "../idl.js";
import {
  buildMarketplaceReputationSummaryForAgent,
  buildMarketplaceUnregisteredSummary,
  serializeMarketplaceDisputeDetail,
  serializeMarketplaceDisputeSummary,
  serializeMarketplaceProposalDetail,
  serializeMarketplaceProposalSummary,
  serializeMarketplaceSkill,
  serializeMarketplaceTask,
  serializeMarketplaceTaskEntry,
} from "../marketplace/serialization.js";
import {
  isMarketplaceJobSpecTaskLinkNotFoundError,
  readMarketplaceJobSpecPointerForTask,
  resolveMarketplaceJobSpecForTask,
  type MarketplaceJobSpecStoreOptions,
  type MarketplaceJobSpecTaskPointer,
  type ResolvedMarketplaceJobSpec,
} from "../marketplace/job-spec-store.js";
import {
  resolveOnChainTaskJobSpecForTask,
  type ResolvedOnChainTaskJobSpec,
} from "../marketplace/task-job-spec.js";
import {
  buildMarketplaceInspectOverview,
  buildMarketplaceInspectSurface,
  buildMarketplaceReputationInspectPlaceholder,
  resolveMarketplaceInspectSurface,
} from "../marketplace/surfaces.mjs";
import { OnChainSkillRegistryClient } from "../skills/registry/client.js";
import { SkillPurchaseManager } from "../skills/registry/payment.js";
import { TaskOperations } from "../task/operations.js";
import { findEscrowPda } from "../task/pda.js";
import { parseTaskTypeAlias } from "../task/types.js";
import {
  loadKeypairFromFile,
  keypairToWallet,
  getDefaultKeypairPath,
} from "../types/wallet.js";
import {
  createClaimTaskTool,
  createCompleteTaskTool,
  createDelegateReputationTool,
  createInitiateDisputeTool,
  createRateSkillTool,
  createResolveDisputeTool,
  createStakeReputationTool,
  createVoteProposalTool,
} from "../tools/agenc/mutation-tools.js";
import { createCreateTaskTool } from "../tools/agenc/tools.js";
import type { ToolResult } from "../tools/types.js";
import { silentLogger } from "../utils/logger.js";
import type { BaseCliOptions, CliRuntimeContext, CliStatusCode } from "./types.js";

export interface MarketTasksListOptions extends BaseCliOptions {
  statuses?: string[];
  taskType?: string;
  jobSpecStoreDir?: string;
}

export interface MarketTaskCreateOptions extends BaseCliOptions {
  description: string;
  reward: string;
  requiredCapabilities: string;
  rewardMint?: string;
  maxWorkers?: number;
  deadline?: number;
  taskType?: string;
  minReputation?: number;
  constraintHash?: string;
  validationMode?: string;
  reviewWindowSecs?: number;
  creatorAgentPda?: string;
  jobSpec?: unknown;
  jobSpecPublishUri?: string;
  fullDescription?: string;
  acceptanceCriteria?: string[];
  deliverables?: string[];
  constraints?: unknown;
  attachments?: unknown;
  jobSpecStoreDir?: string;
}

export interface MarketTaskDetailOptions extends BaseCliOptions {
  taskPda: string;
  jobSpecStoreDir?: string;
  allowRemoteJobSpecResolution?: boolean;
}

export interface MarketTaskCancelOptions extends MarketTaskDetailOptions {}

export interface MarketTaskClaimOptions extends MarketTaskDetailOptions {
  workerAgentPda?: string;
}

export interface MarketTaskCompleteOptions extends MarketTaskDetailOptions {
  proofHash?: string;
  resultData?: string;
  workerAgentPda?: string;
}

export interface MarketTaskAcceptOptions extends MarketTaskDetailOptions {
  workerAgentPda?: string;
}

export interface MarketTaskRejectOptions extends MarketTaskDetailOptions {
  workerAgentPda?: string;
  reason: string;
}

export interface MarketTaskDisputeOptions extends MarketTaskDetailOptions {
  evidence: string;
  resolutionType?: string;
  workerAgentPda?: string;
  workerClaimPda?: string;
  initiatorAgentPda?: string;
}

export interface MarketSkillsListOptions extends BaseCliOptions {
  query?: string;
  tags?: string[];
  limit?: number;
}

export interface MarketSkillDetailOptions extends BaseCliOptions {
  skillPda: string;
}

export interface MarketSkillPurchaseOptions extends MarketSkillDetailOptions {
  expectedPrice?: string;
  buyerAgentPda?: string;
}

export interface MarketSkillRateOptions extends MarketSkillDetailOptions {
  rating: number;
  review?: string;
  raterAgentPda?: string;
}

export interface MarketGovernanceListOptions extends BaseCliOptions {}

export interface MarketGovernanceDetailOptions extends BaseCliOptions {
  proposalPda: string;
}

export interface MarketGovernanceVoteOptions extends MarketGovernanceDetailOptions {
  approve: boolean;
  voterAgentPda?: string;
}

export interface MarketDisputesListOptions extends BaseCliOptions {
  statuses?: string[];
}

export interface MarketDisputeDetailOptions extends BaseCliOptions {
  disputePda: string;
}

export interface MarketDisputeResolveOptions extends MarketDisputeDetailOptions {
  arbiterVotes: Array<{ votePda: string; arbiterAgentPda: string }>;
  extraWorkers?: Array<{ claimPda: string; workerPda: string }>;
}

export interface MarketReputationSummaryOptions extends BaseCliOptions {
  agentPda?: string;
}

export interface MarketReputationStakeOptions extends BaseCliOptions {
  amount: string;
  stakerAgentPda?: string;
}

export interface MarketReputationDelegateOptions extends BaseCliOptions {
  amount: number;
  delegateeAgentPda?: string;
  delegateeAgentId?: string;
  expiresAt?: number;
  delegatorAgentPda?: string;
}

export interface MarketInspectOptions extends BaseCliOptions {
  surface: string;
  subject?: string;
  statuses?: string[];
  query?: string;
  tags?: string[];
  limit?: number;
}

export type MarketCommandOptions =
  | MarketTasksListOptions
  | MarketTaskCreateOptions
  | MarketTaskDetailOptions
  | MarketTaskCancelOptions
  | MarketTaskClaimOptions
  | MarketTaskCompleteOptions
  | MarketTaskAcceptOptions
  | MarketTaskRejectOptions
  | MarketTaskDisputeOptions
  | MarketSkillsListOptions
  | MarketSkillDetailOptions
  | MarketSkillPurchaseOptions
  | MarketSkillRateOptions
  | MarketGovernanceListOptions
  | MarketGovernanceDetailOptions
  | MarketGovernanceVoteOptions
  | MarketDisputesListOptions
  | MarketDisputeDetailOptions
  | MarketDisputeResolveOptions
  | MarketReputationSummaryOptions
  | MarketReputationStakeOptions
  | MarketReputationDelegateOptions
  | MarketInspectOptions;

type MarketProgram = Program<AgencCoordination>;

interface MarketProgramContext {
  connection: Connection;
  program: MarketProgram;
}

interface MarketplaceCliProgramContextOverrides {
  createReadOnlyProgramContext?: (
    options: BaseCliOptions,
  ) => Promise<MarketProgramContext>;
  createSignerProgramContext?: (
    options: BaseCliOptions,
  ) => Promise<MarketProgramContext>;
}

let marketplaceCliProgramContextOverrides:
  | MarketplaceCliProgramContextOverrides
  | null = null;

/**
 * Internal test seam for driving marketplace commands against LiteSVM-backed
 * program contexts without standing up an RPC server.
 */
export function setMarketplaceCliProgramContextOverrides(
  overrides: MarketplaceCliProgramContextOverrides | null,
): void {
  marketplaceCliProgramContextOverrides = overrides;
}

export function resetMarketplaceCliProgramContextOverrides(): void {
  marketplaceCliProgramContextOverrides = null;
}

const SOLANA_RPC_REQUIRED =
  "RPC URL is required for marketplace commands. Use --rpc <url> or configure it in the runtime config.";

const AGENT_ACCT_DISCRIMINATOR = Buffer.from([
  130, 53, 100, 103, 121, 77, 148, 19,
]);
const AGENT_ID_OFFSET = 8;
const AGENT_AUTHORITY_OFFSET = 40;
const ZERO_AGENT_ID = new Uint8Array(32);

interface SignerAgentChoice {
  registered: true;
  authority: string;
  agentPda: string;
  agentId: string;
}

class MultipleSignerAgentsError extends Error {
  readonly code = "MULTIPLE_AGENT_REGISTRATIONS";
  readonly authority: string;
  readonly agents: SignerAgentChoice[];

  constructor(authority: PublicKey, agents: SignerAgentChoice[]) {
    super(
      "Multiple agent registrations found for signer wallet. Provide agentPda with one of the listed agentPda values.",
    );
    this.name = "MultipleSignerAgentsError";
    this.authority = authority.toBase58();
    this.agents = agents;
  }
}

function signerAgentChoicesFromMatches(
  authority: PublicKey,
  matches: ReadonlyArray<{ pubkey: PublicKey; account: { data: Uint8Array } }>,
): SignerAgentChoice[] {
  return matches
    .map((match) => ({
      registered: true as const,
      authority: authority.toBase58(),
      agentPda: match.pubkey.toBase58(),
      agentId: Buffer.from(match.account.data.subarray(AGENT_ID_OFFSET, AGENT_AUTHORITY_OFFSET)).toString("hex"),
    }))
    .sort((left, right) => left.agentPda.localeCompare(right.agentPda));
}

function parseToolError(result: ToolResult): string {
  if (!result.isError) return "Unknown tool failure";
  try {
    const parsed = JSON.parse(result.content) as { error?: string };
    return parsed.error ?? result.content;
  } catch {
    return result.content;
  }
}

function parseToolPayload(result: ToolResult): unknown {
  try {
    return JSON.parse(result.content);
  } catch {
    return { raw: result.content };
  }
}

function requireRpcUrl(
  context: CliRuntimeContext,
  options: BaseCliOptions,
): string | null {
  if (options.rpcUrl) {
    return options.rpcUrl;
  }

  context.error({
    status: "error",
    code: "RPC_NOT_CONFIGURED",
    message: SOLANA_RPC_REQUIRED,
  });
  return null;
}

function parseProgramId(programId?: string): PublicKey | undefined {
  if (!programId) return undefined;
  return new PublicKey(programId);
}

function createWalletProvider(
  connection: Connection,
  keypair: Awaited<ReturnType<typeof loadKeypairFromFile>>,
): AnchorProvider {
  return new AnchorProvider(connection, keypairToWallet(keypair), {
    commitment: "confirmed",
  });
}

async function createReadOnlyProgramContext(options: BaseCliOptions): Promise<{
  connection: Connection;
  program: MarketProgram;
}> {
  if (marketplaceCliProgramContextOverrides?.createReadOnlyProgramContext) {
    return marketplaceCliProgramContextOverrides.createReadOnlyProgramContext(
      options,
    );
  }
  const rpcUrl = options.rpcUrl!;
  const connection = new Connection(rpcUrl);
  const programId = parseProgramId(options.programId);
  return {
    connection,
    program: createReadOnlyProgram(connection, programId),
  };
}

async function createSignerProgramContext(options: BaseCliOptions): Promise<{
  connection: Connection;
  program: MarketProgram;
}> {
  if (marketplaceCliProgramContextOverrides?.createSignerProgramContext) {
    return marketplaceCliProgramContextOverrides.createSignerProgramContext(
      options,
    );
  }
  const rpcUrl = options.rpcUrl!;
  const connection = new Connection(rpcUrl);
  const programId = parseProgramId(options.programId);
  const keypairPath =
    options.keypairPath ??
    process.env.SOLANA_KEYPAIR_PATH ??
    getDefaultKeypairPath();
  const keypair = await loadKeypairFromFile(keypairPath);
  const provider = createWalletProvider(connection, keypair);
  return {
    connection,
    program: createProgram(provider, programId),
  };
}

async function resolveSignerAgent(
  program: ReturnType<typeof createProgram>,
  explicitAgentPda?: string,
): Promise<{
  agentPda: PublicKey;
  agentId: Uint8Array;
  authority: PublicKey;
}> {
  const authority = program.provider.publicKey;
  if (!authority) {
    throw new Error("Signer-backed program context required");
  }

  if (explicitAgentPda) {
    const agentPda = new PublicKey(explicitAgentPda);
    const raw = await (program.account as any).agentRegistration.fetch(agentPda);
    const agent = parseAgentState(raw as Record<string, unknown>);
    if (!agent.authority.equals(authority)) {
      throw new Error(
        `Agent ${explicitAgentPda} does not belong to the connected signer`,
      );
    }
    return {
      agentPda,
      agentId: agent.agentId,
      authority,
    };
  }

  const bs58 = await import("bs58");
  const matches = await program.provider.connection.getProgramAccounts(
    program.programId,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58.default.encode(AGENT_ACCT_DISCRIMINATOR),
          },
        },
        { memcmp: { offset: AGENT_AUTHORITY_OFFSET, bytes: authority.toBase58() } },
      ],
    },
  );

  if (matches.length === 0) {
    throw new Error("No agent registration found for signer wallet");
  }
  if (matches.length > 1) {
    throw new MultipleSignerAgentsError(authority, signerAgentChoicesFromMatches(authority, matches));
  }

  const raw = await (program.account as any).agentRegistration.fetch(
    matches[0]!.pubkey,
  );
  const agent = parseAgentState(raw as Record<string, unknown>);
  return {
    agentPda: matches[0]!.pubkey,
    agentId: agent.agentId,
    authority,
  };
}

function mapTaskSummary(
  entry: Awaited<ReturnType<TaskOperations["fetchAllTasks"]>>[number],
) {
  const task = serializeMarketplaceTaskEntry(entry);
  return {
    taskPda: task.taskPda,
    taskId: task.taskId,
    status: task.status,
    description: task.description,
    creator: task.creator,
    rewardLamports: task.rewardLamports,
    rewardSol: task.rewardSol,
    rewardMint: task.rewardMint,
    taskType: task.taskType,
    taskTypeId: task.taskTypeId,
    taskTypeName: task.taskTypeName,
    taskTypeKey: task.taskTypeKey,
    currentWorkers: task.currentWorkers,
    maxWorkers: task.maxWorkers,
    deadline: task.deadline,
    createdAt: task.createdAt,
  };
}

function mapTaskDetail(taskPda: PublicKey, task: Awaited<ReturnType<TaskOperations["fetchTask"]>>) {
  if (!task) return null;
  return serializeMarketplaceTask(taskPda, task);
}

type SerializedJobSpecPointer =
  | {
      available: true;
      jobSpecHash: string;
      jobSpecUri: string;
      jobSpecTaskLinkPath: string;
      transactionSignature: string;
    }
  | { available: false; error?: string };

type SerializedResolvedJobSpec = {
  available: true;
  jobSpecHash: string;
  jobSpecUri: string;
  jobSpecPath: string;
  jobSpecTaskLinkPath: string | null;
  transactionSignature: string | null;
  integrity: ResolvedMarketplaceJobSpec["integrity"];
  payload: ResolvedMarketplaceJobSpec["payload"];
};

function getJobSpecStoreOptions(
  rootDir?: string,
  allowRemoteJobSpecResolution = false,
): MarketplaceJobSpecStoreOptions {
  return {
    ...(rootDir ? { rootDir } : {}),
    ...(allowRemoteJobSpecResolution ? { allowRemote: true } : {}),
  };
}

function serializeJobSpecPointer(
  pointer: MarketplaceJobSpecTaskPointer,
): SerializedJobSpecPointer {
  return {
    available: true,
    jobSpecHash: pointer.jobSpecHash,
    jobSpecUri: pointer.jobSpecUri,
    jobSpecTaskLinkPath: pointer.jobSpecTaskLinkPath,
    transactionSignature: pointer.transactionSignature,
  };
}

function serializeResolvedJobSpec(
  spec: ResolvedMarketplaceJobSpec,
): SerializedResolvedJobSpec {
  return {
    available: true,
    jobSpecHash: spec.jobSpecHash,
    jobSpecUri: spec.jobSpecUri,
    jobSpecPath: spec.jobSpecPath,
    jobSpecTaskLinkPath: spec.jobSpecTaskLinkPath,
    transactionSignature: spec.transactionSignature,
    integrity: spec.integrity,
    payload: spec.payload,
  };
}

function serializeResolvedOnChainJobSpec(
  spec: ResolvedOnChainTaskJobSpec,
  localPointer?: MarketplaceJobSpecTaskPointer | null,
): SerializedResolvedJobSpec {
  return {
    available: true,
    jobSpecHash: spec.jobSpecHash,
    jobSpecUri: spec.jobSpecUri,
    jobSpecPath: spec.jobSpecPath,
    jobSpecTaskLinkPath: localPointer?.jobSpecTaskLinkPath ?? null,
    transactionSignature: localPointer?.transactionSignature ?? null,
    integrity: spec.integrity,
    payload: spec.payload,
  };
}

async function enrichTaskSummaryWithJobSpec<T extends { taskPda: string }>(
  task: T,
  rootDir?: string,
): Promise<T & { jobSpec: SerializedJobSpecPointer }> {
  try {
    const pointer = await readMarketplaceJobSpecPointerForTask(
      task.taskPda,
      getJobSpecStoreOptions(rootDir),
    );
    return {
      ...task,
      jobSpec: pointer ? serializeJobSpecPointer(pointer) : { available: false },
    };
  } catch (error) {
    return {
      ...task,
      jobSpec: {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function enrichTaskDetailWithJobSpec<T extends { taskPda: string }>(
  task: T,
  rootDir?: string,
  program?: MarketProgram,
  allowRemoteJobSpecResolution = false,
): Promise<T & { jobSpec: SerializedResolvedJobSpec | null }> {
  const storeOptions = getJobSpecStoreOptions(rootDir, allowRemoteJobSpecResolution);
  if (program) {
    const taskPda = new PublicKey(task.taskPda);
    const onChainSpec = await resolveOnChainTaskJobSpecForTask(
      program,
      taskPda,
      storeOptions,
    );
    if (onChainSpec) {
      let localPointer: MarketplaceJobSpecTaskPointer | null = null;
      try {
        localPointer = await readMarketplaceJobSpecPointerForTask(
          task.taskPda,
          storeOptions,
        );
      } catch (error) {
        if (!isMarketplaceJobSpecTaskLinkNotFoundError(error)) throw error;
      }
      return {
        ...task,
        jobSpec: serializeResolvedOnChainJobSpec(onChainSpec, localPointer),
      };
    }
  }

  try {
    const spec = await resolveMarketplaceJobSpecForTask(
      task.taskPda,
      storeOptions,
    );
    return { ...task, jobSpec: serializeResolvedJobSpec(spec) };
  } catch (error) {
    if (isMarketplaceJobSpecTaskLinkNotFoundError(error)) {
      return { ...task, jobSpec: null };
    }
    throw error;
  }
}

function mapSkillSummary(entry: {
  publicKey: PublicKey;
  account: Record<string, unknown>;
}) {
  return serializeMarketplaceSkill(entry);
}

function mapProposalSummary(
  entry: Awaited<ReturnType<GovernanceOperations["fetchAllProposals"]>>[number],
) {
  return serializeMarketplaceProposalSummary(entry);
}

function mapDisputeSummary(
  entry: Awaited<ReturnType<DisputeOperations["fetchAllDisputes"]>>[number],
) {
  return serializeMarketplaceDisputeSummary(entry);
}

function normalizeStatusFilter(values?: string[]): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function filterByStatus<T extends { status: string }>(
  items: T[],
  statuses?: string[],
): T[] {
  const filter = normalizeStatusFilter(statuses);
  if (!filter) return items;
  return items.filter((item) => filter.has(item.status));
}

function parseTaskTypeFilter(input?: string): number | undefined {
  if (!input) return undefined;
  const parsed = parseTaskTypeAlias(input);
  if (parsed === null) {
    throw new Error(
      'taskType must be one of 0/exclusive, 1/collaborative, 2/competitive, or 3/bid-exclusive',
    );
  }
  return parsed;
}

function filterInspectItemsByStatus(
  items: Record<string, unknown>[],
  statuses?: string[],
): Record<string, unknown>[] {
  const filter = normalizeStatusFilter(statuses);
  if (!filter) return items;
  return items.filter((item) =>
    filter.has(String(item.status ?? "").trim().toLowerCase()),
  );
}

type CapturedCliPayload = Record<string, unknown> | null;

function asCapturedCliPayload(value: unknown): CapturedCliPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCapturedArray(
  payload: CapturedCliPayload,
  key: string,
): Record<string, unknown>[] {
  const value = payload?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function readCapturedObject(
  payload: CapturedCliPayload,
  key: string,
): Record<string, unknown> | null {
  const value = payload?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCapturedCount(
  payload: CapturedCliPayload,
  fallbackCount: number,
): number {
  const numeric = Number(payload?.count);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallbackCount;
}

async function captureMarketplaceCommand<TOptions extends BaseCliOptions>(
  context: CliRuntimeContext,
  runner: (
    context: CliRuntimeContext,
    options: TOptions,
  ) => Promise<CliStatusCode>,
  options: TOptions,
): Promise<{
  code: CliStatusCode;
  output: CapturedCliPayload;
  error?: unknown;
}> {
  let output: unknown;
  let error: unknown;
  const captureContext: CliRuntimeContext = {
    logger: context.logger,
    outputFormat: "json",
    output(value) {
      output = value;
    },
    error(value) {
      error = value;
    },
  };
  const code = await runner(captureContext, options);
  return {
    code,
    output: asCapturedCliPayload(output),
    error,
  };
}

function forwardMarketplaceInspectFailure(
  context: CliRuntimeContext,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error !== undefined) {
    context.error(error);
    return;
  }
  context.error({
    status: "error",
    code: "MARKET_INSPECT_FAILED",
    message: fallbackMessage,
  });
}

export async function runMarketInspectCommand(
  context: CliRuntimeContext,
  options: MarketInspectOptions,
): Promise<CliStatusCode> {
  const surface = resolveMarketplaceInspectSurface(options.surface, null);
  if (!surface) {
    context.error({
      status: "error",
      code: "MARKET_INSPECT_SURFACE_INVALID",
      message: `Unknown inspect surface: ${options.surface}`,
    });
    return 1;
  }

  const statuses = Array.isArray(options.statuses)
    ? options.statuses.map((value) => String(value ?? "").trim()).filter(Boolean)
    : undefined;
  const query =
    typeof options.query === "string" && options.query.trim().length > 0
      ? options.query.trim()
      : undefined;
  const tags = Array.isArray(options.tags)
    ? options.tags.map((value) => String(value ?? "").trim()).filter(Boolean)
    : undefined;
  const subject =
    typeof options.subject === "string" && options.subject.trim().length > 0
      ? options.subject.trim()
      : undefined;

  if (!(surface === "reputation" && !subject) && !requireRpcUrl(context, options)) {
    return 1;
  }

  try {
    const buildTasksSurface = async () => {
      const captured = await captureMarketplaceCommand(
        context,
        runMarketTasksListCommand,
        {
          ...options,
          statuses,
        } as MarketTasksListOptions,
      );
      if (captured.code !== 0 || !captured.output) {
        forwardMarketplaceInspectFailure(
          context,
          captured.error,
          "Failed to inspect marketplace tasks.",
        );
        return null;
      }
      const items = readCapturedArray(captured.output, "tasks");
      return buildMarketplaceInspectSurface({
        surface: "tasks",
        items,
        count: readCapturedCount(captured.output, items.length),
        filters: { statuses },
      });
    };

    const buildSkillsSurface = async () => {
      const captured = await captureMarketplaceCommand(
        context,
        runMarketSkillsListCommand,
        {
          ...options,
          query,
          tags,
          limit: options.limit,
        } as MarketSkillsListOptions,
      );
      if (captured.code !== 0 || !captured.output) {
        forwardMarketplaceInspectFailure(
          context,
          captured.error,
          "Failed to inspect marketplace skills.",
        );
        return null;
      }
      const items = readCapturedArray(captured.output, "skills");
      return buildMarketplaceInspectSurface({
        surface: "skills",
        items,
        count: readCapturedCount(captured.output, items.length),
        filters: {
          query,
          tags,
          limit: options.limit,
          activeOnly: false,
        },
      });
    };

    const buildGovernanceSurface = async () => {
      const captured = await captureMarketplaceCommand(
        context,
        runMarketGovernanceListCommand,
        options as MarketGovernanceListOptions,
      );
      if (captured.code !== 0 || !captured.output) {
        forwardMarketplaceInspectFailure(
          context,
          captured.error,
          "Failed to inspect governance proposals.",
        );
        return null;
      }
      const items = filterInspectItemsByStatus(
        readCapturedArray(captured.output, "proposals"),
        statuses,
      );
      return buildMarketplaceInspectSurface({
        surface: "governance",
        items,
        count: items.length,
        filters: { statuses },
      });
    };

    const buildDisputesSurface = async () => {
      const captured = await captureMarketplaceCommand(
        context,
        runMarketDisputesListCommand,
        {
          ...options,
          statuses,
        } as MarketDisputesListOptions,
      );
      if (captured.code !== 0 || !captured.output) {
        forwardMarketplaceInspectFailure(
          context,
          captured.error,
          "Failed to inspect marketplace disputes.",
        );
        return null;
      }
      const items = readCapturedArray(captured.output, "disputes");
      return buildMarketplaceInspectSurface({
        surface: "disputes",
        items,
        count: readCapturedCount(captured.output, items.length),
        filters: { statuses },
      });
    };

    const buildReputationSurface = async () => {
      if (!subject) {
        return buildMarketplaceReputationInspectPlaceholder();
      }
      const captured = await captureMarketplaceCommand(
        context,
        runMarketReputationSummaryCommand,
        {
          ...options,
          agentPda: subject,
        } as MarketReputationSummaryOptions,
      );
      if (captured.code !== 0 || !captured.output) {
        forwardMarketplaceInspectFailure(
          context,
          captured.error,
          "Failed to inspect marketplace reputation.",
        );
        return null;
      }
      const summary = readCapturedObject(captured.output, "summary");
      return buildMarketplaceInspectSurface({
        surface: "reputation",
        subject,
        items: summary ? [summary] : [],
        count: summary ? 1 : 0,
      });
    };

    let inspectSurface;
    switch (surface) {
      case "tasks":
        inspectSurface = await buildTasksSurface();
        break;
      case "skills":
        inspectSurface = await buildSkillsSurface();
        break;
      case "governance":
        inspectSurface = await buildGovernanceSurface();
        break;
      case "disputes":
        inspectSurface = await buildDisputesSurface();
        break;
      case "reputation":
        inspectSurface = await buildReputationSurface();
        break;
      case "marketplace": {
        const surfaces = [
          await buildTasksSurface(),
          await buildSkillsSurface(),
          await buildGovernanceSurface(),
          await buildDisputesSurface(),
          await buildReputationSurface(),
        ];
        if (surfaces.some((entry) => entry === null)) {
          return 1;
        }
        const overviewSurfaces = surfaces.filter(
          (entry): entry is NonNullable<(typeof surfaces)[number]> => entry !== null,
        );
        inspectSurface = buildMarketplaceInspectOverview({
          surfaces: overviewSurfaces,
          subject,
        });
        break;
      }
    }

    if (!inspectSurface) {
      return 1;
    }

    context.output({
      status: "ok",
      command: "market.inspect",
      schema: "market.inspect.output.v1",
      surface: inspectSurface,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_INSPECT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function loadSkillAccount(
  program: ReturnType<typeof createReadOnlyProgram> | ReturnType<typeof createProgram>,
  skillPda: PublicKey,
): Promise<Record<string, unknown> | null> {
  const raw = await (program.account as any).skillRegistration.fetchNullable(
    skillPda,
  );
  return (raw as Record<string, unknown> | null) ?? null;
}

function parsePairList(
  input: string,
  leftLabel: string,
  rightLabel: string,
): Array<Record<string, string>> {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [left, right] = entry.split(":").map((part) => part.trim());
      if (!left || !right) {
        throw new Error(
          `Each ${leftLabel}/${rightLabel} pair must use ${leftLabel}:${rightLabel}`,
        );
      }
      return { [leftLabel]: left, [rightLabel]: right };
    });
}

export async function runMarketTasksListCommand(
  context: CliRuntimeContext,
  options: MarketTasksListOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const ops = new TaskOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const taskTypeFilter = parseTaskTypeFilter(options.taskType);
    const entries = await ops.fetchAllTasks();
    const filteredEntries = taskTypeFilter === undefined
      ? entries
      : entries.filter(({ task }) => task.taskType === taskTypeFilter);
    const items = filterByStatus(
      filteredEntries.map(mapTaskSummary),
      options.statuses,
    );
    const tasks = await Promise.all(
      items.map((task) =>
        enrichTaskSummaryWithJobSpec(task, options.jobSpecStoreDir),
      ),
    );
    context.output({
      status: "ok",
      command: "market.tasks.list",
      schema: "market.tasks.list.output.v1",
      count: tasks.length,
      tasks,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASKS_LIST_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskCreateCommand(
  context: CliRuntimeContext,
  options: MarketTaskCreateOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const createTaskOptions = {
      ...(options.jobSpecStoreDir ? { jobSpecStoreDir: options.jobSpecStoreDir } : {}),
      allowRawTaskCreation: true,
    };
    const tool = createCreateTaskTool(program, silentLogger, createTaskOptions);
    const result = await tool.execute({
      description: options.description,
      reward: options.reward,
      requiredCapabilities: options.requiredCapabilities,
      rewardMint: options.rewardMint,
      maxWorkers: options.maxWorkers,
      deadline: options.deadline,
      taskType: options.taskType,
      minReputation: options.minReputation,
      constraintHash: options.constraintHash,
      validationMode: options.validationMode,
      reviewWindowSecs: options.reviewWindowSecs,
      creatorAgentPda: options.creatorAgentPda,
      jobSpec: options.jobSpec,
      jobSpecPublishUri: options.jobSpecPublishUri,
      fullDescription: options.fullDescription,
      acceptanceCriteria: options.acceptanceCriteria,
      deliverables: options.deliverables,
      constraints: options.constraints,
      attachments: options.attachments,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_TASK_CREATE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.tasks.create",
      schema: "market.tasks.create.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_CREATE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskDetailCommand(
  context: CliRuntimeContext,
  options: MarketTaskDetailOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const ops = new TaskOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const taskPda = new PublicKey(options.taskPda);
    const task = await ops.fetchTask(taskPda);
    if (!task) {
      context.error({
        status: "error",
        code: "MARKET_TASK_NOT_FOUND",
        message: `Task not found: ${options.taskPda}`,
      });
      return 1;
    }
    const taskDetail = mapTaskDetail(taskPda, task);
    if (!taskDetail) {
      context.error({
        status: "error",
        code: "MARKET_TASK_NOT_FOUND",
        message: `Task not found: ${options.taskPda}`,
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.tasks.detail",
      schema: "market.tasks.detail.output.v1",
      task: await enrichTaskDetailWithJobSpec(
        taskDetail,
        options.jobSpecStoreDir,
        program,
        options.allowRemoteJobSpecResolution,
      ),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_DETAIL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskCancelCommand(
  context: CliRuntimeContext,
  options: MarketTaskCancelOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const authority = program.provider.publicKey;
    if (!authority) {
      throw new Error("Signer-backed program context required");
    }
    const taskPda = new PublicKey(options.taskPda);
    const escrowPda = findEscrowPda(taskPda, program.programId);
    const protocolPda = findProtocolPda(program.programId);
    const transactionSignature = await program.methods
      .cancelTask()
      .accountsPartial({
        authority,
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        systemProgram: SystemProgram.programId,
        tokenEscrowAta: null,
        creatorTokenAccount: null,
        rewardMint: null,
        tokenProgram: null,
      })
      .rpc();
    context.output({
      status: "ok",
      command: "market.tasks.cancel",
      schema: "market.tasks.cancel.output.v1",
      result: {
        taskPda: taskPda.toBase58(),
        escrowPda: escrowPda.toBase58(),
        transactionSignature,
      },
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_CANCEL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskClaimCommand(
  context: CliRuntimeContext,
  options: MarketTaskClaimOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createClaimTaskTool(
      program,
      silentLogger,
      {
        ...(options.jobSpecStoreDir
          ? {
              jobSpecStoreDir: options.jobSpecStoreDir,
            }
          : {}),
        ...(options.allowRemoteJobSpecResolution
          ? { allowRemoteJobSpecResolution: true }
          : {}),
        claimJobSpecVerification: "required",
      },
    );
    const result = await tool.execute({
      taskPda: options.taskPda,
      workerAgentPda: options.workerAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_TASK_CLAIM_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.tasks.claim",
      schema: "market.tasks.claim.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_CLAIM_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskCompleteCommand(
  context: CliRuntimeContext,
  options: MarketTaskCompleteOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const resultData =
      options.resultData?.trim() || "Task completed via agenc-runtime market";
    const proofHash =
      options.proofHash ?? createHash("sha256").update(resultData).digest("hex");
    const tool = createCompleteTaskTool(program, silentLogger);
    const result = await tool.execute({
      taskPda: options.taskPda,
      proofHash,
      resultData,
      workerAgentPda: options.workerAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_TASK_COMPLETE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.tasks.complete",
      schema: "market.tasks.complete.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_COMPLETE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskAcceptCommand(
  context: CliRuntimeContext,
  options: MarketTaskAcceptOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const taskPda = new PublicKey(options.taskPda);
    const workerAgentPda = options.workerAgentPda?.trim();
    if (!workerAgentPda) {
      context.error({
        status: "error",
        code: "MARKET_TASK_ACCEPT_FAILED",
        message:
          "market tasks accept requires --worker-agent-pda <agentPda>",
      });
      return 1;
    }

    const ops = new TaskOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const task = await ops.fetchTask(taskPda);
    if (!task) {
      context.error({
        status: "error",
        code: "MARKET_TASK_NOT_FOUND",
        message: `Task not found: ${options.taskPda}`,
      });
      return 1;
    }

    const result = await ops.acceptTaskResult(
      taskPda,
      task,
      new PublicKey(workerAgentPda),
    );

    context.output({
      status: "ok",
      command: "market.tasks.accept",
      schema: "market.tasks.accept.output.v1",
      result: {
        taskPda: taskPda.toBase58(),
        workerAgentPda,
        taskId: Buffer.from(result.taskId).toString("hex"),
        transactionSignature: result.transactionSignature,
      },
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_ACCEPT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskRejectCommand(
  context: CliRuntimeContext,
  options: MarketTaskRejectOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const taskPda = new PublicKey(options.taskPda);
    const workerAgentPda = options.workerAgentPda?.trim();
    if (!workerAgentPda) {
      context.error({
        status: "error",
        code: "MARKET_TASK_REJECT_FAILED",
        message:
          "market tasks reject requires --worker-agent-pda <agentPda>",
      });
      return 1;
    }

    const rejectionReason = options.reason.trim();
    if (!rejectionReason) {
      context.error({
        status: "error",
        code: "MARKET_TASK_REJECT_FAILED",
        message: "market tasks reject requires --reason <text>",
      });
      return 1;
    }

    const ops = new TaskOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const task = await ops.fetchTask(taskPda);
    if (!task) {
      context.error({
        status: "error",
        code: "MARKET_TASK_NOT_FOUND",
        message: `Task not found: ${options.taskPda}`,
      });
      return 1;
    }

    const rejectionHash = createHash("sha256")
      .update(rejectionReason)
      .digest();
    const result = await ops.rejectTaskResult(
      taskPda,
      task,
      new PublicKey(workerAgentPda),
      rejectionHash,
    );

    context.output({
      status: "ok",
      command: "market.tasks.reject",
      schema: "market.tasks.reject.output.v1",
      result: {
        taskPda: taskPda.toBase58(),
        workerAgentPda,
        taskId: Buffer.from(result.taskId).toString("hex"),
        taskSubmissionPda: result.taskSubmissionPda.toBase58(),
        rejectionHash: rejectionHash.toString("hex"),
        transactionSignature: result.transactionSignature,
      },
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_REJECT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketTaskDisputeCommand(
  context: CliRuntimeContext,
  options: MarketTaskDisputeOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createInitiateDisputeTool(program, silentLogger);
    const result = await tool.execute({
      taskPda: options.taskPda,
      evidence: options.evidence,
      resolutionType: options.resolutionType ?? "refund",
      workerAgentPda: options.workerAgentPda,
      workerClaimPda: options.workerClaimPda,
      initiatorAgentPda: options.initiatorAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_TASK_DISPUTE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.tasks.dispute",
      schema: "market.tasks.dispute.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_TASK_DISPUTE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketSkillsListCommand(
  context: CliRuntimeContext,
  options: MarketSkillsListOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const accounts = await (program.account as any).skillRegistration.all();
    let items: ReturnType<typeof mapSkillSummary>[] = accounts.map(
      (entry: { publicKey: PublicKey; account: Record<string, unknown> }) =>
        mapSkillSummary(entry),
    );
    if (options.query) {
      const normalized = options.query.toLowerCase();
      items = items.filter(
        (item: ReturnType<typeof mapSkillSummary>) =>
          item.name.toLowerCase().includes(normalized) ||
          item.author.toLowerCase().includes(normalized) ||
          item.tags.some((tag: string) => tag.toLowerCase().includes(normalized)),
      );
    }
    if (options.tags && options.tags.length > 0) {
      const tagFilter = new Set(
        options.tags.map((tag: string) => tag.toLowerCase()),
      );
      items = items.filter((item: ReturnType<typeof mapSkillSummary>) =>
        item.tags.some((tag: string) => tagFilter.has(tag.toLowerCase())),
      );
    }
    items.sort(
      (
        left: ReturnType<typeof mapSkillSummary>,
        right: ReturnType<typeof mapSkillSummary>,
      ) =>
        right.rating - left.rating ||
        right.downloads - left.downloads ||
        left.name.localeCompare(right.name),
    );
    if (typeof options.limit === "number") {
      items = items.slice(0, options.limit);
    }

    context.output({
      status: "ok",
      command: "market.skills.list",
      schema: "market.skills.list.output.v1",
      count: items.length,
      skills: items,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_SKILLS_LIST_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketSkillDetailCommand(
  context: CliRuntimeContext,
  options: MarketSkillDetailOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const skillPda = new PublicKey(options.skillPda);
    const account = await loadSkillAccount(program, skillPda);
    if (!account) {
      context.error({
        status: "error",
        code: "MARKET_SKILL_NOT_FOUND",
        message: `Skill not found: ${options.skillPda}`,
      });
      return 1;
    }

    const detail = mapSkillSummary({ publicKey: skillPda, account });
    try {
      const { connection, program: signerProgram } =
        await createSignerProgramContext(options);
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
      context.output({
        status: "ok",
        command: "market.skills.detail",
        schema: "market.skills.detail.output.v1",
        skill: {
          ...detail,
          purchased: await purchaseManager.isPurchased(skillPda),
        },
      });
      return 0;
    } catch {
      context.output({
        status: "ok",
        command: "market.skills.detail",
        schema: "market.skills.detail.output.v1",
        skill: detail,
      });
      return 0;
    }
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_SKILL_DETAIL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketSkillPurchaseCommand(
  context: CliRuntimeContext,
  options: MarketSkillPurchaseOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { connection, program } = await createSignerProgramContext(options);
    const signerAgent = await resolveSignerAgent(program, options.buyerAgentPda);
    const skillPda = new PublicKey(options.skillPda);
    const account = await loadSkillAccount(program, skillPda);
    if (!account) {
      context.error({
        status: "error",
        code: "MARKET_SKILL_NOT_FOUND",
        message: `Skill not found: ${options.skillPda}`,
      });
      return 1;
    }
    const detail = mapSkillSummary({ publicKey: skillPda, account });
    if (
      options.expectedPrice &&
      detail.priceLamports !== options.expectedPrice
    ) {
      context.error({
        status: "error",
        code: "MARKET_SKILL_PRICE_MISMATCH",
        message: `Expected price ${options.expectedPrice} does not match on-chain price ${detail.priceLamports}`,
      });
      return 1;
    }

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
      skillPda,
      detail.skillId,
      join(homedir(), ".agenc", "skills", `${detail.skillId}.md`),
    );
    context.output({
      status: "ok",
      command: "market.skills.purchase",
      schema: "market.skills.purchase.output.v1",
      result: {
        skillPda: detail.skillPda,
        skillId: detail.skillId,
        buyerAgentPda: signerAgent.agentPda.toBase58(),
        paid: result.paid,
        pricePaid: result.pricePaid.toString(),
        protocolFee: result.protocolFee.toString(),
        transactionSignature: result.transactionSignature,
        contentPath: result.contentPath,
      },
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_SKILL_PURCHASE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketSkillRateCommand(
  context: CliRuntimeContext,
  options: MarketSkillRateOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createRateSkillTool(program, silentLogger);
    const result = await tool.execute({
      skillPda: options.skillPda,
      rating: options.rating,
      review: options.review,
      raterAgentPda: options.raterAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_SKILL_RATE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.skills.rate",
      schema: "market.skills.rate.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_SKILL_RATE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketGovernanceListCommand(
  context: CliRuntimeContext,
  options: MarketGovernanceListOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const ops = new GovernanceOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const proposals = (await ops.fetchAllProposals()).map(mapProposalSummary);
    context.output({
      status: "ok",
      command: "market.governance.list",
      schema: "market.governance.list.output.v1",
      count: proposals.length,
      proposals,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_GOVERNANCE_LIST_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketGovernanceDetailCommand(
  context: CliRuntimeContext,
  options: MarketGovernanceDetailOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const ops = new GovernanceOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const proposalPda = new PublicKey(options.proposalPda);
    const proposal = await ops.getProposal(proposalPda);
    if (!proposal) {
      context.error({
        status: "error",
        code: "MARKET_PROPOSAL_NOT_FOUND",
        message: `Proposal not found: ${options.proposalPda}`,
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.governance.detail",
      schema: "market.governance.detail.output.v1",
      proposal: serializeMarketplaceProposalDetail(proposalPda, proposal),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_GOVERNANCE_DETAIL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketGovernanceVoteCommand(
  context: CliRuntimeContext,
  options: MarketGovernanceVoteOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createVoteProposalTool(program, silentLogger);
    const result = await tool.execute({
      proposalPda: options.proposalPda,
      approve: options.approve,
      voterAgentPda: options.voterAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_GOVERNANCE_VOTE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.governance.vote",
      schema: "market.governance.vote.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_GOVERNANCE_VOTE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketDisputesListCommand(
  context: CliRuntimeContext,
  options: MarketDisputesListOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const ops = new DisputeOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const disputes = filterByStatus(
      (await ops.fetchAllDisputes()).map(mapDisputeSummary),
      options.statuses,
    );
    context.output({
      status: "ok",
      command: "market.disputes.list",
      schema: "market.disputes.list.output.v1",
      count: disputes.length,
      disputes,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_DISPUTES_LIST_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketDisputeDetailCommand(
  context: CliRuntimeContext,
  options: MarketDisputeDetailOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createReadOnlyProgramContext(options);
    const ops = new DisputeOperations({
      program,
      agentId: ZERO_AGENT_ID,
      logger: silentLogger,
    });
    const disputePda = new PublicKey(options.disputePda);
    const dispute = await ops.fetchDispute(disputePda);
    if (!dispute) {
      context.error({
        status: "error",
        code: "MARKET_DISPUTE_NOT_FOUND",
        message: `Dispute not found: ${options.disputePda}`,
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.disputes.detail",
      schema: "market.disputes.detail.output.v1",
      dispute: serializeMarketplaceDisputeDetail(disputePda, dispute),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_DISPUTE_DETAIL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketDisputeResolveCommand(
  context: CliRuntimeContext,
  options: MarketDisputeResolveOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createResolveDisputeTool(program, silentLogger);
    const result = await tool.execute({
      disputePda: options.disputePda,
      arbiterVotes: options.arbiterVotes,
      extraWorkers: options.extraWorkers,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_DISPUTE_RESOLVE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.disputes.resolve",
      schema: "market.disputes.resolve.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_DISPUTE_RESOLVE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketReputationSummaryCommand(
  context: CliRuntimeContext,
  options: MarketReputationSummaryOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    if (options.agentPda) {
      const { program } = await createReadOnlyProgramContext(options);
      const agentPda = new PublicKey(options.agentPda);
      const summary = await buildMarketplaceReputationSummaryForAgent(
        program,
        agentPda,
        ZERO_AGENT_ID,
      );
      if (!summary) {
        context.output({
          status: "ok",
          command: "market.reputation.summary",
          schema: "market.reputation.summary.output.v1",
          summary: buildMarketplaceUnregisteredSummary({
            agentPda: options.agentPda,
          }),
        });
        return 0;
      }
      context.output({
        status: "ok",
        command: "market.reputation.summary",
        schema: "market.reputation.summary.output.v1",
        summary,
      });
      return 0;
    }

    const { program } = await createSignerProgramContext(options);
    const signerAgent = await resolveSignerAgent(program);
    const summary = await buildMarketplaceReputationSummaryForAgent(
      program,
      signerAgent.agentPda,
      signerAgent.agentId,
    );
    context.output({
      status: "ok",
      command: "market.reputation.summary",
      schema: "market.reputation.summary.output.v1",
      summary:
        summary ??
        buildMarketplaceUnregisteredSummary({
          authority: signerAgent.authority.toBase58(),
          agentPda: signerAgent.agentPda.toBase58(),
        }),
    });
    return 0;
  } catch (error) {
    const multipleAgentDetails = error instanceof MultipleSignerAgentsError
      ? {
          reasonCode: error.code,
          authority: error.authority,
          count: error.agents.length,
          agents: error.agents,
        }
      : {};
    context.error({
      status: "error",
      code: "MARKET_REPUTATION_SUMMARY_FAILED",
      message: error instanceof Error ? error.message : String(error),
      ...multipleAgentDetails,
    });
    return 1;
  }
}

export async function runMarketReputationStakeCommand(
  context: CliRuntimeContext,
  options: MarketReputationStakeOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createStakeReputationTool(program, silentLogger);
    const result = await tool.execute({
      amount: options.amount,
      stakerAgentPda: options.stakerAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_REPUTATION_STAKE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.reputation.stake",
      schema: "market.reputation.stake.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_REPUTATION_STAKE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export async function runMarketReputationDelegateCommand(
  context: CliRuntimeContext,
  options: MarketReputationDelegateOptions,
): Promise<CliStatusCode> {
  if (!requireRpcUrl(context, options)) return 1;

  try {
    const { program } = await createSignerProgramContext(options);
    const tool = createDelegateReputationTool(program, silentLogger);
    const result = await tool.execute({
      amount: options.amount,
      delegateeAgentPda: options.delegateeAgentPda,
      delegateeAgentId: options.delegateeAgentId,
      expiresAt: options.expiresAt,
      delegatorAgentPda: options.delegatorAgentPda,
    });
    if (result.isError) {
      context.error({
        status: "error",
        code: "MARKET_REPUTATION_DELEGATE_FAILED",
        message: parseToolError(result),
      });
      return 1;
    }
    context.output({
      status: "ok",
      command: "market.reputation.delegate",
      schema: "market.reputation.delegate.output.v1",
      result: parseToolPayload(result),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "MARKET_REPUTATION_DELEGATE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

export function parseArbiterVotes(
  value: string,
): Array<{ votePda: string; arbiterAgentPda: string }> {
  return parsePairList(value, "votePda", "arbiterAgentPda") as Array<{
    votePda: string;
    arbiterAgentPda: string;
  }>;
}

export function parseExtraWorkers(
  value: string,
): Array<{ claimPda: string; workerPda: string }> {
  return parsePairList(value, "claimPda", "workerPda") as Array<{
    claimPda: string;
    workerPda: string;
  }>;
}
