import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@tetsuo-ai/sdk';
import { createAgencTools } from './index.js';
import {
  createListTasksTool,
  createGetTaskTool,
  createGetTokenBalanceTool,
  createGetJobSpecTool,
  createRegisterAgentTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
  _resetCreateTaskDedup,
} from './tools.js';
import type { ToolContext } from '../types.js';
import { silentLogger } from '../../utils/logger.js';
import {
  OnChainTaskStatus,
  TaskValidationMode,
} from '../../task/types.js';
import { TaskType } from '../../events/types.js';
import { findAuthorityRateLimitPda } from '../../agent/pda.js';
import { findTaskJobSpecPda } from '../../marketplace/task-job-spec.js';

// ============================================================================
// Mock Data Factories
// ============================================================================

const TASK_PDA = PublicKey.unique();
const AGENT_PDA = PublicKey.unique();
const CREATOR = PublicKey.unique();
const ESCROW = PublicKey.unique();
const SIGNER = PublicKey.unique();
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function fixedTextBytes(text: string, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode(text));
  return out;
}

function makeMockTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: new Uint8Array(32),
    creator: CREATOR,
    requiredCapabilities: 3n, // COMPUTE | INFERENCE
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: 1700003600,
    completedAt: 0,
    escrow: ESCROW,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    rewardMint: null,
    ...overrides,
  };
}

function makeMockAgent() {
  return {
    agentId: new Uint8Array(32),
    authority: PublicKey.unique(),
    capabilities: { toString: () => '1' },
    status: { active: {} },
    registeredAt: { toNumber: () => 1700000000 },
    lastActive: { toNumber: () => 1700000100 },
    endpoint: 'agent://test',
    metadataUri: '',
    tasksCompleted: { toString: () => '5' },
    totalEarned: { toString: () => '5000000000' },
    reputation: 8000,
    activeTasks: 1,
    stake: { toString: () => '1000000000' },
    lastTaskCreated: { toNumber: () => 0 },
    lastDisputeInitiated: { toNumber: () => 0 },
    taskCount24H: 0,
    disputeCount24H: 0,
    rateLimitWindowStart: { toNumber: () => 0 },
    activeDisputeVotes: 0,
    lastVoteTimestamp: { toNumber: () => 0 },
    lastStateUpdate: { toNumber: () => 0 },
    disputesAsDefendant: 0,
    bump: 254,
  };
}

function makeMockProtocolConfig() {
  return {
    authority: PublicKey.unique(),
    treasury: PublicKey.unique(),
    disputeThreshold: 51,
    protocolFeeBps: 100,
    minArbiterStake: { toString: () => '5000000000' },
    minAgentStake: { toString: () => '1000000000' },
    maxClaimDuration: { toNumber: () => 3600 },
    maxDisputeDuration: { toNumber: () => 86400 },
    totalAgents: { toString: () => '10' },
    totalTasks: { toString: () => '50' },
    completedTasks: { toString: () => '40' },
    totalValueDistributed: { toString: () => '100000000000' },
    bump: 255,
    multisigThreshold: 2,
    multisigOwnersLen: 3,
    taskCreationCooldown: { toNumber: () => 60 },
    maxTasksPer24H: 10,
    disputeInitiationCooldown: { toNumber: () => 300 },
    maxDisputesPer24H: 2,
    minStakeForDispute: { toString: () => '2000000000' },
    slashPercentage: 10,
    stateUpdateCooldown: { toNumber: () => 60 },
    votingPeriod: { toNumber: () => 86400 },
    protocolVersion: 1,
    minSupportedVersion: 1,
    multisigOwners: [PublicKey.unique(), PublicKey.unique(), PublicKey.unique()],
  };
}

// ============================================================================
// Mock TaskOperations
// ============================================================================

function createMockOps() {
  return {
    fetchClaimableTasks: vi.fn(async () => [
      { task: makeMockTask(), taskPda: TASK_PDA },
      { task: makeMockTask({ status: OnChainTaskStatus.InProgress }), taskPda: PublicKey.unique() },
    ]),
    fetchAllTasks: vi.fn(async () => [
      { task: makeMockTask(), taskPda: TASK_PDA },
      { task: makeMockTask({ status: OnChainTaskStatus.InProgress }), taskPda: PublicKey.unique() },
      { task: makeMockTask({ status: OnChainTaskStatus.Completed }), taskPda: PublicKey.unique() },
    ]),
    fetchTask: vi.fn(async (pda: PublicKey) => {
      if (pda.equals(TASK_PDA)) return makeMockTask();
      return null;
    }),
    fetchEscrowTokenBalance: vi.fn(async () => 123_456n),
  };
}

// ============================================================================
// Mock Program
// ============================================================================

