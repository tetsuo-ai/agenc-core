import { digestCanonicalJson, sha256Digest } from "../eval-contract/index.js";
import type { EvaluationPilotUpstreamPreflightEvidence } from "../eval-pilot/types.js";
import { buildParserProgram, extractParserResults, testPassed } from "./log-parser.js";
import { EvalExecutorError } from "./source-lock.js";
import type {
  ContainerExecResult,
  ContainerHandle,
  ContainerRunner,
  PilotSourceLockTask,
  PreflightCommandRecord,
  PreflightFailureReason,
  PreflightPhaseTranscript,
  PreflightRunReport,
  TriplePreflightResult,
  VerifierBundle,
} from "./types.js";

const ENVIRONMENT_DIGEST_DOMAIN = "agenc.eval.executor-environment.v1";
const TRANSCRIPT_DIGEST_DOMAIN = "agenc.eval.pilot-preflight-transcript.v1";
const HELPER_DIR = "/agenc-eval";
const EXCERPT_LIMIT = 2_000;

const NETWORK_FAILURE_PATTERN =
  /could not resolve|name resolution|network is unreachable|unable to access|connection timed out|connection refused|no route to host/iu;

export interface PreflightTimeouts {
  readonly patchMs: number;
  readonly rebuildMs: number;
  readonly testMs: number;
  readonly parserMs: number;
}

export const DEFAULT_PREFLIGHT_TIMEOUTS: PreflightTimeouts = {
  patchMs: 120_000,
  rebuildMs: 3_600_000,
  testMs: 3_600_000,
  parserMs: 300_000,
};

/**
 * Some task images (the .NET pilot candidates) ship no python3, so the
 * frozen log parser cannot run inside them. It then runs in this auxiliary
 * offline container instead — never on the host. The node bookworm image is
 * already an executor dependency (phase-2 agent overlay) and carries
 * python3; operators may override per environment.
 */
export const DEFAULT_PARSER_FALLBACK_IMAGE = "node:25.9.0-bookworm";

export interface PreflightExecutionOptions {
  readonly parserFallbackImage?: string;
}

export interface PreflightTaskInputs {
  readonly task: PilotSourceLockTask;
  readonly bundle: VerifierBundle;
  readonly setupPatch: Uint8Array;
  readonly referencePatch: Uint8Array;
}

class PreflightPhaseFailure extends Error {
  constructor(
    readonly reason: PreflightFailureReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "PreflightPhaseFailure";
  }
}

function excerpt(text: string): string {
  return text.length > EXCERPT_LIMIT ? text.slice(text.length - EXCERPT_LIMIT) : text;
}

function record(label: string, script: string, result: ContainerExecResult): PreflightCommandRecord {
  return {
    label,
    script,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    durationMs: result.durationMs,
    stdoutDigest: sha256Digest(result.stdout),
    stderrDigest: sha256Digest(result.stderr),
    stdoutExcerpt: excerpt(result.stdout),
    stderrExcerpt: excerpt(result.stderr),
  };
}

interface PhaseOutcome {
  readonly transcript: PreflightPhaseTranscript;
  readonly results: Readonly<Record<string, string>> | null;
  readonly failure: { readonly reason: PreflightFailureReason; readonly detail: string } | null;
}

