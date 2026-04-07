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

describe("TaskDiscoveryAction", () => {
  let scanner: ReturnType<typeof createMockScanner>;
  let goalManager: ReturnType<typeof createMockGoalManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    scanner = createMockScanner();
    goalManager = createMockGoalManager();
  });

  it("returns hasOutput=false when scanner returns empty", async () => {
    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);
    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("queues a discovered task as a medium-priority goal", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);

    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(true);
    expect(goalManager.addGoal).toHaveBeenCalledTimes(1);
    expect(goalManager.addGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "On-chain task",
        priority: "medium",
        source: "meta-planner",
      }),
    );
  });

  it("deduplicates by PDA across heartbeat cycles", async () => {
    const task = createMockTask();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);

    const action = createTaskDiscoveryAction({ scanner, goalManager });

    // First cycle — queues
    await action.execute(mockContext);
    expect(goalManager.addGoal).toHaveBeenCalledTimes(1);

    // Second cycle — same task, should not re-queue
    vi.clearAllMocks();
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    await action.execute(mockContext);
    expect(goalManager.addGoal).not.toHaveBeenCalled();
  });

  it("caps at maxTasksPerScan", async () => {
    const tasks = Array.from({ length: 10 }, () => createMockTask());
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

    const action = createTaskDiscoveryAction({
      scanner,
      goalManager,
      maxTasksPerScan: 3,
    });
    await action.execute(mockContext);

    expect(goalManager.addGoal).toHaveBeenCalledTimes(3);
  });

  it("returns hasOutput=false when scanner throws", async () => {
    (scanner.scan as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("rpc fail"),
    );

    const action = createTaskDiscoveryAction({ scanner, goalManager });
    const result = await action.execute(mockContext);

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
    expect(goalManager.addGoal).not.toHaveBeenCalled();
  });
});
