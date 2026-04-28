/**
 * JSON-safe serialized types for AgenC built-in tool responses.
 *
 * All bigint → string, PublicKey → base58, Uint8Array → hex,
 * enums → string names.
 *
 * @module
 */

/**
 * JSON-safe representation of verified task marketplace metadata.
 */
export interface SerializedVerifiedTaskMetadata {
  kind: "agenc.marketplace.verifiedTask";
  schemaVersion: 1;
  status: "verified";
  environment: "devnet";
  issuer: "agenc-services-storefront";
  issuerKeyId: string;
  orderId: string;
  serviceTemplateId: string;
  jobSpecHash: string;
  canonicalTaskHash: string;
  verifiedTaskHash: string;
  verifiedTaskUri: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  buyerWallet?: string;
  paymentSignaturePresent: boolean;
  acceptedAt?: string;
  taskPda?: string;
  taskId?: string;
  transactionSignature?: string | null;
}

/**
 * JSON-safe representation of verified job-spec/task metadata.
 */
export interface SerializedTaskJobSpec {
  source: "on-chain" | "local-task-link";
  taskJobSpecPda?: string | null;
  creator?: string | null;
  jobSpecHash: string;
  jobSpecUri: string;
  createdAt?: number;
  updatedAt?: number;
  verified: boolean;
  error?: string;
  verifiedTask?: SerializedVerifiedTaskMetadata | null;
  jobSpecPath?: string | null;
  jobSpecTaskLinkPath?: string | null;
  transactionSignature?: string | null;
  integrity?: {
    algorithm: string;
    canonicalization: string;
    payloadHash: string;
    uri: string;
  } | null;
  payload?: unknown;
}

/**
 * Buyer-facing delivery artifact committed through the fixed on-chain result
 * field. The full artifact remains off-chain; the on-chain field carries a
 * compact hash reference that indexers/storefronts can hydrate.
 */
export interface SerializedTaskDeliveryArtifact {
  sha256: string;
  uri?: string;
  source: 'protocol-result-data' | 'local-artifact-store';
  verified: boolean;
  mediaType?: string;
  sizeBytes?: number;
  fileName?: string;
}

/**
 * JSON-safe representation of an on-chain Task.
 */
export interface SerializedTask {
  taskPda: string;
  taskId: string;
  creator: string;
  status: string;
  taskType: string;
  taskTypeId: number;
  taskTypeKey: string;
  rewardAmount: string;
  rewardSol: string;
  requiredCapabilities: string[];
  maxWorkers: number;
  currentWorkers: number;
  deadline: number;
  isPrivate: boolean;
  createdAt: number;
  completedAt: number;
  completions: number;
  requiredCompletions: number;
  description: string;
  descriptionHex: string;
  constraintHash: string;
  result: string;
  resultText: string | null;
  /** Optional buyer-facing delivery artifact reference committed in resultData. */
  deliveryArtifact?: SerializedTaskDeliveryArtifact | null;
  rewardMint: string | null;
  /** Optional symbol for known reward mints (SOL, USDC, USDT, etc.) */
  rewardSymbol?: string;
  /** Optional verified marketplace job spec metadata for this task. */
  jobSpec?: SerializedTaskJobSpec | null;
  /** Escrow token ATA (present when task is token-denominated and requested by detail view) */
  escrowTokenAccount?: string | null;
  /** Escrow token balance in base units (present when task is token-denominated and requested by detail view) */
  escrowTokenBalance?: string | null;
}

/**
 * JSON-safe representation of an on-chain AgentRegistration.
 */
export interface SerializedAgent {
  agentPda: string;
  agentId: string;
  authority: string;
  status: string;
  capabilities: string[];
  endpoint: string;
  stake: string;
  activeTasks: number;
  reputation: number;
  tasksCompleted: string;
  totalEarned: string;
}

/**
 * JSON-safe representation of the ProtocolConfig.
 */
export interface SerializedProtocolConfig {
  authority: string;
  treasury: string;
  protocolFeeBps: number;
  disputeThreshold: number;
  minAgentStake: string;
  minArbiterStake: string;
  maxClaimDuration: number;
  maxDisputeDuration: number;
  totalAgents: string;
  totalTasks: string;
  completedTasks: string;
  totalValueDistributed: string;
  taskCreationCooldown: number;
  maxTasksPer24h: number;
  disputeInitiationCooldown: number;
  maxDisputesPer24h: number;
  minStakeForDispute: string;
  slashPercentage: number;
  stateUpdateCooldown: number;
  votingPeriod: number;
  protocolVersion: number;
  minSupportedVersion: number;
}

/**
 * JSON-safe representation of a marketplace skill registration.
 */
export interface SerializedSkill {
  skillPda: string;
  skillId: string;
  author: string;
  name: string;
  tags: string[];
  priceLamports: string;
  priceSol?: string;
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

/**
 * JSON-safe representation of a governance proposal summary.
 */
export interface SerializedGovernanceProposalSummary {
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

/**
 * JSON-safe representation of a governance proposal with vote detail.
 */
export interface SerializedGovernanceProposalDetail
  extends SerializedGovernanceProposalSummary {
  executedAt: number;
  votes: Array<{
    voter: string;
    approved: boolean;
    votedAt: number;
    voteWeight: string;
  }>;
}

/**
 * JSON-safe representation of a marketplace dispute summary.
 */
export interface SerializedDisputeSummary {
  disputePda: string;
  taskPda: string;
  initiator: string;
  defendant: string;
  claimant: string;
  respondent: string;
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
  amountAtStake: string | null;
  amountAtStakeSol?: string;
  amountAtStakeMint: string | null;
}

/**
 * JSON-safe representation of a marketplace dispute with additional detail.
 */
export interface SerializedDisputeDetail extends SerializedDisputeSummary {
  disputeId: string;
  initiatorAuthority: string;
  relatedTask?: SerializedTask | null;
}

/**
 * JSON-safe representation of a marketplace reputation summary.
 */
export interface SerializedReputationSummary {
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
  inboundDelegations?: Array<{
    amount: number;
    expiresAt: number;
    createdAt: number;
    delegator?: string;
    delegatee?: string;
  }>;
  outboundDelegations?: Array<{
    amount: number;
    expiresAt: number;
    createdAt: number;
    delegator?: string;
    delegatee?: string;
  }>;
}
