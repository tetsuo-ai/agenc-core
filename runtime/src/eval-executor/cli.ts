import { randomBytes, randomInt } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { runAgentOnTask, runRealProviderAgentOnTask } from "./agent-run.js";
import {
  createRealAgentBatchDeps,
  runRealAgentBatch,
  writeRealAgentBatchSummary,
} from "./batch.js";
import { DockerContainerRunner } from "./container-runner.js";
import {
  DEFAULT_PREFLIGHT_TIMEOUTS,
  mintUpstreamPreflightEvidence,
  runTriplePreflight,
  type PreflightTaskInputs,
} from "./preflight.js";
import {
  EvalExecutorError,
  findPilotTask,
  loadPilotSourceLock,
  readPilotArtifact,
} from "./source-lock.js";
import { runTrustSuiteFromFiles } from "./trust-run.js";
import type { LoadedPilotSourceLock } from "./types.js";
import { decodeVerifierBundle } from "./verifier-bundle.js";

const DEFAULT_LOCK_PATH =
  "eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json";

const DEFAULT_TRUST_SUITE_DIR = "eval/suites/trust-conformance/1.0.0";

const USAGE = `Usage:
  eval:executor verify-lock [--lock <source-lock.json>]
  eval:executor preflight --task <instanceId> [--lock <path>] [--output <dir>]
                          [--operator-task-digest <sha256:...>]
  eval:executor run-agent --task <instanceId> --overlay <dir> [--lock <path>]
                          [--output <dir>] [--agent-timeout-ms <n>]
  eval:executor run-agent-real --task <instanceId> --overlay <dir>
                          --provider-host <host> --provider-base-url <url>
                          --provider-model <model> [--key-env-var <NAME>]
                          [--lock <path>] [--output <dir>] [--agent-timeout-ms <n>]
  eval:executor run-agent-real-batch --overlay <dir>
                          --provider-host <host> --provider-base-url <url>
                          --provider-model <model> [--tasks <id,id,...>]
                          [--key-env-var <NAME>] [--key-command <exe>]
                          [--lock <path>] [--output <dir>] [--agent-timeout-ms <n>]
  eval:executor trust-run --repository-commit <sha>
                          [--suite-dir <dir>] [--seed-slot <n>] [--output <dir>]

verify-lock  Load the frozen pilot source lock, re-hash every CAS artifact,
             and decode every verifier bundle. Hermetic and offline.
preflight    Run the pilot triple preflight for one task inside its pinned
             OCI image (requires docker; containers run --network none).
run-agent    Run the real AgenC agent against one pinned task fully offline
             (--network none, bundled in-container mock provider), collect
             its patch, and verify it with the hidden verifier in a fresh
             offline container. Pipeline-validation lane.
run-agent-real  Run the real AgenC agent against a REAL model provider inside a
             topologically network-isolated egress lane (internal net +
             allowlist proxy sidecar). The agent runs only after every
             containment probe passes; the provider key is read from
             --key-env-var in the executor env and injected via docker exec
             (never on any argv). Requires docker.
run-agent-real-batch  Run run-agent-real across every lock task (or --tasks, in
             the given order): resumable (tasks with an existing report are
             skipped), continue-on-error, per-task image pull, and optional
             per-task key refresh via --key-command (an executable whose
             stdout becomes the key — no shell). Writes batch-progress.log
             and batch-summary.json under --output. Exit 0 only when every
             task ends with a report. This is the documented reproduction
             path for the real-agent baseline report.
trust-run    Run the deterministic trust-conformance suite offline against the
             real runtime seams (budget ledger, SQLite recovery, client
             multiplexer replay, permission evaluator + audit log). Honest
             invariant failures are M3/M4 gap DATA, not command failures:
             exit 0 whenever every attempt was evaluated, 1 only on
             infrastructure-invalid attempts. Writes per-scenario reports,
             raw evidence, preserved failed-attempt state, and a
             content-addressed summary under --output.`;

