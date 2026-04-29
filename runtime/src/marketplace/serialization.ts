import { PublicKey } from "@solana/web3.js";
import { parseAgentState } from "../agent/types.js";
import { DisputeOperations } from "../dispute/operations.js";
import {
  disputeStatusToString,
  ResolutionType,
} from "../dispute/types.js";
import { GovernanceOperations } from "../governance/operations.js";
import {
  proposalStatusToString,
  ProposalType,
} from "../governance/types.js";
import { createProgram, createReadOnlyProgram } from "../idl.js";
import { ReputationEconomyOperations } from "../reputation/economy.js";
import { TaskOperations } from "../task/operations.js";
import {
  taskStatusToString,
  taskTypeToKey,
  taskTypeToString,
} from "../task/types.js";
import { decodeMarketplaceArtifactSha256FromResultData } from "./artifact-delivery.js";
import { lamportsToSol } from "../utils/encoding.js";
import { silentLogger } from "../utils/logger.js";

type TaskListEntry = Awaited<ReturnType<TaskOperations["fetchAllTasks"]>>[number];
type TaskRecord = NonNullable<Awaited<ReturnType<TaskOperations["fetchTask"]>>>;
type ProposalListEntry =
  Awaited<ReturnType<GovernanceOperations["fetchAllProposals"]>>[number];
type ProposalRecord =
  NonNullable<Awaited<ReturnType<GovernanceOperations["getProposal"]>>>;
type DisputeListEntry =
  Awaited<ReturnType<DisputeOperations["fetchAllDisputes"]>>[number];
type DisputeRecord =
  NonNullable<Awaited<ReturnType<DisputeOperations["fetchDispute"]>>>;
type MarketProgram =
  | ReturnType<typeof createProgram>
  | ReturnType<typeof createReadOnlyProgram>;

interface SerializedMarketplaceTask {
  taskPda: string;
  taskId: string;
  status: string;
  creator: string;
  description: string;
  constraintHash: string;
  rewardLamports: string;
  rewardSol: string | undefined;
  rewardMint: string | null;
  taskType: string;
  taskTypeId: number;
  taskTypeName: string;
  taskTypeKey: string;
  currentWorkers: number;
  maxWorkers: number;
  requiredCompletions: number;
  completions: number;
  deadline: number;
  createdAt: number;
  completedAt: number;
  escrow: string;
  resultPreview?: string;
  deliveryArtifact?: {
    sha256: string;
    source: "protocol-result-data";
    verified: false;
  };
}

interface SerializedMarketplaceSkill {
  skillPda: string;
  skillId: string;
  author: string;
  name: string;
  tags: string[];
  priceLamports: string;
  priceSol: string | undefined;
  priceMint: string | null;
  rating: number;
  ratingCount: number;
  downloads: number;
  version: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  contentHash: string;
}

interface SerializedMarketplaceProposalSummary {
  proposalPda: string;
  proposer: string;
  proposalType: string;
  status: string;
  titleHash: string;
  descriptionHash: string;
  payloadPreview?: string;
  votesFor: string;
  votesAgainst: string;
  totalVoters: number;
  quorum: string;
  createdAt: number;
  votingDeadline: number;
  executionAfter: number;
}

interface SerializedMarketplaceProposalDetail
  extends SerializedMarketplaceProposalSummary {
  executedAt: number;
  votes: Array<{
    voter: string;
    approved: boolean;
    votedAt: number;
    voteWeight: string;
  }>;
}

interface SerializedMarketplaceDisputeSummary {
  disputePda: string;
  taskPda: string;
  initiator: string;
  defendant: string;
  status: string;
  resolutionType: string;
  evidenceHash: string;
  votesFor: string;
  votesAgainst: string;
  totalVoters: number;
  createdAt: number;
  votingDeadline: number;
  expiresAt: number;
  resolvedAt: number;
  slashApplied: boolean;
  initiatorSlashApplied: boolean;
  workerStakeAtDispute: string;
  initiatedByCreator: boolean;
  rewardMint: string | null;
}

interface SerializedMarketplaceDisputeDetail
  extends SerializedMarketplaceDisputeSummary {
  disputeId: string;
  initiatorAuthority: string;
}

