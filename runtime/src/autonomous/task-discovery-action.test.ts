import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createTaskDiscoveryAction } from "./task-discovery-action.js";
import type { TaskScanner } from "./scanner.js";
import type { GoalManager } from "./goal-manager.js";
import type { HeartbeatContext } from "../gateway/heartbeat.js";
import type { Task } from "./types.js";

function createMockTask(overrides?: Partial<Task>): Task {
  return {
    pda: PublicKey.unique(),
    taskId: new Uint8Array(32),
    creator: PublicKey.unique(),
    requiredCapabilities: 1n,
    reward: 1_000_000_000n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: Math.floor(Date.now() / 1000) + 3600,
    maxWorkers: 1,
    currentClaims: 0,
    status: 0,
    rewardMint: null,
    ...overrides,
  };
}

function createMockScanner(): TaskScanner {
  return {
    scan: vi.fn().mockResolvedValue([]),
    subscribeToNewTasks: vi.fn(),
    getTask: vi.fn(),
    refreshTask: vi.fn(),
    isTaskAvailable: vi.fn(),
    clearCache: vi.fn(),
    matchesFilter: vi.fn(),
  } as unknown as TaskScanner;
}

function createMockGoalManager(): GoalManager {
  return {
    addGoal: vi.fn().mockResolvedValue({ id: "goal-1" }),
    getActiveGoals: vi.fn().mockResolvedValue([]),
    isDuplicate: vi.fn().mockReturnValue(false),
  } as unknown as GoalManager;
}

const mockContext: HeartbeatContext = {
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
  sendToChannels: vi.fn(),
};

// Mock scoreTaskRisk at module level
vi.mock("./risk-scoring.js", () => ({
  scoreTaskRisk: vi.fn().mockReturnValue({
    score: 0.2,
    tier: "low",
    features: {},
    contributions: [],
    metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
  }),
}));

vi.mock("../marketplace/task-job-spec.js", () => ({
  resolveOnChainTaskJobSpecForTask: vi.fn(),
}));

vi.mock("../marketplace/job-spec-store.js", () => ({
  resolveMarketplaceJobSpecForTask: vi.fn(),
  isMarketplaceJobSpecTaskLinkNotFoundError: vi.fn(
    (error: unknown) =>
      error instanceof Error &&
      error.message.toLowerCase().includes("task link"),
  ),
}));

import { scoreTaskRisk } from "./risk-scoring.js";
import { resolveOnChainTaskJobSpecForTask } from "../marketplace/task-job-spec.js";
import { resolveMarketplaceJobSpecForTask } from "../marketplace/job-spec-store.js";

const mockedScoreTaskRisk = vi.mocked(scoreTaskRisk);
const mockedResolveOnChainTaskJobSpecForTask = vi.mocked(
  resolveOnChainTaskJobSpecForTask,
);
const mockedResolveMarketplaceJobSpecForTask = vi.mocked(
  resolveMarketplaceJobSpecForTask,
);

