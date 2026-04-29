#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  SystemSandboxManager,
  silentLogger,
} from "../runtime/src/index.js";

type WorkspaceAccess = "none" | "readonly" | "readwrite";

interface DrillOptions {
  readonly sandboxes: number;
  readonly jobsPerSandbox: number;
  readonly waves: number;
  readonly jobDurationMs: number;
  readonly pollIntervalMs: number;
  readonly timeoutSeconds: number;
  readonly image: string;
  readonly workspaceAccess: WorkspaceAccess;
  readonly networkAccess: boolean;
  readonly maxTrackedJobs: number | null;
  readonly outputPath: string;
}

interface DrillJobResult {
  readonly sandboxId: string;
  readonly sandboxJobId: string;
  readonly processId: string;
  readonly durationMs: number;
}

interface DrillWaveResult {
  readonly wave: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly sandboxesStarted: number;
  readonly jobsStarted: number;
  readonly jobsCompleted: number;
  readonly jobResults: readonly DrillJobResult[];
}

interface DrillArtifact {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly config: {
    sandboxes: number;
    jobsPerSandbox: number;
      waves: number;
      jobDurationMs: number;
      timeoutSeconds: number;
      image: string;
      workspaceAccess: WorkspaceAccess;
      networkAccess: boolean;
      maxTrackedJobs: number | null;
  };
  readonly overallPassed: boolean;
  readonly waves: readonly DrillWaveResult[];
}

const DEFAULT_SANDBOXES = 4;
const DEFAULT_JOBS_PER_SANDBOX = 2;
const DEFAULT_WAVES = 2;
const DEFAULT_JOB_DURATION_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_IMAGE = "node:20-slim";
const DEFAULT_WORKSPACE_ACCESS: WorkspaceAccess = "none";
const ARTIFACT_DIR = path.join(os.tmpdir(), "agenc-sandbox-fleet-drill");