interface SerializedMarketplaceDelegation {
  amount: number;
  expiresAt: number;
  createdAt: number;
  delegator?: string;
  delegatee?: string;
}

interface SerializedMarketplaceReputationSummary {
  registered: boolean;
  authority?: string;
  agentPda?: string;
  agentId?: string;
  baseReputation?: number;
  effectiveReputation?: number;
  tasksCompleted?: string;
  totalEarned?: string;
  totalEarnedSol?: string;
  stakedAmount?: string;
  stakedAmountSol?: string;
  lockedUntil?: number;
  inboundDelegations?: SerializedMarketplaceDelegation[];
  outboundDelegations?: SerializedMarketplaceDelegation[];
}

function decodeTaskBytes(bytes: Uint8Array): string {
  const nullIndex = bytes.indexOf(0);
  const slice = nullIndex === -1 ? bytes : bytes.subarray(0, nullIndex);
  return new TextDecoder().decode(slice).trim();
}

function decodeCsvBytes(bytes: Uint8Array): string[] {
  const decoded = decodeTaskBytes(bytes);
  if (!decoded) return [];
  return decoded
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function encodeHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function decodePayloadPreview(bytes: Uint8Array): string | undefined {
  const decoded = decodeTaskBytes(bytes);
  return decoded || undefined;
}

function normalizeTaskStatus(status: string): string {
  switch (status) {
    case "Open":
      return "open";
    case "InProgress":
      return "in_progress";
    case "PendingValidation":
      return "pending_validation";
    case "Completed":
      return "completed";
    case "Cancelled":
      return "cancelled";
    case "Disputed":
      return "disputed";
    default:
      return status.trim().toLowerCase();
  }
}

function normalizeProposalStatus(status: string): string {
  switch (status) {
    case "Active":
      return "active";
    case "Executed":
      return "executed";
    case "Defeated":
      return "defeated";
    case "Cancelled":
      return "cancelled";
    default:
      return status.trim().toLowerCase();
  }
}

function normalizeDisputeStatus(status: string): string {
  switch (status) {
    case "Active":
      return "active";
    case "Resolved":
      return "resolved";
    case "Expired":
      return "expired";
    case "Cancelled":
      return "cancelled";
    default:
      return status.trim().toLowerCase();
  }
}

function proposalTypeToLabel(type: ProposalType): string {
  switch (type) {
    case ProposalType.ProtocolUpgrade:
      return "protocol_upgrade";
    case ProposalType.FeeChange:
      return "fee_change";
    case ProposalType.TreasurySpend:
      return "treasury_spend";
    case ProposalType.RateLimitChange:
      return "rate_limit_change";
    default:
      return "unknown";
  }
}

function resolutionTypeToLabel(type: ResolutionType): string {
  switch (type) {
    case ResolutionType.Refund:
      return "refund";
    case ResolutionType.Complete:
      return "complete";
    case ResolutionType.Split:
      return "split";
    default:
      return "unknown";
  }
}

function toNumber(
  value: { toNumber?: () => number } | number | bigint | string | undefined,
  fallback = 0,
): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  if (typeof value?.toNumber === "function") return value.toNumber();
  return fallback;
}

export function serializeMarketplaceTask(
  taskPda: PublicKey,
  task: TaskRecord,
): SerializedMarketplaceTask {
  const deliveryArtifactSha256 = decodeMarketplaceArtifactSha256FromResultData(task.result);
  return {
    taskPda: taskPda.toBase58(),
    taskId: encodeHex(task.taskId),
    status: normalizeTaskStatus(taskStatusToString(task.status)),
    creator: task.creator.toBase58(),
    description: decodeTaskBytes(task.description) || "untitled task",
    constraintHash: encodeHex(task.constraintHash),
    rewardLamports: task.rewardAmount.toString(),
    rewardSol: task.rewardMint ? undefined : lamportsToSol(task.rewardAmount),
    rewardMint: task.rewardMint?.toBase58() ?? null,
    taskType: String(task.taskType),
    taskTypeId: task.taskType,
    taskTypeName: taskTypeToString(task.taskType),
    taskTypeKey: taskTypeToKey(task.taskType),
    currentWorkers: task.currentWorkers,
    maxWorkers: task.maxWorkers,
    requiredCompletions: task.requiredCompletions,
    completions: task.completions,
    deadline: task.deadline,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    escrow: task.escrow.toBase58(),
    resultPreview: deliveryArtifactSha256
      ? undefined
      : decodeTaskBytes(task.result) || undefined,
    deliveryArtifact: deliveryArtifactSha256
      ? {
          sha256: deliveryArtifactSha256,
          source: "protocol-result-data",
          verified: false,
        }
      : undefined,
  };
}