function createMockProgram() {
  const taskJobSpecAccounts = new Map<string, any>();
  let lastSetTaskJobSpecArgs:
    | { jobSpecHash: number[]; jobSpecUri: string }
    | null = null;

  const createTaskMethodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn(async () => 'mock-create-task-sig'),
  };
  const configureTaskValidationMethodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn(async () => 'mock-configure-validation-sig'),
  };
  const registerAgentMethodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn(async () => 'mock-register-agent-sig'),
  };
  const setTaskJobSpecMethodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn(async () => {
      const accounts = setTaskJobSpecMethodChain.accountsPartial.mock.calls.at(-1)?.[0];
      if (!accounts || !lastSetTaskJobSpecArgs) {
        throw new Error('Missing taskJobSpec accounts or args');
      }
      taskJobSpecAccounts.set(accounts.taskJobSpec.toBase58(), {
        task: accounts.task,
        creator: accounts.creator,
        jobSpecHash: Uint8Array.from(lastSetTaskJobSpecArgs.jobSpecHash),
        jobSpecUri: lastSetTaskJobSpecArgs.jobSpecUri,
        createdAt: { toNumber: () => 1700000200 },
        updatedAt: { toNumber: () => 1700000200 },
        bump: 255,
      });
      return 'mock-set-task-job-spec-sig';
    }),
  };
  const getProgramAccounts = vi.fn(async () => [{ pubkey: AGENT_PDA }]);

  return {
    programId: PublicKey.unique(),
    provider: {
      publicKey: SIGNER,
      connection: {
        getProgramAccounts,
        getAccountInfo: vi.fn(async () => null),
        getTokenAccountBalance: vi.fn(async () => ({
          context: { slot: 1 },
          value: {
            amount: '2500000',
            decimals: 6,
            uiAmount: 2.5,
            uiAmountString: '2.5',
          },
        })),
      },
    },
    account: {
      agentRegistration: {
        fetch: vi.fn(async (pda: PublicKey) => {
          if (pda.equals(AGENT_PDA)) return makeMockAgent();
          throw new Error('Account does not exist');
        }),
      },
      protocolConfig: {
        fetch: vi.fn(async () => makeMockProtocolConfig()),
      },
      taskJobSpec: {
        fetch: vi.fn(async (pda: PublicKey) => {
          const account = taskJobSpecAccounts.get(pda.toBase58());
          if (account) return account;
          throw new Error('Account does not exist');
        }),
      },
    },
    methods: {
      createTask: vi.fn().mockReturnValue(createTaskMethodChain),
      configureTaskValidation: vi.fn().mockReturnValue(configureTaskValidationMethodChain),
      registerAgent: vi.fn().mockReturnValue(registerAgentMethodChain),
      setTaskJobSpec: vi.fn().mockImplementation((jobSpecHash: number[], jobSpecUri: string) => {
        lastSetTaskJobSpecArgs = { jobSpecHash, jobSpecUri };
        return setTaskJobSpecMethodChain;
      }),
    },
    _createTaskMethodChain: createTaskMethodChain,
    _configureTaskValidationMethodChain: configureTaskValidationMethodChain,
    _registerAgentMethodChain: registerAgentMethodChain,
    _setTaskJobSpecMethodChain: setTaskJobSpecMethodChain,
    _taskJobSpecAccounts: taskJobSpecAccounts,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createAgencTools', () => {
  it('returns all built-in agenc tools', () => {
    const mockProgram = createMockProgram() as unknown as ToolContext['program'];
    const tools = createAgencTools({
      connection: {} as ToolContext['connection'],
      program: mockProgram,
      logger: silentLogger,
    });

    expect(tools).toHaveLength(19);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'agenc.claimTask',
      'agenc.completeTask',
      'agenc.createProposal',
      'agenc.createTask',
      'agenc.delegateReputation',
      'agenc.getAgent',
      'agenc.getJobSpec',
      'agenc.getProtocolConfig',
      'agenc.getTask',
      'agenc.getTokenBalance',
      'agenc.initiateDispute',
      'agenc.listTasks',
      'agenc.purchaseSkill',
      'agenc.rateSkill',
      'agenc.registerAgent',
      'agenc.registerSkill',
      'agenc.resolveDispute',
      'agenc.stakeReputation',
      'agenc.voteProposal',
    ]);
  });
});

