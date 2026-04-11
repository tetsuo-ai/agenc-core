import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import {
  TaskOperations,
  TASK_STATUS_OFFSET,
  type TaskOpsConfig,
} from "./operations.js";
import {
  MANUAL_VALIDATION_SENTINEL,
  OnChainTaskStatus,
  TaskValidationMode,
  type OnChainTask,
} from "./types.js";
import { TaskType } from "../events/types.js";
import {
  TaskNotClaimableError,
  TaskSubmissionError,
  ValidationError,
  AnchorErrorCodes,
} from "../types/errors.js";
import { silentLogger } from "../utils/logger.js";
import {
  PROGRAM_ID,
  HASH_SIZE,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  TRUSTED_RISC0_SELECTOR,
} from "@tetsuo-ai/sdk";

const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new PublicKey(
  "E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ",
);
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new PublicKey(
  "3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc",
);

/**
 * Creates a 32-byte agent ID from a seed.
 */
function createAgentId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

/**
 * Creates a mock raw task as returned by Anchor fetch.
 */
function createMockRawTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: new Array(32).fill(0).map((_: number, i: number) => i),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: { toString: () => "3" },
    description: new Array(64).fill(0),
    constraintHash: new Array(32).fill(0),
    rewardAmount: { toString: () => "1000000" },
    maxWorkers: 5,
    currentWorkers: 0,
    status: { open: {} },
    taskType: { exclusive: {} },
    createdAt: { toNumber: () => 1700000000 },
    deadline: { toNumber: () => 1700003600 },
    completedAt: { toNumber: () => 0 },
    escrow: Keypair.generate().publicKey,
    result: new Array(64).fill(0),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

/**
 * Creates a mock raw task claim as returned by Anchor fetch.
 */
function createMockRawClaim(
  agentPda: PublicKey,
  taskPda: PublicKey,
  overrides: Record<string, unknown> = {},
) {
  return {
    task: taskPda,
    worker: agentPda,
    claimedAt: { toNumber: () => 1700000000 },
    expiresAt: { toNumber: () => 1700003600 },
    completedAt: { toNumber: () => 0 },
    proofHash: new Array(32).fill(0),
    resultData: new Array(64).fill(0),
    isCompleted: false,
    isValidated: false,
    rewardPaid: { toString: () => "0" },
    bump: 254,
    ...overrides,
  };
}

/**
 * Creates a parsed OnChainTask for tests.
 */
function createParsedTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 3n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 5,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: 1700003600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    rewardMint: null,
    protocolFeeBps: 101,
    minReputation: 0,
    dependsOn: null,
    dependencyType: null,
    ...overrides,
  };
}

function createSerializedTaskAccountData(
  overrides: Partial<OnChainTask> = {},
): Buffer {
  const task = createParsedTask(overrides);
  const buffer = Buffer.alloc(382);
  let offset = 8;

  const writeFixedBytes = (value: Uint8Array, length: number) => {
    const bytes = Buffer.from(value);
    bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
    offset += length;
  };

  writeFixedBytes(task.taskId, 32);
  task.creator.toBuffer().copy(buffer, offset);
  offset += 32;
  buffer.writeBigUInt64LE(task.requiredCapabilities, offset);
  offset += 8;
  writeFixedBytes(task.description, 64);
  writeFixedBytes(task.constraintHash, 32);
  buffer.writeBigUInt64LE(task.rewardAmount, offset);
  offset += 8;
  buffer[offset++] = task.maxWorkers;
  buffer[offset++] = task.currentWorkers;
  buffer[offset++] = task.status;
  buffer[offset++] = task.taskType;
  buffer.writeBigInt64LE(BigInt(task.createdAt), offset);
  offset += 8;
  buffer.writeBigInt64LE(BigInt(task.deadline), offset);
  offset += 8;
  buffer.writeBigInt64LE(BigInt(task.completedAt), offset);
  offset += 8;
  task.escrow.toBuffer().copy(buffer, offset);
  offset += 32;
  writeFixedBytes(task.result, 64);
  buffer[offset++] = task.completions;
  buffer[offset++] = task.requiredCompletions;
  buffer[offset++] = task.bump;
  buffer.writeUInt16LE(task.protocolFeeBps ?? 101, offset);
  offset += 2;
  if (task.dependsOn) {
    task.dependsOn.toBuffer().copy(buffer, offset);
  }
  offset += 32;
  buffer[offset++] = task.dependencyType ?? 0;
  buffer.writeUInt16LE(task.minReputation ?? 0, offset);
  offset += 2;
  if (task.rewardMint) {
    buffer[offset++] = 1;
    task.rewardMint.toBuffer().copy(buffer, offset);
  } else {
    buffer[offset++] = 0;
  }

  return buffer;
}

function createProgramTaskAccount(overrides: Partial<OnChainTask> = {}) {
  return {
    pubkey: Keypair.generate().publicKey,
    account: {
      data: createSerializedTaskAccountData(overrides),
    },
  };
}

