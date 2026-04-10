import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { ToolResult } from '../types.js';
import { silentLogger } from '../../utils/logger.js';
import { DisputeOperations } from '../../dispute/operations.js';
import type { OnChainDispute } from '../../dispute/types.js';
import { OnChainDisputeStatus, ResolutionType } from '../../dispute/types.js';
import { GovernanceOperations } from '../../governance/operations.js';
import { ProposalStatus, ProposalType } from '../../governance/types.js';
import * as marketplaceSerialization from '../../marketplace/serialization.js';
import { TaskOperations } from '../../task/operations.js';
import type { OnChainTask } from '../../task/types.js';
import { OnChainTaskStatus, TaskType } from '../../task/types.js';
import {
  createGetDisputeTool,
  createGetGovernanceProposalTool,
  createGetReputationSummaryTool,
  createGetSkillTool,
  createInspectMarketplaceTool,
  createListDisputesTool,
  createListGovernanceProposalsTool,
  createListSkillsTool,
} from './tools.js';

function parseJson(result: ToolResult) {
  return JSON.parse(result.content) as Record<string, any>;
}

function fixedBytes(value: string, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(value).slice(0, size));
  return bytes;
}

function makeSkillAccount({
  id,
  author,
  name,
  tags,
  ratingCount,
  totalRating,
  downloads,
  isActive,
}: {
  id: number;
  author: PublicKey;
  name: string;
  tags: string[];
  ratingCount: number;
  totalRating: number;
  downloads: number;
  isActive: boolean;
}) {
  return {
    skillId: new Uint8Array(32).fill(id),
    author,
    name: fixedBytes(name),
    tags: fixedBytes(tags.join(',')),
    price: { toString: () => '42' },
    priceMint: null,
    ratingCount,
    totalRating: { toString: () => String(totalRating) },
    downloadCount: downloads,
    version: 1,
    isActive,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    contentHash: new Uint8Array(32).fill(id + 10),
  };
}

function makeTaskRecord(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32).fill(7),
    creator: PublicKey.unique(),
    requiredCapabilities: 0n,
    description: fixedBytes('Disputed task payload'),
    constraintHash: new Uint8Array(32),
    rewardAmount: 2_500_000_000n,
    maxWorkers: 1,
    currentWorkers: 1,
    status: OnChainTaskStatus.Disputed,
    taskType: TaskType.Exclusive,
    createdAt: 1_700_000_000,
    deadline: 1_700_010_000,
    completedAt: 0,
    escrow: PublicKey.unique(),
    result: fixedBytes('result'),
    completions: 0,
    requiredCompletions: 1,
    bump: 1,
    rewardMint: null,
    ...overrides,
  };
}

function makeDisputeRecord(overrides: Partial<OnChainDispute> = {}): OnChainDispute {
  return {
    disputeId: new Uint8Array(32).fill(9),
    task: PublicKey.unique(),
    initiator: PublicKey.unique(),
    initiatorAuthority: PublicKey.unique(),
    evidenceHash: new Uint8Array(32).fill(4),
    resolutionType: ResolutionType.Refund,
    status: OnChainDisputeStatus.Active,
    createdAt: 1_700_000_123,
    resolvedAt: 0,
    votesFor: 3n,
    votesAgainst: 1n,
    totalVoters: 4,
    votingDeadline: 1_700_000_456,
    expiresAt: 1_700_000_789,
    slashApplied: false,
    initiatorSlashApplied: false,
    workerStakeAtDispute: 750_000_000n,
    initiatedByCreator: false,
    bump: 1,
    defendant: PublicKey.unique(),
    rewardMint: null,
    ...overrides,
  };
}

function makeProposal(status: ProposalStatus, seed: number) {
  return {
    proposer: PublicKey.unique(),
    proposerAuthority: PublicKey.unique(),
    nonce: BigInt(seed),
    proposalType: ProposalType.FeeChange,
    titleHash: new Uint8Array(32).fill(seed),
    descriptionHash: new Uint8Array(32).fill(seed + 1),
    payload: fixedBytes(`payload-${seed}`),
    status,
    createdAt: 1_700_000_000 + seed,
    votingDeadline: 1_700_000_100 + seed,
    executionAfter: 1_700_000_200 + seed,
    executedAt: status === ProposalStatus.Executed ? 1_700_000_300 + seed : 0,
    votesFor: BigInt(10 + seed),
    votesAgainst: BigInt(seed),
    totalVoters: 3 + seed,
    quorum: BigInt(20),
    bump: 1,
  };
}

