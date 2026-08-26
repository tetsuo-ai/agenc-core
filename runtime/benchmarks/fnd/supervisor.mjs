import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { formatBoundedDiagnostic } from "./diagnostic.mjs";
import { markOwnedTemporaryRootForRetention } from "./isolation.mjs";

export const MAX_SUPERVISOR_TIMEOUT_MS = 60_000;
export const MAX_SUPERVISOR_ARGUMENTS = 64;
export const MAX_SUPERVISOR_ARGUMENT_BYTES = 16_384;
export const MAX_SUPERVISOR_OUTPUT_BYTES = 4_194_304;
export const CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS = 2_000;
export const CHILD_TERMINATION_POLL_INTERVAL_MS = 20;
const MAX_COMPLETION_RECORD_BYTES = 256;
const PRODUCTION_TERMINATE_GRACE_MS = 0;
const PRODUCTION_SETTLEMENT_KEEPALIVE_INTERVAL_MS = 1_000;

let productionContainmentPromise;

export function runBoundedChild(options) {
  const validated = validateOptions(options);
  if (validated.processTreeController === undefined) {
    return runProductionContainedChild(validated);
  }
  return runBoundedChildWithController(validated);
}

async function runProductionContainedChild(options) {
  const runSupervisedProcess =
    options.productionContainmentRunner ??
    (await loadProductionContainment()).runSupervisedProcess;
  const startedAt = performance.now();
  let completionObserved = false;
  let observedStderr = "";
  const settlementKeepAlive = setInterval(
    () => {},
    PRODUCTION_SETTLEMENT_KEEPALIVE_INTERVAL_MS,
  );
  let result;
  try {
    try {
      result = await runSupervisedProcess(
        {
          args: options.args,
          cwd: options.cwd,
          env: options.env,
          program: options.command,
        },
        {
          maxOutputBytes: options.maxOutputBytes,
          onStderr(chunk, control) {
            if (
              completionObserved ||
              options.expectedCompletionRecord === undefined
            ) {
              return;
            }
            observedStderr += chunk.toString("utf8");
            if (
              outputContainsExactLine(
                observedStderr,
                options.expectedCompletionRecord,
              )
            ) {
              completionObserved = true;
              control.stop("consumer_limit");
            }
          },
          settleBackstopMs: CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS,
          terminateGraceMs: PRODUCTION_TERMINATE_GRACE_MS,
          timeoutMs: options.timeoutMs,
        },
      );
    } catch (error) {
      throw markOwnedTemporaryRootForRetention(
        containmentError(
          "production process-tree settlement was not proven",
          error,
        ),
      );
    }
  } finally {
    clearInterval(settlementKeepAlive);
  }
  if (result.backstopExpired) {
    throw markOwnedTemporaryRootForRetention(
      containmentError("production process-tree settlement was not proven"),
    );
  }
  if (result.error !== undefined) {
    throw markOwnedTemporaryRootForRetention(
      containmentError(
        "production process-tree settlement was not proven",
        result.error,
      ),
    );
  }
  if (result.stopReason === "output_limit") {
    throw new Error("child exceeded the bounded output ceiling");
  }
  const timedOut = result.stopReason === "timeout";
  if (
    result.stopReason !== undefined &&
    !timedOut &&
    !(result.stopReason === "consumer_limit" && completionObserved)
  ) {
    throw new Error(
      `child stopped for unexpected reason: ${result.stopReason}`,
    );
  }
  if (
    options.expectedCompletionRecord !== undefined &&
    !completionObserved &&
    !timedOut
  ) {
    throw new Error(
      "child exited before authenticated benchmark completion: " +
        formatBoundedDiagnostic(result.stderr),
    );
  }
  return {
    elapsedMs: performance.now() - startedAt,
    exitCode: completionObserved && !timedOut ? 0 : result.exitCode,
    signal: completionObserved && !timedOut ? null : result.signal,
    stderr: result.stderr.toString("utf8"),
    stdout: result.stdout.toString("utf8"),
    timedOut,
  };
}