function createMockRawAgentRegistration(authority: PublicKey) {
  return {
    agentId: Array.from(createAgentId(77)),
    authority,
    capabilities: { toString: () => "3" },
    status: { active: {} },
    endpoint: "http://localhost:3000",
    metadataUri: "https://example.com/agent.json",
    registeredAt: { toNumber: () => 1700000000 },
    lastActive: { toNumber: () => 1700000100 },
    tasksCompleted: { toString: () => "10" },
    totalEarned: { toString: () => "5000000" },
    reputation: 9000,
    activeTasks: 1,
    stake: { toString: () => "1000000" },
    bump: 200,
  };
}

/**
 * Creates a mock Anchor program for testing.
 */
function createMockProgram() {
  const providerPublicKey = Keypair.generate().publicKey;
  const getProgramAccounts = vi.fn().mockResolvedValue([]);
  const getAccountInfo = vi.fn().mockResolvedValue(null);
  const getTokenAccountBalance = vi.fn();
  const coderAccountsMemcmp = vi
    .fn()
    .mockReturnValue({ offset: 0, bytes: "task-discriminator" });
  const mockProvider = {
    publicKey: providerPublicKey,
    connection: {
      getProgramAccounts,
      getAccountInfo,
      getTokenAccountBalance,
    },
  };

  const taskFetch = vi.fn();
  const taskAll = vi.fn().mockResolvedValue([]);
  const taskClaimFetch = vi.fn();
  const taskClaimAll = vi.fn().mockResolvedValue([]);
  const protocolConfigFetch = vi.fn().mockResolvedValue({
    treasury: Keypair.generate().publicKey,
  });
  const agentRegistrationFetch = vi
    .fn()
    .mockResolvedValue(createMockRawAgentRegistration(providerPublicKey));

  const claimTaskRpc = vi.fn().mockResolvedValue("claim-sig");
  const completeTaskRpc = vi.fn().mockResolvedValue("complete-sig");
  const completeTaskPrivateRpc = vi.fn().mockResolvedValue("private-sig");
  const configureTaskValidationRpc = vi.fn().mockResolvedValue("configure-sig");
  const submitTaskResultRpc = vi.fn().mockResolvedValue("submit-sig");
  const acceptTaskResultRpc = vi.fn().mockResolvedValue("accept-sig");
  const rejectTaskResultRpc = vi.fn().mockResolvedValue("reject-sig");
  const autoAcceptTaskResultRpc = vi.fn().mockResolvedValue("auto-accept-sig");
  const validateTaskResultRpc = vi.fn().mockResolvedValue("validate-sig");

  const claimTaskBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: claimTaskRpc,
  };

  const completeTaskBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    rpc: completeTaskRpc,
  };

  const completeTaskPrivateBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    rpc: completeTaskPrivateRpc,
  };
  const configureTaskValidationBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: configureTaskValidationRpc,
  };
  const submitTaskResultBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: submitTaskResultRpc,
  };
  const acceptTaskResultBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    rpc: acceptTaskResultRpc,
  };
  const rejectTaskResultBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: rejectTaskResultRpc,
  };
  const autoAcceptTaskResultBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    rpc: autoAcceptTaskResultRpc,
  };
  const validateTaskResultBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    rpc: validateTaskResultRpc,
  };
  const completeTaskPrivateMethod = vi
    .fn()
    .mockReturnValue(completeTaskPrivateBuilder);
  const configureTaskValidationMethod = vi
    .fn()
    .mockReturnValue(configureTaskValidationBuilder);
  const submitTaskResultMethod = vi
    .fn()
    .mockReturnValue(submitTaskResultBuilder);
  const acceptTaskResultMethod = vi
    .fn()
    .mockReturnValue(acceptTaskResultBuilder);
  const rejectTaskResultMethod = vi
    .fn()
    .mockReturnValue(rejectTaskResultBuilder);
  const autoAcceptTaskResultMethod = vi
    .fn()
    .mockReturnValue(autoAcceptTaskResultBuilder);
  const validateTaskResultMethod = vi
    .fn()
    .mockReturnValue(validateTaskResultBuilder);

  const program = {
    programId: PROGRAM_ID,
    provider: mockProvider,
    coder: {
      accounts: {
        memcmp: coderAccountsMemcmp,
      },
    },
    account: {
      task: { fetch: taskFetch, all: taskAll },
      taskClaim: { fetch: taskClaimFetch, all: taskClaimAll },
      protocolConfig: { fetch: protocolConfigFetch },
      agentRegistration: { fetch: agentRegistrationFetch },
    },
    methods: {
      claimTask: vi.fn().mockReturnValue(claimTaskBuilder),
      completeTask: vi.fn().mockReturnValue(completeTaskBuilder),
      completeTaskPrivate: completeTaskPrivateMethod,
      configureTaskValidation: configureTaskValidationMethod,
      submitTaskResult: submitTaskResultMethod,
      acceptTaskResult: acceptTaskResultMethod,
      rejectTaskResult: rejectTaskResultMethod,
      autoAcceptTaskResult: autoAcceptTaskResultMethod,
      validateTaskResult: validateTaskResultMethod,
    },
  };

  return {
    program: program as unknown as TaskOpsConfig["program"],
    mocks: {
      taskFetch,
      taskAll,
      taskClaimFetch,
      taskClaimAll,
      protocolConfigFetch,
      agentRegistrationFetch,
      getProgramAccounts,
      getAccountInfo,
      getTokenAccountBalance,
      coderAccountsMemcmp,
      claimTaskRpc,
      completeTaskRpc,
      completeTaskPrivateRpc,
      configureTaskValidationRpc,
      submitTaskResultRpc,
      acceptTaskResultRpc,
      rejectTaskResultRpc,
      autoAcceptTaskResultRpc,
      validateTaskResultRpc,
      completeTaskPrivateMethod,
      configureTaskValidationMethod,
      submitTaskResultMethod,
      acceptTaskResultMethod,
      rejectTaskResultMethod,
      autoAcceptTaskResultMethod,
      validateTaskResultMethod,
      claimTaskBuilder,
      completeTaskBuilder,
      completeTaskPrivateBuilder,
      configureTaskValidationBuilder,
      submitTaskResultBuilder,
      acceptTaskResultBuilder,
      rejectTaskResultBuilder,
      autoAcceptTaskResultBuilder,
      validateTaskResultBuilder,
    },
  };
}