function createMockProgram() {
  const firstSkillPda = PublicKey.unique();
  const secondSkillPda = PublicKey.unique();
  const thirdSkillPda = PublicKey.unique();
  const author = PublicKey.unique();

  const skillAccounts = [
    {
      publicKey: firstSkillPda,
      account: makeSkillAccount({
        id: 1,
        author,
        name: 'Solana Router',
        tags: ['solana', 'routing'],
        ratingCount: 2,
        totalRating: 9,
        downloads: 5,
        isActive: true,
      }),
    },
    {
      publicKey: secondSkillPda,
      account: makeSkillAccount({
        id: 2,
        author,
        name: 'Solana Auditor',
        tags: ['solana', 'security'],
        ratingCount: 2,
        totalRating: 9,
        downloads: 9,
        isActive: true,
      }),
    },
    {
      publicKey: thirdSkillPda,
      account: makeSkillAccount({
        id: 3,
        author,
        name: 'Python Lint',
        tags: ['python', 'lint'],
        ratingCount: 1,
        totalRating: 5,
        downloads: 1,
        isActive: false,
      }),
    },
  ];

  return {
    programId: PublicKey.unique(),
    provider: {
      publicKey: PublicKey.unique(),
      connection: {
        getProgramAccounts: vi.fn(async () => []),
      },
    },
    coder: {
      accounts: {
        memcmp: vi.fn(() => ({ offset: 0, bytes: '' })),
      },
    },
    account: {
      skillRegistration: {
        all: vi.fn(async () => skillAccounts),
        fetchNullable: vi.fn(async (pda: PublicKey) => {
          const match = skillAccounts.find((entry) => entry.publicKey.equals(pda));
          return match?.account ?? null;
        }),
      },
      task: {
        fetch: vi.fn(async () => null),
      },
      dispute: {
        all: vi.fn(async () => []),
        fetchNullable: vi.fn(async () => null),
      },
      agentRegistration: {
        fetchNullable: vi.fn(async () => null),
      },
    },
    _skillPdas: { firstSkillPda, secondSkillPda, thirdSkillPda },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agenc query tools', () => {
  it('agenc.listSkills filters and sorts marketplace skills', async () => {
    const program = createMockProgram();
    const tool = createListSkillsTool(program as never, silentLogger);

    const result = await tool.execute({ query: 'solana', activeOnly: true });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.total).toBe(2);
    expect(parsed.skills.map((skill: Record<string, unknown>) => skill.name)).toEqual([
      'Solana Auditor',
      'Solana Router',
    ]);
  });

  it('agenc.getSkill returns serialized skill detail', async () => {
    const program = createMockProgram();
    const tool = createGetSkillTool(program as never, silentLogger);

    const result = await tool.execute({
      skillPda: program._skillPdas.firstSkillPda.toBase58(),
    });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.skillPda).toBe(program._skillPdas.firstSkillPda.toBase58());
    expect(parsed.name).toBe('Solana Router');
    expect(parsed.tags).toEqual(['solana', 'routing']);
  });

  it('agenc.listGovernanceProposals filters normalized proposal status', async () => {
    const program = createMockProgram();
    vi.spyOn(GovernanceOperations.prototype, 'fetchAllProposals').mockResolvedValue([
      { proposalPda: PublicKey.unique(), proposal: makeProposal(ProposalStatus.Active, 1) },
      { proposalPda: PublicKey.unique(), proposal: makeProposal(ProposalStatus.Cancelled, 2) },
    ]);
    const tool = createListGovernanceProposalsTool(program as never, silentLogger);

    const result = await tool.execute({ status: 'cancelled' });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.total).toBe(1);
    expect(parsed.proposals[0].status).toBe('cancelled');
  });

  it('agenc.getGovernanceProposal returns serialized vote detail', async () => {
    const program = createMockProgram();
    const proposalPda = PublicKey.unique();
    vi.spyOn(GovernanceOperations.prototype, 'getProposal').mockResolvedValue({
      ...makeProposal(ProposalStatus.Executed, 4),
      proposalPda,
      votes: [
        {
          proposal: proposalPda,
          voter: PublicKey.unique(),
          approved: true,
          votedAt: 1_700_000_999,
          voteWeight: 42n,
          bump: 1,
        },
      ],
    });
    const tool = createGetGovernanceProposalTool(program as never, silentLogger);

    const result = await tool.execute({ proposalPda: proposalPda.toBase58() });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.proposalPda).toBe(proposalPda.toBase58());
    expect(parsed.status).toBe('executed');
    expect(parsed.votes).toHaveLength(1);
    expect(parsed.votes[0].voteWeight).toBe('42');
  });

  it('agenc.listDisputes returns enriched dispute summaries', async () => {
    const program = createMockProgram();
    const taskPda = PublicKey.unique();
    const disputePda = PublicKey.unique();
    const task = makeTaskRecord({ taskId: new Uint8Array(32).fill(11), rewardAmount: 2_500_000_000n });
    const dispute = makeDisputeRecord({ task: taskPda });

    vi.spyOn(DisputeOperations.prototype, 'fetchAllDisputes').mockResolvedValue([
      { disputePda, dispute },
    ]);
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue(task);

    const tool = createListDisputesTool(program as never, silentLogger);
    const result = await tool.execute({ status: 'active' });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.disputes[0]).toMatchObject({
      disputePda: disputePda.toBase58(),
      taskPda: taskPda.toBase58(),
      claimant: dispute.initiator.toBase58(),
      respondent: dispute.defendant.toBase58(),
      amountAtStake: '2500000000',
      amountAtStakeSol: '2.5',
      amountAtStakeMint: null,
      status: 'active',
    });
  });

  it('agenc.getDispute returns enriched dispute detail with related task context', async () => {
    const program = createMockProgram();
    const taskPda = PublicKey.unique();
    const disputePda = PublicKey.unique();
    const task = makeTaskRecord({ taskId: new Uint8Array(32).fill(12), rewardAmount: 900_000_000n });
    const dispute = makeDisputeRecord({ task: taskPda });

    vi.spyOn(DisputeOperations.prototype, 'fetchDispute').mockResolvedValue(dispute);
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue(task);

    const tool = createGetDisputeTool(program as never, silentLogger);
    const result = await tool.execute({ disputePda: disputePda.toBase58() });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.disputePda).toBe(disputePda.toBase58());
    expect(parsed.claimant).toBe(dispute.initiator.toBase58());
    expect(parsed.respondent).toBe(dispute.defendant.toBase58());
    expect(parsed.amountAtStake).toBe('900000000');
    expect(parsed.amountAtStakeSol).toBe('0.9');
    expect(parsed.relatedTask).toMatchObject({
      taskPda: taskPda.toBase58(),
      rewardAmount: '900000000',
      rewardSol: '0.9',
      status: 'Disputed',
    });
  });

  it('agenc.getReputationSummary returns an unregistered summary when no agent registration exists', async () => {
    const program = createMockProgram();
    const agentPda = PublicKey.unique();

    vi.spyOn(marketplaceSerialization, 'buildMarketplaceReputationSummaryForAgent').mockResolvedValue(null);

    const tool = createGetReputationSummaryTool(program as never, silentLogger);
    const result = await tool.execute({ agentPda: agentPda.toBase58() });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed).toEqual({
      registered: false,
      agentPda: agentPda.toBase58(),
    });
  });

  it('agenc.inspectMarketplace returns a reputation placeholder when no subject is provided', async () => {
    const program = createMockProgram();
    const summarySpy = vi.spyOn(
      marketplaceSerialization,
      'buildMarketplaceReputationSummaryForAgent',
    );

    const tool = createInspectMarketplaceTool(program as never, silentLogger);
    const result = await tool.execute({ surface: 'reputation' });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed).toMatchObject({
      surface: 'reputation',
      status: 'requires_input',
      count: 0,
      subject: null,
      items: [],
    });
    expect(parsed.message).toContain('Provide <agentPda>');
    expect(summarySpy).not.toHaveBeenCalled();
  });

  it('agenc.inspectMarketplace overview keeps reputation in requires-input state without a subject', async () => {
    const program = createMockProgram();
    const summarySpy = vi.spyOn(
      marketplaceSerialization,
      'buildMarketplaceReputationSummaryForAgent',
    );

    vi.spyOn(TaskOperations.prototype, 'fetchAllTasks').mockResolvedValue([]);
    vi.spyOn(GovernanceOperations.prototype, 'fetchAllProposals').mockResolvedValue([]);
    vi.spyOn(DisputeOperations.prototype, 'fetchAllDisputes').mockResolvedValue([]);

    const tool = createInspectMarketplaceTool(program as never, silentLogger);
    const result = await tool.execute({ surface: 'marketplace' });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.surface).toBe('marketplace');
    expect(parsed.status).toBe('requires_input');
    expect(parsed.count).toBe(5);
    expect(parsed.overview.reputation).toMatchObject({
      status: 'requires_input',
      count: 0,
    });
    expect(parsed.overview.reputation.message).toContain('Provide <agentPda>');
    expect(summarySpy).not.toHaveBeenCalled();
  });

  it('agenc.inspectMarketplace tasks surface preserves total count when limit truncates items', async () => {
    const program = createMockProgram();
    const tasks = [
      { taskPda: PublicKey.unique(), task: makeTaskRecord({ createdAt: 1_700_000_001, status: OnChainTaskStatus.Open }) },
      { taskPda: PublicKey.unique(), task: makeTaskRecord({ createdAt: 1_700_000_002, status: OnChainTaskStatus.Open }) },
      { taskPda: PublicKey.unique(), task: makeTaskRecord({ createdAt: 1_700_000_003, status: OnChainTaskStatus.Open }) },
    ];

    vi.spyOn(TaskOperations.prototype, 'fetchAllTasks').mockResolvedValue(tasks);

    const tool = createInspectMarketplaceTool(program as never, silentLogger);
    const result = await tool.execute({ surface: 'tasks', limit: 1 });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.surface).toBe('tasks');
    expect(parsed.count).toBe(3);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].taskPda).toBe(tasks[2].taskPda.toBase58());
  });

  it('agenc.inspectMarketplace overview uses total task count even when task items are limited', async () => {
    const program = createMockProgram();
    const tasks = [
      { taskPda: PublicKey.unique(), task: makeTaskRecord({ createdAt: 1_700_000_001, status: OnChainTaskStatus.Open }) },
      { taskPda: PublicKey.unique(), task: makeTaskRecord({ createdAt: 1_700_000_002, status: OnChainTaskStatus.Open }) },
      { taskPda: PublicKey.unique(), task: makeTaskRecord({ createdAt: 1_700_000_003, status: OnChainTaskStatus.Open }) },
    ];

    vi.spyOn(TaskOperations.prototype, 'fetchAllTasks').mockResolvedValue(tasks);
    vi.spyOn(GovernanceOperations.prototype, 'fetchAllProposals').mockResolvedValue([]);
    vi.spyOn(DisputeOperations.prototype, 'fetchAllDisputes').mockResolvedValue([]);

    const tool = createInspectMarketplaceTool(program as never, silentLogger);
    const result = await tool.execute({ surface: 'overview', limit: 1 });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.surface).toBe('marketplace');
    expect(parsed.overview.tasks.count).toBe(3);
    expect(parsed.overview.skills.count).toBe(3);
    expect(parsed.overview.governance.count).toBe(0);
    expect(parsed.overview.disputes.count).toBe(0);
    expect(parsed.overview.reputation.count).toBe(0);
  });

  it('agenc.inspectMarketplace returns disputes surfaces with enriched dispute aliases intact', async () => {
    const program = createMockProgram();
    const taskPda = PublicKey.unique();
    const disputePda = PublicKey.unique();
    const task = makeTaskRecord({ taskId: new Uint8Array(32).fill(13), rewardAmount: 1_500_000_000n });
    const dispute = makeDisputeRecord({ task: taskPda });

    vi.spyOn(DisputeOperations.prototype, 'fetchAllDisputes').mockResolvedValue([
      { disputePda, dispute },
    ]);
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue(task);

    const tool = createInspectMarketplaceTool(program as never, silentLogger);
    const result = await tool.execute({ surface: 'dispute', limit: 5 });
    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.surface).toBe('disputes');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      disputePda: disputePda.toBase58(),
      taskPda: taskPda.toBase58(),
      claimant: dispute.initiator.toBase58(),
      respondent: dispute.defendant.toBase58(),
      amountAtStake: '1500000000',
      amountAtStakeSol: '1.5',
      amountAtStakeMint: null,
      status: 'active',
    });
  });
});