describe('agenc.listTasks', () => {
  let tool: ReturnType<typeof createListTasksTool>;
  let mockOps: ReturnType<typeof createMockOps>;

  beforeEach(() => {
    mockOps = createMockOps();
    tool = createListTasksTool(mockOps as never, silentLogger);
  });

  it('uses fetchClaimableTasks for open status (default)', async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(mockOps.fetchClaimableTasks).toHaveBeenCalled();
    expect(mockOps.fetchAllTasks).not.toHaveBeenCalled();
    expect(parsed.count).toBe(1); // Only Open tasks
  });

  it('uses fetchClaimableTasks for in_progress status', async () => {
    const result = await tool.execute({ status: 'in_progress' });
    const parsed = JSON.parse(result.content);

    expect(mockOps.fetchClaimableTasks).toHaveBeenCalled();
    expect(mockOps.fetchAllTasks).not.toHaveBeenCalled();
    expect(parsed.count).toBe(1); // Only InProgress tasks
  });

  it('uses fetchAllTasks for all status', async () => {
    const result = await tool.execute({ status: 'all' });
    const parsed = JSON.parse(result.content);

    expect(mockOps.fetchAllTasks).toHaveBeenCalled();
    expect(parsed.count).toBe(3);
  });

  it('respects limit parameter', async () => {
    const result = await tool.execute({ status: 'all', limit: 1 });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(3);
  });

  it('clamps limit to MAX_LIMIT', async () => {
    const result = await tool.execute({ status: 'all', limit: 999 });
    const parsed = JSON.parse(result.content);

    // Should still work (just capped at 200)
    expect(parsed.count).toBe(3);
  });

  it('returns valid task fields', async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0]).toHaveProperty('taskPda');
    expect(parsed.tasks[0]).toHaveProperty('status', 'Open');
    expect(parsed.tasks[0]).toHaveProperty('rewardSol');
    expect(parsed.tasks[0]).toHaveProperty('requiredCapabilities');
    expect(parsed.tasks[0]).toHaveProperty('isPrivate');
  });

  it('returns agent-readable descriptions and task type metadata', async () => {
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      {
        task: makeMockTask({
          description: fixedTextBytes('collab build'),
          taskType: TaskType.Collaborative,
        }),
        taskPda: TASK_PDA,
      },
    ]);

    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0]).toMatchObject({
      description: 'collab build',
      taskType: 'Collaborative',
      taskTypeId: TaskType.Collaborative,
      taskTypeKey: 'collaborative',
    });
    expect(parsed.tasks[0].descriptionHex).toMatch(/^[a-f0-9]{128}$/);
    expect(parsed.tasks[0].constraintHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serializes rewardMint as null for SOL tasks', async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0]).toHaveProperty('rewardMint', null);
  });

  it('serializes rewardMint as base58 for token tasks', async () => {
    const TOKEN_MINT = PublicKey.unique();
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      { task: makeMockTask({ rewardMint: TOKEN_MINT }), taskPda: TASK_PDA },
    ]);

    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0].rewardMint).toBe(TOKEN_MINT.toBase58());
  });

  it('filters list by rewardMint base58', async () => {
    const mintA = PublicKey.unique();
    const mintB = PublicKey.unique();
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      { task: makeMockTask({ rewardMint: mintA }), taskPda: PublicKey.unique() },
      { task: makeMockTask({ rewardMint: mintB }), taskPda: PublicKey.unique() },
      { task: makeMockTask({ rewardMint: null }), taskPda: PublicKey.unique() },
    ]);

    const result = await tool.execute({ rewardMint: mintB.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.tasks[0].rewardMint).toBe(mintB.toBase58());
  });

  it('filters list by SOL rewardMint alias', async () => {
    const mintA = PublicKey.unique();
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      { task: makeMockTask({ rewardMint: mintA }), taskPda: PublicKey.unique() },
      { task: makeMockTask({ rewardMint: null }), taskPda: PublicKey.unique() },
    ]);

    const result = await tool.execute({ rewardMint: 'SOL' });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.tasks[0].rewardMint).toBeNull();
  });

  it('filters list by task type alias', async () => {
    mockOps.fetchAllTasks.mockResolvedValueOnce([
      { task: makeMockTask({ taskType: TaskType.Exclusive }), taskPda: PublicKey.unique() },
      { task: makeMockTask({ taskType: TaskType.Collaborative }), taskPda: PublicKey.unique() },
    ]);

    const result = await tool.execute({ status: 'all', taskType: 'collaborative' });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.tasks[0].taskTypeKey).toBe('collaborative');
  });

  it('includes published job spec summaries when on-chain metadata exists', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const createResult = await createTool.execute({
      description: 'listed spec',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Metadata published for list queries.',
    });
    const created = JSON.parse(createResult.content);
    const createdTaskPda = new PublicKey(created.taskPda);

    mockOps.fetchAllTasks.mockResolvedValueOnce([
      { task: makeMockTask(), taskPda: createdTaskPda },
    ]);
    tool = createListTasksTool(mockOps as never, silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const result = await tool.execute({ status: 'all' });
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0].jobSpec).toMatchObject({
      source: 'on-chain',
      verified: false,
      taskJobSpecPda: created.taskJobSpecPda,
      creator: SIGNER.toBase58(),
      jobSpecHash: created.jobSpecHash,
      jobSpecUri: created.jobSpecUri,
    });
  });

  it('can include full job spec payloads for listed tasks when requested', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const createResult = await createTool.execute({
      description: 'listed payload',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Agents should see this complete list payload.',
    });
    const created = JSON.parse(createResult.content);
    const createdTaskPda = new PublicKey(created.taskPda);

    mockOps.fetchAllTasks.mockResolvedValueOnce([
      { task: makeMockTask(), taskPda: createdTaskPda },
    ]);
    tool = createListTasksTool(mockOps as never, silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const result = await tool.execute({
      status: 'all',
      includeJobSpecPayload: true,
    });
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0].jobSpec).toMatchObject({
      source: 'on-chain',
      verified: true,
      taskJobSpecPda: created.taskJobSpecPda,
    });
    expect(parsed.tasks[0].jobSpec.payload.fullDescription).toBe(
      'Agents should see this complete list payload.',
    );
  });
});

