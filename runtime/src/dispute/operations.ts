/**
 * DisputeOperations - On-chain dispute query and transaction operations.
 *
 * Provides methods for fetching disputes/votes from the chain and submitting
 * initiate, vote, resolve, cancel, expire, and slash transactions.
 *
 * @module
 */

import { PublicKey, SystemProgram, type AccountMeta } from "@solana/web3.js";
import { toAnchorBytes } from "../utils/encoding.js";
import type { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  OnChainDispute,
  OnChainDisputeVote,
  InitiateDisputeParams,
  VoteDisputeParams,
  DisputeAcceptedBidSettlement,
  ResolveDisputeParams,
  ExpireDisputeParams,
  ApplySlashParams,
  DisputeResult,
  VoteResult,
} from "./types.js";
import {
  parseOnChainDispute,
  parseOnChainDisputeVote,
  OnChainDisputeStatus,
  DISPUTE_STATUS_OFFSET,
  DISPUTE_TASK_OFFSET,
} from "./types.js";
import { createProgram } from "../idl.js";
import { deriveDisputePda, deriveVotePda } from "./pda.js";
import {
  findAgentPda,
  findAuthorityRateLimitPda,
  findProtocolPda,
  deriveAuthorityVotePda,
} from "../agent/pda.js";
import { fetchTreasury } from "../utils/treasury.js";
import { deriveClaimPda, deriveEscrowPda, deriveTaskSubmissionPda } from "../task/pda.js";
import {
  accountMetaToIntentMeta,
  hexBytes,
  namedAccountMeta,
  type MarketplaceTransactionIntent,
} from "../task/transaction-intent.js";
import {
  buildResolveDisputeTokenAccounts,
  buildExpireDisputeTokenAccounts,
  buildApplyDisputeSlashTokenAccounts,
} from "../utils/token.js";
import {
  isAnchorError,
  AnchorErrorCodes,
  validateByteLength,
  validateNonZeroBytes,
  ValidationError,
} from "../types/errors.js";
import {
  DisputeVoteError,
  DisputeResolutionError,
  DisputeSlashError,
} from "./errors.js";
import { encodeStatusByte, queryWithFallback } from "../utils/query.js";
import type { MetricsProvider } from "../task/types.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for DisputeOperations class.
 */
export interface DisputeOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Agent ID (32 bytes) for deriving agent PDA */
  agentId: Uint8Array;
  /** Logger instance (defaults to silent logger) */
  logger?: Logger;
  /** Optional metrics provider for telemetry */
  metrics?: MetricsProvider;
}

// ============================================================================
// DisputeOperations Class
// ============================================================================

/**
 * On-chain dispute query and transaction operations.
 *
 * Provides methods for:
 * - Querying disputes and votes from the chain
 * - Submitting initiate, vote, resolve, cancel, expire, and slash transactions
 * - Caching PDAs and protocol treasury for efficiency
 *
 * @example
 * ```typescript
 * const ops = new DisputeOperations({
 *   program,
 *   agentId: myAgentId,
 * });
 *
 * const dispute = await ops.fetchDispute(disputePda);
 * if (dispute && dispute.status === OnChainDisputeStatus.Active) {
 *   await ops.voteOnDispute({ disputePda, taskPda, approve: true });
 * }
 * ```
 */
export class DisputeOperations {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;
  private readonly metrics?: MetricsProvider;

  // Cached derived values
  private readonly agentPda: PublicKey;
  private readonly protocolPda: PublicKey;
  private readonly authorityRateLimitPda: PublicKey;
  private cachedTreasury: PublicKey | null = null;

  constructor(config: DisputeOpsConfig) {
    this.program = config.program;
    this.agentId = new Uint8Array(config.agentId);
    this.logger = config.logger ?? silentLogger;
    this.metrics = config.metrics;

    this.agentPda = findAgentPda(this.agentId, this.program.programId);
    this.protocolPda = findProtocolPda(this.program.programId);
    this.authorityRateLimitPda = findAuthorityRateLimitPda(
      this.program.provider.publicKey!,
      this.program.programId,
    );
  }

  private async resolveExistingTaskSubmissionPda(
    claimPda: PublicKey | null,
  ): Promise<PublicKey | null> {
    if (!claimPda) return null;

    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const taskSubmissionAccount = await (
      this.program.account as unknown as {
        taskSubmission?: {
          fetchNullable?: (pda: PublicKey) => Promise<unknown>;
        };
      }
    ).taskSubmission?.fetchNullable?.(taskSubmissionPda);

    return taskSubmissionAccount ? taskSubmissionPda : null;
  }

