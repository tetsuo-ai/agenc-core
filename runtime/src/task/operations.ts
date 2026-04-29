/**
 * TaskOperations - On-chain task query and transaction operations.
 *
 * Provides methods for fetching tasks/claims from the chain and submitting
 * claim/complete transactions. Independent of AgentManager — takes a program
 * instance directly.
 *
 * @module
 */

import { PublicKey, SystemProgram, type AccountMeta } from "@solana/web3.js";
import {
  deriveZkConfigPda,
  HASH_SIZE,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BYTES_LEN,
  TRUSTED_RISC0_SELECTOR,
  getAssociatedTokenAddressSync,
} from "@tetsuo-ai/sdk";
import { toAnchorBytes } from "../utils/encoding.js";
import type { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  OnChainTask,
  OnChainTaskClaim,
  ClaimResult,
  CompleteResult,
  TaskSubmissionResult,
  TaskCompletionOptions,
  TaskValidationConfigResult,
  TaskValidationMode,
} from "./types.js";
import {
  isManualValidationTask,
  parseOnChainTask,
  parseOnChainTaskAccountData,
  parseOnChainTaskClaim,
  OnChainTaskStatus,
} from "./types.js";
import {
  deriveTaskPda,
  deriveClaimPda,
  deriveEscrowPda,
  deriveTaskValidationConfigPda,
  deriveTaskAttestorConfigPda,
  deriveTaskSubmissionPda,
  deriveTaskValidationVotePda,
} from "./pda.js";
import { deriveAgentPda, findProtocolPda } from "../agent/pda.js";
import { parseAgentState } from "../agent/types.js";
import { fetchTreasury } from "../utils/treasury.js";
import { buildCompleteTaskTokenAccounts } from "../utils/token.js";
import {
  type MarketplaceJobSpecStoreOptions,
  resolveMarketplaceJobSpecReference,
} from "../marketplace/job-spec-store.js";
import {
  fetchTaskJobSpecPointer,
  resolveOnChainTaskJobSpecForTask,
  type OnChainTaskJobSpecPointer,
} from "../marketplace/task-job-spec.js";
import {
  compileResolvedMarketplaceTaskJob,
  type CompiledJob,
} from "./compiled-job.js";
import {
  isAnchorError,
  parseAnchorError,
  TaskNotClaimableError,
  TaskSubmissionError,
  AnchorErrorCodes,
  ValidationError,
  validateByteLength,
  validateNonZeroBytes,
} from "../types/errors.js";
import { encodeStatusByte, queryWithFallback } from "../utils/query.js";
import {
  accountMetaToIntentMeta,
  hexBytes,
  namedAccountMeta,
  type MarketplaceTransactionIntent,
} from "./transaction-intent.js";

// ============================================================================
// Account Layout Constants
// ============================================================================

/**
 * Byte offset of the `status` field in the on-chain Task account.
 *
 * Layout: 8 (discriminator) + 32 (task_id) + 32 (creator) + 8 (required_capabilities)
 *       + 64 (description) + 32 (constraint_hash) + 8 (reward_amount)
 *       + 1 (max_workers) + 1 (current_workers) = 186
 */
export const TASK_STATUS_OFFSET = 186;

const BINDING_SPEND_SEED = Buffer.from("binding_spend");
const NULLIFIER_SPEND_SEED = Buffer.from("nullifier_spend");
const ROUTER_SEED = Buffer.from("router");
const VERIFIER_SEED = Buffer.from("verifier");
const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new PublicKey(
  "E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ",
);
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new PublicKey(
  "3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc",
);

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for TaskOperations class.
 */
export interface TaskOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Agent ID (32 bytes) for deriving agent PDA */
  agentId: Uint8Array;
  /** Logger instance (defaults to silent logger) */
  logger?: Logger;
  /** Root directory for marketplace job spec objects and task links */
  jobSpecStoreDir?: string;
  /** Allow claim-time verification to fetch remote https job specs. Defaults to false. */
  allowRemoteJobSpecResolution?: boolean;
  /**
   * Claim-time job spec verification policy.
   *
   * - "when-present" (default): verify marketplace job specs when the on-chain
   *   task_job_spec pointer exists, while preserving legacy raw task claiming.
   * - "required": require every task to have a verified job spec before claim.
   * - "disabled": do not perform off-chain job spec verification before claim.
   */
  claimJobSpecVerification?: "when-present" | "required" | "disabled";
}

// ============================================================================
// TaskOperations Class
// ============================================================================

/**
 * On-chain task query and transaction operations.
 *
 * Provides methods for:
 * - Querying tasks and claims from the chain
 * - Submitting claim, complete, and completePrivate transactions
 * - Caching PDAs and protocol treasury for efficiency
 *
 * @example
 * ```typescript
 * const ops = new TaskOperations({
 *   program,
 *   agentId: myAgentId,
 * });
 *
 * const task = await ops.fetchTask(taskPda);
 * if (task) {
 *   const result = await ops.claimTask(taskPda, task);
 * }
 * ```
 */
export class TaskOperations {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;
  private readonly jobSpecStoreOptions: MarketplaceJobSpecStoreOptions;
  private readonly claimJobSpecVerification:
    | "when-present"
    | "required"
    | "disabled";

  // Cached PDAs
  private cachedAgentPda: PublicKey | null = null;
  private cachedProtocolTreasury: PublicKey | null = null;