function usage(): void {
  process.stdout.write(`Usage:
  npm run drill:sandbox:fleet
  npm run drill:sandbox:fleet -- --sandboxes 6 --jobs-per-sandbox 3 --waves 2

Flags:
  --sandboxes <count>          Concurrent sandboxes per wave. Default: ${DEFAULT_SANDBOXES}
  --jobs-per-sandbox <count>   Concurrent jobs per sandbox. Default: ${DEFAULT_JOBS_PER_SANDBOX}
  --waves <count>              Number of repeated waves. Default: ${DEFAULT_WAVES}
  --job-duration-ms <ms>       Duration of each sandbox job. Default: ${DEFAULT_JOB_DURATION_MS}
  --poll-interval-ms <ms>      Status polling interval. Default: ${DEFAULT_POLL_INTERVAL_MS}
  --timeout-seconds <seconds>  Per-wave timeout. Default: ${DEFAULT_TIMEOUT_SECONDS}
  --image <docker-image>       Sandbox image. Default: ${DEFAULT_IMAGE}
  --workspace-access <none|readonly|readwrite>  Default: ${DEFAULT_WORKSPACE_ACCESS}
  --network-access             Enable outbound network for sandboxes.
  --max-tracked-jobs <count>   Override sandbox job tracking ceiling. Default: use runtime default
  --output <path>              Artifact output path.
  --help                       Show this message.
`);
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(flag: string, fallback: number): number {
  const value = getFlagValue(flag);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  flag: string,
  envValue: string | undefined,
): number | null {
  const value = getFlagValue(flag) ?? envValue ?? null;
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer when provided`);
  }
  return parsed;
}

function parseWorkspaceAccess(): WorkspaceAccess {
  const value = getFlagValue("--workspace-access");
  if (!value) {
    return DEFAULT_WORKSPACE_ACCESS;
  }
  if (value === "none" || value === "readonly" || value === "readwrite") {
    return value;
  }
  throw new Error(`Unsupported workspace access: ${value}`);
}

function parseOptions(): DrillOptions {
  const outputPath =
    getFlagValue("--output") ??
    path.join(ARTIFACT_DIR, `sandbox-fleet-drill-${Date.now()}.json`);
  return {
    sandboxes: parsePositiveInteger("--sandboxes", DEFAULT_SANDBOXES),
    jobsPerSandbox: parsePositiveInteger(
      "--jobs-per-sandbox",
      DEFAULT_JOBS_PER_SANDBOX,
    ),
    waves: parsePositiveInteger("--waves", DEFAULT_WAVES),
    jobDurationMs: parsePositiveInteger(
      "--job-duration-ms",
      DEFAULT_JOB_DURATION_MS,
    ),
    pollIntervalMs: parsePositiveInteger(
      "--poll-interval-ms",
      DEFAULT_POLL_INTERVAL_MS,
    ),
    timeoutSeconds: parsePositiveInteger(
      "--timeout-seconds",
      DEFAULT_TIMEOUT_SECONDS,
    ),
    image: getFlagValue("--image") ?? DEFAULT_IMAGE,
    workspaceAccess: parseWorkspaceAccess(),
    networkAccess: hasFlag("--network-access"),
    maxTrackedJobs: parseOptionalPositiveInteger(
      "--max-tracked-jobs",
      process.env.AGENC_SYSTEM_SANDBOX_MAX_TRACKED_JOBS,
    ),
    outputPath: path.resolve(process.cwd(), outputPath),
  };
}

function parseToolResult(
  result: { readonly content: string; readonly isError?: boolean },
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch (error) {
    throw new Error(
      `${label} returned non-JSON content: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} returned a non-object payload`);
  }
  const payload = parsed as Record<string, unknown>;
  if (result.isError || typeof payload.error === "string") {
    throw new Error(
      `${label} failed: ${typeof payload.error === "string" ? payload.error : result.content}`,
    );
  }
  return payload;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobsToExit(
  manager: SystemSandboxManager,
  sandboxJobIds: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<DrillJobResult[]> {
  const startedAtMs = Date.now();
  const completed = new Map<string, DrillJobResult>();

  while (Date.now() - startedAtMs <= timeoutMs) {
    await Promise.all(
      sandboxJobIds.map(async (sandboxJobId) => {
        if (completed.has(sandboxJobId)) {
          return;
        }
        const status = parseToolResult(
          await manager.sandboxJobStatus({ sandboxJobId }),
          `sandboxJobStatus(${sandboxJobId})`,
        );
        const state = String(status.state ?? "");
        if (state !== "exited") {
          if (state === "failed") {
            throw new Error(`sandbox job ${sandboxJobId} failed`);
          }
          return;
        }
        completed.set(sandboxJobId, {
          sandboxId: String(status.sandboxId),
          sandboxJobId,
          processId: String(status.processId),
          durationMs:
            Number(status.updatedAt ?? Date.now()) - Number(status.startedAt ?? Date.now()),
        });
      }),
    );

    if (completed.size === sandboxJobIds.length) {
      return [...completed.values()];
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `sandbox fleet drill timed out waiting for ${sandboxJobIds.length - completed.size} job(s)`,
  );
}

async function runWave(
  manager: SystemSandboxManager,
  wave: number,
  options: DrillOptions,
): Promise<DrillWaveResult> {
  const startedAt = new Date().toISOString();
  const sandboxes = await Promise.all(
    Array.from({ length: options.sandboxes }, async (_, sandboxIndex) => {
      const sandbox = parseToolResult(
        await manager.startSandbox({
          label: `phase1-wave-${wave}-sandbox-${sandboxIndex + 1}`,
          image: options.image,
          workspaceAccess: options.workspaceAccess,
          networkAccess: options.networkAccess,
        }),
        `startSandbox(${wave}:${sandboxIndex + 1})`,
      );
      return {
        sandboxId: String(sandbox.sandboxId),
      };
    }),
  );

  const sandboxJobIds: string[] = [];
  try {
    for (let sandboxIndex = 0; sandboxIndex < sandboxes.length; sandboxIndex += 1) {
      const sandbox = sandboxes[sandboxIndex]!;
      const startedJobs = await Promise.all(
        Array.from({ length: options.jobsPerSandbox }, async (_, jobIndex) => {
          const started = parseToolResult(
            await manager.sandboxJobStart({
              sandboxId: sandbox.sandboxId,
              label: `phase1-wave-${wave}-sandbox-${sandboxIndex + 1}-job-${jobIndex + 1}`,
              command: "node",
              args: [
                "-e",
                `setTimeout(() => { console.log("sandbox:${sandboxIndex + 1}:job:${jobIndex + 1}:done"); }, ${options.jobDurationMs});`,
              ],
            }),
            `sandboxJobStart(${wave}:${sandboxIndex + 1}:${jobIndex + 1})`,
          );
          const sandboxJobId = String(started.sandboxJobId);
          sandboxJobIds.push(sandboxJobId);
          return sandboxJobId;
        }),
      );
      if (startedJobs.length !== options.jobsPerSandbox) {
        throw new Error(`expected ${options.jobsPerSandbox} jobs for sandbox ${sandbox.sandboxId}`);
      }
    }

    const jobResults = await waitForJobsToExit(
      manager,
      sandboxJobIds,
      options.timeoutSeconds * 1000,
      options.pollIntervalMs,
    );

    return {
      wave,
      startedAt,
      finishedAt: new Date().toISOString(),
      sandboxesStarted: sandboxes.length,
      jobsStarted: sandboxJobIds.length,
      jobsCompleted: jobResults.length,
      jobResults,
    };
  } finally {
    await Promise.all(
      sandboxes.map(async (sandbox) => {
        try {
          await manager.sandboxStop({ sandboxId: sandbox.sandboxId });
        } catch {
          // Best-effort cleanup so the drill still reports the original failure.
        }
      }),
    );
  }
}

async function writeArtifact(
  outputPath: string,
  artifact: DrillArtifact,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  const options = parseOptions();
  console.log(`[sandbox-drill] sandboxes=${options.sandboxes}`);
  console.log(`[sandbox-drill] jobs-per-sandbox=${options.jobsPerSandbox}`);
  console.log(`[sandbox-drill] waves=${options.waves}`);
  console.log(`[sandbox-drill] image=${options.image}`);
  console.log(`[sandbox-drill] workspace-access=${options.workspaceAccess}`);
  console.log(`[sandbox-drill] network-access=${options.networkAccess}`);
  if (options.maxTrackedJobs !== null) {
    console.log(`[sandbox-drill] max-tracked-jobs=${options.maxTrackedJobs}`);
  }

  const manager = new SystemSandboxManager({
    rootDir: path.join(
      ARTIFACT_DIR,
      `runtime-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ),
    logger: silentLogger,
    workspacePath: process.cwd(),
    defaultImage: options.image,
    defaultWorkspaceAccess: options.workspaceAccess,
    defaultNetworkAccess: options.networkAccess,
    maxTrackedJobs: options.maxTrackedJobs ?? undefined,
  });

  const waves: DrillWaveResult[] = [];
  let overallPassed = false;
  try {
    for (let wave = 1; wave <= options.waves; wave += 1) {
      console.log(`\n==> sandbox fleet wave ${wave}`);
      const result = await runWave(manager, wave, options);
      waves.push(result);
      console.log(
        `[sandbox-drill] wave ${wave} completed: sandboxes=${result.sandboxesStarted} jobs=${result.jobsCompleted}`,
      );
    }
    overallPassed = true;
  } finally {
    await manager.resetForTesting().catch(() => undefined);
    const artifact: DrillArtifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      config: {
        sandboxes: options.sandboxes,
        jobsPerSandbox: options.jobsPerSandbox,
        waves: options.waves,
        jobDurationMs: options.jobDurationMs,
        timeoutSeconds: options.timeoutSeconds,
        image: options.image,
        workspaceAccess: options.workspaceAccess,
        networkAccess: options.networkAccess,
        maxTrackedJobs: options.maxTrackedJobs,
      },
      overallPassed,
      waves,
    };
    await writeArtifact(options.outputPath, artifact);
    console.log(`[sandbox-drill] artifact: ${options.outputPath}`);
    if (!overallPassed) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] sandbox fleet drill failed: ${message}`);
  process.exit(1);
});