export function serializeMarketplaceTaskEntry(
  entry: TaskListEntry,
): SerializedMarketplaceTask {
  return serializeMarketplaceTask(entry.taskPda, entry.task);
}

export function serializeMarketplaceSkill(entry: {
  publicKey: PublicKey;
  account: Record<string, unknown>;
}): SerializedMarketplaceSkill {
  const account = entry.account as Record<string, any>;
  const skillId = new Uint8Array(account.skillId ?? account.skill_id);
  const name = decodeTaskBytes(new Uint8Array(account.name));
  const tags = decodeCsvBytes(new Uint8Array(account.tags));
  const priceLamports = BigInt(account.price.toString());
  const ratingCount = Number(account.ratingCount ?? account.rating_count ?? 0);
  const totalRating = BigInt(
    account.totalRating?.toString?.() ??
      account.total_rating?.toString?.() ??
      "0",
  );
  const rating = ratingCount > 0 ? Number(totalRating) / ratingCount : 0;

  return {
    skillPda: entry.publicKey.toBase58(),
    skillId: encodeHex(skillId),
    author: (account.author as PublicKey).toBase58(),
    name: name || `skill:${encodeHex(skillId).slice(0, 8)}`,
    tags,
    priceLamports: priceLamports.toString(),
    priceSol:
      account.priceMint || account.price_mint
        ? undefined
        : lamportsToSol(priceLamports),
    priceMint:
      ((account.priceMint ?? account.price_mint) as PublicKey | null)?.toBase58() ??
      null,
    rating: Number(rating.toFixed(2)),
    ratingCount,
    downloads: Number(account.downloadCount ?? account.download_count ?? 0),
    version: Number(account.version ?? 0),
    isActive: Boolean(account.isActive ?? account.is_active),
    createdAt: toNumber(account.createdAt),
    updatedAt: toNumber(account.updatedAt),
    contentHash: encodeHex(
      new Uint8Array(account.contentHash ?? account.content_hash),
    ),
  };
}

export function serializeMarketplaceProposalSummary(
  entry: ProposalListEntry,
): SerializedMarketplaceProposalSummary {
  const { proposal, proposalPda } = entry;
  return {
    proposalPda: proposalPda.toBase58(),
    proposer: proposal.proposer.toBase58(),
    proposalType: proposalTypeToLabel(proposal.proposalType),
    status: normalizeProposalStatus(proposalStatusToString(proposal.status)),
    titleHash: encodeHex(proposal.titleHash),
    descriptionHash: encodeHex(proposal.descriptionHash),
    payloadPreview: decodePayloadPreview(proposal.payload),
    votesFor: proposal.votesFor.toString(),
    votesAgainst: proposal.votesAgainst.toString(),
    totalVoters: proposal.totalVoters,
    quorum: proposal.quorum.toString(),
    createdAt: proposal.createdAt,
    votingDeadline: proposal.votingDeadline,
    executionAfter: proposal.executionAfter,
  };
}

export function serializeMarketplaceProposalDetail(
  proposalPda: PublicKey,
  proposal: ProposalRecord,
): SerializedMarketplaceProposalDetail {
  return {
    ...serializeMarketplaceProposalSummary({ proposal, proposalPda }),
    executedAt: proposal.executedAt,
    votes: proposal.votes.map((vote) => ({
      voter: vote.voter.toBase58(),
      approved: vote.approved,
      votedAt: vote.votedAt,
      voteWeight: vote.voteWeight.toString(),
    })),
  };
}

