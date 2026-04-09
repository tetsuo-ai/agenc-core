import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { ToolResult } from '../types.js';
import { silentLogger } from '../../utils/logger.js';
import { TaskType } from '../../events/types.js';
import { ProposalType } from '../../governance/types.js';
import { GovernanceOperations } from '../../governance/operations.js';
import { DisputeOperations } from '../../dispute/operations.js';
import { ReputationEconomyOperations } from '../../reputation/economy.js';
import { TaskOperations } from '../../task/operations.js';
import {
  findBidBookPda,
  findBidPda,
  findBidderMarketStatePda,
} from '../../task/pda.js';
import {
  createClaimTaskTool,
  createCompleteTaskTool,
  createInitiateDisputeTool,
  createRegisterSkillTool,
  createPurchaseSkillTool,
  createCreateProposalTool,
  createResolveDisputeTool,
  createStakeReputationTool,
  createDelegateReputationTool,
} from './mutation-tools.js';

const SIGNER = PublicKey.unique();
const AGENT_PDA = PublicKey.unique();
const TASK_PDA = PublicKey.unique();
const CLAIM_PDA = PublicKey.unique();
const DISPUTE_PDA = PublicKey.unique();
const SKILL_PDA = PublicKey.unique();
const DEFENDANT_AGENT_PDA = PublicKey.unique();
const DEFENDANT_WALLET = PublicKey.unique();
const CREATOR_WALLET = PublicKey.unique();
const PROPOSAL_PDA = PublicKey.unique();
const DELEGATION_PDA = PublicKey.unique();
const TREASURY = PublicKey.unique();
const STAKE_PDA = PublicKey.unique();

function parseJson(result: ToolResult) {
  return JSON.parse(result.content) as Record<string, unknown>;
}

