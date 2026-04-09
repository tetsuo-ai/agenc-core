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
import { OnChainSkillRegistryClient } from "../skills/registry/client.js";
import { SkillPurchaseManager } from "../skills/registry/payment.js";
import { TaskOperations } from "../task/operations.js";
import { findEscrowPda } from "../task/pda.js";
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
}

export interface MarketTaskCreateOptions extends BaseCliOptions {
  description: string;
  reward: string;
  requiredCapabilities: string;
  maxWorkers?: number;
  deadline?: number;
  taskType?: number;
  creatorAgentPda?: string;
}

export interface MarketTaskDetailOptions extends BaseCliOptions {
  taskPda: string;
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

export type MarketCommandOptions =
  | MarketTasksListOptions
  | MarketTaskCreateOptions
  | MarketTaskDetailOptions
  | MarketTaskCancelOptions
  | MarketTaskClaimOptions
  | MarketTaskCompleteOptions
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
  | MarketReputationDelegateOptions;

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
const ZERO_AGENT_ID = new Uint8Array(32);

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
        { memcmp: { offset: 40, bytes: authority.toBase58() } },
      ],
    },
  );

  if (matches.length === 0) {
    throw new Error("No agent registration found for signer wallet");
  }
  if (matches.length > 1) {
    throw new Error("Multiple agent registrations found for signer wallet");
  }

  const raw = await (program.account as any).agentRegistration.fetch(
    matches[0].pubkey,
  );
  const agent = parseAgentState(raw as Record<string, unknown>);
  return {
    agentPda: matches[0].pubkey,
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
    const items = filterByStatus(
      (await ops.fetchAllTasks()).map(mapTaskSummary),
      options.statuses,
    );
    context.output({
      status: "ok",
      command: "market.tasks.list",
      schema: "market.tasks.list.output.v1",
      count: items.length,
      tasks: items,
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
    const tool = createCreateTaskTool(program, silentLogger);
    const result = await tool.execute({
      description: options.description,
      reward: options.reward,
      requiredCapabilities: options.requiredCapabilities,
      maxWorkers: options.maxWorkers,
      deadline: options.deadline,
      taskType: options.taskType,
      creatorAgentPda: options.creatorAgentPda,
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
    context.output({
      status: "ok",
      command: "market.tasks.detail",
      schema: "market.tasks.detail.output.v1",
      task: mapTaskDetail(taskPda, task),
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
    const tool = createClaimTaskTool(program, silentLogger);
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
    context.error({
      status: "error",
      code: "MARKET_REPUTATION_SUMMARY_FAILED",
      message: error instanceof Error ? error.message : String(error),
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