  private buildInitiateDisputeBuilder(
    program: Program<AgencCoordination>,
    params: InitiateDisputeParams,
    disputePda: PublicKey,
    initiatorClaimPda: PublicKey | null,
    taskSubmissionPda: PublicKey | null,
    remainingAccounts: AccountMeta[],
    mode: "default" | "legacyInitiateDispute",
  ) {
    const builder = (program.methods as any)
      .initiateDispute(
        toAnchorBytes(params.disputeId),
        toAnchorBytes(params.taskId),
        toAnchorBytes(params.evidenceHash),
        params.resolutionType,
        params.evidence,
      )
      .accountsPartial({
        dispute: disputePda,
        task: params.taskPda,
        agent: this.agentPda,
        ...(mode === "default"
          ? { authorityRateLimit: this.authorityRateLimitPda }
          : {}),
        protocolConfig: this.protocolPda,
        initiatorClaim: initiatorClaimPda ?? null,
        workerAgent: params.workerAgentPda ?? null,
        workerClaim: params.workerClaimPda ?? null,
        ...(mode === "default" ? { taskSubmission: taskSubmissionPda } : {}),
        authority: program.provider.publicKey,
        systemProgram: SystemProgram.programId,
      });

    if (remainingAccounts.length > 0) {
      builder.remainingAccounts(remainingAccounts);
    }

    return builder;
  }

