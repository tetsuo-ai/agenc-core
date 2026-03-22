import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WebChatDeps } from "./types.js";

const mocks = vi.hoisted(() => ({
  createReadOnlyProgram: vi.fn(),
  createProgram: vi.fn(),
  loadKeypairFromFile: vi.fn(),
  getDefaultKeypairPath: vi.fn(() => "/tmp/test-id.json"),
  fetchAllTasks: vi.fn(),
  serializeMarketplaceTaskEntry: vi.fn(),
}));

vi.mock("../../idl.js", () => ({
  createReadOnlyProgram: mocks.createReadOnlyProgram,
  createProgram: mocks.createProgram,
  IDL: {},
}));

vi.mock("../../types/wallet.js", () => ({
  loadKeypairFromFile: mocks.loadKeypairFromFile,
  getDefaultKeypairPath: mocks.getDefaultKeypairPath,
}));

vi.mock("../../task/operations.js", () => ({
  TaskOperations: class {
    fetchAllTasks = mocks.fetchAllTasks;
  },
}));

vi.mock("../../marketplace/serialization.js", () => ({
  buildMarketplaceReputationSummaryForAgent: vi.fn(),
  buildMarketplaceUnregisteredSummary: vi.fn(),
  serializeMarketplaceDisputeSummary: vi.fn(),
  serializeMarketplaceProposalDetail: vi.fn(),
  serializeMarketplaceProposalSummary: vi.fn(),
  serializeMarketplaceSkill: vi.fn(),
  serializeMarketplaceTaskEntry: mocks.serializeMarketplaceTaskEntry,
}));

import { handleTasksList } from "./handlers.js";

describe("handleTasksList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists tasks through the read-only program context without loading a signer keypair", async () => {
    mocks.createReadOnlyProgram.mockReturnValue({ program: "readonly" });
    mocks.createProgram.mockImplementation(() => {
      throw new Error("unexpected signer program creation");
    });
    mocks.loadKeypairFromFile.mockImplementation(() => {
      throw new Error("signer keypair should not be loaded for task listing");
    });
    mocks.fetchAllTasks.mockResolvedValue([{ fake: true }]);
    mocks.serializeMarketplaceTaskEntry.mockReturnValue({
      taskPda: "task-pda-1",
      status: "open",
      rewardLamports: "50000000",
      creator: "creator-1",
      description: "public task",
      currentWorkers: 0,
    });

    const send = vi.fn();
    const deps: WebChatDeps = {
      gateway: {
        getStatus: () =>
          ({
            state: "running",
            uptimeMs: 0,
            channels: [],
            activeSessions: 0,
            controlPlanePort: 0,
          }) as any,
        config: {
          connection: {
            rpcUrl: "https://api.devnet.solana.com",
          },
        },
      },
      connection: {} as any,
    };

    await handleTasksList(deps, undefined, "req-tasks", send);

    expect(mocks.createReadOnlyProgram).toHaveBeenCalledOnce();
    expect(mocks.loadKeypairFromFile).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "tasks.list",
      payload: [
        {
          id: "task-pda-1",
          status: "open",
          reward: "0.05",
          creator: "creator-1",
          description: "public task",
          worker: undefined,
        },
      ],
      id: "req-tasks",
    });
  });
});