describe('agenc.getTask', () => {
  let tool: ReturnType<typeof createGetTaskTool>;
  let mockOps: ReturnType<typeof createMockOps>;

  beforeEach(() => {
    mockOps = createMockOps();
    tool = createGetTaskTool(mockOps as never, silentLogger);
  });

  it('returns task details for valid PDA', async () => {
    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.taskPda).toBe(TASK_PDA.toBase58());
    expect(parsed.status).toBe('Open');
  });

  it('returns completion and result details in agent-readable form', async () => {
    mockOps.fetchTask.mockResolvedValueOnce(makeMockTask({
      completedAt: 1700009999,
      description: fixedTextBytes('verify build'),
      result: fixedTextBytes('done proof'),
      status: OnChainTaskStatus.Completed,
      taskType: TaskType.Competitive,
    }));

    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(parsed).toMatchObject({
      completedAt: 1700009999,
      description: 'verify build',
      resultText: 'done proof',
      status: 'Completed',
      taskTypeKey: 'competitive',
    });
    expect(parsed.result).toMatch(/^[a-f0-9]{128}$/);
  });

  it('includes escrow token balance for token tasks', async () => {
    mockOps.fetchTask.mockResolvedValueOnce(makeMockTask({ rewardMint: USDC_MINT, escrow: ESCROW }));
    mockOps.fetchEscrowTokenBalance.mockResolvedValueOnce(123n);

    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(parsed.rewardMint).toBe(USDC_MINT.toBase58());
    expect(parsed.escrowTokenBalance).toBe('123');
    expect(parsed.escrowTokenAccount).toBeTypeOf('string');
  });

  it('returns isError for invalid base58', async () => {
    const result = await tool.execute({ taskPda: 'not-valid-base58!!!' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Invalid base58');
  });

  it('returns isError for not-found task', async () => {
    const result = await tool.execute({ taskPda: PublicKey.unique().toBase58() });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('not found');
  });

  it('returns isError for missing taskPda', async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });

  it('includes verified published job spec metadata when requested', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const createResult = await createTool.execute({
      description: 'detail spec',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Detailed metadata for getTask.',
    });
    const created = JSON.parse(createResult.content);
    const createdTaskPda = new PublicKey(created.taskPda);

    mockOps.fetchTask.mockImplementation(async (pda: PublicKey) => {
      if (pda.equals(createdTaskPda)) return makeMockTask();
      return null;
    });
    tool = createGetTaskTool(mockOps as never, silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const result = await tool.execute({ taskPda: created.taskPda });
    const parsed = JSON.parse(result.content);

    expect(parsed.jobSpec).toMatchObject({
      source: 'on-chain',
      verified: true,
      taskJobSpecPda: created.taskJobSpecPda,
      creator: SIGNER.toBase58(),
      jobSpecHash: created.jobSpecHash,
      jobSpecUri: created.jobSpecUri,
    });
    expect(parsed.jobSpec.payload.fullDescription).toBe('Detailed metadata for getTask.');
  });
});

