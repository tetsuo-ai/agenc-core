/**
 * Autonomous Agent System
 *
 * Provides self-operating agents that automatically discover, claim,
 * execute, and complete tasks on the AgenC protocol.
 *
 * @module
 */

export {
  TaskScanner,
  type TaskScannerConfig,
  type TaskEventSubscription,
  type TaskCreatedCallback,
} from "./scanner.js";
export {
  // Types
  type Task,
  TaskStatus,
  type TaskFilter,
  type ClaimStrategy,
  type AutonomousTaskExecutor,
  type DiscoveryMode,
  // Default strategy
  DefaultClaimStrategy,
} from "./types.js";
export {
  DesktopExecutor,
  type DesktopExecutorConfig,
  type DesktopExecutorResult,
  type GoalStatus,
  type ExecutionStep,
} from "./desktop-executor.js";
export {
  GoalStore,
  type GoalStoreInput,
  type StrategicGoalRecord,
  type StrategicGoalStatus,
  type StrategicExecutionSummary,
  type StrategicWorkingNote,
} from "./goal-store.js";
export { StrategicMemory } from "./strategic-memory.js";
export {
  GoalManager,
  type GoalManagerConfig,
  type ManagedGoal,
} from "./goal-manager.js";
export {
  createAwarenessGoalBridge,
  type AwarenessPattern,
  type AwarenessGoalBridgeConfig,
} from "./awareness-goal-bridge.js";
export {
  createGoalExecutorAction,
  type GoalExecutorActionConfig,
} from "./goal-executor-action.js";