describe("TaskDiscoveryAction", () => {
  let scanner: ReturnType<typeof createMockScanner>;
  let goalManager: ReturnType<typeof createMockGoalManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    scanner = createMockScanner();
    goalManager = createMockGoalManager();
    mockedResolveOnChainTaskJobSpecForTask.mockResolvedValue(null as never);
    mockedResolveMarketplaceJobSpecForTask.mockResolvedValue(null as never);
  });

  it("returns hasOutput=false when scanner returns empty", async () => {
    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);
    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("queues goals for low-risk tasks", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });

    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    expect(goalManager.addGoal).toHaveBeenCalledTimes(1);
    expect(goalManager.addGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "On-chain task",
        priority: "medium", // low risk → medium priority
        source: "meta-planner",
      }),
    );
  });

  it("includes resolved job spec details in queued goals", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });
    const resolveJobSpecForTask = vi.fn().mockResolvedValue({
      jobSpecHash: "a".repeat(64),
      jobSpecUri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
      payload: {
        title: "Build scraper",
        fullDescription: "Scrape paginated pages and return normalized JSON.",
        acceptanceCriteria: ["handles pagination", "verifies output schema"],
        deliverables: ["source code", "README"],
        constraints: { maxRuntimeSecs: 60 },
        attachments: [{ uri: "https://example.com/spec.md", label: "Spec" }],
      },
    });

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      resolveJobSpecForTask,
    });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    expect(resolveJobSpecForTask).toHaveBeenCalledWith(task.pda.toBase58());
    const goalInput = (goalManager.addGoal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(goalInput.title).toBe("On-chain task: Build scraper");
    expect(goalInput.description).toContain("Job spec URI: agenc://job-spec/sha256/");
    expect(goalInput.description).toContain("Acceptance criteria:\n- handles pagination");
    expect(goalInput.description).toContain("Deliverables:\n- source code");
    expect(goalInput.description).toContain('Constraints: {"maxRuntimeSecs":60}');
    expect(goalInput.description).toContain("Spec: https://example.com/spec.md");
  });

  it("prefers on-chain task job spec pointers when program metadata is available", async () => {
    const task = createMockTask();
    const mockProgram = {} as never;
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });
    mockedResolveOnChainTaskJobSpecForTask.mockResolvedValue({
      jobSpecHash: "b".repeat(64),
      jobSpecUri: `agenc://job-spec/sha256/${"b".repeat(64)}`,
      payload: {
        title: "Publish docs",
        fullDescription: "Write and publish docs.",
        acceptanceCriteria: ["docs published"],
        deliverables: ["published docs"],
        constraints: null,
        attachments: [],
      },
    } as never);

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      program: mockProgram,
    });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    expect(mockedResolveOnChainTaskJobSpecForTask).toHaveBeenCalledWith(
      mockProgram,
      expect.any(PublicKey),
      {},
    );
    expect(mockedResolveMarketplaceJobSpecForTask).not.toHaveBeenCalled();
    const goalInput = (goalManager.addGoal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(goalInput.title).toBe("On-chain task: Publish docs");
    expect(goalInput.description).toContain(
      "Job spec URI: agenc://job-spec/sha256/",
    );
  });

  it("falls back to local task job spec links when on-chain metadata is absent", async () => {
    const task = createMockTask();
    const mockProgram = {} as never;
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });
    mockedResolveMarketplaceJobSpecForTask.mockResolvedValue({
      jobSpecHash: "c".repeat(64),
      jobSpecUri: `agenc://job-spec/sha256/${"c".repeat(64)}`,
      payload: {
        title: "Fallback sync",
        fullDescription: "Sync the fallback data source.",
        acceptanceCriteria: ["sync succeeds"],
        deliverables: ["sync report"],
        constraints: null,
        attachments: [],
      },
    } as never);

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      program: mockProgram,
    });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    expect(mockedResolveOnChainTaskJobSpecForTask).toHaveBeenCalledWith(
      mockProgram,
      expect.any(PublicKey),
      {},
    );
    expect(mockedResolveMarketplaceJobSpecForTask).toHaveBeenCalledWith(
      task.pda.toBase58(),
      {},
    );
    const goalInput = (goalManager.addGoal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(goalInput.title).toBe("On-chain task: Fallback sync");
    expect(goalInput.description).toContain(
      "Sync the fallback data source.",
    );
  });

  it("falls back to PDA and reward when job spec resolution fails", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });
    const logger = { warn: vi.fn() } as any;
    const resolveJobSpecForTask = vi
      .fn()
      .mockRejectedValue(new Error("invalid local job spec link"));

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      resolveJobSpecForTask,
      logger,
    });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    const goalInput = (goalManager.addGoal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(goalInput.title).toBe("On-chain task");
    expect(goalInput.description).toBe(
      `Task PDA: ${task.pda.toBase58()}, reward: ${task.reward}`,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to resolve task job spec"),
      expect.any(Error),
    );
  });

  it("queues goals for medium-risk tasks with low priority", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.5,
      tier: "medium",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });

    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    expect(goalManager.addGoal).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "low" }),
    );
  });

  it("skips high-risk tasks", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.85,
      tier: "high",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });

    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(false);
    expect(goalManager.addGoal).not.toHaveBeenCalled();
    expect(result.output).toContain("skipped 1 high-risk");
  });

  it("deduplicates by PDA across heartbeat cycles", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });

    const action = createTaskDiscoveryAction({ scanner, goalManager });

    // First cycle — queues
    await action.execute(mockContext);
    expect(goalManager.addGoal).toHaveBeenCalledTimes(1);

    // Second cycle — same task, should not re-queue
    vi.clearAllMocks();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });
    await action.execute(mockContext);
    expect(goalManager.addGoal).not.toHaveBeenCalled();
  });

  it("caps at maxTasksPerScan", async () => {
    const tasks = Array.from({ length: 10 }, () => createMockTask());
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.2,
      tier: "low",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      maxTasksPerScan: 3,
    });
    await action.execute(mockContext);

    expect(goalManager.addGoal).toHaveBeenCalledTimes(3);
  });

  it("skips tasks above custom maxRiskScore", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    mockedScoreTaskRisk.mockReturnValue({
      score: 0.4,
      tier: "medium",
      features: {} as any,
      contributions: [],
      metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
    });

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      maxRiskScore: 0.3,
    });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(false);
    expect(goalManager.addGoal).not.toHaveBeenCalled();
  });
});