async function runPhase(
  runner: ContainerRunner,
  inputs: PreflightTaskInputs,
  phase: "base" | "reference",
  timeouts: PreflightTimeouts,
  options: PreflightExecutionOptions,
): Promise<PhaseOutcome> {
  const commands: PreflightCommandRecord[] = [];
  const appliedPatches: string[] = [];
  let handle: ContainerHandle;
  try {
    handle = await runner.createTaskContainer(inputs.task.image);
  } catch (error) {
    return {
      transcript: { phase, imageDigest: "", appliedPatches: [], commands: [], testResults: null },
      results: null,
      failure: {
        reason: "infrastructure_error",
        detail: `container creation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  let results: Readonly<Record<string, string>> | null = null;
  let failure: PhaseOutcome["failure"] = null;
  try {
    const exec = async (
      label: string,
      script: string,
      timeoutMs: number,
      target: ContainerHandle = handle,
    ): Promise<ContainerExecResult> => {
      const result = await runner.exec(target, { script, timeoutMs });
      commands.push(record(label, script, result));
      if (result.timedOut) {
        throw new PreflightPhaseFailure("timeout", `${label} exceeded ${timeoutMs}ms`);
      }
      return result;
    };

    const patches: Array<{ readonly name: string; readonly bytes: Uint8Array }> = [];
    if (inputs.setupPatch.byteLength > 0) {
      patches.push({ name: "setup.patch", bytes: inputs.setupPatch });
    }
    if (phase === "reference") {
      if (inputs.referencePatch.byteLength === 0) {
        throw new PreflightPhaseFailure("infrastructure_error", "reference patch is empty");
      }
      patches.push({ name: "reference.patch", bytes: inputs.referencePatch });
    }
    patches.push({
      name: "test.patch",
      bytes: new TextEncoder().encode(inputs.bundle.testPatch),
    });

    for (const patch of patches) {
      if (patch.bytes.byteLength === 0) continue;
      const target = `${HELPER_DIR}/${patch.name}`;
      await runner.writeFile(handle, target, patch.bytes);
      const applied = await exec(
        `apply ${patch.name}`,
        `git -c core.fileMode=false apply --verbose '${target}'`,
        timeouts.patchMs,
      );
      if (applied.exitCode !== 0) {
        throw new PreflightPhaseFailure(
          "patch_apply_failed",
          `${patch.name} did not apply: ${excerpt(applied.stderr)}`,
        );
      }
      appliedPatches.push(patch.name);
    }

    for (const [index, command] of inputs.bundle.rebuildCommands.entries()) {
      const rebuilt = await exec(`rebuild[${index}]`, command, timeouts.rebuildMs);
      if (rebuilt.exitCode !== 0) {
        const combined = `${rebuilt.stdout}\n${rebuilt.stderr}`;
        throw new PreflightPhaseFailure(
          NETWORK_FAILURE_PATTERN.test(combined) ? "network_required" : "rebuild_failed",
          `rebuild[${index}] exited ${rebuilt.exitCode}: ${excerpt(rebuilt.stderr)}`,
        );
      }
    }

    let capturedTestOutput = "";
    let lastTestExit: number | null = 0;
    for (const [index, command] of inputs.bundle.testCommands.entries()) {
      // A nonzero test exit is expected while target tests still fail; the
      // parsed per-test results are the verdict source, not the exit code.
      const tested = await exec(`test[${index}]`, command, timeouts.testMs);
      capturedTestOutput += `${tested.stdout}\n${tested.stderr}\n`;
      lastTestExit = tested.exitCode;
    }

    // Upstream SWE-bench-Live semantics: the log parser consumes the output
    // of the bundle's print commands (e.g. `cat reports/mocha-results.json`),
    // not the raw test stdout. Redirect in-container so the host output cap
    // cannot truncate the parser input.
    for (const [index, command] of inputs.bundle.printCommands.entries()) {
      // A failing print command is not fatal by itself; an empty parser
      // input already surfaces through the taxonomy below.
      await exec(
        `print[${index}]`,
        `( ${command} ) >> ${HELPER_DIR}/parser-input.log`,
        timeouts.parserMs,
      );
    }
    await runner.writeFile(
      handle,
      `${HELPER_DIR}/captured-test-output.log`,
      new TextEncoder().encode(capturedTestOutput),
    );
    const parserProgram = new TextEncoder().encode(buildParserProgram(inputs.bundle.logParser));
    const parserScript =
      `python3 ${HELPER_DIR}/parse-log.py ${HELPER_DIR}/parser-input.log test-output.log ${HELPER_DIR}/captured-test-output.log`;
    const probe = await exec("probe-python3", "command -v python3", timeouts.patchMs);
    let parsed: ContainerExecResult;
    if (probe.exitCode === 0) {
      await runner.writeFile(handle, `${HELPER_DIR}/parse-log.py`, parserProgram);
      parsed = await exec("parse-log", parserScript, timeouts.parserMs);
    } else {
      // The task image ships no python3 (the .NET candidates). Run the
      // frozen parser in an offline auxiliary container instead — still
      // never on the host. test-output.log is workdir-relative and is not
      // copied; the printed parser input and the captured output cover it.
      const aux = await runner.createAuxiliaryContainer(
        options.parserFallbackImage ?? DEFAULT_PARSER_FALLBACK_IMAGE,
      );
      try {
        await runner.writeFile(aux, `${HELPER_DIR}/parse-log.py`, parserProgram);
        for (const file of ["parser-input.log", "captured-test-output.log"]) {
          try {
            await runner.copyFile(handle, `${HELPER_DIR}/${file}`, aux, `${HELPER_DIR}/${file}`);
          } catch {
            // An absent candidate file is fine; the harness reads the first
            // readable candidate.
          }
        }
        parsed = await exec("parse-log[fallback]", parserScript, timeouts.parserMs, aux);
      } finally {
        await runner.remove(aux);
      }
    }
    if (parsed.exitCode !== 0) {
      throw new PreflightPhaseFailure(
        "parser_failed",
        `log parser exited ${parsed.exitCode}: ${excerpt(parsed.stderr)}`,
      );
    }
    results = extractParserResults(parsed.stdout);
    if (Object.keys(results).length === 0) {
      throw new PreflightPhaseFailure(
        "test_command_failed",
        `no test results were parsed (last test exit ${lastTestExit})`,
      );
    }
  } catch (error) {
    if (error instanceof PreflightPhaseFailure) {
      failure = { reason: error.reason, detail: error.detail };
    } else if (error instanceof EvalExecutorError) {
      failure = { reason: "infrastructure_error", detail: error.message };
    } else {
      throw error;
    }
  } finally {
    await runner.remove(handle);
  }
  return {
    transcript: {
      phase,
      imageDigest: handle.imageDigest,
      appliedPatches,
      commands,
      testResults: results,
    },
    results,
    failure,
  };
}

function firstFailing(
  results: Readonly<Record<string, string>>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    if (!testPassed(results, name)) return name;
  }
  return null;
}

function statusEvidence(results: Readonly<Record<string, string>>, name: string): string {
  const status = results[name];
  return status === undefined
    ? "absent from parsed results"
    : `status ${JSON.stringify(status)}`;
}

function firstPassing(
  results: Readonly<Record<string, string>>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    if (testPassed(results, name)) return name;
  }
  return null;
}

/**
 * One cold preflight run: a fresh base-phase container proving the target
 * checks fail and the regression checks pass, then a fresh reference-phase
 * container proving the pinned reference solution passes everything.
 */
export async function runSinglePreflight(
  runner: ContainerRunner,
  inputs: PreflightTaskInputs,
  runIndex: 1 | 2 | 3,
  timeouts: PreflightTimeouts = DEFAULT_PREFLIGHT_TIMEOUTS,
  options: PreflightExecutionOptions = {},
): Promise<PreflightRunReport> {
  const startedAt = new Date().toISOString();
  const environment = await runner.environment();
  const environmentDigest = digestCanonicalJson(ENVIRONMENT_DIGEST_DOMAIN, {
    ...environment,
    image: inputs.task.image,
  });

  const phases: PreflightPhaseTranscript[] = [];
  let baseFailsTargetChecks = false;
  let basePassesRegressionChecks = false;
  let referencePassesAllChecks = false;
  let failure: PreflightRunReport["failure"] = null;

  const base = await runPhase(runner, inputs, "base", timeouts, options);
  phases.push(base.transcript);
  if (base.failure) {
    failure = base.failure;
  } else if (base.results) {
    const unexpectedlyPassing = firstPassing(base.results, inputs.bundle.failToPass);
    baseFailsTargetChecks = unexpectedlyPassing === null;
    const regressionFailing = firstFailing(base.results, inputs.bundle.passToPass);
    basePassesRegressionChecks = regressionFailing === null;
    if (!baseFailsTargetChecks) {
      failure = {
        reason: "base_unexpectedly_passes",
        detail: `target check ${unexpectedlyPassing} already passes on the pinned base`,
      };
    } else if (!basePassesRegressionChecks) {
      failure = {
        reason: "regression_check_failed",
        detail: `regression check ${regressionFailing} does not pass on the pinned base ` +
          `(${statusEvidence(base.results, regressionFailing!)})`,
      };
    }
  }

  if (!failure) {
    const reference = await runPhase(runner, inputs, "reference", timeouts, options);
    phases.push(reference.transcript);
    if (reference.failure) {
      failure = reference.failure;
    } else if (reference.results) {
      const failing = firstFailing(reference.results, [
        ...inputs.bundle.failToPass,
        ...inputs.bundle.passToPass,
      ]);
      referencePassesAllChecks = failing === null;
      if (!referencePassesAllChecks) {
        failure = {
          reason: "reference_solution_failed",
          detail: `${failing} does not pass with the pinned reference solution ` +
            `(${statusEvidence(reference.results, failing!)})`,
        };
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const verdicts = {
    coldRebuild: true,
    baseFailsTargetChecks,
    basePassesRegressionChecks,
    referencePassesAllChecks,
  } as const;
  const evidenceDigest = digestCanonicalJson(TRANSCRIPT_DIGEST_DOMAIN, {
    taskId: inputs.task.instanceId,
    runIndex,
    startedAt,
    finishedAt,
    environmentDigest,
    phases,
    verdicts,
    failure,
  });
  return {
    taskId: inputs.task.instanceId,
    runIndex,
    startedAt,
    finishedAt,
    phases,
    verdicts,
    failure,
    environmentDigest,
    evidenceDigest,
  };
}

/**
 * The pilot protocol's triple preflight. Stops at the first failed run: one
 * failure already disqualifies the candidate, and the remaining runs would
 * spend an hour-scale rebuild proving nothing.
 */
export async function runTriplePreflight(
  runner: ContainerRunner,
  inputs: PreflightTaskInputs,
  timeouts: PreflightTimeouts = DEFAULT_PREFLIGHT_TIMEOUTS,
  options: PreflightExecutionOptions = {},
): Promise<TriplePreflightResult> {
  const runs: PreflightRunReport[] = [];
  for (const runIndex of [1, 2, 3] as const) {
    const report = await runSinglePreflight(runner, inputs, runIndex, timeouts, options);
    runs.push(report);
    if (report.failure) break;
  }
  const qualified = runs.length === 3 && runs.every((run) =>
    run.failure === null &&
    run.verdicts.baseFailsTargetChecks &&
    run.verdicts.basePassesRegressionChecks &&
    run.verdicts.referencePassesAllChecks
  );
  return { taskId: inputs.task.instanceId, qualified, runs };
}

/**
 * Mint the typed qualification evidence the pilot curation catalog consumes.
 * This exists only for a fully qualified triple; anything else throws, so a
 * failed candidate can never be laundered into `status: "complete"`.
 */
export function mintUpstreamPreflightEvidence(
  result: TriplePreflightResult,
  operatorTaskDigest: `sha256:${string}`,
): EvaluationPilotUpstreamPreflightEvidence {
  if (!result.qualified || result.runs.length !== 3) {
    throw new EvalExecutorError([
      `task ${result.taskId} is not qualified; refusing to mint upstream preflight evidence`,
    ]);
  }
  const [first, second, third] = result.runs;
  const toRun = (report: PreflightRunReport) => {
    if (
      report.failure !== null ||
      !report.verdicts.baseFailsTargetChecks ||
      !report.verdicts.basePassesRegressionChecks ||
      !report.verdicts.referencePassesAllChecks
    ) {
      throw new EvalExecutorError([
        `run ${report.runIndex} for ${result.taskId} did not hold every preflight verdict`,
      ]);
    }
    return {
      runIndex: report.runIndex,
      coldRebuild: true,
      baseFailsTargetChecks: true,
      basePassesRegressionChecks: true,
      referencePassesAllChecks: true,
      environmentDigest: report.environmentDigest,
      evidenceDigest: report.evidenceDigest,
    } as const;
  };
  return {
    kind: "agenc.eval.pilot-upstream-triple-preflight",
    evidenceVersion: "1.0.0",
    taskId: result.taskId,
    operatorTaskDigest,
    status: "complete",
    runs: [toRun(first!), toRun(second!), toRun(third!)],
  };
}
