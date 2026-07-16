import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { DockerContainerRunner } from "./container-runner.js";
import {
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
import { decodeVerifierBundle } from "./verifier-bundle.js";

const DEFAULT_LOCK_PATH =
  "eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json";

const USAGE = `Usage:
  eval:executor verify-lock [--lock <source-lock.json>]
  eval:executor preflight --task <instanceId> [--lock <path>] [--output <dir>]
                          [--operator-task-digest <sha256:...>]

verify-lock  Load the frozen pilot source lock, re-hash every CAS artifact,
             and decode every verifier bundle. Hermetic and offline.
preflight    Run the pilot triple preflight for one task inside its pinned
             OCI image (requires docker; containers run --network none).`;

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

  const result = await runTriplePreflight(runner, inputs);
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
      "operator-task-digest": { type: "string" },
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
    });
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