function makeRawAgent(authority: PublicKey) {
  return {
    agentId: new Uint8Array(32).fill(7),
    authority,
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

function createRpcChain(signature: string) {
  return {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn(async () => signature),
  };
}

function createMockProgram(options: { signer?: PublicKey | null } = {}) {
  const signer = 'signer' in options ? options.signer ?? null : SIGNER;
  const registerSkillChain = createRpcChain('register-skill-sig');
  const purchaseSkillChain = createRpcChain('purchase-skill-sig');
  const treasuryAccount = Buffer.alloc(72);
  TREASURY.toBuffer().copy(treasuryAccount, 40);

  const program = {
    programId: PublicKey.unique(),
    provider: {
      publicKey: signer,
      connection: {
        getProgramAccounts: vi.fn(async () => []),
        getAccountInfo: vi.fn(async () => ({ data: treasuryAccount })),
      },
    },
    account: {
      agentRegistration: {
        fetch: vi.fn(async (pda: PublicKey) => {
          if (pda.equals(AGENT_PDA)) return makeRawAgent(SIGNER);
          if (pda.equals(DEFENDANT_AGENT_PDA)) return makeRawAgent(DEFENDANT_WALLET);
          throw new Error(`Unknown agent: ${pda.toBase58()}`);
        }),
      },
      skillRegistration: {
        fetch: vi.fn(async (pda: PublicKey) => {
          if (pda.equals(SKILL_PDA)) {
            return {
              author: DEFENDANT_AGENT_PDA,
              price: { toString: () => '42' },
              priceMint: null,
            };
          }
          throw new Error(`Unknown skill: ${pda.toBase58()}`);
        }),
      },
      taskClaim: {
        all: vi.fn(async () => []),
      },
    },
    methods: {
      registerSkill: vi.fn().mockReturnValue(registerSkillChain),
      purchaseSkill: vi.fn().mockReturnValue(purchaseSkillChain),
    },
    _registerSkillChain: registerSkillChain,
    _purchaseSkillChain: purchaseSkillChain,
  };

  return program;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agenc mutation tools', () => {
  it('agenc.claimTask returns a signer error when the program context is read-only', async () => {
    const program = createMockProgram({ signer: null });
    const tool = createClaimTaskTool(program as never, silentLogger);

    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });

    expect(result.isError).toBe(true);
    expect(parseJson(result)).toEqual({
      error: 'This action requires a signer-backed program context',
    });
  });

  it('agenc.claimTask tells the caller to register an agent when auto-discovery finds none', async () => {
    const program = createMockProgram();
    const tool = createClaimTaskTool(program as never, silentLogger);

    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });

    expect(result.isError).toBe(true);
    expect(String(parseJson(result).error)).toContain('agenc-runtime agent register');
  });

  it('agenc.completeTask validates proofHash length', async () => {
    const program = createMockProgram();
    const tool = createCompleteTaskTool(program as never, silentLogger);

    const result = await tool.execute({
      taskPda: TASK_PDA.toBase58(),
      proofHash: 'abcd',
    });

    expect(result.isError).toBe(true);
    expect(String(parseJson(result).error)).toContain('proofHash');
  });

  it('agenc.completeTask derives accepted-bid settlement accounts for bid-exclusive tasks', async () => {
    const program = createMockProgram();
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue({
      creator: CREATOR_WALLET,
      taskType: TaskType.BidExclusive,
    } as never);
    const completeSpy = vi
      .spyOn(TaskOperations.prototype, 'completeTask')
      .mockResolvedValue({
        success: true,
        taskId: new Uint8Array(32).fill(3),
        isPrivate: false,
        transactionSignature: 'complete-sig',
      });

    const tool = createCompleteTaskTool(program as never, silentLogger);
    const result = await tool.execute({
      taskPda: TASK_PDA.toBase58(),
      proofHash: 'ab'.repeat(32),
      workerAgentPda: AGENT_PDA.toBase58(),
    });

    expect(result.isError).toBeUndefined();
    expect(completeSpy).toHaveBeenCalledWith(
      TASK_PDA,
      expect.objectContaining({
        taskType: TaskType.BidExclusive,
      }),
      expect.any(Uint8Array),
      null,
      {
        acceptedBidSettlement: {
          bidBook: findBidBookPda(TASK_PDA, program.programId),
          acceptedBid: findBidPda(TASK_PDA, AGENT_PDA, program.programId),
          bidderMarketState: findBidderMarketStatePda(AGENT_PDA, program.programId),
        },
        bidderAuthority: SIGNER,
      },
    );
  });

  it('agenc.registerSkill returns the derived skill payload on success', async () => {
    const program = createMockProgram();
    const tool = createRegisterSkillTool(program as never, silentLogger);

    const result = await tool.execute({
      authorAgentPda: AGENT_PDA.toBase58(),
      skillId: '11'.repeat(32),
      name: 'Routing Expert',
      contentHash: 'ab'.repeat(32),
      price: '42',
      tags: ['solana', 'routing'],
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.authorAgentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.price).toBe('42');
    expect(parsed.transactionSignature).toBe('register-skill-sig');
    expect(program.methods.registerSkill).toHaveBeenCalledTimes(1);
    const registerArgs = program.methods.registerSkill.mock.calls[0];
    expect(registerArgs[3]?.constructor?.name).toBe('BN');
    expect(registerArgs[3]?.toString()).toBe('42');
    expect(program._registerSkillChain.accountsPartial).toHaveBeenCalledTimes(1);
  });

  it('agenc.createProposal maps proposalType strings and returns a success payload', async () => {
    const program = createMockProgram();
    const createProposalSpy = vi
      .spyOn(GovernanceOperations.prototype, 'createProposal')
      .mockResolvedValue({
        proposalPda: PROPOSAL_PDA,
        transactionSignature: 'proposal-sig',
      });
    const tool = createCreateProposalTool(program as never, silentLogger);

    const result = await tool.execute({
      proposerAgentPda: AGENT_PDA.toBase58(),
      proposalType: 'fee_change',
      title: 'Raise fee',
      description: 'Proposal body',
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.proposalPda).toBe(PROPOSAL_PDA.toBase58());
    expect(parsed.proposalType).toBe('fee_change');
    expect(parsed.transactionSignature).toBe('proposal-sig');
    expect(createProposalSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalType: ProposalType.FeeChange,
        votingPeriod: 86_400,
      }),
    );
  });

  it('agenc.purchaseSkill returns the purchase payload on success', async () => {
    const program = createMockProgram();
    const tool = createPurchaseSkillTool(program as never, silentLogger);

    const result = await tool.execute({
      skillPda: SKILL_PDA.toBase58(),
      buyerAgentPda: AGENT_PDA.toBase58(),
      expectedPrice: '42',
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.skillPda).toBe(SKILL_PDA.toBase58());
    expect(parsed.buyerAgentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.pricePaid).toBe('42');
    expect(parsed.priceMint).toBeNull();
    expect(parsed.transactionSignature).toBe('purchase-skill-sig');
    expect(program.methods.purchaseSkill).toHaveBeenCalledTimes(1);
    const purchaseArg = program.methods.purchaseSkill.mock.calls[0][0];
    expect(purchaseArg?.constructor?.name).toBe('BN');
    expect(purchaseArg?.toString()).toBe('42');
    expect(program._purchaseSkillChain.accountsPartial).toHaveBeenCalledTimes(1);
  });


  it('agenc.initiateDispute auto-discovers the sole worker claim for creator-initiated disputes', async () => {
    const program = createMockProgram();
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue({
      creator: SIGNER,
      taskId: new Uint8Array(32).fill(9),
    } as never);
    program.account.taskClaim.all.mockResolvedValue([
      {
        publicKey: CLAIM_PDA,
        account: {
          task: TASK_PDA,
          worker: DEFENDANT_AGENT_PDA,
          claimedAt: { toNumber: () => 1700000000 },
          expiresAt: { toNumber: () => 1700003600 },
          completedAt: { toNumber: () => 0 },
          proofHash: new Uint8Array(32),
          resultData: new Uint8Array(64),
          isCompleted: false,
          isValidated: false,
          rewardPaid: { toString: () => '0' },
          bump: 1,
        },
      },
    ]);
    const initiateSpy = vi
      .spyOn(DisputeOperations.prototype, 'initiateDispute')
      .mockResolvedValue({
        disputePda: DISPUTE_PDA,
        transactionSignature: 'dispute-sig',
      });

    const tool = createInitiateDisputeTool(program as never, silentLogger);
    const result = await tool.execute({
      taskPda: TASK_PDA.toBase58(),
      evidence: 'creator dispute evidence',
      resolutionType: 'refund',
      initiatorAgentPda: AGENT_PDA.toBase58(),
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.disputePda).toBe(DISPUTE_PDA.toBase58());
    expect(parsed.transactionSignature).toBe('dispute-sig');
    expect(initiateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        initiatorClaimPda: null,
        workerAgentPda: DEFENDANT_AGENT_PDA,
        workerClaimPda: CLAIM_PDA,
      }),
    );
  });

  it('agenc.resolveDispute returns transaction details when the dispute resolves', async () => {
    const program = createMockProgram();
    vi.spyOn(DisputeOperations.prototype, 'fetchDispute').mockResolvedValue({
      task: TASK_PDA,
      defendant: DEFENDANT_AGENT_PDA,
    } as never);
    const resolveSpy = vi
      .spyOn(DisputeOperations.prototype, 'resolveDispute')
      .mockResolvedValue({
        disputePda: DISPUTE_PDA,
        transactionSignature: 'resolve-sig',
      });
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue({
      creator: CREATOR_WALLET,
    } as never);

    const tool = createResolveDisputeTool(program as never, silentLogger);
    const votePda = PublicKey.unique();
    const arbiterAgentPda = PublicKey.unique();
    const result = await tool.execute({
      disputePda: DISPUTE_PDA.toBase58(),
      arbiterVotes: [
        {
          votePda: votePda.toBase58(),
          arbiterAgentPda: arbiterAgentPda.toBase58(),
        },
      ],
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.disputePda).toBe(DISPUTE_PDA.toBase58());
    expect(parsed.taskPda).toBe(TASK_PDA.toBase58());
    expect(parsed.creator).toBe(CREATOR_WALLET.toBase58());
    expect(parsed.defendant).toBe(DEFENDANT_AGENT_PDA.toBase58());
    expect(parsed.transactionSignature).toBe('resolve-sig');
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPda: TASK_PDA,
        creatorPubkey: CREATOR_WALLET,
        workerAgentPda: DEFENDANT_AGENT_PDA,
        workerAuthority: DEFENDANT_WALLET,
        arbiterVotes: [
          {
            votePda,
            arbiterAgentPda,
          },
        ],
      }),
    );
  });

  it('agenc.resolveDispute derives accepted-bid settlement accounts for bid-exclusive disputes', async () => {
    const program = createMockProgram();
    vi.spyOn(DisputeOperations.prototype, 'fetchDispute').mockResolvedValue({
      task: TASK_PDA,
      defendant: DEFENDANT_AGENT_PDA,
    } as never);
    vi.spyOn(TaskOperations.prototype, 'fetchTask').mockResolvedValue({
      creator: CREATOR_WALLET,
      taskType: TaskType.BidExclusive,
    } as never);
    const resolveSpy = vi
      .spyOn(DisputeOperations.prototype, 'resolveDispute')
      .mockResolvedValue({
        disputePda: DISPUTE_PDA,
        transactionSignature: 'resolve-bid-sig',
      });

    const tool = createResolveDisputeTool(program as never, silentLogger);
    const votePda = PublicKey.unique();
    const arbiterAgentPda = PublicKey.unique();
    const result = await tool.execute({
      disputePda: DISPUTE_PDA.toBase58(),
      arbiterVotes: [
        {
          votePda: votePda.toBase58(),
          arbiterAgentPda: arbiterAgentPda.toBase58(),
        },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPda: TASK_PDA,
        workerAgentPda: DEFENDANT_AGENT_PDA,
        acceptedBidSettlement: {
          bidBook: findBidBookPda(TASK_PDA, program.programId),
          acceptedBid: findBidPda(TASK_PDA, DEFENDANT_AGENT_PDA, program.programId),
          bidderMarketState: findBidderMarketStatePda(
            DEFENDANT_AGENT_PDA,
            program.programId,
          ),
        },
      }),
    );
  });

  it('agenc.delegateReputation resolves delegatee ids and returns a success payload', async () => {
    const program = createMockProgram();
    const delegateSpy = vi
      .spyOn(ReputationEconomyOperations.prototype, 'delegateReputation')
      .mockResolvedValue({
        delegationPda: DELEGATION_PDA,
        transactionSignature: 'delegate-sig',
      });
    const tool = createDelegateReputationTool(program as never, silentLogger);

    const result = await tool.execute({
      delegatorAgentPda: AGENT_PDA.toBase58(),
      delegateeAgentId: '22'.repeat(32),
      amount: 500,
      expiresAt: 1234,
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.delegationPda).toBe(DELEGATION_PDA.toBase58());
    expect(parsed.delegatorAgentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.amount).toBe(500);
    expect(parsed.expiresAt).toBe(1234);
    expect(parsed.transactionSignature).toBe('delegate-sig');
    expect(delegateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500,
        expiresAt: 1234,
      }),
    );
  });

  it('agenc.stakeReputation returns the stake payload on success', async () => {
    const program = createMockProgram();
    const stakeSpy = vi
      .spyOn(ReputationEconomyOperations.prototype, 'stakeReputation')
      .mockResolvedValue({
        stakePda: STAKE_PDA,
        transactionSignature: 'stake-sig',
      });
    const tool = createStakeReputationTool(program as never, silentLogger);

    const result = await tool.execute({
      stakerAgentPda: AGENT_PDA.toBase58(),
      amount: '100000000',
    });

    const parsed = parseJson(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.stakePda).toBe(STAKE_PDA.toBase58());
    expect(parsed.agentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.amount).toBe('100000000');
    expect(parsed.transactionSignature).toBe('stake-sig');
    expect(stakeSpy).toHaveBeenCalledWith({
      amount: 100000000n,
    });
  });
});
