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
  fetchAllTaskSubmissions: vi.fn(),
  serializeMarketplaceDisputeDetail: vi.fn(),
  serializeMarketplaceTask: vi.fn(),
  serializeMarketplaceTaskEntry: vi.fn(),
  decodeMarketplaceArtifactSha256FromResultData: vi.fn(),
  readMarketplaceArtifactReference: vi.fn(),
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
    fetchAllTaskSubmissions = mocks.fetchAllTaskSubmissions;
  },
}));

vi.mock('../../marketplace/artifact-delivery.js', () => ({
  decodeMarketplaceArtifactSha256FromResultData:
    mocks.decodeMarketplaceArtifactSha256FromResultData,
  readMarketplaceArtifactReference: mocks.readMarketplaceArtifactReference,
}));

vi.mock('../../marketplace/serialization.js', () => ({
  buildMarketplaceReputationSummaryForAgent: vi.fn(),
  buildMarketplaceUnregisteredSummary: vi.fn(),
  serializeMarketplaceDisputeSummary: vi.fn(),
  serializeMarketplaceProposalDetail: vi.fn(),
  serializeMarketplaceProposalSummary: vi.fn(),
  serializeMarketplaceSkill: vi.fn(),
  serializeMarketplaceDisputeDetail: mocks.serializeMarketplaceDisputeDetail,
  serializeMarketplaceTask: mocks.serializeMarketplaceTask,
  serializeMarketplaceTaskEntry: mocks.serializeMarketplaceTaskEntry,
}));

import { handleTasksList } from './handlers.js';

describe('handleTasksList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no creator-review submissions to hydrate from. Individual tests
    // can override this when they want to exercise the submission-hydration
    // path.
    mocks.fetchAllTaskSubmissions.mockResolvedValue([]);
    mocks.decodeMarketplaceArtifactSha256FromResultData.mockReturnValue(null);
    mocks.readMarketplaceArtifactReference.mockResolvedValue(null);
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

  it('hydrates buyer-facing delivery artifacts from creator-review task submissions', async () => {
    // Creator-review tasks land their result in a separate task_submission PDA,
    // so the dashboard has to look at fetchAllTaskSubmissions() and decode the
    // sha256-prefixed artifact reference out of the latest submission's
    // resultData. Verify that flow surfaces a deliveryArtifact on the summary.
    const taskPda = PublicKey.unique();
    const sha256 = 'a'.repeat(64);

    mocks.createReadOnlyProgram.mockReturnValue({ program: 'readonly' });
    mocks.loadKeypairFromFile.mockImplementation(() => {
      throw new Error('signer keypair unavailable for this scenario');
    });
    mocks.fetchAllTasks.mockResolvedValue([
      { task: { createdAt: 1 }, taskPda },
    ]);
    mocks.fetchAllTaskSubmissions.mockResolvedValue([
      {
        submission: {
          task: taskPda,
          resultData: new Uint8Array(64),
          submittedAt: 1700000200,
        },
        submissionPda: PublicKey.unique(),
      },
    ]);
    mocks.decodeMarketplaceArtifactSha256FromResultData.mockReturnValue(sha256);
    mocks.readMarketplaceArtifactReference.mockResolvedValue({
      kind: 'agenc.marketplace.artifactReference',
      schemaVersion: 1,
      sha256,
      uri: 'agenc://artifact/sha256/' + sha256 + '/report.md',
      source: 'file',
      createdAt: '2026-04-27T00:00:00.000Z',
      sizeBytes: 256,
      mediaType: 'text/markdown; charset=utf-8',
      fileName: 'report.md',
      localPath: '/tmp/reports/' + sha256 + '/report.md',
    });
    mocks.serializeMarketplaceTaskEntry.mockReturnValue({
      taskPda: taskPda.toBase58(),
      status: 'completed',
      rewardLamports: '50000000',
      creator: 'creator-1',
      description: 'review-mode task',
      currentWorkers: 1,
      // No deliveryArtifact on the task itself (creator-review case) — the
      // hydration must come from the submission map.
      deliveryArtifact: undefined,
      resultPreview: undefined,
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
        config: { connection: { rpcUrl: 'https://api.devnet.solana.com' } },
      },
      connection: {} as any,
    };

    await handleTasksList(deps, undefined, 'req-hydrate', send);

    expect(mocks.fetchAllTaskSubmissions).toHaveBeenCalledOnce();
    expect(mocks.readMarketplaceArtifactReference).toHaveBeenCalledWith(sha256);
    expect(send).toHaveBeenCalledWith({
      type: 'tasks.list',
      payload: [
        {
          id: taskPda.toBase58(),
          status: 'completed',
          reward: '0.05',
          creator: 'creator-1',
          description: 'review-mode task',
          worker: '1 worker(s)',
          deliveryArtifact: {
            source: 'task-submission',
            sha256,
            verified: true,
            uri: 'agenc://artifact/sha256/' + sha256 + '/report.md',
            fileName: 'report.md',
            mediaType: 'text/markdown; charset=utf-8',
            sizeBytes: 256,
          },
        },
      ],
      id: 'req-hydrate',
    });
  });

  it('reports an unverified delivery artifact when only the protocol sha256 is decodable', async () => {
    const taskPda = PublicKey.unique();
    const sha256 = 'b'.repeat(64);

    mocks.createReadOnlyProgram.mockReturnValue({ program: 'readonly' });
    mocks.loadKeypairFromFile.mockImplementation(() => {
      throw new Error('signer keypair unavailable for this scenario');
    });
    mocks.fetchAllTasks.mockResolvedValue([
      { task: { createdAt: 1 }, taskPda },
    ]);
    mocks.fetchAllTaskSubmissions.mockResolvedValue([
      {
        submission: {
          task: taskPda,
          resultData: new Uint8Array(64),
          submittedAt: 1700000300,
        },
        submissionPda: PublicKey.unique(),
      },
    ]);
    mocks.decodeMarketplaceArtifactSha256FromResultData.mockReturnValue(sha256);
    // No local-store reference yet for this sha256 (e.g. fresh worker box).
    mocks.readMarketplaceArtifactReference.mockResolvedValue(null);
    mocks.serializeMarketplaceTaskEntry.mockReturnValue({
      taskPda: taskPda.toBase58(),
      status: 'completed',
      rewardLamports: '10000000',
      creator: 'creator-1',
      description: 'review-mode task',
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
        config: { connection: { rpcUrl: 'https://api.devnet.solana.com' } },
      },
      connection: {} as any,
    };

    await handleTasksList(deps, undefined, 'req-unverified', send);

    expect(send).toHaveBeenCalledWith({
      type: 'tasks.list',
      payload: [
        expect.objectContaining({
          id: taskPda.toBase58(),
          deliveryArtifact: {
            source: 'task-submission',
            sha256,
            verified: false,
          },
        }),
      ],
      id: 'req-unverified',
    });
  });
});