  constructor(config: TaskOpsConfig) {
    this.program = config.program;
    this.agentId = new Uint8Array(config.agentId);
    this.logger = config.logger ?? silentLogger;
    this.jobSpecStoreOptions = {
      ...(config.jobSpecStoreDir ? { rootDir: config.jobSpecStoreDir } : {}),
      allowRemote: config.allowRemoteJobSpecResolution ?? false,
    };
    this.claimJobSpecVerification =
      config.claimJobSpecVerification ?? "when-present";
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Fetch a single task by its PDA address.
   *
   * @param taskPda - Task account PDA
   * @returns Parsed task or null if not found
   */
  async fetchTask(taskPda: PublicKey): Promise<OnChainTask | null> {
    try {
      const raw = await this.program.account.task.fetch(taskPda);
      return parseOnChainTask(raw);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        return null;
      }
      this.logger.error(`Failed to fetch task ${taskPda.toBase58()}: ${err}`);
      throw err;
    }
  }

  /**
   * Fetch a task by creator and task ID, also returning the derived PDA.
   *
   * @param creator - Task creator's public key
   * @param taskId - 32-byte task identifier
   * @returns Object with parsed task and PDA, or null if not found
   */
  async fetchTaskByIds(
    creator: PublicKey,
    taskId: Uint8Array,
  ): Promise<{ task: OnChainTask; taskPda: PublicKey } | null> {
    const { address: taskPda } = deriveTaskPda(
      creator,
      taskId,
      this.program.programId,
    );
    const task = await this.fetchTask(taskPda);
    if (!task) {
      return null;
    }
    return { task, taskPda };
  }

  private async fetchTaskAccounts(
    filters: Array<{ memcmp: { offset: number; bytes: string } }> = [],
  ): Promise<Array<{ task: OnChainTask; taskPda: PublicKey }>> {
    const discriminator = this.program.coder.accounts.memcmp("task");
    const accounts = await this.program.provider.connection.getProgramAccounts(
      this.program.programId,
      {
        filters: [{ memcmp: discriminator }, ...filters],
      },
    );

    const results: Array<{ task: OnChainTask; taskPda: PublicKey }> = [];
    for (const account of accounts) {
      try {
        results.push({
          task: parseOnChainTaskAccountData(account.account.data),
          taskPda: account.pubkey,
        });
      } catch (err) {
        this.logger.warn(
          `Skipping undecodable task account ${account.pubkey.toBase58()}: ${String(err)}`,
        );
      }
    }

    return results;
  }

  /**
   * Fetch all tasks from the chain.
   *
   * @returns Array of all tasks with their PDAs
   */
  async fetchAllTasks(): Promise<
    Array<{ task: OnChainTask; taskPda: PublicKey }>
  > {
    return this.fetchTaskAccounts();
  }

  /**
   * Fetch all claimable tasks (Open or InProgress status).
   *
   * Uses server-side memcmp filters to query only accounts with the desired
   * status byte, avoiding downloading the entire task set. Falls back to
   * {@link fetchAllTasks} with client-side filtering if the filtered queries
   * fail (e.g. RPC does not support the filter).
   *
   * @returns Array of claimable tasks with their PDAs
   */
  async fetchClaimableTasks(): Promise<
    Array<{ task: OnChainTask; taskPda: PublicKey }>
  > {
    return queryWithFallback(
      async () => {
        const [openAccounts, inProgressAccounts] = await Promise.all([
          this.fetchTaskAccounts([
            {
              memcmp: {
                offset: TASK_STATUS_OFFSET,
                bytes: encodeStatusByte(OnChainTaskStatus.Open),
              },
            },
          ]),
          this.fetchTaskAccounts([
            {
              memcmp: {
                offset: TASK_STATUS_OFFSET,
                bytes: encodeStatusByte(OnChainTaskStatus.InProgress),
              },
            },
          ]),
        ]);

        return [...openAccounts, ...inProgressAccounts];
      },
      async () => {
        const all = await this.fetchAllTasks();
        return all.filter(
          ({ task }) =>
            task.status === OnChainTaskStatus.Open ||
            task.status === OnChainTaskStatus.InProgress,
        );
      },
      this.logger,
      "fetchClaimableTasks",
    );
  }