export function serializeMarketplaceDisputeSummary(
  entry: DisputeListEntry,
): SerializedMarketplaceDisputeSummary {
  const { dispute, disputePda } = entry;
  return {
    disputePda: disputePda.toBase58(),
    taskPda: dispute.task.toBase58(),
    initiator: dispute.initiator.toBase58(),
    defendant: dispute.defendant.toBase58(),
    status: normalizeDisputeStatus(disputeStatusToString(dispute.status)),
    resolutionType: resolutionTypeToLabel(dispute.resolutionType),
    evidenceHash: encodeHex(dispute.evidenceHash),
    votesFor: dispute.votesFor.toString(),
    votesAgainst: dispute.votesAgainst.toString(),
    totalVoters: dispute.totalVoters,
    createdAt: dispute.createdAt,
    votingDeadline: dispute.votingDeadline,
    expiresAt: dispute.expiresAt,
    resolvedAt: dispute.resolvedAt,
    slashApplied: dispute.slashApplied,
    initiatorSlashApplied: dispute.initiatorSlashApplied,
    workerStakeAtDispute: dispute.workerStakeAtDispute.toString(),
    initiatedByCreator: dispute.initiatedByCreator,
    rewardMint: dispute.rewardMint?.toBase58() ?? null,
  };
}

export function serializeMarketplaceDisputeDetail(
  disputePda: PublicKey,
  dispute: DisputeRecord,
): SerializedMarketplaceDisputeDetail {
  return {
    ...serializeMarketplaceDisputeSummary({ dispute, disputePda }),
    disputeId: encodeHex(dispute.disputeId),
    initiatorAuthority: dispute.initiatorAuthority.toBase58(),
  };
}

function buildMarketplaceReputationSummary(
  agentPda: PublicKey,
  agentId: Uint8Array,
  agent: ReturnType<typeof parseAgentState>,
  stake: Awaited<ReturnType<ReputationEconomyOperations["getStake"]>>,
  effectiveReputation: Awaited<
    ReturnType<ReputationEconomyOperations["getEffectiveReputation"]>
  >,
  inboundDelegations: Awaited<
    ReturnType<ReputationEconomyOperations["getDelegationsTo"]>
  >,
  outboundDelegations: Awaited<
    ReturnType<ReputationEconomyOperations["getDelegationsFrom"]>
  >,
): SerializedMarketplaceReputationSummary {
  return {
    registered: true,
    authority: agent.authority.toBase58(),
    agentPda: agentPda.toBase58(),
    agentId: encodeHex(agentId),
    baseReputation: agent.reputation,
    effectiveReputation,
    tasksCompleted: agent.tasksCompleted.toString(),
    totalEarned: agent.totalEarned.toString(),
    totalEarnedSol: lamportsToSol(agent.totalEarned),
    stakedAmount: stake?.stakedAmount.toString() ?? "0",
    stakedAmountSol: lamportsToSol(stake?.stakedAmount ?? 0n),
    lockedUntil: stake?.lockedUntil ?? 0,
    inboundDelegations: inboundDelegations.map((entry) => ({
      delegator: entry.delegator.toBase58(),
      amount: entry.amount,
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
    })),
    outboundDelegations: outboundDelegations.map((entry) => ({
      delegatee: entry.delegatee.toBase58(),
      amount: entry.amount,
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
    })),
  };
}

export function buildMarketplaceUnregisteredSummary(
  overrides: Omit<SerializedMarketplaceReputationSummary, "registered"> = {},
): SerializedMarketplaceReputationSummary {
  return {
    registered: false,
    ...overrides,
  };
}

export async function buildMarketplaceReputationSummaryForAgent(
  program: MarketProgram,
  agentPda: PublicKey,
  agentId: Uint8Array,
): Promise<SerializedMarketplaceReputationSummary | null> {
  const rawAgent = await (program.account as any).agentRegistration.fetchNullable(
    agentPda,
  );
  if (!rawAgent) {
    return null;
  }

  const agent = parseAgentState(rawAgent as Record<string, unknown>);
  const ops = new ReputationEconomyOperations({
    program,
    agentId,
    logger: silentLogger,
  });
  const [stake, effectiveReputation, inboundDelegations, outboundDelegations] =
    await Promise.all([
      ops.getStake(agentPda),
      ops.getEffectiveReputation(agentPda),
      ops.getDelegationsTo(agentPda),
      ops.getDelegationsFrom(agentPda),
    ]);

  return buildMarketplaceReputationSummary(
    agentPda,
    agentId,
    agent,
    stake,
    effectiveReputation,
    inboundDelegations,
    outboundDelegations,
  );
}