describe("TaskOperations", () => {
  const agentId = createAgentId(42);
  let ops: TaskOperations;
  let mocks: ReturnType<typeof createMockProgram>["mocks"];
  let mockProgram: ReturnType<typeof createMockProgram>["program"];

  beforeEach(() => {
    const created = createMockProgram();
    mockProgram = created.program;
    mocks = created.mocks;
    ops = new TaskOperations({
      program: mockProgram,
      agentId,
      logger: silentLogger,
    });
  });

  describe("constructor", () => {
    it("initializes with program and agentId", () => {
      expect(ops).toBeInstanceOf(TaskOperations);
    });

    it("accepts optional logger", () => {
      const opsWithLogger = new TaskOperations({
        program: mockProgram,
        agentId,
        logger: silentLogger,
      });
      expect(opsWithLogger).toBeInstanceOf(TaskOperations);
    });
  });

  describe("fetchTask", () => {
    it("returns parsed OnChainTask when found", async () => {
      const rawTask = createMockRawTask();
      mocks.taskFetch.mockResolvedValue(rawTask);

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchTask(taskPda);

      expect(result).not.toBeNull();
      expect(result!.rewardAmount).toBe(1_000_000n);
      expect(typeof result!.requiredCapabilities).toBe("bigint");
      expect(result!.status).toBe(OnChainTaskStatus.Open);
    });

    it("returns null for non-existent PDA", async () => {
      mocks.taskFetch.mockRejectedValue(new Error("Account does not exist"));

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchTask(taskPda);

      expect(result).toBeNull();
    });

    it("returns null for could not find error", async () => {
      mocks.taskFetch.mockRejectedValue(new Error("could not find account"));

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchTask(taskPda);

      expect(result).toBeNull();
    });

    it("throws on unexpected errors", async () => {
      mocks.taskFetch.mockRejectedValue(new Error("Network error"));

      const taskPda = Keypair.generate().publicKey;
      await expect(ops.fetchTask(taskPda)).rejects.toThrow("Network error");
    });
  });

  describe("fetchAllTasks", () => {
    it("returns all tasks from chain", async () => {
      mocks.getProgramAccounts.mockResolvedValue([
        createProgramTaskAccount({ rewardAmount: 1_000n }),
        createProgramTaskAccount({ rewardAmount: 2_000n }),
      ]);

      const results = await ops.fetchAllTasks();

      expect(results.length).toBe(2);
      expect(results[0].task.rewardAmount).toBe(1_000n);
      expect(results[1].task.rewardAmount).toBe(2_000n);
      expect(results[0].taskPda).toBeInstanceOf(PublicKey);
      expect(mocks.coderAccountsMemcmp).toHaveBeenCalledWith("task");
    });

    it("returns empty array when no tasks", async () => {
      mocks.getProgramAccounts.mockResolvedValue([]);

      const results = await ops.fetchAllTasks();

      expect(results).toEqual([]);
    });
  });

  describe("fetchClaimableTasks", () => {
    it("issues two memcmp-filtered queries for Open and InProgress", async () => {
      const openAccount = createProgramTaskAccount({
        status: OnChainTaskStatus.Open,
      });
      const inProgressAccount = createProgramTaskAccount({
        status: OnChainTaskStatus.InProgress,
      });

      mocks.getProgramAccounts.mockImplementation(
        (_programId: PublicKey, config?: { filters?: unknown[] }) => {
          const filters = config?.filters;
          if (!Array.isArray(filters) || filters.length < 2) {
            return Promise.resolve([]);
          }
          const filter = filters[1] as {
            memcmp: { offset: number; bytes: string };
          };
          if (
            filter.memcmp.bytes ===
            utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.Open]))
          ) {
            return Promise.resolve([openAccount]);
          }
          if (
            filter.memcmp.bytes ===
            utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.InProgress]))
          ) {
            return Promise.resolve([inProgressAccount]);
          }
          return Promise.resolve([]);
        },
      );

      const results = await ops.fetchClaimableTasks();

      expect(results.length).toBe(2);
      expect(results[0].task.status).toBe(OnChainTaskStatus.Open);
      expect(results[0].taskPda.equals(openAccount.pubkey)).toBe(true);
      expect(results[1].task.status).toBe(OnChainTaskStatus.InProgress);
      expect(results[1].taskPda.equals(inProgressAccount.pubkey)).toBe(true);

      expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(2);
      const firstCall = mocks.getProgramAccounts.mock.calls[0];
      const secondCall = mocks.getProgramAccounts.mock.calls[1];
      expect(firstCall[0]).toEqual(PROGRAM_ID);
      expect(secondCall[0]).toEqual(PROGRAM_ID);
      expect(firstCall[1].filters[0]).toEqual({
        memcmp: { offset: 0, bytes: "task-discriminator" },
      });
      expect(firstCall[1].filters[1]).toEqual({
        memcmp: {
          offset: TASK_STATUS_OFFSET,
          bytes: utils.bytes.bs58.encode(
            Buffer.from([OnChainTaskStatus.Open]),
          ),
        },
      });
      expect(secondCall[1].filters[0]).toEqual({
        memcmp: { offset: 0, bytes: "task-discriminator" },
      });
      expect(secondCall[1].filters[1]).toEqual({
        memcmp: {
          offset: TASK_STATUS_OFFSET,
          bytes: utils.bytes.bs58.encode(
            Buffer.from([OnChainTaskStatus.InProgress]),
          ),
        },
      });
    });

    it("uses correct offset 186 for status field", () => {
      expect(TASK_STATUS_OFFSET).toBe(186);
    });

    it("returns empty array when no claimable tasks exist", async () => {
      mocks.getProgramAccounts.mockResolvedValue([]);

      const results = await ops.fetchClaimableTasks();

      expect(results).toEqual([]);
    });

    it("falls back to fetchAllTasks on memcmp filter failure", async () => {
      const openAccount = createProgramTaskAccount({
        status: OnChainTaskStatus.Open,
      });
      const completedAccount = createProgramTaskAccount({
        status: OnChainTaskStatus.Completed,
      });

      mocks.getProgramAccounts.mockImplementation(
        (_programId: PublicKey, config?: { filters?: unknown[] }) => {
          const filters = config?.filters;
          if (Array.isArray(filters) && filters.length > 1) {
            return Promise.reject(
              new Error("RPC does not support memcmp filters"),
            );
          }
          return Promise.resolve([openAccount, completedAccount]);
        },
      );

      const results = await ops.fetchClaimableTasks();

      expect(results.length).toBe(1);
      expect(results[0].task.status).toBe(OnChainTaskStatus.Open);
      expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(3);
    });

    it("combines results from both filtered queries", async () => {
      const openAccounts = Array.from({ length: 3 }, () =>
        createProgramTaskAccount({ status: OnChainTaskStatus.Open }),
      );
      const inProgressAccounts = Array.from({ length: 2 }, () =>
        createProgramTaskAccount({ status: OnChainTaskStatus.InProgress }),
      );

      mocks.getProgramAccounts.mockImplementation(
        (_programId: PublicKey, config?: { filters?: unknown[] }) => {
          const filters = config?.filters;
          if (!Array.isArray(filters) || filters.length < 2) {
            return Promise.resolve([]);
          }
          const filter = filters[1] as {
            memcmp: { offset: number; bytes: string };
          };
          if (
            filter.memcmp.bytes ===
            utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.Open]))
          ) {
            return Promise.resolve(openAccounts);
          }
          if (
            filter.memcmp.bytes ===
            utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.InProgress]))
          ) {
            return Promise.resolve(inProgressAccounts);
          }
          return Promise.resolve([]);
        },
      );

      const results = await ops.fetchClaimableTasks();

      expect(results.length).toBe(5);
      expect(
        results.filter((r) => r.task.status === OnChainTaskStatus.Open).length,
      ).toBe(3);
      expect(
        results.filter((r) => r.task.status === OnChainTaskStatus.InProgress)
          .length,
      ).toBe(2);
    });
  });

  describe("fetchClaim", () => {
    it("returns this agent's claim when found", async () => {
      const rawClaim = createMockRawClaim(
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
      );
      mocks.taskClaimFetch.mockResolvedValue(rawClaim);

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchClaim(taskPda);

      expect(result).not.toBeNull();
      expect(result!.isCompleted).toBe(false);
    });

    it("returns null for non-existent claim", async () => {
      mocks.taskClaimFetch.mockRejectedValue(
        new Error("Account does not exist"),
      );

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchClaim(taskPda);

      expect(result).toBeNull();
    });
  });

  describe("fetchActiveClaims", () => {
    it("returns only uncompleted claims for this agent", async () => {
      // Need to get the agent PDA to create matching claims
      const { address: agentPda } = (() => {
        const [address, bump] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), Buffer.from(agentId)],
          PROGRAM_ID,
        );
        return { address, bump };
      })();

      const otherAgent = Keypair.generate().publicKey;
      const taskPda1 = Keypair.generate().publicKey;
      const taskPda2 = Keypair.generate().publicKey;

      mocks.taskClaimAll.mockResolvedValue([
        {
          publicKey: Keypair.generate().publicKey,
          account: createMockRawClaim(agentPda, taskPda1, {
            isCompleted: false,
          }),
        },
        {
          publicKey: Keypair.generate().publicKey,
          account: createMockRawClaim(agentPda, taskPda2, {
            isCompleted: true,
          }),
        },
        {
          publicKey: Keypair.generate().publicKey,
          account: createMockRawClaim(otherAgent, taskPda1, {
            isCompleted: false,
          }),
        },
      ]);

      const results = await ops.fetchActiveClaims();

      expect(results.length).toBe(1);
      expect(results[0].claim.isCompleted).toBe(false);
      expect(results[0].claim.worker.equals(agentPda)).toBe(true);
    });
  });

  describe("claimTask", () => {
    it("calls claimTask with correct accounts", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      const result = await ops.claimTask(taskPda, task);

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("claim-sig");
      expect(mocks.claimTaskBuilder.accountsPartial).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          systemProgram: SystemProgram.programId,
        }),
      );
    });

    it("throws TaskNotClaimableError on TaskFullyClaimed", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: {
          number: AnchorErrorCodes.TaskFullyClaimed,
          code: "TaskFullyClaimed",
        },
        message: "Task has reached maximum workers",
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(
        TaskNotClaimableError,
      );
    });

    it("throws TaskNotClaimableError on TaskExpired", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: {
          number: AnchorErrorCodes.TaskExpired,
          code: "TaskExpired",
        },
        message: "Task has expired",
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(
        TaskNotClaimableError,
      );
    });

    it("throws TaskNotClaimableError on InsufficientCapabilities", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: {
          number: AnchorErrorCodes.InsufficientCapabilities,
          code: "InsufficientCapabilities",
        },
        message: "Agent has insufficient capabilities",
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(
        TaskNotClaimableError,
      );
    });

    it("throws TaskNotClaimableError on TaskNotOpen", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: {
          number: AnchorErrorCodes.TaskNotOpen,
          code: "TaskNotOpen",
        },
        message: "Task is not open",
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(
        TaskNotClaimableError,
      );
    });

    it("throws TaskNotClaimableError on AlreadyClaimed", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: {
          number: AnchorErrorCodes.AlreadyClaimed,
          code: "AlreadyClaimed",
        },
        message: "Already claimed",
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(
        TaskNotClaimableError,
      );
    });
  });

  describe("completeTask", () => {
    it("calls completeTask with correct arguments", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);
      const resultData = new Uint8Array(64).fill(0xcd);

      const result = await ops.completeTask(
        taskPda,
        task,
        proofHash,
        resultData,
      );

      expect(result.success).toBe(true);
      expect(result.isPrivate).toBe(false);
      expect(result.transactionSignature).toBe("complete-sig");
    });

    it("handles null resultData", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);

      const result = await ops.completeTask(taskPda, task, proofHash, null);

      expect(result.success).toBe(true);
    });

    it("routes manual validation tasks to submitTaskResult", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask({
        constraintHash: new Uint8Array(MANUAL_VALIDATION_SENTINEL),
      });
      const proofHash = new Uint8Array(32).fill(0xab);

      const result = await ops.completeTask(taskPda, task, proofHash, null);

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("submit-sig");
      expect(mocks.submitTaskResultMethod).toHaveBeenCalledTimes(1);
      expect(mocks.completeTaskBuilder.accountsPartial).not.toHaveBeenCalled();
    });

    it("appends parent and accepted-bid settlement accounts when provided", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);
      const parentTaskPda = Keypair.generate().publicKey;
      const bidBook = Keypair.generate().publicKey;
      const acceptedBid = Keypair.generate().publicKey;
      const bidderMarketState = Keypair.generate().publicKey;
      const bidderAuthority = Keypair.generate().publicKey;

      await ops.completeTask(taskPda, task, proofHash, null, {
        parentTaskPda,
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
        bidderAuthority,
      });

      expect(mocks.completeTaskBuilder.remainingAccounts).toHaveBeenCalledWith([
        { pubkey: parentTaskPda, isSigner: false, isWritable: false },
        { pubkey: bidBook, isSigner: false, isWritable: true },
        { pubkey: acceptedBid, isSigner: false, isWritable: true },
        { pubkey: bidderMarketState, isSigner: false, isWritable: true },
        { pubkey: bidderAuthority, isSigner: false, isWritable: true },
      ]);
    });

    it("throws TaskSubmissionError on failure", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.completeTaskBuilder.rpc.mockRejectedValue(
        new Error("Transaction failed"),
      );

      await expect(
        ops.completeTask(taskPda, task, new Uint8Array(32).fill(0xab), null),
      ).rejects.toThrow(TaskSubmissionError);
    });
  });

  describe("completeTaskPrivate", () => {
    it("calls completeTaskPrivate with correct arguments", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const sealBytes = new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(0x01);
      sealBytes.set(TRUSTED_RISC0_SELECTOR, 0);
      const journal = new Uint8Array(RISC0_JOURNAL_LEN).fill(0x02);
      const imageId = new Uint8Array(RISC0_IMAGE_ID_LEN).fill(0x03);
      const bindingSeed = new Uint8Array(HASH_SIZE).fill(0x04);
      const nullifierSeed = new Uint8Array(HASH_SIZE).fill(0x05);

      const result = await ops.completeTaskPrivate(
        taskPda,
        task,
        sealBytes,
        journal,
        imageId,
        bindingSeed,
        nullifierSeed,
      );

      expect(result.success).toBe(true);
      expect(result.isPrivate).toBe(true);
      expect(result.transactionSignature).toBe("private-sig");

      expect(mocks.completeTaskPrivateMethod).toHaveBeenCalledTimes(1);
      const proofArg = mocks.completeTaskPrivateMethod.mock
        .calls[0][1] as Record<string, unknown>;
      expect(Buffer.isBuffer(proofArg.sealBytes)).toBe(true);
      expect(Buffer.isBuffer(proofArg.journal)).toBe(true);
      expect(Object.keys(proofArg).sort()).toEqual([
        "bindingSeed",
        "imageId",
        "journal",
        "nullifierSeed",
        "sealBytes",
      ]);

      const accounts = mocks.completeTaskPrivateBuilder.accountsPartial.mock
        .calls[0][0] as Record<string, unknown>;
      expect(accounts.bindingSpend).toBeInstanceOf(PublicKey);
      expect(accounts.nullifierSpend).toBeInstanceOf(PublicKey);
      expect(
        (accounts.routerProgram as PublicKey).equals(
          TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        ),
      ).toBe(true);
      expect(
        (accounts.verifierProgram as PublicKey).equals(
          TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
        ),
      ).toBe(true);
      expect(accounts.router).toBeInstanceOf(PublicKey);
      expect(accounts.verifierEntry).toBeInstanceOf(PublicKey);
      expect((accounts.creator as PublicKey).equals(task.creator)).toBe(true);
    });

    it("appends accepted-bid settlement accounts with explicit bidder authority", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const sealBytes = new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(0x01);
      sealBytes.set(TRUSTED_RISC0_SELECTOR, 0);
      const journal = new Uint8Array(RISC0_JOURNAL_LEN).fill(0x02);
      const imageId = new Uint8Array(RISC0_IMAGE_ID_LEN).fill(0x03);
      const bindingSeed = new Uint8Array(HASH_SIZE).fill(0x04);
      const nullifierSeed = new Uint8Array(HASH_SIZE).fill(0x05);
      const bidBook = Keypair.generate().publicKey;
      const acceptedBid = Keypair.generate().publicKey;
      const bidderMarketState = Keypair.generate().publicKey;
      const bidderAuthority = Keypair.generate().publicKey;

      await ops.completeTaskPrivate(
        taskPda,
        task,
        sealBytes,
        journal,
        imageId,
        bindingSeed,
        nullifierSeed,
        {
          acceptedBidSettlement: {
            bidBook,
            acceptedBid,
            bidderMarketState,
          },
          bidderAuthority,
        },
      );

      expect(
        mocks.completeTaskPrivateBuilder.remainingAccounts,
      ).toHaveBeenCalledWith([
        { pubkey: bidBook, isSigner: false, isWritable: true },
        { pubkey: acceptedBid, isSigner: false, isWritable: true },
        { pubkey: bidderMarketState, isSigner: false, isWritable: true },
        { pubkey: bidderAuthority, isSigner: false, isWritable: true },
      ]);
    });

    it("throws TaskSubmissionError on failure", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.completeTaskPrivateBuilder.rpc.mockRejectedValue(
        new Error("ZK verification failed"),
      );

      await expect(
        ops.completeTaskPrivate(
          taskPda,
          task,
          (() => {
            const sealBytes = new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(0x01);
            sealBytes.set(TRUSTED_RISC0_SELECTOR, 0);
            return sealBytes;
          })(),
          new Uint8Array(RISC0_JOURNAL_LEN).fill(0x02),
          new Uint8Array(RISC0_IMAGE_ID_LEN).fill(0x03),
          new Uint8Array(HASH_SIZE).fill(0x04),
          new Uint8Array(HASH_SIZE).fill(0x05),
        ),
      ).rejects.toThrow(TaskSubmissionError);
    });
  });

  describe("Task Validation V2", () => {
    it("configures task validation with creator review mode", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const attestor = Keypair.generate().publicKey;

      const result = await ops.configureTaskValidation(
        taskPda,
        task,
        TaskValidationMode.CreatorReview,
        900,
        2,
        attestor,
      );

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("configure-sig");
      expect(mocks.configureTaskValidationMethod).toHaveBeenCalledTimes(1);
      expect(mocks.configureTaskValidationMethod.mock.calls[0][0]).toBe(
        TaskValidationMode.CreatorReview,
      );
      expect(
        mocks.configureTaskValidationMethod.mock.calls[0][1].toString(),
      ).toBe("900");
      expect(mocks.configureTaskValidationMethod.mock.calls[0][2]).toBe(2);
      expect(mocks.configureTaskValidationMethod.mock.calls[0][3]).toBe(
        attestor,
      );
      expect(
        mocks.configureTaskValidationBuilder.accountsPartial,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          taskAttestorConfig: expect.any(PublicKey),
          creator: mockProgram.provider.publicKey,
          systemProgram: SystemProgram.programId,
        }),
      );
      expect(result.taskAttestorConfigPda).toBeInstanceOf(PublicKey);
    });

    it("submits a task result for creator review", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);
      const resultData = new Uint8Array(64).fill(0xcd);

      const result = await ops.submitTaskResult(
        taskPda,
        task,
        proofHash,
        resultData,
      );

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("submit-sig");
      expect(mocks.submitTaskResultMethod).toHaveBeenCalledTimes(1);
      expect(
        mocks.submitTaskResultBuilder.accountsPartial,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          authority: mockProgram.provider.publicKey,
          systemProgram: SystemProgram.programId,
        }),
      );
    });

    it("accepts a reviewed task result using the worker authority wallet", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const workerPda = Keypair.generate().publicKey;
      const workerAuthority = Keypair.generate().publicKey;
      const bidBook = Keypair.generate().publicKey;
      const acceptedBid = Keypair.generate().publicKey;
      const bidderMarketState = Keypair.generate().publicKey;

      mocks.agentRegistrationFetch.mockResolvedValue(
        createMockRawAgentRegistration(workerAuthority),
      );

      const result = await ops.acceptTaskResult(taskPda, task, workerPda, {
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
      });

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("accept-sig");
      expect(mocks.agentRegistrationFetch).toHaveBeenCalledWith(workerPda);
      expect(mocks.acceptTaskResultMethod).toHaveBeenCalledTimes(1);
      expect(mocks.acceptTaskResultBuilder.accountsPartial).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          worker: workerPda,
          creator: mockProgram.provider.publicKey,
          workerAuthority,
        }),
      );
      expect(
        mocks.acceptTaskResultBuilder.remainingAccounts,
      ).toHaveBeenCalledWith([
        { pubkey: bidBook, isSigner: false, isWritable: true },
        { pubkey: acceptedBid, isSigner: false, isWritable: true },
        { pubkey: bidderMarketState, isSigner: false, isWritable: true },
        { pubkey: workerAuthority, isSigner: false, isWritable: true },
      ]);
    });

    it("rejects a reviewed task result", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const workerPda = Keypair.generate().publicKey;
      const workerAuthority = Keypair.generate().publicKey;
      const rejectionHash = new Uint8Array(32).fill(0xee);

      mocks.agentRegistrationFetch.mockResolvedValue(
        createMockRawAgentRegistration(workerAuthority),
      );

      const result = await ops.rejectTaskResult(
        taskPda,
        task,
        workerPda,
        rejectionHash,
      );

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("reject-sig");
      expect(mocks.agentRegistrationFetch).toHaveBeenCalledWith(workerPda);
      expect(mocks.rejectTaskResultMethod).toHaveBeenCalledTimes(1);
      expect(mocks.rejectTaskResultBuilder.accountsPartial).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          creator: mockProgram.provider.publicKey,
          worker: workerPda,
          workerAuthority,
        }),
      );
    });

    it("auto-accepts a timed-out reviewed task result", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const workerPda = Keypair.generate().publicKey;
      const workerAuthority = Keypair.generate().publicKey;
      const bidBook = Keypair.generate().publicKey;
      const acceptedBid = Keypair.generate().publicKey;
      const bidderMarketState = Keypair.generate().publicKey;

      mocks.agentRegistrationFetch.mockResolvedValue(
        createMockRawAgentRegistration(workerAuthority),
      );

      const result = await ops.autoAcceptTaskResult(taskPda, task, workerPda, {
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
      });

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("auto-accept-sig");
      expect(mocks.autoAcceptTaskResultMethod).toHaveBeenCalledTimes(1);
      expect(
        mocks.autoAcceptTaskResultBuilder.accountsPartial,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          worker: workerPda,
          creator: task.creator,
          authority: mockProgram.provider.publicKey,
          workerAuthority,
        }),
      );
      expect(
        mocks.autoAcceptTaskResultBuilder.remainingAccounts,
      ).toHaveBeenCalledWith([
        { pubkey: bidBook, isSigner: false, isWritable: true },
        { pubkey: acceptedBid, isSigner: false, isWritable: true },
        { pubkey: bidderMarketState, isSigner: false, isWritable: true },
        { pubkey: workerAuthority, isSigner: false, isWritable: true },
      ]);
    });

    it("records a validator vote for a reviewed task result", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const workerPda = Keypair.generate().publicKey;
      const workerAuthority = Keypair.generate().publicKey;
      const validatorAgentPda = Keypair.generate().publicKey;

      mocks.agentRegistrationFetch.mockResolvedValue(
        createMockRawAgentRegistration(workerAuthority),
      );

      const result = await ops.validateTaskResult(
        taskPda,
        task,
        workerPda,
        true,
        validatorAgentPda,
      );

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe("validate-sig");
      expect(result.taskValidationVotePda).toBeInstanceOf(PublicKey);
      expect(mocks.validateTaskResultMethod).toHaveBeenCalledTimes(1);
      expect(mocks.validateTaskResultMethod).toHaveBeenCalledWith(true);
      expect(mocks.validateTaskResultBuilder.accountsPartial).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          worker: workerPda,
          creator: task.creator,
          reviewer: mockProgram.provider.publicKey,
          validatorAgent: validatorAgentPda,
          taskAttestorConfig: null,
          taskValidationVote: expect.any(PublicKey),
          workerAuthority,
        }),
      );
    });
  });

  describe("protocol treasury caching", () => {
    it("caches treasury address across multiple calls", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);

      await ops.completeTask(taskPda, task, proofHash, null);
      await ops.completeTask(taskPda, task, proofHash, null);

      // protocolConfig.fetch should only be called once (cached)
      expect(mocks.protocolConfigFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("agent PDA caching", () => {
    it("reuses cached agent PDA across operations", async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      await ops.claimTask(taskPda, task);
      await ops.claimTask(taskPda, task);

      // Both should use the same agent PDA (verified via claimTask accounts)
      const calls = mocks.claimTaskBuilder.accountsPartial.mock.calls;
      expect(calls[0][0].worker.equals(calls[1][0].worker)).toBe(true);
    });
  });

  describe("Input validation (#963)", () => {
    const taskPda = Keypair.generate().publicKey;
    const mockTask: OnChainTask = {
      taskId: new Uint8Array(32).fill(1),
      creator: Keypair.generate().publicKey,
      requiredCapabilities: 3n,
      description: new Uint8Array(64),
      constraintHash: new Uint8Array(32),
      rewardAmount: 1000000n,
      maxWorkers: 5,
      currentWorkers: 0,
      status: OnChainTaskStatus.InProgress,
      taskType: TaskType.Exclusive,
      createdAt: 1700000000,
      deadline: 1700003600,
      completedAt: 0,
      escrow: Keypair.generate().publicKey,
      result: new Uint8Array(64),
      completions: 0,
      requiredCompletions: 1,
      bump: 255,
      protocolFeeBps: 100,
      rewardMint: null,
      minReputation: 0,
      dependsOn: null,
      dependencyType: null,
    };

    it("completeTask rejects proofHash shorter than 32 bytes", async () => {
      await expect(
        ops.completeTask(taskPda, mockTask, new Uint8Array(16), null),
      ).rejects.toThrow("expected 32 bytes");
    });

    it("completeTask rejects all-zero proofHash", async () => {
      await expect(
        ops.completeTask(taskPda, mockTask, new Uint8Array(32), null),
      ).rejects.toThrow("cannot be all zeros");
    });

    it("completeTask rejects resultData shorter than 64 bytes", async () => {
      const validProof = new Uint8Array(32).fill(1);
      await expect(
        ops.completeTask(taskPda, mockTask, validProof, new Uint8Array(32)),
      ).rejects.toThrow("expected 64 bytes");
    });

    it("completeTaskPrivate rejects sealBytes shorter than expected", async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda,
          mockTask,
          new Uint8Array(RISC0_SEAL_BORSH_LEN - 1),
          new Uint8Array(RISC0_JOURNAL_LEN).fill(1),
          new Uint8Array(RISC0_IMAGE_ID_LEN).fill(1),
          new Uint8Array(HASH_SIZE).fill(1),
          new Uint8Array(HASH_SIZE).fill(1),
        ),
      ).rejects.toThrow(`expected ${RISC0_SEAL_BORSH_LEN} bytes`);
    });

    it("completeTaskPrivate rejects all-zero imageId", async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda,
          mockTask,
          (() => {
            const sealBytes = new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(1);
            sealBytes.set(TRUSTED_RISC0_SELECTOR, 0);
            return sealBytes;
          })(),
          new Uint8Array(RISC0_JOURNAL_LEN).fill(1),
          new Uint8Array(RISC0_IMAGE_ID_LEN),
          new Uint8Array(HASH_SIZE).fill(1),
          new Uint8Array(HASH_SIZE).fill(1),
        ),
      ).rejects.toThrow("cannot be all zeros");
    });

    it("completeTaskPrivate rejects all-zero bindingSeed", async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda,
          mockTask,
          (() => {
            const sealBytes = new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(1);
            sealBytes.set(TRUSTED_RISC0_SELECTOR, 0);
            return sealBytes;
          })(),
          new Uint8Array(RISC0_JOURNAL_LEN).fill(1),
          new Uint8Array(RISC0_IMAGE_ID_LEN).fill(1),
          new Uint8Array(HASH_SIZE),
          new Uint8Array(HASH_SIZE).fill(1),
        ),
      ).rejects.toThrow("cannot be all zeros");
    });

    it("completeTaskPrivate rejects all-zero nullifierSeed", async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda,
          mockTask,
          (() => {
            const sealBytes = new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(1);
            sealBytes.set(TRUSTED_RISC0_SELECTOR, 0);
            return sealBytes;
          })(),
          new Uint8Array(RISC0_JOURNAL_LEN).fill(1),
          new Uint8Array(RISC0_IMAGE_ID_LEN).fill(1),
          new Uint8Array(HASH_SIZE).fill(1),
          new Uint8Array(HASH_SIZE),
        ),
      ).rejects.toThrow("cannot be all zeros");
    });

    it("completeTaskPrivate rejects untrusted seal selector", async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda,
          mockTask,
          new Uint8Array(RISC0_SEAL_BORSH_LEN).fill(1),
          new Uint8Array(RISC0_JOURNAL_LEN).fill(1),
          new Uint8Array(RISC0_IMAGE_ID_LEN).fill(1),
          new Uint8Array(HASH_SIZE).fill(1),
          new Uint8Array(HASH_SIZE).fill(1),
        ),
      ).rejects.toThrow("trusted selector");
    });
  });
});