  /**
   * Fetch this agent's claim for a task.
   *
   * @param taskPda - Task account PDA
   * @returns Parsed claim or null if not found
   */
  async fetchClaim(taskPda: PublicKey): Promise<OnChainTaskClaim | null> {
    try {
      const agentPda = this.getAgentPda();
      const { address: claimPda } = deriveClaimPda(
        taskPda,
        agentPda,
        this.program.programId,
      );
      const raw = await this.program.account.taskClaim.fetch(claimPda);
      return parseOnChainTaskClaim(raw);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch all active (uncompleted) claims for this agent.
   *
   * @returns Array of active claims with their PDAs and associated task PDAs
   */
  async fetchActiveClaims(): Promise<
    Array<{ claim: OnChainTaskClaim; claimPda: PublicKey; taskPda: PublicKey }>
  > {
    const agentPda = this.getAgentPda();
    const allClaims = await this.program.account.taskClaim.all();

    const results: Array<{
      claim: OnChainTaskClaim;
      claimPda: PublicKey;
      taskPda: PublicKey;
    }> = [];

    for (const acc of allClaims) {
      const claim = parseOnChainTaskClaim(acc.account);
      // Filter to this agent's uncompleted claims
      if (claim.worker.equals(agentPda) && !claim.isCompleted) {
        results.push({
          claim,
          claimPda: acc.publicKey,
          taskPda: claim.task,
        });
      }
    }

    return results;
  }

  /**
   * Fetch token escrow ATA balance for a token-denominated task.
   *
   * Returns 0 when the ATA does not exist (e.g. already closed).
   */
  async fetchEscrowTokenBalance(
    taskPda: PublicKey,
    rewardMint: PublicKey,
  ): Promise<bigint> {
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const escrowTokenAta = getAssociatedTokenAddressSync(
      rewardMint,
      escrowPda,
      true,
    );
    try {
      const balance =
        await this.program.provider.connection.getTokenAccountBalance(
          escrowTokenAta,
        );
      return BigInt(balance.value.amount);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        return 0n;
      }
      this.logger.error(
        `Failed to fetch escrow token balance for ${taskPda.toBase58()}: ${err}`,
      );
      throw err;
    }
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  /**
   * Claim a task for this agent.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @returns Claim result with signature and claim PDA
   */
  async claimTask(taskPda: PublicKey, task: OnChainTask): Promise<ClaimResult> {
    const intent = await this.previewClaimTaskIntent(taskPda, task);

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);

    this.logger.info(`Claiming task ${taskPda.toBase58()}`);

    try {
      const baseAccounts = {
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerPda,
        authority: this.program.provider.publicKey,
        systemProgram: SystemProgram.programId,
      };
      const taskJobSpec = intent.accountMetas.find(
        (account) => account.name === "taskJobSpec",
      )?.pubkey;
      let signature: string;
      if (taskJobSpec) {
        try {
          signature = await (this.program.methods as any)
            .claimTaskWithJobSpec()
            .accountsPartial({
              ...baseAccounts,
              taskJobSpec: new PublicKey(taskJobSpec),
            })
            .rpc();
        } catch (err) {
          if (!isInstructionFallbackNotFound(err)) {
            throw err;
          }
          this.logger.warn(
            `Program ${this.program.programId.toBase58()} does not expose claimTaskWithJobSpec; falling back to legacy claimTask after local job spec verification`,
          );
          signature = await this.program.methods
            .claimTask()
            .accountsPartial(baseAccounts)
            .rpc();
        }
      } else {
        signature = await this.program.methods
          .claimTask()
          .accountsPartial(baseAccounts)
          .rpc();
      }

      this.logger.info(`Task claimed: ${signature}`);

      return {
        success: true,
        taskId: task.taskId,
        claimPda,
        transactionSignature: signature,
      };
    } catch (err) {
      const parsed = parseAnchorError(err);
      if (parsed) {
        if (isAnchorError(err, AnchorErrorCodes.TaskFullyClaimed)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Task has reached maximum workers",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.TaskExpired)) {
          throw new TaskNotClaimableError(taskPda, "Task has expired");
        }
        if (isAnchorError(err, AnchorErrorCodes.InsufficientCapabilities)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent lacks required capabilities",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.TaskNotOpen)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Task is not open for claims",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.AlreadyClaimed)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent has already claimed this task",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.AgentNotActive)) {
          throw new TaskNotClaimableError(taskPda, "Agent is not active");
        }
        if (isAnchorError(err, AnchorErrorCodes.MaxActiveTasksReached)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent has reached maximum active tasks",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.InsufficientReputation)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent reputation below task minimum",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.InvalidStatusTransition)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Invalid task status transition",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.SelfTaskNotAllowed)) {
          throw new TaskNotClaimableError(taskPda, "Cannot claim own task");
        }
      }
      this.logger.error(`Failed to claim task ${taskPda.toBase58()}: ${err}`);
      throw err;
    }
  }

  async previewClaimTaskIntent(
    taskPda: PublicKey,
    task: OnChainTask,
  ): Promise<MarketplaceTransactionIntent> {
    const verifiedJobSpecPointer =
      await this.assertClaimJobSpecVerified(taskPda);
    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const accountMetas = [
      namedAccountMeta("task", taskPda, true),
      namedAccountMeta("claim", claimPda, true),
      namedAccountMeta("protocolConfig", protocolPda, false),
      namedAccountMeta("worker", workerPda, true),
      namedAccountMeta("authority", this.program.provider.publicKey!, true, true),
      namedAccountMeta("systemProgram", SystemProgram.programId, false),
    ];
    if (verifiedJobSpecPointer) {
      accountMetas.push(
        namedAccountMeta(
          "taskJobSpec",
          new PublicKey(verifiedJobSpecPointer.taskJobSpecPda),
          false,
        ),
      );
    }

    return {
      kind: verifiedJobSpecPointer ? "claim_task_with_job_spec" : "claim_task",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      jobSpecHash: verifiedJobSpecPointer?.jobSpecHash ?? null,
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas,
    };
  }

  /**
   * Fail closed for marketplace tasks whose on-chain job spec metadata exists
   * but cannot be resolved and integrity-verified locally/remotely.
   */
  private async assertClaimJobSpecVerified(
    taskPda: PublicKey,
  ): Promise<OnChainTaskJobSpecPointer | null> {
    if (this.claimJobSpecVerification === "disabled") return null;

    let pointer: Awaited<ReturnType<typeof fetchTaskJobSpecPointer>>;
    try {
      pointer = await fetchTaskJobSpecPointer(this.program, taskPda);
    } catch (err) {
      throw new TaskNotClaimableError(
        taskPda,
        `Unable to verify task job spec metadata before claim: ${formatUnknownError(err)}`,
      );
    }

    if (!pointer) {
      if (this.claimJobSpecVerification === "required") {
        throw new TaskNotClaimableError(
          taskPda,
          "No verified task job spec metadata found before claim",
        );
      }
      return null;
    }

    try {
      await resolveMarketplaceJobSpecReference(
        pointer,
        this.jobSpecStoreOptions,
      );
    } catch (err) {
      throw new TaskNotClaimableError(
        taskPda,
        `Task job spec could not be verified before claim: ${formatUnknownError(err)}`,
      );
    }

    return pointer;
  }

  async resolveCompiledJobForTask(taskPda: PublicKey): Promise<CompiledJob | null> {
    const resolved = await resolveOnChainTaskJobSpecForTask(
      this.program,
      taskPda,
      this.jobSpecStoreOptions,
    );
    if (!resolved) {
      return null;
    }
    return compileResolvedMarketplaceTaskJob(resolved);
  }

  /**
   * Configure Task Validation V2 for an existing task.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param mode - Validation mode matching the on-chain enum
   * @param reviewWindowSecs - Review window in seconds
   * @returns Configuration result with signature and validation config PDA
   */
  async configureTaskValidation(
    taskPda: PublicKey,
    task: OnChainTask,
    mode: TaskValidationMode | number,
    reviewWindowSecs: number | bigint,
    validatorQuorum = 0,
    attestor?: PublicKey | null,
  ): Promise<TaskValidationConfigResult> {
    const creator = this.program.provider.publicKey;
    if (!creator) {
      throw new ValidationError(
        "Program provider does not have a public key for task validation",
      );
    }

    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskAttestorConfigPda = deriveTaskAttestorConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    await this.previewConfigureTaskValidationIntent(
      taskPda,
      task,
      mode,
      reviewWindowSecs,
      validatorQuorum,
      attestor,
    );

    const methods = this.program.methods as unknown as {
      configureTaskValidation: (
        validationMode: number,
        reviewWindow: BN,
        validatorQuorum: number,
        attestor: PublicKey | null,
      ) => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          rpc: () => Promise<string>;
        };
      };
    };

    this.logger.info(`Configuring validation for task ${taskPda.toBase58()}`);

    try {
      const signature = await methods
        .configureTaskValidation(
          Number(mode),
          new BN(reviewWindowSecs.toString()),
          validatorQuorum,
          attestor ?? null,
        )
        .accountsPartial({
          task: taskPda,
          taskValidationConfig: taskValidationConfigPda,
          taskAttestorConfig: taskAttestorConfigPda,
          protocolConfig: protocolPda,
          creator,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return {
        success: true,
        taskId: task.taskId,
        taskValidationConfigPda,
        taskAttestorConfigPda,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to configure validation for ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewConfigureTaskValidationIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    mode: TaskValidationMode | number,
    reviewWindowSecs: number | bigint,
    validatorQuorum = 0,
    attestor?: PublicKey | null,
  ): Promise<MarketplaceTransactionIntent> {
    const creator = this.program.provider.publicKey;
    if (!creator) {
      throw new ValidationError(
        "Program provider does not have a public key for task validation",
      );
    }

    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskAttestorConfigPda = deriveTaskAttestorConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);

    return {
      kind: "configure_task_validation",
      programId: this.program.programId.toBase58(),
      signer: creator.toBase58(),
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      validationMode: String(Number(mode)),
      reviewWindowSecs: reviewWindowSecs.toString(),
      validatorQuorum,
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("taskValidationConfig", taskValidationConfigPda, true),
        namedAccountMeta("taskAttestorConfig", taskAttestorConfigPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("creator", creator, true, true),
        namedAccountMeta("systemProgram", SystemProgram.programId, false),
        ...(attestor ? [namedAccountMeta("attestor", attestor, false)] : []),
      ],
    };
  }

  /**
   * Submit a result for Task Validation V2 manual validation.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param proofHash - Worker-submitted proof hash
   * @param resultData - Optional worker-submitted result payload
   * @returns Submission result with signature and submission PDA
   */
  async submitTaskResult(
    taskPda: PublicKey,
    task: OnChainTask,
    proofHash: Uint8Array,
    resultData: Uint8Array | null,
  ): Promise<TaskSubmissionResult> {
    validateByteLength(proofHash, 32, "proofHash");
    validateNonZeroBytes(proofHash, "proofHash");
    if (resultData !== null) {
      validateByteLength(resultData, 64, "resultData");
    }

    const authority = this.program.provider.publicKey;
    if (!authority) {
      throw new ValidationError(
        "Program provider does not have a public key for task submission",
      );
    }

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    await this.previewSubmitTaskResultIntent(taskPda, task);

    const methods = this.program.methods as unknown as {
      submitTaskResult: (
        proofHashBytes: number[],
        resultBytes: number[] | null,
      ) => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          rpc: () => Promise<string>;
        };
      };
    };

    this.logger.info(`Submitting task result ${taskPda.toBase58()} for review`);

    try {
      const signature = await methods
        .submitTaskResult(
          toAnchorBytes(proofHash),
          resultData ? toAnchorBytes(resultData) : null,
        )
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          taskValidationConfig: taskValidationConfigPda,
          taskSubmission: taskSubmissionPda,
          protocolConfig: protocolPda,
          worker: workerPda,
          authority,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return {
        success: true,
        taskId: task.taskId,
        taskSubmissionPda,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to submit task result ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewSubmitTaskResultIntent(
    taskPda: PublicKey,
    task: OnChainTask,
  ): Promise<MarketplaceTransactionIntent> {
    const authority = this.program.provider.publicKey;
    if (!authority) {
      throw new ValidationError(
        "Program provider does not have a public key for task submission",
      );
    }

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);

    return {
      kind: "submit_task_result",
      programId: this.program.programId.toBase58(),
      signer: authority.toBase58(),
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      claimPda: claimPda.toBase58(),
      workerPda: workerPda.toBase58(),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("taskValidationConfig", taskValidationConfigPda, true),
        namedAccountMeta("taskSubmission", taskSubmissionPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("worker", workerPda, false),
        namedAccountMeta("authority", authority, true, true),
        namedAccountMeta("systemProgram", SystemProgram.programId, false),
      ],
    };
  }

  /**
   * Accept a pending Task Validation V2 submission and settle the reward.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param workerPda - Worker agent PDA that owns the submission
   * @param options - Optional dependent-task and marketplace settlement accounts
   * @returns Completion result with signature
   */
  async acceptTaskResult(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    options?: TaskCompletionOptions,
  ): Promise<CompleteResult> {
    const creator = this.program.provider.publicKey;
    if (!creator) {
      throw new ValidationError(
        "Program provider does not have a public key for task acceptance",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const workerAuthority = await this.getWorkerAuthority(workerPda);
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      workerAuthority,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      workerAuthority,
    );
    await this.previewAcceptTaskResultIntent(taskPda, task, workerPda, options);

    const methods = this.program.methods as unknown as {
      acceptTaskResult: () => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          remainingAccounts: (accounts: AccountMeta[]) => { rpc: () => Promise<string> };
          rpc: () => Promise<string>;
        };
      };
    };

    this.logger.info(`Accepting task result ${taskPda.toBase58()}`);

    try {
      const builder = methods.acceptTaskResult().accountsPartial({
        task: taskPda,
        claim: claimPda,
        escrow: escrowPda,
        taskValidationConfig: taskValidationConfigPda,
        taskSubmission: taskSubmissionPda,
        worker: workerPda,
        protocolConfig: protocolPda,
        treasury,
        creator,
        workerAuthority,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      return {
        success: true,
        taskId: task.taskId,
        isPrivate: false,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to accept task result ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewAcceptTaskResultIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    options?: TaskCompletionOptions,
  ): Promise<MarketplaceTransactionIntent> {
    const creator = this.program.provider.publicKey;
    if (!creator) {
      throw new ValidationError(
        "Program provider does not have a public key for task acceptance",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const workerAuthority = await this.getWorkerAuthority(workerPda);
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      workerAuthority,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      workerAuthority,
    );

    return {
      kind: "accept_task_result",
      programId: this.program.programId.toBase58(),
      signer: creator.toBase58(),
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      claimPda: claimPda.toBase58(),
      workerPda: workerPda.toBase58(),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("taskValidationConfig", taskValidationConfigPda, true),
        namedAccountMeta("taskSubmission", taskSubmissionPda, true),
        namedAccountMeta("worker", workerPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("treasury", treasury, true),
        namedAccountMeta("creator", creator, true, true),
        namedAccountMeta("workerAuthority", workerAuthority, true),
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

  /**
   * Reject a pending Task Validation V2 submission.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param workerPda - Worker agent PDA that owns the submission
   * @param rejectionHash - Evidence or rejection reason hash
   * @returns Submission result with signature and submission PDA
   */
  async rejectTaskResult(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    rejectionHash: Uint8Array,
  ): Promise<TaskSubmissionResult> {
    validateByteLength(rejectionHash, 32, "rejectionHash");

    const creator = this.program.provider.publicKey;
    if (!creator) {
      throw new ValidationError(
        "Program provider does not have a public key for task rejection",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    await this.previewRejectTaskResultIntent(taskPda, task, workerPda);

    const methods = this.program.methods as unknown as {
      rejectTaskResult: (rejectionHashBytes: number[]) => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          rpc: () => Promise<string>;
        };
      };
    };

    this.logger.info(`Rejecting task result ${taskPda.toBase58()}`);

    try {
      const workerAuthority = await this.getWorkerAuthority(workerPda);
      const signature = await methods
        .rejectTaskResult(toAnchorBytes(rejectionHash))
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          taskValidationConfig: taskValidationConfigPda,
          taskSubmission: taskSubmissionPda,
          worker: workerPda,
          protocolConfig: protocolPda,
          creator,
          workerAuthority,
        })
        .rpc();

      return {
        success: true,
        taskId: task.taskId,
        taskSubmissionPda,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to reject task result ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewRejectTaskResultIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
  ): Promise<MarketplaceTransactionIntent> {
    const creator = this.program.provider.publicKey;
    if (!creator) {
      throw new ValidationError(
        "Program provider does not have a public key for task rejection",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const workerAuthority = await this.getWorkerAuthority(workerPda);

    return {
      kind: "reject_task_result",
      programId: this.program.programId.toBase58(),
      signer: creator.toBase58(),
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      claimPda: claimPda.toBase58(),
      workerPda: workerPda.toBase58(),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("taskValidationConfig", taskValidationConfigPda, true),
        namedAccountMeta("taskSubmission", taskSubmissionPda, true),
        namedAccountMeta("worker", workerPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("creator", creator, true, true),
        namedAccountMeta("workerAuthority", workerAuthority, false),
      ],
    };
  }

  /**
   * Permissionlessly auto-accept a timed-out creator-review submission.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param workerPda - Worker agent PDA that owns the submission
   * @param options - Optional dependent-task and marketplace settlement accounts
   * @returns Completion result with signature
   */
  async autoAcceptTaskResult(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    options?: TaskCompletionOptions,
  ): Promise<CompleteResult> {
    const authority = this.program.provider.publicKey;
    if (!authority) {
      throw new ValidationError(
        "Program provider does not have a public key for auto-acceptance",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const workerAuthority = await this.getWorkerAuthority(workerPda);
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      workerAuthority,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      workerAuthority,
    );
    await this.previewAutoAcceptTaskResultIntent(
      taskPda,
      task,
      workerPda,
      options,
    );

    const methods = this.program.methods as unknown as {
      autoAcceptTaskResult: () => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          remainingAccounts: (accounts: AccountMeta[]) => { rpc: () => Promise<string> };
          rpc: () => Promise<string>;
        };
      };
    };

    this.logger.info(`Auto-accepting task result ${taskPda.toBase58()}`);

    try {
      const builder = methods.autoAcceptTaskResult().accountsPartial({
        task: taskPda,
        claim: claimPda,
        escrow: escrowPda,
        taskValidationConfig: taskValidationConfigPda,
        taskSubmission: taskSubmissionPda,
        worker: workerPda,
        protocolConfig: protocolPda,
        treasury,
        creator: task.creator,
        workerAuthority,
        authority,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      return {
        success: true,
        taskId: task.taskId,
        isPrivate: false,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to auto-accept task result ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewAutoAcceptTaskResultIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    options?: TaskCompletionOptions,
  ): Promise<MarketplaceTransactionIntent> {
    const authority = this.program.provider.publicKey;
    if (!authority) {
      throw new ValidationError(
        "Program provider does not have a public key for auto-acceptance",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const workerAuthority = await this.getWorkerAuthority(workerPda);
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      workerAuthority,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      workerAuthority,
    );

    return {
      kind: "auto_accept_task_result",
      programId: this.program.programId.toBase58(),
      signer: authority.toBase58(),
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      claimPda: claimPda.toBase58(),
      workerPda: workerPda.toBase58(),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("taskValidationConfig", taskValidationConfigPda, true),
        namedAccountMeta("taskSubmission", taskSubmissionPda, true),
        namedAccountMeta("worker", workerPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("treasury", treasury, true),
        namedAccountMeta("creator", task.creator, true),
        namedAccountMeta("workerAuthority", workerAuthority, true),
        namedAccountMeta("authority", authority, true, true),
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

  /**
   * Record a validator quorum vote or external attestation for a submission.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param workerPda - Worker agent PDA that owns the submission
   * @param approved - Whether the reviewer approves the submission
   * @param validatorAgentPda - Optional validator agent PDA for quorum mode
   * @param options - Optional dependent-task and marketplace settlement accounts
   * @returns Submission result with signature, submission PDA, and vote PDA
   */
  async validateTaskResult(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    approved: boolean,
    validatorAgentPda?: PublicKey | null,
    options?: TaskCompletionOptions,
  ): Promise<TaskSubmissionResult> {
    const reviewer = this.program.provider.publicKey;
    if (!reviewer) {
      throw new ValidationError(
        "Program provider does not have a public key for task validation voting",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskAttestorConfigPda = deriveTaskAttestorConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const taskValidationVotePda = deriveTaskValidationVotePda(
      taskSubmissionPda,
      reviewer,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const workerAuthority = await this.getWorkerAuthority(workerPda);
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      workerAuthority,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      workerAuthority,
    );
    await this.previewValidateTaskResultIntent(
      taskPda,
      task,
      workerPda,
      validatorAgentPda,
      options,
    );

    const methods = this.program.methods as unknown as {
      validateTaskResult: (approved: boolean) => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          remainingAccounts: (accounts: AccountMeta[]) => { rpc: () => Promise<string> };
          rpc: () => Promise<string>;
        };
      };
    };

    this.logger.info(`Recording task validation vote ${taskPda.toBase58()}`);

    try {
      const builder = methods.validateTaskResult(approved).accountsPartial({
        task: taskPda,
        claim: claimPda,
        escrow: escrowPda,
        taskValidationConfig: taskValidationConfigPda,
        taskAttestorConfig: validatorAgentPda ? null : taskAttestorConfigPda,
        taskSubmission: taskSubmissionPda,
        taskValidationVote: taskValidationVotePda,
        worker: workerPda,
        protocolConfig: protocolPda,
        validatorAgent: validatorAgentPda ?? null,
        treasury,
        creator: task.creator,
        workerAuthority,
        reviewer,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      return {
        success: true,
        taskId: task.taskId,
        taskSubmissionPda,
        taskValidationVotePda,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to validate task result ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewValidateTaskResultIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    workerPda: PublicKey,
    validatorAgentPda?: PublicKey | null,
    options?: TaskCompletionOptions,
  ): Promise<MarketplaceTransactionIntent> {
    const reviewer = this.program.provider.publicKey;
    if (!reviewer) {
      throw new ValidationError(
        "Program provider does not have a public key for task validation voting",
      );
    }

    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const taskValidationConfigPda = deriveTaskValidationConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskAttestorConfigPda = deriveTaskAttestorConfigPda(
      taskPda,
      this.program.programId,
    ).address;
    const taskSubmissionPda = deriveTaskSubmissionPda(
      claimPda,
      this.program.programId,
    ).address;
    const taskValidationVotePda = deriveTaskValidationVotePda(
      taskSubmissionPda,
      reviewer,
      this.program.programId,
    ).address;
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const workerAuthority = await this.getWorkerAuthority(workerPda);
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      workerAuthority,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      workerAuthority,
    );

    return {
      kind: "validate_task_result",
      programId: this.program.programId.toBase58(),
      signer: reviewer.toBase58(),
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      claimPda: claimPda.toBase58(),
      workerPda: workerPda.toBase58(),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("taskValidationConfig", taskValidationConfigPda, true),
        ...(validatorAgentPda
          ? []
          : [namedAccountMeta("taskAttestorConfig", taskAttestorConfigPda, false)]),
        namedAccountMeta("taskSubmission", taskSubmissionPda, true),
        namedAccountMeta("taskValidationVote", taskValidationVotePda, true),
        namedAccountMeta("worker", workerPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        ...(validatorAgentPda
          ? [namedAccountMeta("validatorAgent", validatorAgentPda, false)]
          : []),
        namedAccountMeta("treasury", treasury, true),
        namedAccountMeta("creator", task.creator, true),
        namedAccountMeta("workerAuthority", workerAuthority, true),
        namedAccountMeta("reviewer", reviewer, true, true),
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

  /**
   * Complete a task with a public proof.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param result - Task execution result with proof hash
   * @returns Completion result with signature
   */
  async completeTask(
    taskPda: PublicKey,
    task: OnChainTask,
    proofHash: Uint8Array,
    resultData: Uint8Array | null,
    options?: TaskCompletionOptions,
  ): Promise<CompleteResult> {
    // Input validation (#963)
    validateByteLength(proofHash, 32, "proofHash");
    validateNonZeroBytes(proofHash, "proofHash");
    if (resultData !== null) {
      validateByteLength(resultData, 64, "resultData");
    }

    if (isManualValidationTask(task)) {
      this.logger.info(
        `Task ${taskPda.toBase58()} requires manual validation; routing to submitTaskResult`,
      );
      const submission = await this.submitTaskResult(
        taskPda,
        task,
        proofHash,
        resultData,
      );
      return {
        success: submission.success,
        taskId: submission.taskId,
        isPrivate: false,
        transactionSignature: submission.transactionSignature,
      };
    }

    await this.previewCompleteTaskIntent(taskPda, task, options);
    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.program.provider.publicKey!,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      this.program.provider.publicKey ?? undefined,
    );

    this.logger.info(`Completing task ${taskPda.toBase58()}`);

    try {
      const builder = this.program.methods
        .completeTask(
          toAnchorBytes(proofHash),
          resultData ? toAnchorBytes(resultData) : null,
        )
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: task.creator,
          worker: workerPda,
          protocolConfig: protocolPda,
          treasury,
          authority: this.program.provider.publicKey,
          systemProgram: SystemProgram.programId,
          ...tokenAccounts,
        });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Task completed: ${signature}`);

      return {
        success: true,
        taskId: task.taskId,
        isPrivate: false,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to complete task ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewCompleteTaskIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    options?: TaskCompletionOptions,
  ): Promise<MarketplaceTransactionIntent> {
    if (isManualValidationTask(task)) {
      return this.previewSubmitTaskResultIntent(taskPda, task);
    }

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.program.provider.publicKey!,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      this.program.provider.publicKey ?? undefined,
    );
    return {
      kind: "complete_task",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("creator", task.creator, true),
        namedAccountMeta("worker", workerPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("treasury", treasury, true),
        namedAccountMeta("authority", this.program.provider.publicKey!, true, true),
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

  /**
   * Complete a task with a private ZK proof.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param sealBytes - Router seal bytes
   * @param journal - Fixed private journal bytes
   * @param imageId - Trusted image ID bytes
   * @param bindingSeed - 32-byte binding spend seed
   * @param nullifierSeed - 32-byte nullifier spend seed
   * @returns Completion result with signature
   */
  async completeTaskPrivate(
    taskPda: PublicKey,
    task: OnChainTask,
    sealBytes: Uint8Array,
    journal: Uint8Array,
    imageId: Uint8Array,
    bindingSeed: Uint8Array,
    nullifierSeed: Uint8Array,
    options?: TaskCompletionOptions,
  ): Promise<CompleteResult> {
    // Input validation (#963)
    validateByteLength(sealBytes, RISC0_SEAL_BYTES_LEN, "sealBytes");
    validateByteLength(journal, RISC0_JOURNAL_LEN, "journal");
    validateByteLength(imageId, RISC0_IMAGE_ID_LEN, "imageId");
    validateByteLength(bindingSeed, HASH_SIZE, "bindingSeed");
    validateByteLength(nullifierSeed, HASH_SIZE, "nullifierSeed");
    validateNonZeroBytes(imageId, "imageId");
    validateNonZeroBytes(bindingSeed, "bindingSeed");
    validateNonZeroBytes(nullifierSeed, "nullifierSeed");

    if (
      !Buffer.from(sealBytes.subarray(0, TRUSTED_RISC0_SELECTOR.length)).equals(
        Buffer.from(TRUSTED_RISC0_SELECTOR),
      )
    ) {
      throw new Error("sealBytes selector does not match trusted selector");
    }

    await this.previewCompleteTaskPrivateIntent(
      taskPda,
      task,
      bindingSeed,
      nullifierSeed,
      options,
    );
    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const [bindingSpend] = PublicKey.findProgramAddressSync(
      [BINDING_SPEND_SEED, Buffer.from(bindingSeed)],
      this.program.programId,
    );
    const [nullifierSpend] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SPEND_SEED, Buffer.from(nullifierSeed)],
      this.program.programId,
    );
    const [router] = PublicKey.findProgramAddressSync(
      [ROUTER_SEED],
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    );
    const [verifierEntry] = PublicKey.findProgramAddressSync(
      [VERIFIER_SEED, Buffer.from(TRUSTED_RISC0_SELECTOR)],
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    );
    const zkConfigPda = deriveZkConfigPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.program.provider.publicKey!,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      this.program.provider.publicKey ?? undefined,
    );

    this.logger.info(`Completing task privately ${taskPda.toBase58()}`);

    try {
      // task_id argument is a u64 on-chain, convert taskId bytes to number
      // The on-chain instruction uses task_id: u64 as a proof binding input
      const taskIdBN = new BN(task.taskId.slice(0, 8), "le");

      const proof = {
        sealBytes: Buffer.from(sealBytes),
        journal: Buffer.from(journal),
        imageId: toAnchorBytes(imageId),
        bindingSeed: toAnchorBytes(bindingSeed),
        nullifierSeed: toAnchorBytes(nullifierSeed),
      };

      const completeTaskPrivateMethod = this.program.methods as unknown as {
        completeTaskPrivate: (
          taskId: BN,
          proofArgs: typeof proof,
        ) => {
          accountsPartial: (accounts: Record<string, unknown>) => {
            remainingAccounts: (accounts: AccountMeta[]) => {
              rpc: () => Promise<string>;
            };
            rpc: () => Promise<string>;
          };
        };
      };

      const builder = completeTaskPrivateMethod
        .completeTaskPrivate(taskIdBN, proof)
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: task.creator,
          worker: workerPda,
          protocolConfig: protocolPda,
          zkConfig: zkConfigPda,
          bindingSpend,
          nullifierSpend,
          treasury,
          authority: this.program.provider.publicKey,
          routerProgram: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
          router,
          verifierEntry,
          verifierProgram: TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ...tokenAccounts,
        });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Task completed privately: ${signature}`);

      return {
        success: true,
        taskId: task.taskId,
        isPrivate: true,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to complete task privately ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async previewCompleteTaskPrivateIntent(
    taskPda: PublicKey,
    task: OnChainTask,
    bindingSeed: Uint8Array,
    nullifierSeed: Uint8Array,
    options?: TaskCompletionOptions,
  ): Promise<MarketplaceTransactionIntent> {
    validateByteLength(bindingSeed, HASH_SIZE, "bindingSeed");
    validateByteLength(nullifierSeed, HASH_SIZE, "nullifierSeed");
    validateNonZeroBytes(bindingSeed, "bindingSeed");
    validateNonZeroBytes(nullifierSeed, "nullifierSeed");

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const [bindingSpend] = PublicKey.findProgramAddressSync(
      [BINDING_SPEND_SEED, Buffer.from(bindingSeed)],
      this.program.programId,
    );
    const [nullifierSpend] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SPEND_SEED, Buffer.from(nullifierSeed)],
      this.program.programId,
    );
    const [router] = PublicKey.findProgramAddressSync(
      [ROUTER_SEED],
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    );
    const [verifierEntry] = PublicKey.findProgramAddressSync(
      [VERIFIER_SEED, Buffer.from(TRUSTED_RISC0_SELECTOR)],
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    );
    const zkConfigPda = deriveZkConfigPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.program.provider.publicKey!,
      treasury,
    );
    const remainingAccounts = this.buildTaskCompletionRemainingAccounts(
      options,
      this.program.provider.publicKey ?? undefined,
    );
    return {
      kind: "complete_task_private",
      programId: this.program.programId.toBase58(),
      signer: this.program.provider.publicKey?.toBase58() ?? null,
      taskPda: taskPda.toBase58(),
      taskId: hexBytes(task.taskId),
      rewardLamports: task.rewardAmount.toString(),
      rewardMint: task.rewardMint?.toBase58() ?? null,
      constraintHash: hexBytes(task.constraintHash),
      accountMetas: [
        namedAccountMeta("task", taskPda, true),
        namedAccountMeta("claim", claimPda, true),
        namedAccountMeta("escrow", escrowPda, true),
        namedAccountMeta("creator", task.creator, true),
        namedAccountMeta("worker", workerPda, true),
        namedAccountMeta("protocolConfig", protocolPda, false),
        namedAccountMeta("zkConfig", zkConfigPda, false),
        namedAccountMeta("bindingSpend", bindingSpend, true),
        namedAccountMeta("nullifierSpend", nullifierSpend, true),
        namedAccountMeta("treasury", treasury, true),
        namedAccountMeta("authority", this.program.provider.publicKey!, true, true),
        namedAccountMeta("routerProgram", TRUSTED_RISC0_ROUTER_PROGRAM_ID, false),
        namedAccountMeta("router", router, false),
        namedAccountMeta("verifierEntry", verifierEntry, false),
        namedAccountMeta("verifierProgram", TRUSTED_RISC0_VERIFIER_PROGRAM_ID, false),
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

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Get the agent PDA, caching for reuse.
   */
  private getAgentPda(): PublicKey {
    if (!this.cachedAgentPda) {
      this.cachedAgentPda = deriveAgentPda(
        this.agentId,
        this.program.programId,
      ).address;
    }
    return this.cachedAgentPda;
  }

  /**
   * Get the protocol treasury address, fetching and caching from protocolConfig.
   */
  private async getProtocolTreasury(): Promise<PublicKey> {
    if (this.cachedProtocolTreasury) {
      return this.cachedProtocolTreasury;
    }
    this.cachedProtocolTreasury = await fetchTreasury(
      this.program,
      this.program.programId,
    );
    return this.cachedProtocolTreasury;
  }

  /**
   * Resolve the worker authority wallet from an agent registration PDA.
   */
  private async getWorkerAuthority(workerPda: PublicKey): Promise<PublicKey> {
    const agentAccount = this.program.account as unknown as {
      agentRegistration?: {
        fetch?: (address: PublicKey) => Promise<unknown>;
      };
    };

    if (!agentAccount.agentRegistration?.fetch) {
      throw new ValidationError(
        "Program account namespace is missing agentRegistration.fetch",
      );
    }

    const rawAgent = await agentAccount.agentRegistration.fetch(workerPda);
    return parseAgentState(rawAgent).authority;
  }

  /**
   * Build remaining accounts for dependent-task and Marketplace V2 settlement.
   */
  private buildTaskCompletionRemainingAccounts(
    options?: TaskCompletionOptions,
    defaultBidderAuthority?: PublicKey,
  ): AccountMeta[] {
    const accounts: AccountMeta[] = [];
    if (!options) return accounts;

    if (options.parentTaskPda) {
      accounts.push({
        pubkey: options.parentTaskPda,
        isSigner: false,
        isWritable: false,
      });
    }

    if (options.acceptedBidSettlement) {
      const bidderAuthority =
        options.bidderAuthority ??
        defaultBidderAuthority ??
        this.program.provider.publicKey;
      if (!bidderAuthority) {
        throw new ValidationError(
          "bidderAuthority is required when acceptedBidSettlement is provided",
        );
      }

      accounts.push({
        pubkey: options.acceptedBidSettlement.bidBook,
        isSigner: false,
        isWritable: true,
      });
      accounts.push({
        pubkey: options.acceptedBidSettlement.acceptedBid,
        isSigner: false,
        isWritable: true,
      });
      accounts.push({
        pubkey: options.acceptedBidSettlement.bidderMarketState,
        isSigner: false,
        isWritable: true,
      });
      accounts.push({
        pubkey: bidderAuthority,
        isSigner: false,
        isWritable: true,
      });
    }

    return accounts;
  }
}

// ============================================================================
// Utility Helpers
// ============================================================================

/**
 * Checks if an error indicates an account was not found.
 */
function isAccountNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("Account does not exist") ||
      err.message.includes("could not find"))
  );
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isInstructionFallbackNotFound(err: unknown): boolean {
  const message = formatUnknownError(err);
  return (
    message.includes("InstructionFallbackNotFound") ||
    message.includes("Fallback functions are not supported")
  );
}