describe('agenc.getJobSpec', () => {
  beforeEach(() => {
    _resetCreateTaskDedup();
  });

  it('returns a verified full job spec by task PDA via the on-chain pointer', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const getJobSpecTool = createGetJobSpecTool(silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const createResult = await createTool.execute({
      description: 'worker spec',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Run the worker-side job spec resolver and return the payload.',
      acceptanceCriteria: ['resolves by task PDA', 'verifies sha256 hash'],
      deliverables: ['resolved payload'],
    });
    const created = JSON.parse(createResult.content);
    const expectedTaskJobSpecPda = findTaskJobSpecPda(
      new PublicKey(created.taskPda),
      mockProgram.programId,
    ).toBase58();

    const result = await getJobSpecTool.execute({ taskPda: created.taskPda });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.source).toBe('on-chain');
    expect(parsed.taskPda).toBe(created.taskPda);
    expect(parsed.taskId).toBe(created.taskId);
    expect(parsed.taskJobSpecPda).toBe(expectedTaskJobSpecPda);
    expect(parsed.creator).toBe(SIGNER.toBase58());
    expect(parsed.jobSpecHash).toBe(created.jobSpecHash);
    expect(parsed.jobSpecUri).toBe(created.jobSpecUri);
    expect(parsed.jobSpecPath).toBe(created.jobSpecPath);
    expect(parsed.jobSpecTaskLinkPath).toBe(created.jobSpecTaskLinkPath);
    expect(parsed.transactionSignature).toBe('mock-set-task-job-spec-sig');
    expect(parsed.integrity.payloadHash).toBe(created.jobSpecHash);
    expect(parsed.payload.fullDescription).toBe(
      'Run the worker-side job spec resolver and return the payload.',
    );
    expect(parsed.payload.acceptanceCriteria).toEqual([
      'resolves by task PDA',
      'verifies sha256 hash',
    ]);
  });

  it('returns isError when no task job spec metadata exists', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const tool = createGetJobSpecTool(silentLogger, {
      program: createMockProgram() as never,
      jobSpecStoreDir: rootDir,
    });

    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      'No task job spec metadata found',
    );
  });

  it('returns isError when the job spec object is tampered', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const getJobSpecTool = createGetJobSpecTool(silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const createResult = await createTool.execute({
      description: 'tamper spec',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Original spec body.',
    });
    const created = JSON.parse(createResult.content);
    const envelope = JSON.parse(await readFile(created.jobSpecPath, 'utf8'));
    envelope.payload.fullDescription = 'Tampered spec body.';
    await writeFile(created.jobSpecPath, JSON.stringify(envelope), 'utf8');

    const result = await getJobSpecTool.execute({ taskPda: created.taskPda });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      'failed integrity verification',
    );
  });

  it('fetches and verifies a public https job spec when the pointer uses a remote uri', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const getJobSpecTool = createGetJobSpecTool(silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const createResult = await createTool.execute({
      description: 'remote spec',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Resolve this job spec from public storage.',
    });
    const created = JSON.parse(createResult.content);
    const envelope = JSON.parse(await readFile(created.jobSpecPath, 'utf8'));
    const publicUri = 'https://example.com/agenc/job-spec.json';
    const taskJobSpecPda = findTaskJobSpecPda(
      new PublicKey(created.taskPda),
      mockProgram.programId,
    ).toBase58();
    mockProgram._taskJobSpecAccounts.get(taskJobSpecPda).jobSpecUri = publicUri;
    const link = JSON.parse(await readFile(created.jobSpecTaskLinkPath, 'utf8'));
    link.jobSpecUri = publicUri;
    await writeFile(created.jobSpecTaskLinkPath, JSON.stringify(link), 'utf8');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(`${JSON.stringify(envelope)}\n`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    try {
      const result = await getJobSpecTool.execute({ taskPda: created.taskPda });
      const parsed = JSON.parse(result.content);

      expect(result.isError).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledWith(publicUri, {
        headers: { accept: 'application/json' },
      });
      expect(parsed.source).toBe('on-chain');
      expect(parsed.jobSpecHash).toBe(created.jobSpecHash);
      expect(parsed.jobSpecUri).toBe(publicUri);
      expect(parsed.jobSpecPath).toBe(publicUri);
      expect(parsed.integrity.uri).toBe(`agenc://job-spec/sha256/${created.jobSpecHash}`);
      expect(parsed.payload.fullDescription).toBe(
        'Resolve this job spec from public storage.',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns isError when the task link uri no longer matches the hash', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const createTool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });
    const getJobSpecTool = createGetJobSpecTool(silentLogger, {
      program: mockProgram as never,
      jobSpecStoreDir: rootDir,
    });

    const createResult = await createTool.execute({
      description: 'mismatch spec',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Spec body.',
    });
    const created = JSON.parse(createResult.content);
    const link = JSON.parse(await readFile(created.jobSpecTaskLinkPath, 'utf8'));
    link.jobSpecUri = 'agenc://job-spec/sha256/' + '0'.repeat(64);
    await writeFile(created.jobSpecTaskLinkPath, JSON.stringify(link), 'utf8');

    const result = await getJobSpecTool.execute({ taskPda: created.taskPda });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      'task link uri does not match hash',
    );
  });
});

