import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_RUNTIME_PERSISTENCE_DIRNAME = ".agenc";
const DEFAULT_MEMORY_DB_FILENAME = "memory.db";
const DEFAULT_REPLAY_DB_FILENAME = "replay-events.sqlite";
const DEFAULT_TASK_CHECKPOINT_DB_FILENAME = "task-checkpoints.sqlite";
const DEFAULT_TASK_DLQ_DB_FILENAME = "task-dlq.sqlite";

interface RuntimePersistencePaths {
  readonly rootDir: string;
  readonly memoryDbPath: string;
  readonly replayDbPath: string;
}

interface TaskExecutorPersistencePaths extends RuntimePersistencePaths {
  readonly taskRootDir: string;
  readonly checkpointDbPath: string;
  readonly deadLetterDbPath: string;
}

type TaskExecutorPersistenceMode = "memory" | "sqlite";

export interface TaskExecutorPersistenceConfig {
  readonly mode?: TaskExecutorPersistenceMode;
  readonly rootDir?: string;
  readonly checkpointDbPath?: string;
  readonly deadLetterDbPath?: string;
}

function resolveRuntimePersistenceRoot(rootDir?: string): string {
  return resolve(rootDir ?? join(homedir(), DEFAULT_RUNTIME_PERSISTENCE_DIRNAME));
}

function normalizeAgentScope(agentId?: Uint8Array | string): string {
  if (!agentId) {
    return "default";
  }
  if (typeof agentId === "string") {
    return agentId.trim().length > 0 ? agentId : "default";
  }
  return Buffer.from(agentId).toString("hex");
}

export function resolveRuntimePersistencePaths(
  rootDir?: string,
): RuntimePersistencePaths {
  const resolvedRoot = resolveRuntimePersistenceRoot(rootDir);
  return {
    rootDir: resolvedRoot,
    memoryDbPath: join(resolvedRoot, DEFAULT_MEMORY_DB_FILENAME),
    replayDbPath: join(resolvedRoot, DEFAULT_REPLAY_DB_FILENAME),
  };
}

export function resolveTaskExecutorPersistencePaths(params?: {
  readonly rootDir?: string;
  readonly agentId?: Uint8Array | string;
  readonly checkpointDbPath?: string;
  readonly deadLetterDbPath?: string;
}): TaskExecutorPersistencePaths {
  const runtimePaths = resolveRuntimePersistencePaths(params?.rootDir);
  const agentScope = normalizeAgentScope(params?.agentId);
  const taskRootDir = join(runtimePaths.rootDir, "task-executor", agentScope);

  return {
    ...runtimePaths,
    taskRootDir,
    checkpointDbPath:
      params?.checkpointDbPath ??
      join(taskRootDir, DEFAULT_TASK_CHECKPOINT_DB_FILENAME),
    deadLetterDbPath:
      params?.deadLetterDbPath ??
      join(taskRootDir, DEFAULT_TASK_DLQ_DB_FILENAME),
  };
}