async function verifyLock(lockPath: string): Promise<number> {
  const loaded = await loadPilotSourceLock(lockPath);
  for (const task of loaded.lock.tasks) {
    const bundleBytes = await readPilotArtifact(loaded, task.artifacts.verifierBundle);
    decodeVerifierBundle(bundleBytes, task.instanceId);
    await readPilotArtifact(loaded, task.artifacts.setupPatch);
    await readPilotArtifact(loaded, task.artifacts.referencePatch);
    await readPilotArtifact(loaded, task.artifacts.sourceEvidence);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    lock: path.resolve(lockPath),
    documentDigest: loaded.lock.documentDigest,
    tasks: loaded.lock.tasks.length,
  }, null, 2)}\n`);
  return 0;
}

async function preflight(options: {
  readonly lockPath: string;
  readonly taskId: string;
  readonly outputDir: string;
  readonly operatorTaskDigest?: string;
  readonly parserFallbackImage?: string;
}): Promise<number> {
  const loaded = await loadPilotSourceLock(options.lockPath);
  const task = findPilotTask(loaded.lock, options.taskId);
  const inputs: PreflightTaskInputs = {
    task,
    bundle: decodeVerifierBundle(
      await readPilotArtifact(loaded, task.artifacts.verifierBundle),
      task.instanceId,
    ),
    setupPatch: await readPilotArtifact(loaded, task.artifacts.setupPatch),
    referencePatch: await readPilotArtifact(loaded, task.artifacts.referencePatch),
  };
  const runner = new DockerContainerRunner();
  await runner.environment();

  const result = await runTriplePreflight(runner, inputs, DEFAULT_PREFLIGHT_TIMEOUTS, {
    parserFallbackImage: options.parserFallbackImage,
  });
  const taskDir = path.join(options.outputDir, task.instanceId);
  await mkdir(taskDir, { recursive: true });
  for (const run of result.runs) {
    await writeFile(
      path.join(taskDir, `preflight-run-${run.runIndex}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  await writeFile(
    path.join(taskDir, "preflight-summary.json"),
    `${JSON.stringify({
      taskId: result.taskId,
      qualified: result.qualified,
      runs: result.runs.map((run) => ({
        runIndex: run.runIndex,
        failure: run.failure,
        verdicts: run.verdicts,
        evidenceDigest: run.evidenceDigest,
      })),
    }, null, 2)}\n`,
    { flag: "wx" },
  );
  if (result.qualified && options.operatorTaskDigest) {
    const evidence = mintUpstreamPreflightEvidence(
      result,
      options.operatorTaskDigest as `sha256:${string}`,
    );
    await writeFile(
      path.join(taskDir, "upstream-preflight-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  process.stdout.write(`${JSON.stringify({
    taskId: result.taskId,
    qualified: result.qualified,
    firstFailure: result.runs.find((run) => run.failure)?.failure ?? null,
    outputDir: taskDir,
  }, null, 2)}\n`);
  return result.qualified ? 0 : 1;
}

async function runAgent(options: {
  readonly lockPath: string;
  readonly taskId: string;
  readonly overlayDir: string;
  readonly outputDir: string;
  readonly agentTimeoutMs?: number;
  readonly parserFallbackImage?: string;
}): Promise<number> {
  const loaded = await loadPilotSourceLock(options.lockPath);
  const task = findPilotTask(loaded.lock, options.taskId);
  const runner = new DockerContainerRunner();
  await runner.environment();
  const { report, patchBytes, rawAgentResult } = await runAgentOnTask(
    runner,
    {
      task,
      bundle: decodeVerifierBundle(
        await readPilotArtifact(loaded, task.artifacts.verifierBundle),
        task.instanceId,
      ),
      setupPatch: await readPilotArtifact(loaded, task.artifacts.setupPatch),
    },
    {
      overlay: { hostDir: options.overlayDir },
      agentTimeoutMs: options.agentTimeoutMs,
    },
    DEFAULT_PREFLIGHT_TIMEOUTS,
    { parserFallbackImage: options.parserFallbackImage },
  );
  const taskDir = path.join(options.outputDir, task.instanceId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, "agent-run-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  if (patchBytes !== null) {
    await writeFile(path.join(taskDir, "agent-patch.diff"), patchBytes, { flag: "wx" });
  }
  if (rawAgentResult !== null && rawAgentResult.length > 0) {
    await writeFile(path.join(taskDir, "agent-result.json"), rawAgentResult, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    taskId: report.taskId,
    outcome: report.outcome,
    failureDetail: report.failureDetail,
    tokenUsage: report.agent.tokenUsage,
    outputDir: taskDir,
  }, null, 2)}\n`);
  return report.outcome === "verified_fix" ? 0 : 1;
}

interface RealProviderRunConfig {
  readonly overlayDir: string;
  readonly outputDir: string;
  readonly allowHost: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly keyEnvVar: string;
  readonly agentTimeoutMs?: number;
  readonly parserFallbackImage?: string;
}

/**
 * One real-provider task run against an already-loaded lock: egress lane,
 * report + patch + raw-result files under `<outputDir>/<taskId>/`. Shared by
 * the single-task and batch subcommands so their behavior cannot drift.
 */