  private async shouldRetryLegacyInitiateDispute(err: unknown): Promise<boolean> {
    const message = err instanceof Error ? err.message : String(err);
    if (
      !message.includes("account: protocol_config") ||
      !message.includes("AccountNotInitialized")
    ) {
      return false;
    }

    const authorityRateLimitAccount =
      await this.program.provider.connection.getAccountInfo(
        this.authorityRateLimitPda,
        "confirmed",
      );
    return authorityRateLimitAccount === null;
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Fetch a single dispute by its PDA address.
   *
   * @param disputePda - Dispute account PDA
   * @returns Parsed dispute or null if not found
   */
  async fetchDispute(disputePda: PublicKey): Promise<OnChainDispute | null> {
    try {
      const raw = await this.program.account.dispute.fetchNullable(disputePda);
      if (!raw) return null;
      return this.enrichDisputeWithRewardMint(
        parseOnChainDispute(raw as Record<string, unknown>),
      );
    } catch (err) {
      this.logger.error(
        `Failed to fetch dispute ${disputePda.toBase58()}: ${err}`,
      );
      throw err;
    }
  }

  /**
   * Fetch a dispute by its ID, also returning the derived PDA.
   *
   * @param disputeId - 32-byte dispute identifier
   * @returns Object with parsed dispute and PDA, or null if not found
   */
  async fetchDisputeByIds(
    disputeId: Uint8Array,
  ): Promise<{ dispute: OnChainDispute; disputePda: PublicKey } | null> {
    const { address: disputePda } = deriveDisputePda(
      disputeId,
      this.program.programId,
    );
    const dispute = await this.fetchDispute(disputePda);
    if (!dispute) return null;
    return { dispute, disputePda };
  }

  /**
   * Fetch all disputes from the chain.
   *
   * @returns Array of all disputes with their PDAs
   */
  async fetchAllDisputes(): Promise<
    Array<{ dispute: OnChainDispute; disputePda: PublicKey }>
  > {
    const accounts = await this.program.account.dispute.all();
    const parsed = await Promise.all(
      accounts.map(async (acc) => ({
        dispute: await this.enrichDisputeWithRewardMint(
          parseOnChainDispute(acc.account as Record<string, unknown>),
        ),
        disputePda: acc.publicKey,
      })),
    );
    return parsed;
  }

  /**
   * Fetch all active disputes using memcmp filter on status field.
   *
   * @returns Array of active disputes with their PDAs
   */
  async fetchActiveDisputes(): Promise<
    Array<{ dispute: OnChainDispute; disputePda: PublicKey }>
  > {
    return queryWithFallback(
      async () => {
        const accounts = await this.program.account.dispute.all([
          {
            memcmp: {
              offset: DISPUTE_STATUS_OFFSET,
              bytes: encodeStatusByte(OnChainDisputeStatus.Active),
            },
          },
        ]);
        return Promise.all(
          accounts.map(async (acc) => ({
            dispute: await this.enrichDisputeWithRewardMint(
              parseOnChainDispute(acc.account as Record<string, unknown>),
            ),
            disputePda: acc.publicKey,
          })),
        );
      },
      async () => {
        const all = await this.fetchAllDisputes();
        return all.filter(
          ({ dispute }) => dispute.status === OnChainDisputeStatus.Active,
        );
      },
      this.logger,
      "fetchActiveDisputes",
    );
  }

  /**
   * Fetch all disputes for a specific task using memcmp filter.
   *
   * @param taskPda - Task account PDA
   * @returns Array of disputes for the task
   */
  async fetchDisputesForTask(
    taskPda: PublicKey,
  ): Promise<Array<{ dispute: OnChainDispute; disputePda: PublicKey }>> {
    return queryWithFallback(
      async () => {
        const accounts = await this.program.account.dispute.all([
          {
            memcmp: {
              offset: DISPUTE_TASK_OFFSET,
              bytes: taskPda.toBase58(),
            },
          },
        ]);
        return Promise.all(
          accounts.map(async (acc) => ({
            dispute: await this.enrichDisputeWithRewardMint(
              parseOnChainDispute(acc.account as Record<string, unknown>),
            ),
            disputePda: acc.publicKey,
          })),
        );
      },
      async () => {
        const all = await this.fetchAllDisputes();
        return all.filter(({ dispute }) => dispute.task.equals(taskPda));
      },
      this.logger,
      "fetchDisputesForTask",
    );
  }

  /**
   * Fetch a single dispute vote by its PDA address.
   *
   * @param votePda - Vote account PDA
   * @returns Parsed vote or null if not found
   */
  async fetchVote(votePda: PublicKey): Promise<OnChainDisputeVote | null> {
    try {
      const raw = await this.program.account.disputeVote.fetchNullable(votePda);
      if (!raw) return null;
      return parseOnChainDisputeVote(raw as Record<string, unknown>);
    } catch (err) {
      this.logger.error(`Failed to fetch vote ${votePda.toBase58()}: ${err}`);
      throw err;
    }
  }

  async previewInitiateDisputeIntent(
    params: InitiateDisputeParams,
  ): Promise<MarketplaceTransactionIntent> {
    const { address: disputePda } = deriveDisputePda(
      params.disputeId,
      this.program.programId,
    );
    const { address: derivedClaimPda } = deriveClaimPda(
      params.taskPda,
      this.agentPda,
      this.program.programId,
    );
    const initiatorClaimPda =
      params.initiatorClaimPda === undefined
        ? derivedClaimPda
        : params.initiatorClaimPda;
    const taskSubmissionClaimPda =
      params.workerClaimPda ?? initiatorClaimPda ?? null;
    const taskSubmissionPda = await this.resolveExistingTaskSubmissionPda(
      taskSubmissionClaimPda,
    );
    return this.buildInitiateDisputeIntent(
      params,
      disputePda,
      initiatorClaimPda,
      taskSubmissionPda,
      this.buildRemainingAccounts(undefined, params.defendantWorkers),
    );
  }

  async previewVoteDisputeIntent(
    params: VoteDisputeParams,
  ): Promise<MarketplaceTransactionIntent> {
    const dispute = await this.fetchDispute(params.disputePda);
    const { address: votePda } = deriveVotePda(
      params.disputePda,
      this.agentPda,
      this.program.programId,
    );
    const { address: authVotePda } = deriveAuthorityVotePda(
      params.disputePda,
      this.program.provider.publicKey!,
      this.program.programId,
    );
    return this.buildVoteDisputeIntent(params, dispute, votePda, authVotePda);
  }

  async previewResolveDisputeIntent(
    params: ResolveDisputeParams,
  ): Promise<MarketplaceTransactionIntent> {
    const { address: escrowPda } = deriveEscrowPda(
      params.taskPda,
      this.program.programId,
    );
    const rawTask = (await this.program.account.task.fetch(
      params.taskPda,
    )) as { rewardMint: PublicKey | null };
    const treasury = await this.getTreasury();
    const tokenAccounts = buildResolveDisputeTokenAccounts(
      rawTask.rewardMint ?? null,
      escrowPda,
      params.creatorPubkey,
      params.workerAuthority ?? null,
      treasury,
    );
    const remainingAccounts = this.buildRemainingAccounts(
      params.arbiterVotes,
      params.extraWorkers,
      params.acceptedBidSettlement,
    );
    return this.buildResolveDisputeIntent(
      params,
      escrowPda,
      treasury,
      tokenAccounts,
      remainingAccounts,
    );
  }

  async previewCancelDisputeIntent(
    disputePda: PublicKey,
    taskPda: PublicKey,
  ): Promise<MarketplaceTransactionIntent> {
    const dispute = await this.fetchDispute(disputePda);
    return this.buildCancelDisputeIntent(disputePda, taskPda, dispute);
  }

  async previewExpireDisputeIntent(
    params: ExpireDisputeParams,
  ): Promise<MarketplaceTransactionIntent> {
    const { address: escrowPda } = deriveEscrowPda(
      params.taskPda,
      this.program.programId,
    );
    const rawTask = (await this.program.account.task.fetch(
      params.taskPda,
    )) as { rewardMint: PublicKey | null };
    const tokenAccounts = buildExpireDisputeTokenAccounts(
      rawTask.rewardMint ?? null,
      escrowPda,
      params.creatorPubkey,
      params.workerAuthority ?? null,
    );
    const remainingAccounts = this.buildRemainingAccounts(
      params.arbiterVotes,
      params.extraWorkers,
      params.acceptedBidSettlement,
    );
    return this.buildExpireDisputeIntent(
      params,
      escrowPda,
      tokenAccounts,
      remainingAccounts,
    );
  }

  async previewApplySlashIntent(
    params: ApplySlashParams,
  ): Promise<MarketplaceTransactionIntent> {
    const treasury = await this.getTreasury();
    const { address: escrowPda } = deriveEscrowPda(
      params.taskPda,
      this.program.programId,
    );
    const rawTask = (await this.program.account.task.fetch(
      params.taskPda,
    )) as { rewardMint: PublicKey | null };
    const tokenAccounts = buildApplyDisputeSlashTokenAccounts(
      rawTask.rewardMint ?? null,
      escrowPda,
      treasury,
    );
    return this.buildApplySlashIntent(params, escrowPda, treasury, tokenAccounts);
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  /**
   * Initiate a dispute for a task.
   *
   * @param params - Dispute initiation parameters
   * @returns Dispute result with PDA and transaction signature
   */
  async initiateDispute(params: InitiateDisputeParams): Promise<DisputeResult> {
    // Input validation (#963)
    validateByteLength(params.disputeId, 32, "disputeId");
    validateByteLength(params.taskId, 32, "taskId");
    validateByteLength(params.evidenceHash, 32, "evidenceHash");
    validateNonZeroBytes(params.evidenceHash, "evidenceHash");
    if (!params.evidence || params.evidence.length === 0) {
      throw new ValidationError("Invalid evidence: cannot be empty");
    }
    if (params.evidence.length > 256) {
      throw new ValidationError(
        "Invalid evidence: exceeds maximum length (256 characters)",
      );
    }
    if (params.resolutionType < 0 || params.resolutionType > 2) {
      throw new ValidationError(
        "Invalid resolution type: must be 0 (Refund), 1 (Complete), or 2 (Split)",
      );
    }

    const start = Date.now();
    const { address: disputePda } = deriveDisputePda(
      params.disputeId,
      this.program.programId,
    );
    const { address: derivedClaimPda } = deriveClaimPda(
      params.taskPda,
      this.agentPda,
      this.program.programId,
    );
    const initiatorClaimPda =
      params.initiatorClaimPda === undefined
        ? derivedClaimPda
        : params.initiatorClaimPda;
    const taskSubmissionClaimPda =
      params.workerClaimPda ?? initiatorClaimPda ?? null;
    const taskSubmissionPda = await this.resolveExistingTaskSubmissionPda(
      taskSubmissionClaimPda,
    );

    this.logger.info(
      `Initiating dispute for task ${params.taskPda.toBase58()}`,
    );

    try {
      const remainingAccounts = this.buildRemainingAccounts(
        undefined,
        params.defendantWorkers,
      );
      this.buildInitiateDisputeIntent(
        params,
        disputePda,
        initiatorClaimPda,
        taskSubmissionPda,
        remainingAccounts,
      );
      const signature = await this.buildInitiateDisputeBuilder(
        this.program,
        params,
        disputePda,
        initiatorClaimPda,
        taskSubmissionPda,
        remainingAccounts,
        "default",
      ).rpc();

      this.logger.info(`Dispute initiated: ${signature}`);
      this.recordDisputeMetrics("initiate", Date.now() - start);

      return { disputePda, transactionSignature: signature };
    } catch (err) {
      if (await this.shouldRetryLegacyInitiateDispute(err)) {
        this.logger.warn(
          "Retrying dispute initiation with legacy devnet account layout compatibility",
        );

        const legacyProgram = createProgram(
          this.program.provider as AnchorProvider,
          this.program.programId,
          "legacyInitiateDispute",
        );
        const remainingAccounts = this.buildRemainingAccounts(
          undefined,
          params.defendantWorkers,
        );
        const signature = await this.buildInitiateDisputeBuilder(
          legacyProgram,
          params,
          disputePda,
          initiatorClaimPda,
          taskSubmissionPda,
          remainingAccounts,
          "legacyInitiateDispute",
        ).rpc();

        this.logger.info(
          `Dispute initiated via legacy compatibility path: ${signature}`,
        );
        this.recordDisputeMetrics("initiate", Date.now() - start);

        return { disputePda, transactionSignature: signature };
      }

      const pda = disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.InsufficientEvidence)) {
        throw new DisputeResolutionError(pda, "Insufficient evidence provided");
      }
      if (isAnchorError(err, AnchorErrorCodes.EvidenceTooLong)) {
        throw new DisputeResolutionError(
          pda,
          "Evidence exceeds maximum allowed length",
        );
      }
      if (isAnchorError(err, AnchorErrorCodes.InsufficientStakeForDispute)) {
        throw new DisputeResolutionError(
          pda,
          "Insufficient stake to initiate dispute",
        );
      }
      this.logger.error(`Failed to initiate dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Vote on an active dispute.
   *
   * @param params - Vote parameters
   * @returns Vote result with PDA and transaction signature
   */
  async voteOnDispute(params: VoteDisputeParams): Promise<VoteResult> {
    const start = Date.now();
    const dispute = await this.fetchDispute(params.disputePda);
    const { address: votePda } = deriveVotePda(
      params.disputePda,
      this.agentPda,
      this.program.programId,
    );
    const { address: authVotePda } = deriveAuthorityVotePda(
      params.disputePda,
      this.program.provider.publicKey!,
      this.program.programId,
    );

    this.logger.info(
      `Voting ${params.approve ? "for" : "against"} dispute ${params.disputePda.toBase58()}`,
    );
    this.buildVoteDisputeIntent(params, dispute, votePda, authVotePda);

    try {
      const signature = await this.program.methods
        .voteDispute(params.approve)
        .accountsPartial({
          dispute: params.disputePda,
          task: params.taskPda,
          workerClaim: params.workerClaimPda ?? null,
          defendantAgent: dispute?.defendant ?? null,
          vote: votePda,
          authorityVote: authVotePda,
          arbiter: this.agentPda,
          protocolConfig: this.protocolPda,
          authority: this.program.provider.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Vote cast: ${signature}`);
      this.recordDisputeMetrics("vote", Date.now() - start);

      return { votePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeVoteError(pda, "Dispute is not active");
      }
      if (isAnchorError(err, AnchorErrorCodes.VotingEnded)) {
        throw new DisputeVoteError(pda, "Voting period has ended");
      }
      if (isAnchorError(err, AnchorErrorCodes.AlreadyVoted)) {
        throw new DisputeVoteError(pda, "Already voted on this dispute");
      }
      if (isAnchorError(err, AnchorErrorCodes.NotArbiter)) {
        throw new DisputeVoteError(
          pda,
          "Not authorized to vote (not an arbiter)",
        );
      }
      this.logger.error(`Failed to vote on dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Resolve a dispute after voting period ends.
   *
   * @param params - Resolution parameters
   * @returns Dispute result with transaction signature
   */
  async resolveDispute(params: ResolveDisputeParams): Promise<DisputeResult> {
    const start = Date.now();
    const { address: escrowPda } = deriveEscrowPda(
      params.taskPda,
      this.program.programId,
    );

    this.logger.info(`Resolving dispute ${params.disputePda.toBase58()}`);

    try {
      // Fetch task to determine if it's a token task (only need rewardMint)
      const rawTask = (await this.program.account.task.fetch(
        params.taskPda,
      )) as { rewardMint: PublicKey | null };
      const treasury = await this.getTreasury();
      const tokenAccounts = buildResolveDisputeTokenAccounts(
        rawTask.rewardMint ?? null,
        escrowPda,
        params.creatorPubkey,
        params.workerAuthority ?? null,
        treasury,
      );

      const remainingAccounts = this.buildRemainingAccounts(
        params.arbiterVotes,
        params.extraWorkers,
        params.acceptedBidSettlement,
      );
      this.buildResolveDisputeIntent(
        params,
        escrowPda,
        treasury,
        tokenAccounts,
        remainingAccounts,
      );

      const builder = this.program.methods.resolveDispute().accountsPartial({
        dispute: params.disputePda,
        task: params.taskPda,
        escrow: escrowPda,
        protocolConfig: this.protocolPda,
        authority: this.program.provider.publicKey,
        creator: params.creatorPubkey,
        workerClaim: params.workerClaimPda ?? null,
        worker: params.workerAgentPda ?? null,
        workerWallet: params.workerAuthority ?? null,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Dispute resolved: ${signature}`);
      this.recordDisputeMetrics("resolve", Date.now() - start);

      return { disputePda: params.disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeResolutionError(pda, "Dispute is not active");
      }
      if (isAnchorError(err, AnchorErrorCodes.VotingNotEnded)) {
        throw new DisputeResolutionError(pda, "Voting period has not ended");
      }
      if (isAnchorError(err, AnchorErrorCodes.InsufficientVotes)) {
        throw new DisputeResolutionError(pda, "Insufficient votes to resolve");
      }
      if (isAnchorError(err, AnchorErrorCodes.UnauthorizedResolver)) {
        throw new DisputeResolutionError(
          pda,
          "Not authorized to resolve this dispute",
        );
      }
      if (isAnchorError(err, AnchorErrorCodes.DisputeAlreadyResolved)) {
        throw new DisputeResolutionError(
          pda,
          "Dispute has already been resolved",
        );
      }
      this.logger.error(`Failed to resolve dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Cancel a dispute (only by initiator, before votes are cast).
   *
   * @param disputePda - Dispute account PDA
   * @param taskPda - Task account PDA
   * @returns Dispute result with transaction signature
   */
  async cancelDispute(
    disputePda: PublicKey,
    taskPda: PublicKey,
  ): Promise<DisputeResult> {
    const start = Date.now();
    this.logger.info(`Cancelling dispute ${disputePda.toBase58()}`);

    try {
      const dispute = await this.fetchDispute(disputePda);
      if (!dispute) {
        throw new DisputeResolutionError(
          disputePda.toBase58(),
          "Dispute not found",
        );
      }
      this.buildCancelDisputeIntent(disputePda, taskPda, dispute);

      const signature = await (this.program.methods.cancelDispute() as any)
        .accountsPartial({
          protocolConfig: this.protocolPda,
          dispute: disputePda,
          task: taskPda,
          authority: this.program.provider.publicKey,
        })
        .remainingAccounts([
          { pubkey: dispute.defendant, isSigner: false, isWritable: true },
        ])
        .rpc();

      this.logger.info(`Dispute cancelled: ${signature}`);
      this.recordDisputeMetrics("cancel", Date.now() - start);

      return { disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeResolutionError(pda, "Dispute is not active");
      }
      if (isAnchorError(err, AnchorErrorCodes.UnauthorizedResolver)) {
        throw new DisputeResolutionError(
          pda,
          "Only the dispute initiator can cancel",
        );
      }
      this.logger.error(`Failed to cancel dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Expire a dispute after its expiration deadline.
   * This is a permissionless operation (no signer constraint beyond fee payer).
   *
   * @param params - Expiration parameters
   * @returns Dispute result with transaction signature
   */
  async expireDispute(params: ExpireDisputeParams): Promise<DisputeResult> {
    const start = Date.now();
    const { address: escrowPda } = deriveEscrowPda(
      params.taskPda,
      this.program.programId,
    );

    this.logger.info(`Expiring dispute ${params.disputePda.toBase58()}`);

    try {
      // Fetch task to determine if it's a token task (only need rewardMint)
      const rawTask = (await this.program.account.task.fetch(
        params.taskPda,
      )) as { rewardMint: PublicKey | null };
      const tokenAccounts = buildExpireDisputeTokenAccounts(
        rawTask.rewardMint ?? null,
        escrowPda,
        params.creatorPubkey,
        params.workerAuthority ?? null,
      );

      const remainingAccounts = this.buildRemainingAccounts(
        params.arbiterVotes,
        params.extraWorkers,
        params.acceptedBidSettlement,
      );
      this.buildExpireDisputeIntent(
        params,
        escrowPda,
        tokenAccounts,
        remainingAccounts,
      );

      const builder = this.program.methods.expireDispute().accountsPartial({
        dispute: params.disputePda,
        task: params.taskPda,
        escrow: escrowPda,
        protocolConfig: this.protocolPda,
        creator: params.creatorPubkey,
        authority: this.program.provider.publicKey,
        workerClaim: params.workerClaimPda ?? null,
        worker: params.workerAgentPda ?? null,
        workerWallet: params.workerAuthority ?? null,
        ...tokenAccounts,
      });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Dispute expired: ${signature}`);
      this.recordDisputeMetrics("expire", Date.now() - start);

      return { disputePda: params.disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotExpired)) {
        throw new DisputeResolutionError(pda, "Dispute has not expired yet");
      }
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeResolutionError(pda, "Dispute is not active");
      }
      this.logger.error(`Failed to expire dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Apply a dispute slash to a worker's stake.
   * This is a permissionless operation (no signer constraint beyond fee payer).
   *
   * @param params - Slash parameters
   * @returns Dispute result with transaction signature
   */
  async applySlash(params: ApplySlashParams): Promise<DisputeResult> {
    const start = Date.now();
    const treasury = await this.getTreasury();
    const { address: escrowPda } = deriveEscrowPda(
      params.taskPda,
      this.program.programId,
    );

    this.logger.info(
      `Applying slash for dispute ${params.disputePda.toBase58()}`,
    );

    try {
      const rawTask = (await this.program.account.task.fetch(
        params.taskPda,
      )) as { rewardMint: PublicKey | null };
      const tokenAccounts = buildApplyDisputeSlashTokenAccounts(
        rawTask.rewardMint ?? null,
        escrowPda,
        treasury,
      );
      this.buildApplySlashIntent(params, escrowPda, treasury, tokenAccounts);

      const signature = await this.program.methods
        .applyDisputeSlash()
        .accountsPartial({
          dispute: params.disputePda,
          task: params.taskPda,
          workerClaim: params.workerClaimPda,
          workerAgent: params.workerAgentPda,
          protocolConfig: this.protocolPda,
          treasury,
          authority: this.program.provider.publicKey,
          ...tokenAccounts,
        })
        .rpc();

      this.logger.info(`Slash applied: ${signature}`);
      this.recordDisputeMetrics("applySlash", Date.now() - start);

      return { disputePda: params.disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.SlashAlreadyApplied)) {
        throw new DisputeSlashError(pda, "Slash has already been applied");
      }
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotResolved)) {
        throw new DisputeSlashError(pda, "Dispute has not been resolved");
      }
      this.logger.error(`Failed to apply slash: ${err}`);
      throw err;
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private buildInitiateDisputeIntent(
    params: InitiateDisputeParams,
    disputePda: PublicKey,
    initiatorClaimPda: PublicKey | null,
    taskSubmissionPda: PublicKey | null,
    remainingAccounts: AccountMeta[],
  ): MarketplaceTransactionIntent {
    return {
      kind: "initiate_dispute",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: params.taskPda.toBase58(),
      taskId: hexBytes(params.taskId),
      disputePda: disputePda.toBase58(),
      disputeId: hexBytes(params.disputeId),
      claimPda: initiatorClaimPda?.toBase58(),
      workerPda: params.workerAgentPda?.toBase58(),
      evidenceHash: hexBytes(params.evidenceHash),
      resolutionType: String(params.resolutionType),
      accountMetas: [
        namedAccountMeta("dispute", disputePda, true),
        namedAccountMeta("task", params.taskPda, true),
        namedAccountMeta("agent", this.agentPda, true),
        namedAccountMeta("authorityRateLimit", this.authorityRateLimitPda, true),
        namedAccountMeta("protocolConfig", this.protocolPda, false),
        ...(initiatorClaimPda
          ? [namedAccountMeta("initiatorClaim", initiatorClaimPda, true)]
          : []),
        ...(params.workerAgentPda
          ? [namedAccountMeta("workerAgent", params.workerAgentPda, true)]
          : []),
        ...(params.workerClaimPda
          ? [namedAccountMeta("workerClaim", params.workerClaimPda, true)]
          : []),
        ...(taskSubmissionPda
          ? [namedAccountMeta("taskSubmission", taskSubmissionPda, true)]
          : []),
        ...(this.program.provider.publicKey
          ? [namedAccountMeta("authority", this.program.provider.publicKey, true, true)]
          : []),
        namedAccountMeta("systemProgram", SystemProgram.programId, false),
        ...remainingAccounts.map((account, index) =>
          accountMetaToIntentMeta(`remaining.${index}`, account),
        ),
      ],
    };
  }

  private buildVoteDisputeIntent(
    params: VoteDisputeParams,
    dispute: OnChainDispute | null,
    votePda: PublicKey,
    authVotePda: PublicKey,
  ): MarketplaceTransactionIntent {
    return {
      kind: "vote_dispute",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: params.taskPda.toBase58(),
      disputePda: params.disputePda.toBase58(),
      workerPda: dispute?.defendant.toBase58(),
      accountMetas: [
        namedAccountMeta("dispute", params.disputePda, true),
        namedAccountMeta("task", params.taskPda, true),
        ...(params.workerClaimPda
          ? [namedAccountMeta("workerClaim", params.workerClaimPda, true)]
          : []),
        ...(dispute?.defendant
          ? [namedAccountMeta("defendantAgent", dispute.defendant, false)]
          : []),
        namedAccountMeta("vote", votePda, true),
        namedAccountMeta("authorityVote", authVotePda, true),
        namedAccountMeta("arbiter", this.agentPda, true),
        namedAccountMeta("protocolConfig", this.protocolPda, false),
        ...(this.program.provider.publicKey
          ? [namedAccountMeta("authority", this.program.provider.publicKey, true, true)]
          : []),
        namedAccountMeta("systemProgram", SystemProgram.programId, false),
      ],
    };
  }

  private buildResolveDisputeIntent(
    params: ResolveDisputeParams,
    escrowPda: PublicKey,
    treasury: PublicKey,
    tokenAccounts: Record<string, PublicKey | null | undefined>,
    remainingAccounts: AccountMeta[],
  ): MarketplaceTransactionIntent {
    return {
      kind: "resolve_dispute",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: params.taskPda.toBase58(),
      disputePda: params.disputePda.toBase58(),
      claimPda: params.workerClaimPda?.toBase58(),
      workerPda: params.workerAgentPda?.toBase58(),
      accountMetas: [
        namedAccountMeta("dispute", params.disputePda, true),
        namedAccountMeta("task", params.taskPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("protocolConfig", this.protocolPda, false),
        ...(this.program.provider.publicKey
          ? [namedAccountMeta("authority", this.program.provider.publicKey, true, true)]
          : []),
        namedAccountMeta("creator", params.creatorPubkey, true),
        ...(params.workerClaimPda
          ? [namedAccountMeta("workerClaim", params.workerClaimPda, true)]
          : []),
        ...(params.workerAgentPda
          ? [namedAccountMeta("worker", params.workerAgentPda, true)]
          : []),
        ...(params.workerAuthority
          ? [namedAccountMeta("workerWallet", params.workerAuthority, true)]
          : []),
        namedAccountMeta("treasury", treasury, true),
        namedAccountMeta("systemProgram", SystemProgram.programId, false),
        ...Object.entries(tokenAccounts)
          .filter((entry): entry is [string, PublicKey] => entry[1] instanceof PublicKey)
          .map(([name, pubkey]) => namedAccountMeta(name, pubkey, true)),
        ...remainingAccounts.map((account, index) =>
          accountMetaToIntentMeta(`remaining.${index}`, account),
        ),
      ],
    };
  }

  private buildCancelDisputeIntent(
    disputePda: PublicKey,
    taskPda: PublicKey,
    dispute: OnChainDispute | null,
  ): MarketplaceTransactionIntent {
    return {
      kind: "cancel_dispute",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: taskPda.toBase58(),
      disputePda: disputePda.toBase58(),
      workerPda: dispute?.defendant.toBase58(),
      accountMetas: [
        namedAccountMeta("dispute", disputePda, true),
        namedAccountMeta("task", taskPda, true),
        ...(this.program.provider.publicKey
          ? [namedAccountMeta("authority", this.program.provider.publicKey, true, true)]
          : []),
        ...(dispute?.defendant
          ? [namedAccountMeta("defendant", dispute.defendant, true)]
          : []),
      ],
    };
  }

  private buildExpireDisputeIntent(
    params: ExpireDisputeParams,
    escrowPda: PublicKey,
    tokenAccounts: Record<string, PublicKey | null | undefined>,
    remainingAccounts: AccountMeta[],
  ): MarketplaceTransactionIntent {
    return {
      kind: "expire_dispute",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: params.taskPda.toBase58(),
      disputePda: params.disputePda.toBase58(),
      claimPda: params.workerClaimPda?.toBase58(),
      workerPda: params.workerAgentPda?.toBase58(),
      accountMetas: [
        namedAccountMeta("dispute", params.disputePda, true),
        namedAccountMeta("task", params.taskPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("protocolConfig", this.protocolPda, false),
        namedAccountMeta("creator", params.creatorPubkey, true),
        ...(this.program.provider.publicKey
          ? [namedAccountMeta("authority", this.program.provider.publicKey, true, true)]
          : []),
        ...(params.workerClaimPda
          ? [namedAccountMeta("workerClaim", params.workerClaimPda, true)]
          : []),
        ...(params.workerAgentPda
          ? [namedAccountMeta("worker", params.workerAgentPda, true)]
          : []),
        ...(params.workerAuthority
          ? [namedAccountMeta("workerWallet", params.workerAuthority, true)]
          : []),
        ...Object.entries(tokenAccounts)
          .filter((entry): entry is [string, PublicKey] => entry[1] instanceof PublicKey)
          .map(([name, pubkey]) => namedAccountMeta(name, pubkey, true)),
        ...remainingAccounts.map((account, index) =>
          accountMetaToIntentMeta(`remaining.${index}`, account),
        ),
      ],
    };
  }

  private buildApplySlashIntent(
    params: ApplySlashParams,
    escrowPda: PublicKey,
    treasury: PublicKey,
    tokenAccounts: Record<string, PublicKey | null | undefined>,
  ): MarketplaceTransactionIntent {
    return {
      kind: "apply_dispute_slash",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: params.taskPda.toBase58(),
      disputePda: params.disputePda.toBase58(),
      claimPda: params.workerClaimPda.toBase58(),
      workerPda: params.workerAgentPda.toBase58(),
      accountMetas: [
        namedAccountMeta("dispute", params.disputePda, true),
        namedAccountMeta("task", params.taskPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("workerClaim", params.workerClaimPda, true),
        namedAccountMeta("workerAgent", params.workerAgentPda, true),
        namedAccountMeta("protocolConfig", this.protocolPda, false),
        namedAccountMeta("treasury", treasury, true),
        ...(this.program.provider.publicKey
          ? [namedAccountMeta("authority", this.program.provider.publicKey, true, true)]
          : []),
        ...Object.entries(tokenAccounts)
          .filter((entry): entry is [string, PublicKey] => entry[1] instanceof PublicKey)
          .map(([name, pubkey]) => namedAccountMeta(name, pubkey, true)),
      ],
    };
  }

  private recordDisputeMetrics(operation: string, durationMs: number): void {
    if (!this.metrics) return;
    const labels = { operation };
    this.metrics.counter(TELEMETRY_METRIC_NAMES.DISPUTE_OPS_TOTAL, 1, labels);
    this.metrics.histogram(
      TELEMETRY_METRIC_NAMES.DISPUTE_OP_DURATION,
      durationMs,
      labels,
    );
  }

  /**
   * Get the protocol treasury address, fetching and caching from protocolConfig.
   */
  private async getTreasury(): Promise<PublicKey> {
    if (this.cachedTreasury) return this.cachedTreasury;
    this.cachedTreasury = await fetchTreasury(
      this.program,
      this.program.programId,
    );
    return this.cachedTreasury;
  }

  /**
   * Build remaining_accounts array from arbiter votes, worker pairs, and optional
   * accepted-bid settlement suffix.
   *
   * Order:
   * 1. arbiter (vote, agent) pairs
   * 2. worker (claim, agent) pairs
   * 3. optional accepted-bid settlement accounts
   *
   * All accounts are writable, non-signer.
   */
  private buildRemainingAccounts(
    arbiterVotes?: Array<{ votePda: PublicKey; arbiterAgentPda: PublicKey }>,
    workers?: Array<{ claimPda: PublicKey; workerPda: PublicKey }>,
    acceptedBidSettlement?: DisputeAcceptedBidSettlement,
  ): AccountMeta[] {
    const accounts: AccountMeta[] = [];
    for (const { votePda, arbiterAgentPda } of arbiterVotes ?? []) {
      accounts.push({ pubkey: votePda, isSigner: false, isWritable: true });
      accounts.push({
        pubkey: arbiterAgentPda,
        isSigner: false,
        isWritable: true,
      });
    }
    for (const { claimPda, workerPda } of workers ?? []) {
      accounts.push({ pubkey: claimPda, isSigner: false, isWritable: true });
      accounts.push({ pubkey: workerPda, isSigner: false, isWritable: true });
    }
    if (acceptedBidSettlement) {
      accounts.push({
        pubkey: acceptedBidSettlement.bidBook,
        isSigner: false,
        isWritable: true,
      });
      accounts.push({
        pubkey: acceptedBidSettlement.acceptedBid,
        isSigner: false,
        isWritable: true,
      });
      accounts.push({
        pubkey: acceptedBidSettlement.bidderMarketState,
        isSigner: false,
        isWritable: true,
      });
    }
    return accounts;
  }

  /**
   * Attach the disputed task's reward mint to a parsed dispute.
   * Falls back to null if the task cannot be fetched.
   */
  private async enrichDisputeWithRewardMint(
    dispute: OnChainDispute,
  ): Promise<OnChainDispute> {
    try {
      const rawTask = (await this.program.account.task.fetch(dispute.task)) as {
        rewardMint: PublicKey | null;
      };
      return { ...dispute, rewardMint: rawTask.rewardMint ?? null };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch reward mint for dispute task ${dispute.task.toBase58()}: ${String(err)}`,
      );
      return { ...dispute, rewardMint: null };
    }
  }
}