function runBoundedChildWithController(validated) {
  const processTreeController = validated.processTreeController;
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(validated.command, validated.args, {
        cwd: validated.cwd,
        detached: process.platform !== "win32",
        env: validated.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    const startedAt = performance.now();
    let childFailure;
    let closeRecord;
    let outputBytes = 0;
    let outputOverflow = false;
    let settled = false;
    let stderr = "";
    let stdout = "";
    let terminationDeadlineAt;
    let terminationFailure;
    let terminationPollTimer;
    let terminationSettlementTimer;
    let terminationStarted = false;
    let timedOut = false;

    const deadlineTimer = setTimeout(
      () => beginTermination("timeout"),
      validated.timeoutMs,
    );

    const clearTimers = () => {
      clearTimeout(deadlineTimer);
      if (terminationPollTimer !== undefined) {
        clearTimeout(terminationPollTimer);
      }
      if (terminationSettlementTimer !== undefined) {
        clearTimeout(terminationSettlementTimer);
      }
    };

    const destroyChildStreams = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      destroyChildStreams();
      rejectPromise(error);
    };

    const resolveOnce = () => {
      if (settled || closeRecord === undefined) return;
      settled = true;
      clearTimers();
      resolvePromise({
        elapsedMs: closeRecord.elapsedMs,
        exitCode: closeRecord.exitCode,
        signal: closeRecord.signal,
        stderr,
        stdout,
        timedOut,
      });
    };

    function beginTermination(reason, failure) {
      if (reason === "timeout") timedOut = true;
      if (reason === "output_overflow") outputOverflow = true;
      if (failure !== undefined && childFailure === undefined) {
        childFailure = failure;
      }
      if (terminationStarted || settled) return;
      terminationStarted = true;
      clearTimeout(deadlineTimer);
      terminationDeadlineAt =
        performance.now() + CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS;
      tryTerminateProcessTree();
      const remainingMs = Math.max(
        0,
        terminationDeadlineAt - performance.now(),
      );
      terminationSettlementTimer = setTimeout(
        finishTerminationAtDeadline,
        remainingMs,
      );
      pollTerminationSettlement();
    }

    function tryTerminateProcessTree() {
      try {
        processTreeController.terminate(child);
      } catch (error) {
        if (terminationFailure === undefined) terminationFailure = error;
      }
    }

    function processTreeIsAlive() {
      try {
        const alive = processTreeController.isAlive(child);
        if (typeof alive !== "boolean") {
          throw new Error("process-tree liveness probe must return a boolean");
        }
        return alive;
      } catch (error) {
        if (terminationFailure === undefined) terminationFailure = error;
        return undefined;
      }
    }

    function pollTerminationSettlement() {
      if (settled) return;
      const treeAlive = processTreeIsAlive();
      if (treeAlive === false && closeRecord !== undefined) {
        settleAfterForcedTermination();
        return;
      }
      const remainingMs = terminationDeadlineAt - performance.now();
      if (remainingMs <= 0) return;
      terminationPollTimer = setTimeout(
        pollTerminationSettlement,
        Math.min(CHILD_TERMINATION_POLL_INTERVAL_MS, remainingMs),
      );
    }

    function finishTerminationAtDeadline() {
      if (settled) return;
      const treeAlive = processTreeIsAlive();
      if (treeAlive !== false) {
        rejectOnce(
          markOwnedTemporaryRootForRetention(
            containmentError(
              `process tree did not terminate within ${CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS} ms`,
              terminationFailure,
            ),
          ),
        );
        return;
      }
      if (closeRecord === undefined) {
        rejectOnce(
          containmentError(
            `child did not settle within ${CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS} ms ` +
              "after process-tree termination",
            terminationFailure,
          ),
        );
        return;
      }
      settleAfterForcedTermination();
    }

    function settleAfterForcedTermination() {
      if (terminationFailure !== undefined) {
        rejectOnce(
          containmentError(
            "process-tree termination failed",
            terminationFailure,
          ),
        );
        return;
      }
      if (childFailure !== undefined) {
        rejectOnce(childFailure);
        return;
      }
      if (outputOverflow) {
        rejectOnce(new Error("child exceeded the bounded output ceiling"));
        return;
      }
      resolveOnce();
    }

    const appendOutput = (stream, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > validated.maxOutputBytes) {
        beginTermination("output_overflow");
        return stream;
      }
      return stream + chunk;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (child.pid === undefined) {
        rejectOnce(error);
        return;
      }
      beginTermination("child_error", error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      closeRecord = {
        elapsedMs: performance.now() - startedAt,
        exitCode,
        signal,
      };
      if (terminationStarted) {
        pollTerminationSettlement();
      } else {
        const treeAlive = processTreeIsAlive();
        if (treeAlive === false) {
          resolveOnce();
        } else {
          beginTermination("normal_exit");
        }
      }
    });
  });
}