async function runRealProviderAgentTask(
  loaded: LoadedPilotSourceLock,
  taskId: string,
  options: RealProviderRunConfig,
): Promise<{ readonly outcome: string; readonly summary: Record<string, unknown> }> {
  const task = findPilotTask(loaded.lock, taskId);
  const runner = new DockerContainerRunner();
  await runner.environment();
  // Resolve the provider host once, on the host, to a set of pinned IPs the
  // sidecar dials — so a mid-run DNS flip cannot redirect egress.
  const pinIps = await resolve4(options.allowHost);
  if (pinIps.length === 0) {
    throw new EvalExecutorError([`could not resolve any IP for ${options.allowHost}`]);
  }
  const { report, patchBytes, rawAgentResult } = await runRealProviderAgentOnTask(
    runner,
    (request) => runner.createEgressLane(request),
    {
      task,
      bundle: decodeVerifierBundle(
        await readPilotArtifact(loaded, task.artifacts.verifierBundle),
        task.instanceId,
      ),
      setupPatch: await readPilotArtifact(loaded, task.artifacts.setupPatch),
    },
    {
      overlay: { hostDir: options.overlayDir },
      agentTimeoutMs: options.agentTimeoutMs,
      allowHost: options.allowHost,
      allowPort: 443,
      pinIps,
      model: options.model,
      baseUrl: options.baseUrl,
      keyEnvVar: options.keyEnvVar,
      runId: randomBytes(5).toString("hex"),
      subnetOctet: randomInt(1, 255),
    },
    DEFAULT_PREFLIGHT_TIMEOUTS,
    { parserFallbackImage: options.parserFallbackImage },
  );
  const taskDir = path.join(options.outputDir, task.instanceId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, "agent-run-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  if (patchBytes !== null) {
    await writeFile(path.join(taskDir, "agent-patch.diff"), patchBytes, { flag: "wx" });
  }
  if (rawAgentResult !== null && rawAgentResult.length > 0) {
    await writeFile(path.join(taskDir, "agent-result.json"), rawAgentResult, { flag: "wx" });
  }
  return {
    outcome: report.outcome,
    summary: {
      taskId: report.taskId,
      outcome: report.outcome,
      oracleContainment: report.egress?.oracleContainment,
      denyProbes: report.egress?.denyProbes,
      patchKeyScan: report.egress?.patchKeyScan,
      failureDetail: report.failureDetail,
      tokenUsage: report.agent.tokenUsage,
      outputDir: taskDir,
    },
  };
}

