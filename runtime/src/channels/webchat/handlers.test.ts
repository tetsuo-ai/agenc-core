import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { WebChatDeps } from './types.js';

const mocks = vi.hoisted(() => ({
  createReadOnlyProgram: vi.fn(),
  createProgram: vi.fn(),
  loadKeypairFromFile: vi.fn(),
  getDefaultKeypairPath: vi.fn(() => '/tmp/test-id.json'),
  fetchAllTasks: vi.fn(),
  fetchActiveClaims: vi.fn(),
  serializeMarketplaceTaskEntry: vi.fn(),
}));

vi.mock('../../idl.js', () => ({
  createReadOnlyProgram: mocks.createReadOnlyProgram,
  createProgram: mocks.createProgram,
  IDL: {},
}));

vi.mock('../../types/wallet.js', () => ({
  loadKeypairFromFile: mocks.loadKeypairFromFile,
  getDefaultKeypairPath: mocks.getDefaultKeypairPath,
}));

vi.mock('../../task/operations.js', () => ({
  TaskOperations: class {
    fetchAllTasks = mocks.fetchAllTasks;
    fetchActiveClaims = mocks.fetchActiveClaims;
  },
}));

vi.mock('../../marketplace/serialization.js', () => ({
  buildMarketplaceReputationSummaryForAgent: vi.fn(),
  buildMarketplaceUnregisteredSummary: vi.fn(),
  serializeMarketplaceDisputeSummary: vi.fn(),
  serializeMarketplaceProposalDetail: vi.fn(),
  serializeMarketplaceProposalSummary: vi.fn(),
  serializeMarketplaceSkill: vi.fn(),
  serializeMarketplaceTaskEntry: mocks.serializeMarketplaceTaskEntry,
}));

import { handleTasksList } from './handlers.js';

describe('handleTasksList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists tasks even when signer enrichment is unavailable', async () => {
    mocks.createReadOnlyProgram.mockReturnValue({ program: 'readonly' });
    mocks.loadKeypairFromFile.mockImplementation(() => {
      throw new Error('signer keypair should not block task listing');
    });
    mocks.fetchAllTasks.mockResolvedValue([{ fake: true, task: { createdAt: 1 } }]);
    mocks.fetchActiveClaims.mockResolvedValue([]);
    mocks.serializeMarketplaceTaskEntry.mockReturnValue({
      taskPda: 'task-pda-1',
      status: 'open',
      rewardLamports: '50000000',
      creator: 'creator-1',
      description: 'public task',
      currentWorkers: 0,
    });

    const send = vi.fn();
    const deps: WebChatDeps = {
      gateway: {
        getStatus: () =>
          ({
            state: 'running',
            uptimeMs: 0,
            channels: [],
            activeSessions: 0,
            controlPlanePort: 0,
          }) as any,
        config: {
          connection: {
            rpcUrl: 'https://api.devnet.solana.com',
          },
        },
      },
      connection: {} as any,
    };

    await handleTasksList(deps, undefined, 'req-tasks', send);

    expect(mocks.createReadOnlyProgram).toHaveBeenCalledOnce();
    expect(mocks.loadKeypairFromFile).toHaveBeenCalledOnce();
    expect(mocks.fetchActiveClaims).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: 'tasks.list',
      payload: [
        {
          id: 'task-pda-1',
          status: 'open',
          reward: '0.05',
          creator: 'creator-1',
          description: 'public task',
          worker: undefined,
        },
      ],
      id: 'req-tasks',
    });
  });

  it('enriches the task list with signer ownership metadata when the signer agent is available', async () => {
    const ownedTaskPda = PublicKey.unique();
    const claimedTaskPda = PublicKey.unique();
    const viewerAgentPda = PublicKey.unique();
    const authority = PublicKey.unique();
    const agentData = Buffer.alloc(80);
    agentData.set(new Uint8Array(32).fill(9), 8);

    mocks.createReadOnlyProgram.mockReturnValue({ program: 'readonly' });
    mocks.loadKeypairFromFile.mockResolvedValue({ publicKey: authority });
    mocks.createProgram.mockReturnValue({
      programId: PublicKey.unique(),
      provider: {
        publicKey: authority,
        connection: {
          getProgramAccounts: vi.fn(async () => [
            { pubkey: viewerAgentPda, account: { data: agentData } },
          ]),
        },
      },
    });
    mocks.fetchAllTasks.mockResolvedValue([
      { task: { createdAt: 1 }, taskPda: claimedTaskPda },
      { task: { createdAt: 2 }, taskPda: ownedTaskPda },
    ]);
    mocks.fetchActiveClaims.mockResolvedValue([
      {
        claim: { isCompleted: false },
        claimPda: PublicKey.unique(),
        taskPda: claimedTaskPda,
      },
    ]);
    mocks.serializeMarketplaceTaskEntry
      .mockReturnValueOnce({
        taskPda: ownedTaskPda.toBase58(),
        status: 'open',
        rewardLamports: '20000000',
        creator: viewerAgentPda.toBase58(),
        description: 'owned task',
        currentWorkers: 0,
      })
      .mockReturnValueOnce({
        taskPda: claimedTaskPda.toBase58(),
        status: 'open',
        rewardLamports: '30000000',
        creator: PublicKey.unique().toBase58(),
        description: 'claimed task',
        currentWorkers: 1,
      });

    const send = vi.fn();
    const deps: WebChatDeps = {
      gateway: {
        getStatus: () =>
          ({
            state: 'running',
            uptimeMs: 0,
            channels: [],
            activeSessions: 0,
            controlPlanePort: 0,
          }) as any,
        config: {
          connection: {
            rpcUrl: 'https://api.devnet.solana.com',
          },
        },
      },
      connection: {} as any,
    };

    await handleTasksList(deps, undefined, 'req-owned', send);

    expect(mocks.fetchActiveClaims).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'tasks.list',
      payload: [
        {
          id: ownedTaskPda.toBase58(),
          status: 'open',
          reward: '0.02',
          creator: viewerAgentPda.toBase58(),
          description: 'owned task',
          worker: undefined,
          viewerAgentPda: viewerAgentPda.toBase58(),
          ownedBySigner: true,
          assignedToSigner: false,
          claimableBySigner: false,
        },
        {
          id: claimedTaskPda.toBase58(),
          status: 'open',
          reward: '0.03',
          creator: expect.any(String),
          description: 'claimed task',
          worker: '1 worker(s)',
          viewerAgentPda: viewerAgentPda.toBase58(),
          ownedBySigner: false,
          assignedToSigner: true,
          claimableBySigner: false,
        },
      ],
      id: 'req-owned',
    });
  });
});