describe('agenc.getTokenBalance' , () => {
  it('returns token balance for mint and default owner', async () => {
    const mockProgram = createMockProgram();
    const tool = createGetTokenBalanceTool(mockProgram as never, silentLogger);

    const result = await tool.execute({ mint: USDC_MINT.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.mint).toBe(USDC_MINT.toBase58());
    expect(parsed.owner).toBe(SIGNER.toBase58());
    expect(parsed.amount).toBe('2500000');
  });
});

describe('agenc.registerAgent', () => {
  it('returns existing registration when signer is already registered', async () => {
    const mockProgram = createMockProgram();
    const tool = createRegisterAgentTool(mockProgram as never, silentLogger);

    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.alreadyRegistered).toBe(true);
    expect(parsed.agentPda).toBe(AGENT_PDA.toBase58());
    expect(mockProgram.methods.registerAgent).not.toHaveBeenCalled();
  });

  it('registers a new agent when signer has no registration', async () => {
    const mockProgram = createMockProgram();
    (mockProgram.provider.connection.getProgramAccounts as any).mockResolvedValueOnce([]);
    const tool = createRegisterAgentTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      capabilities: '1',
      endpoint: 'https://agenc.local',
    });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.transactionSignature).toBe('mock-register-agent-sig');
    expect(parsed.agentPda).toBeTypeOf('string');
    expect(parsed.stakeAmount).toBe('1000000000');
    expect(mockProgram.methods.registerAgent).toHaveBeenCalledOnce();
    expect(mockProgram.methods.registerAgent).toHaveBeenCalledWith(
      expect.any(Array),
      expect.anything(),
      'https://agenc.local',
      null,
      expect.anything(),
    );
  });

  it('rejects zero capabilities', async () => {
    const mockProgram = createMockProgram();
    (mockProgram.provider.connection.getProgramAccounts as any).mockResolvedValueOnce([]);
    const tool = createRegisterAgentTool(mockProgram as never, silentLogger);

    const result = await tool.execute({ capabilities: '0' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('capabilities must be greater than zero');
  });

  it('rejects stakeAmount below protocol minimum', async () => {
    const mockProgram = createMockProgram();
    (mockProgram.provider.connection.getProgramAccounts as any).mockResolvedValueOnce([]);
    const tool = createRegisterAgentTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      capabilities: '1',
      endpoint: 'https://agenc.local',
      stakeAmount: '1',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('stakeAmount must be at least protocol minAgentStake');
  });

  it('returns an error when protocol config cannot be loaded', async () => {
    const mockProgram = createMockProgram();
    (mockProgram.provider.connection.getProgramAccounts as any).mockResolvedValueOnce([]);
    mockProgram.account.protocolConfig.fetch.mockRejectedValueOnce(new Error('missing protocol config'));
    const tool = createRegisterAgentTool(mockProgram as never, silentLogger);

    const result = await tool.execute({ capabilities: '1', endpoint: 'https://agenc.local' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Failed to fetch protocol config');
  });
});

describe('agenc.createTask', () => {
  beforeEach(() => {
    _resetCreateTaskDedup();
  });

  it('creates a SOL task with defaults', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'hello task',
      reward: '1000000',
      requiredCapabilities: '1',
    });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.taskPda).toBeTypeOf('string');
    expect(parsed.transactionSignature).toBe('mock-create-task-sig');
    expect(parsed.rewardMint).toBeNull();
    expect(parsed.taskType).toBe('Exclusive');
    expect(parsed.taskTypeId).toBe(TaskType.Exclusive);
    expect(parsed.taskTypeKey).toBe('exclusive');
    expect(parsed.validationMode).toBe('auto');
    expect(parsed.validationConfigured).toBe(false);
    expect(mockProgram.methods.createTask).toHaveBeenCalledOnce();

    const accounts = mockProgram._createTaskMethodChain.accountsPartial.mock.calls[0][0];
    const expectedAuthorityRateLimit = findAuthorityRateLimitPda(
      SIGNER,
      mockProgram.programId,
    );
    expect(accounts.authorityRateLimit.equals(expectedAuthorityRateLimit)).toBe(true);
    expect(parsed.authorityRateLimitPda).toBe(
      expectedAuthorityRateLimit.toBase58(),
    );
  });

  it('accepts task type aliases when creating tasks', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'collab task',
      reward: '1000000',
      requiredCapabilities: '1',
      taskType: 'collaborative',
      maxWorkers: 2,
    });
    const parsed = JSON.parse(result.content);
    const createTaskArgs = mockProgram.methods.createTask.mock.calls[0];

    expect(result.isError).toBeUndefined();
    expect(parsed.taskType).toBe('Collaborative');
    expect(parsed.taskTypeId).toBe(TaskType.Collaborative);
    expect(parsed.taskTypeKey).toBe('collaborative');
    expect(createTaskArgs[6]).toBe(TaskType.Collaborative);
  });

  it('treats placeholder strings on optional createTask fields as omitted', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'placeholder task',
      reward: '1000000',
      requiredCapabilities: '1',
      taskId: 'None',
      creatorAgentPda: 'None',
      rewardMint: 'None',
      constraintHash: 'None',
      validationMode: 'None',
      maxWorkers: 'None',
      minReputation: 'None',
      reviewWindowSecs: 'None',
    });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.taskId).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.creatorAgentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.rewardMint).toBeNull();
    expect(parsed.constraintHash).toBeNull();
    expect(parsed.validationMode).toBe('auto');
    expect(parsed.validationConfigured).toBe(false);
    expect(parsed.minReputation).toBe(0);
    expect(mockProgram.methods.createTask).toHaveBeenCalledOnce();
  });

  it('creates and configures a creator-review task', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'review task',
      reward: '1000000',
      requiredCapabilities: '1',
      validationMode: 'creator-review',
      reviewWindowSecs: 120,
    });
    const parsed = JSON.parse(result.content);
    const createTaskArgs = mockProgram.methods.createTask.mock.calls[0];
    const configureArgs = mockProgram.methods.configureTaskValidation.mock.calls[0];

    expect(result.isError).toBeUndefined();
    expect(parsed.validationMode).toBe('creator-review');
    expect(parsed.validationConfigured).toBe(true);
    expect(parsed.reviewWindowSecs).toBe(120);
    expect(parsed.constraintHash).toBeNull();
    expect(parsed.validationTransactionSignature).toBe('mock-configure-validation-sig');
    expect(createTaskArgs[7]).toBeNull();
    expect(configureArgs[0]).toBe(TaskValidationMode.CreatorReview);
    expect(configureArgs[1].toString()).toBe('120');
    expect(configureArgs[2]).toBe(0);
    expect(configureArgs[3]).toBeNull();
  });

  it('stores full marketplace job specs by hash, publishes an on-chain pointer, and links them to the task', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });

    const result = await tool.execute({
      description: 'build scraper',
      reward: '1000000',
      requiredCapabilities: '1',
      fullDescription: 'Build a scraper with pagination, retries, and JSON output.',
      acceptanceCriteria: ['handles pagination', 'writes JSON report'],
      deliverables: ['source code', 'README'],
      constraints: { noSecrets: true, maxRuntimeSecs: 60 },
      attachments: [{ uri: 'https://example.com/spec.md', label: 'Spec' }],
    });
    const parsed = JSON.parse(result.content);
    const expectedTaskJobSpecPda = findTaskJobSpecPda(
      new PublicKey(parsed.taskPda),
      mockProgram.programId,
    ).toBase58();

    expect(result.isError).toBeUndefined();
    expect(parsed.jobSpecHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.jobSpecUri).toBe(`agenc://job-spec/sha256/${parsed.jobSpecHash}`);
    expect(parsed.jobSpecPath).toContain(`${parsed.jobSpecHash}.json`);
    expect(parsed.jobSpecTaskLinkPath).toContain(`${parsed.taskPda}.json`);
    expect(parsed.taskJobSpecPda).toBe(expectedTaskJobSpecPda);
    expect(parsed.jobSpecTransactionSignature).toBe('mock-set-task-job-spec-sig');
    expect(parsed.jobSpecIntegrity).toEqual({
      algorithm: 'sha256',
      canonicalization: 'json-stable-v1',
    });
    expect(mockProgram.methods.setTaskJobSpec).toHaveBeenCalledOnce();

    const envelope = JSON.parse(await readFile(parsed.jobSpecPath, 'utf8'));
    expect(envelope.integrity.payloadHash).toBe(parsed.jobSpecHash);
    expect(envelope.payload.shortDescription).toBe('build scraper');
    expect(envelope.payload.fullDescription).toBe(
      'Build a scraper with pagination, retries, and JSON output.',
    );
    expect(envelope.payload.acceptanceCriteria).toEqual([
      'handles pagination',
      'writes JSON report',
    ]);
    expect(envelope.payload.constraints).toEqual({
      maxRuntimeSecs: 60,
      noSecrets: true,
    });
    expect(envelope.payload.attachments).toEqual([
      { uri: 'https://example.com/spec.md', label: 'Spec' },
    ]);

    const link = JSON.parse(await readFile(parsed.jobSpecTaskLinkPath, 'utf8'));
    expect(link.taskPda).toBe(parsed.taskPda);
    expect(link.taskId).toBe(parsed.taskId);
    expect(link.jobSpecHash).toBe(parsed.jobSpecHash);
    expect(link.jobSpecUri).toBe(parsed.jobSpecUri);
    expect(link.transactionSignature).toBe('mock-set-task-job-spec-sig');
  });

  it('rejects unsafe job spec metadata before sending the createTask RPC' , async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agenc-job-spec-'));
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger, {
      jobSpecStoreDir: rootDir,
    });

    const result = await tool.execute({
      description: 'unsafe spec',
      reward: '1000000',
      requiredCapabilities: '1',
      attachments: ['file:///etc/passwd'],
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Invalid jobSpec metadata');
    expect(mockProgram.methods.createTask).not.toHaveBeenCalled();
  });

  it('rejects explicit constraint hashes for creator-review tasks', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'bad review task',
      reward: '1000000',
      requiredCapabilities: '1',
      validationMode: 'creator-review',
      constraintHash: '00'.repeat(32),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Do not provide constraintHash');
    expect(mockProgram.methods.createTask).not.toHaveBeenCalled();
  });

  it('rejects creator-review for non-exclusive task types before sending the createTask RPC', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'bad competitive review task',
      reward: '1000000',
      requiredCapabilities: '1',
      taskType: TaskType.Competitive,
      validationMode: 'creator-review',
      fullDescription: 'This should not be persisted or created before validation fails.',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      'validationMode="creator-review" is only supported when taskType is 0/exclusive',
    );
    expect(mockProgram.methods.createTask).not.toHaveBeenCalled();
  });

  it('rejects requiredCapabilities of zero', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'hello task',
      reward: '1000000',
      requiredCapabilities: '0',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('requiredCapabilities must be greater than zero');
  });

  it('rejects unknown reward mints', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);
    const unknownMint = PublicKey.unique();

    const result = await tool.execute({
      description: 'hello task',
      reward: '1000000',
      requiredCapabilities: '1',
      rewardMint: unknownMint.toBase58(),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Unsupported rewardMint');
  });

  it('wires SPL reward accounts for known reward mints', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'usdc task',
      reward: '1000000',
      requiredCapabilities: '1',
      rewardMint: USDC_MINT.toBase58(),
    });
    const parsed = JSON.parse(result.content);
    const accounts = mockProgram._createTaskMethodChain.accountsPartial.mock.calls[0][0];

    expect(result.isError).toBeUndefined();
    expect(parsed.rewardMint).toBe(USDC_MINT.toBase58());
    expect(accounts.rewardMint.equals(USDC_MINT)).toBe(true);
    expect(accounts.creatorTokenAccount.equals(getAssociatedTokenAddressSync(USDC_MINT, SIGNER))).toBe(
      true,
    );
    expect(
      accounts.tokenEscrowAta.equals(
        getAssociatedTokenAddressSync(USDC_MINT, accounts.escrow, true),
      ),
    ).toBe(true);
    expect(accounts.tokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(accounts.associatedTokenProgram.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('proceeds to RPC without pre-checking protocol config (on-chain validation)', async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: 'protocol check task',
      reward: '1000000',
      requiredCapabilities: '1',
    });

    // createTask no longer pre-validates protocol config or agent registration;
    // the on-chain program handles those checks. With a successful mock RPC, it returns success.
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content).transactionSignature).toBe('mock-create-task-sig');
  });
});