function loadProductionContainment() {
  productionContainmentPromise ??=
    import("../../src/utils/supervisedProcess.ts");
  return productionContainmentPromise;
}

function outputContainsExactLine(output, expectedLine) {
  return output.split(/\r?\n/u).includes(expectedLine);
}

function validateOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new Error("bounded child options must be an object");
  }
  if (typeof options.command !== "string" || options.command.length === 0) {
    throw new Error("bounded child command must be non-empty");
  }
  if (
    !Array.isArray(options.args) ||
    options.args.length > MAX_SUPERVISOR_ARGUMENTS ||
    options.args.some(
      (argument) =>
        typeof argument !== "string" ||
        Buffer.byteLength(argument) > MAX_SUPERVISOR_ARGUMENT_BYTES,
    )
  ) {
    throw new Error("bounded child arguments exceed their named limits");
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new Error("bounded child cwd must be non-empty");
  }
  if (
    options.env === null ||
    typeof options.env !== "object" ||
    Array.isArray(options.env)
  ) {
    throw new Error("bounded child environment must be an object");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_SUPERVISOR_TIMEOUT_MS
  ) {
    throw new Error("bounded child timeout exceeds its named limit");
  }
  if (
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes <= 0 ||
    options.maxOutputBytes > MAX_SUPERVISOR_OUTPUT_BYTES
  ) {
    throw new Error("bounded child output ceiling exceeds its named limit");
  }
  if (
    options.expectedCompletionRecord !== undefined &&
    (typeof options.expectedCompletionRecord !== "string" ||
      options.expectedCompletionRecord.length === 0 ||
      /[\r\n]/u.test(options.expectedCompletionRecord) ||
      Buffer.byteLength(options.expectedCompletionRecord) >
        MAX_COMPLETION_RECORD_BYTES)
  ) {
    throw new Error("bounded child completion record is invalid");
  }
  if (options.processTreeController !== undefined) {
    const controller = options.processTreeController;
    if (
      controller === null ||
      typeof controller !== "object" ||
      typeof controller.terminate !== "function" ||
      typeof controller.isAlive !== "function"
    ) {
      throw new Error("bounded child process-tree controller is invalid");
    }
  }
  if (
    options.productionContainmentRunner !== undefined &&
    typeof options.productionContainmentRunner !== "function"
  ) {
    throw new Error("bounded child production containment runner is invalid");
  }
  if (
    options.processTreeController !== undefined &&
    options.productionContainmentRunner !== undefined
  ) {
    throw new Error("bounded child containment seams are mutually exclusive");
  }
  if (
    options.processTreeController !== undefined &&
    options.expectedCompletionRecord !== undefined
  ) {
    throw new Error(
      "bounded child completion records require production containment",
    );
  }
  return options;
}

function containmentError(message, cause) {
  if (cause === undefined) return new Error(message);
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${message}: ${causeMessage}`, { cause });
}