async function runRealProviderAgent(
  options: RealProviderRunConfig & {
    readonly lockPath: string;
    readonly taskId: string;
  },
): Promise<number> {
  const loaded = await loadPilotSourceLock(options.lockPath);
  const { outcome, summary } = await runRealProviderAgentTask(
    loaded,
    options.taskId,
    options,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return outcome === "verified_fix" ? 0 : 1;
}

async function runRealProviderAgentBatch(
  options: RealProviderRunConfig & {
    readonly lockPath: string;
    readonly taskIds?: readonly string[];
    readonly keyCommand?: string;
  },
): Promise<number> {
  const loaded = await loadPilotSourceLock(options.lockPath);
  const deps = createRealAgentBatchDeps({
    outputDir: options.outputDir,
    keyCommand: options.keyCommand,
    runTask: (taskId) => runRealProviderAgentTask(loaded, taskId, options),
  });
  const summary = await runRealAgentBatch(
    {
      loaded,
      taskIds: options.taskIds,
      outputDir: options.outputDir,
      keyCommand: options.keyCommand,
      keyEnvVar: options.keyEnvVar,
    },
    deps,
  );
  const summaryPath = await writeRealAgentBatchSummary(options.outputDir, summary);
  process.stdout.write(`${JSON.stringify({ ...summary, summaryPath }, null, 2)}\n`);
  // The batch's job is a complete scorecard: every task must end with a
  // report (verified or not). Driver-level failures are the only batch
  // failure — a lost task means the scorecard is not the one asked for.
  return summary.driverErrors === 0 ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  const { values } = parseArgs({
    args: [...rest],
    options: {
      lock: { type: "string" },
      task: { type: "string" },
      output: { type: "string" },
      overlay: { type: "string" },
      "agent-timeout-ms": { type: "string" },
      "operator-task-digest": { type: "string" },
      "parser-fallback-image": { type: "string" },
      "provider-host": { type: "string" },
      "provider-base-url": { type: "string" },
      "provider-model": { type: "string" },
      "key-env-var": { type: "string" },
      "key-command": { type: "string" },
      tasks: { type: "string" },
      "suite-dir": { type: "string" },
      "seed-slot": { type: "string" },
      "repository-commit": { type: "string" },
    },
    strict: true,
  });
  const lockPath = values.lock ?? DEFAULT_LOCK_PATH;
  if (command === "verify-lock") {
    return verifyLock(lockPath);
  }
  if (command === "preflight") {
    if (!values.task) {
      throw new EvalExecutorError(["preflight requires --task <instanceId>"]);
    }
    const digest = values["operator-task-digest"];
    if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new EvalExecutorError(["--operator-task-digest must be a sha256 digest"]);
    }
    return preflight({
      lockPath,
      taskId: values.task,
      outputDir: values.output ?? "eval-executor-output",
      operatorTaskDigest: digest,
      parserFallbackImage: values["parser-fallback-image"],
    });
  }
  if (command === "run-agent") {
    if (!values.task || !values.overlay) {
      throw new EvalExecutorError(["run-agent requires --task <instanceId> and --overlay <dir>"]);
    }
    const timeoutRaw = values["agent-timeout-ms"];
    const agentTimeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    if (agentTimeoutMs !== undefined && (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs <= 0)) {
      throw new EvalExecutorError(["--agent-timeout-ms must be a positive integer"]);
    }
    return runAgent({
      lockPath,
      taskId: values.task,
      overlayDir: values.overlay,
      outputDir: values.output ?? "eval-executor-output",
      agentTimeoutMs,
      parserFallbackImage: values["parser-fallback-image"],
    });
  }
  if (command === "run-agent-real") {
    if (!values.task || !values.overlay) {
      throw new EvalExecutorError(["run-agent-real requires --task <instanceId> and --overlay <dir>"]);
    }
    const host = values["provider-host"];
    const baseUrl = values["provider-base-url"];
    const model = values["provider-model"];
    if (!host || !baseUrl || !model) {
      throw new EvalExecutorError([
        "run-agent-real requires --provider-host, --provider-base-url, and --provider-model",
      ]);
    }
    const timeoutRaw = values["agent-timeout-ms"];
    const agentTimeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    if (agentTimeoutMs !== undefined && (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs <= 0)) {
      throw new EvalExecutorError(["--agent-timeout-ms must be a positive integer"]);
    }
    return runRealProviderAgent({
      lockPath,
      taskId: values.task,
      overlayDir: values.overlay,
      outputDir: values.output ?? "eval-executor-output",
      allowHost: host,
      baseUrl,
      model,
      keyEnvVar: values["key-env-var"] ?? "OPENAI_COMPATIBLE_API_KEY",
      agentTimeoutMs,
      parserFallbackImage: values["parser-fallback-image"],
    });
  }
  if (command === "run-agent-real-batch") {
    if (!values.overlay) {
      throw new EvalExecutorError(["run-agent-real-batch requires --overlay <dir>"]);
    }
    const host = values["provider-host"];
    const baseUrl = values["provider-base-url"];
    const model = values["provider-model"];
    if (!host || !baseUrl || !model) {
      throw new EvalExecutorError([
        "run-agent-real-batch requires --provider-host, --provider-base-url, and --provider-model",
      ]);
    }
    const timeoutRaw = values["agent-timeout-ms"];
    const agentTimeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    if (agentTimeoutMs !== undefined && (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs <= 0)) {
      throw new EvalExecutorError(["--agent-timeout-ms must be a positive integer"]);
    }
    const taskIds = values.tasks === undefined
      ? undefined
      : values.tasks.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
    if (taskIds !== undefined && taskIds.length === 0) {
      throw new EvalExecutorError(["--tasks must name at least one task id"]);
    }
    return runRealProviderAgentBatch({
      lockPath,
      taskIds,
      overlayDir: values.overlay,
      outputDir: values.output ?? "eval-executor-output",
      allowHost: host,
      baseUrl,
      model,
      keyEnvVar: values["key-env-var"] ?? "OPENAI_COMPATIBLE_API_KEY",
      keyCommand: values["key-command"],
      agentTimeoutMs,
      parserFallbackImage: values["parser-fallback-image"],
    });
  }
  if (command === "trust-run") {
    const repositoryCommit = values["repository-commit"];
    if (!repositoryCommit || !/^[0-9a-f]{40,64}$/u.test(repositoryCommit)) {
      throw new EvalExecutorError([
        "trust-run requires --repository-commit <40-64 hex chars> (explicit pin, e.g. `git rev-parse HEAD`)",
      ]);
    }
    const seedSlotRaw = values["seed-slot"];
    const seedSlot = seedSlotRaw === undefined ? 0 : Number(seedSlotRaw);
    if (!Number.isSafeInteger(seedSlot) || seedSlot < 0) {
      throw new EvalExecutorError(["--seed-slot must be a non-negative integer"]);
    }
    const summary = await runTrustSuiteFromFiles({
      suiteDir: values["suite-dir"] ?? DEFAULT_TRUST_SUITE_DIR,
      seedSlot,
      outputDir: values.output ?? "eval-executor-output/trust",
      repositoryCommit,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    // Honest invariant failures are the suite's product (M3/M4 gap data);
    // only attempts the harness could not evaluate fail the command.
    return summary.infrastructureInvalid === 0 ? 0 : 1;
  }
  process.stderr.write(`Unknown command ${command}\n${USAGE}\n`);
  return 2;
}

const isDirectInvocation = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isDirectInvocation) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
