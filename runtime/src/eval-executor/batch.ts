import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { EvalExecutorError, findPilotTask } from "./source-lock.js";
import { decodeStrictJson, readBoundedRegularFile } from "../eval-pilot/safe-io.js";
import { validateAgentRunReport } from "./agent-run-report.js";
import { EVAL_EXECUTOR_MAXIMUM_ARTIFACT_BYTES, type AgentRunReport, type LoadedPilotSourceLock, type PilotSourceLockTask } from "./types.js";

const execFileAsync = promisify(execFile);

const IMAGE_PULL_TIMEOUT_MS = 1_800_000;
const KEY_COMMAND_TIMEOUT_MS = 120_000;

export interface RealAgentBatchOptions {
  readonly loaded: LoadedPilotSourceLock;
  /** Explicit task order; defaults to lock order when omitted. */
  readonly taskIds?: readonly string[];
  readonly outputDir: string;
  /**
   * Executable run before each task (execFile, no shell); its stdout becomes
   * the provider key for that task via `keyEnvVar`. Lets short-lived OAuth
   * tokens survive a multi-hour batch without baking any provider's refresh
   * flow into the executor.
   */
  readonly keyCommand?: string;
  readonly keyEnvVar: string;
}

export interface RealAgentBatchDeps {
  /** Run one task end to end and return its outcome string. */
  readonly runTask: (taskId: string) => Promise<{ readonly outcome: string }>;
  /** Pre-pull the task's pinned image; failures abort only that task. */
  readonly pullImage: (imageReference: string) => Promise<void>;
  readonly loadReport: (task: PilotSourceLockTask) => Promise<AgentRunReport | null>;
  readonly refreshKey?: () => Promise<string>;
  readonly log: (line: string) => Promise<void>;
  readonly setKeyEnv: (name: string, value: string) => void;
}

export interface RealAgentBatchTaskResult {
  readonly taskId: string;
  readonly status: "completed" | "skipped" | "driver_error";
  readonly outcome: string | null;
  readonly detail: string | null;
}

export interface RealAgentBatchSummary {
  readonly total: number;
  readonly completed: number;
  readonly skipped: number;
  readonly driverErrors: number;
  readonly verifiedFixes: number;
  readonly results: readonly RealAgentBatchTaskResult[];
}

/**
 * Sequential batch driver over pinned pilot tasks: resumable (tasks with an
 * existing report are skipped), key-refreshing (per task, so OAuth tokens
 * stay fresh), and continue-on-error (one task's driver failure never takes
 * down the batch — the scorecard needs every task attempted).
 */
export async function runRealAgentBatch(
  options: RealAgentBatchOptions,
  deps: RealAgentBatchDeps,
): Promise<RealAgentBatchSummary> {
  const order = options.taskIds !== undefined && options.taskIds.length > 0
    ? options.taskIds
    : options.loaded.lock.tasks.map((task) => task.instanceId);
  // Validate the whole order against the lock BEFORE any pull/refresh/run:
  // a typo'd task id must fail the batch while it is still free.
  const tasksById = new Map(
    order.map((taskId) => [taskId, findPilotTask(options.loaded.lock, taskId)]),
  );
  const results: RealAgentBatchTaskResult[] = [];
  for (const taskId of order) {
    const task = tasksById.get(taskId)!;
    try {
      const report = await deps.loadReport(task);
      if (report !== null) {
        await deps.log(`${taskId} SKIP (validated report) outcome=${report.outcome}`);
        results.push({ taskId, status: "skipped", outcome: report.outcome, detail: null });
        continue;
      }
      await deps.log(`${taskId} pull`);
      await deps.pullImage(task.image);
      if (deps.refreshKey !== undefined) {
        const key = (await deps.refreshKey()).trim();
        if (key.length === 0) {
          throw new EvalExecutorError([
            `key command produced an empty key for ${taskId}`,
          ]);
        }
        deps.setKeyEnv(options.keyEnvVar, key);
      }
      await deps.log(`${taskId} run`);
      const { outcome } = await deps.runTask(taskId);
      await deps.log(`${taskId} DONE outcome=${outcome}`);
      results.push({ taskId, status: "completed", outcome, detail: null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await deps.log(`${taskId} DRIVER_ERROR ${detail.slice(0, 300)}`);
      results.push({ taskId, status: "driver_error", outcome: null, detail });
    }
  }
  return {
    total: order.length,
    completed: results.filter((r) => r.status === "completed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    driverErrors: results.filter((r) => r.status === "driver_error").length,
    verifiedFixes: results.filter((r) => r.outcome === "verified_fix").length,
    results,
  };
}

/** Production deps shared by the CLI; separated so tests can inject fakes. */
export function createRealAgentBatchDeps(options: {
  readonly outputDir: string;
  readonly keyCommand?: string;
  readonly runTask: (taskId: string) => Promise<{ readonly outcome: string }>;
}): RealAgentBatchDeps {
  const progressLog = path.join(options.outputDir, "batch-progress.log");
  return {
    runTask: options.runTask,
    pullImage: async (imageReference) => {
      await execFileAsync("docker", ["pull", "-q", imageReference], {
        timeout: IMAGE_PULL_TIMEOUT_MS,
      });
    },
    loadReport: async (task) => {
      const taskDir = path.join(options.outputDir, task.instanceId);
      const reportPath = path.join(taskDir, "agent-run-report.json");
      const failure = new EvalExecutorError([
        `Cannot resume ${task.instanceId}: prior report is unreadable, invalid, or not bound to this real-provider source-lock task. Move the task directory ${taskDir} aside or choose a new output directory before rerunning.`,
      ]);
      try {
        await lstat(reportPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw failure;
      }
      try {
        const report = validateAgentRunReport(
          decodeStrictJson(await readBoundedRegularFile(reportPath, EVAL_EXECUTOR_MAXIMUM_ARTIFACT_BYTES), reportPath),
          task,
        );
        if (report.egress === null) throw failure;
        return report;
      } catch {
        throw failure;
      }
    },
    ...(options.keyCommand !== undefined
      ? {
        refreshKey: async () => {
          const { stdout } = await execFileAsync(options.keyCommand!, [], {
            timeout: KEY_COMMAND_TIMEOUT_MS,
          });
          return stdout;
        },
      }
      : {}),
    log: async (line) => {
      const stamped = `[${new Date().toISOString()}] ${line}\n`;
      process.stdout.write(stamped);
      await mkdir(options.outputDir, { recursive: true });
      await appendFile(progressLog, stamped);
    },
    setKeyEnv: (name, value) => {
      process.env[name] = value;
    },
  };
}

export async function writeRealAgentBatchSummary(
  outputDir: string,
  summary: RealAgentBatchSummary,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, "batch-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summaryPath;
}