describe('agenc.getAgent', () => {
  let tool: ReturnType<typeof createGetAgentTool>;

  beforeEach(() => {
    const mockProgram = createMockProgram();
    tool = createGetAgentTool(mockProgram as never, silentLogger);
  });

  it('returns agent details for valid PDA', async () => {
    const result = await tool.execute({ agentPda: AGENT_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.agentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.status).toBe('Active');
    expect(parsed.capabilities).toContain('COMPUTE');
  });

  it('returns isError for invalid base58', async () => {
    const result = await tool.execute({ agentPda: '!!!invalid' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Invalid base58');
  });

  it('returns isError for not-found agent', async () => {
    const result = await tool.execute({ agentPda: PublicKey.unique().toBase58() });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('not found');
  });
});

describe('agenc.getProtocolConfig', () => {
  let tool: ReturnType<typeof createGetProtocolConfigTool>;

  beforeEach(() => {
    const mockProgram = createMockProgram();
    tool = createGetProtocolConfigTool(mockProgram as never, silentLogger);
  });

  it('returns protocol config', async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed).toHaveProperty('protocolFeeBps', 100);
    expect(parsed).toHaveProperty('disputeThreshold', 51);
    expect(parsed).toHaveProperty('protocolVersion', 1);
    expect(parsed).toHaveProperty('totalTasks', '50');
  });

  it('returns protocol init guidance when config account is missing', async () => {
    const mockProgram = createMockProgram();
    mockProgram.account.protocolConfig.fetch.mockRejectedValueOnce(
      new Error('Account does not exist or has no data Fn9U13jRCieDTQ8oKsEqcrqs3CoohbBnbYD4gdt6CPXE'),
    );
    const missingTool = createGetProtocolConfigTool(mockProgram as never, silentLogger);

    const result = await missingTool.execute({});

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain('Protocol config is not initialized');
  });
});
