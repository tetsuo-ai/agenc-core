/**
 * Child process for the M5 exit proofs (hermetic + acceptance lanes).
 *
 * `crash <mode> <stateDir>`:
 *   Runs the verified-change pipeline against the fixture repository. The
 *   scripted implement child applies the real fix in the worktree and its
 *   terminal is durably recorded (A1); IMMEDIATELY after that durable
 *   record — and before the parent effect_result can commit — the harness
 *   arms the `after_spawn_before_effect_result` failpoint, which fsyncs the
 *   marker file and SIGKILLs this process. The kill window therefore
 *   objectively contains a durable child terminal and NO parent result.
 *
 * `resume <mode> <stateDir>`:
 *   Fresh process over the same on-disk state: runs admission recovery
 *   (daemon-startup mirror), `resumeOpenWorkflows()`, awaits the run, and
 *   prints a single-line JSON report for the parent test.
 *
 * `<mode>` is `controller` (bare controller assembly) or `wiring` (through
 * `createDaemonWorkflowController`, the acceptance lane).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildM5Harness, M5_EXIT_RUN_ID } from "./m5-harness.js";

const FAILPOINT = "after_spawn_before_effect_result";
const FAILPOINT_TOKEN = "m5-workflow-child";

type Command = "crash" | "resume";
type Mode = "controller" | "wiring";

function requireArgument(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const command = requireArgument(process.argv[2], "command") as Command;
const mode = requireArgument(process.argv[3], "mode") as Mode;
const stateDir = requireArgument(process.argv[4], "state directory");

const home = join(stateDir, "home");
const repoPath = join(stateDir, "repo");
const receiptsDir = join(stateDir, "receipts");
mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.AGENC_HOME = home;

const IMPLEMENT_FIX = {
  file: "lib/add.js",
  contents: "module.exports.add = (a, b) => a + b;\n",
} as const;

function buildHarness(withCrashArming: boolean) {
  return buildM5Harness({
    home,
    repoPath,
    receiptsDir,
    implementFix: IMPLEMENT_FIX,
    throughDaemonWiring: mode === "wiring",
    ...(withCrashArming
      ? {
          onImplementSettled: () => {
            // Arm the production failpoint ONLY now: the child terminal is
            // already durable, the parent effect_result is not yet
            // journaled. hitM5WorkflowFailpoint reads process.env at call
            // time, fsyncs the marker, and SIGKILLs the process.
            process.env.AGENC_TEST_DURABILITY_FAILPOINT = FAILPOINT;
            process.env.AGENC_TEST_DURABILITY_FAILPOINT_TOKEN = FAILPOINT_TOKEN;
          },
        }
      : {}),
  });
}

async function crash(): Promise<never> {
  const harness = buildHarness(true);
  const started = await harness.controller.start({
    goal: "lib/add.js returns the wrong value: add(2, 3) must equal 5. Fix the arithmetic bug so the required script passes.",
    repoPath,
    reviewerModel: "scripted-reviewer",
    permissionMode: "acceptEdits",
    requiredVerification: [{ label: "unit", script: "bash test.sh" }],
    maxImplementAttempts: 2,
    runId: M5_EXIT_RUN_ID,
  });
  await harness.controller.awaitRun(started.runId);
  throw new Error("the M5 exit failpoint did not terminate the crash child");
}

async function resume(): Promise<void> {
  // Daemon-startup mirror: admission recovery BEFORE workflow resume, so a
  // reservation left `dispatched` by the kill is held (never silently
  // freed).
  const { openStateDatabases } = await import(
    "../../../src/state/sqlite-driver.js"
  );
  const { ExecutionAdmissionRepository } = await import(
    "../../../src/state/execution-admission.js"
  );
  {
    const driver = openStateDatabases({ cwd: repoPath, agencHome: home });
    try {
      const admission = new ExecutionAdmissionRepository(driver, {
        ownerId: "m5-exit-recovery",
        ownerPid: process.pid,
      });
      admission.recover({ activeOwnerIds: new Set() });
    } finally {
      driver.close();
    }
  }

  const harness = buildHarness(false);
  const preResume = {
    implementOutcome:
      harness.repo.getEffect(M5_EXIT_RUN_ID, "workflow.implement")?.outcome ??
      null,
    implementChildTerminal:
      harness.repo.getCurrentTerminalResult(`${M5_EXIT_RUN_ID}:implement#1`)
        ?.status ?? null,
    terminal:
      harness.repo.getCurrentTerminalResult(M5_EXIT_RUN_ID)?.status ?? null,
  };

  const resumed = await harness.resumeOpenWorkflows();
  await harness.controller.awaitRun(M5_EXIT_RUN_ID);

  const effects = harness.repo.listEffects(M5_EXIT_RUN_ID).map((effect) => ({
    stepId: effect.stepId,
    outcome: effect.outcome ?? null,
    childRunId: effect.childRunId ?? null,
  }));
  const terminal = harness.repo.getCurrentTerminalResult(M5_EXIT_RUN_ID);

  const readReceipts = (name: string): unknown[] => {
    const path = join(receiptsDir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  };

  // Reservation states via a fresh repository view.
  const driver = openStateDatabases({ cwd: repoPath, agencHome: home });
  let reservations: { readonly id: string; readonly status: string }[];
  try {
    const admission = new ExecutionAdmissionRepository(driver, {
      ownerId: "m5-exit-report",
      ownerPid: process.pid,
    });
    reservations = admission
      .listReservations({ runId: M5_EXIT_RUN_ID, limit: 50 })
      .map((reservation) => ({
        id: reservation.reservationId,
        status: reservation.status,
      }));
  } finally {
    driver.close();
  }

  const report = {
    mode,
    preResume,
    resumed,
    terminal:
      terminal === undefined
        ? null
        : {
            status: terminal.status,
            stopReason: terminal.stopReason,
            finalMessage: terminal.finalMessage,
          },
    effects,
    implementReceipts: readReceipts("implement-attempts.jsonl"),
    worktreeProvisions: readReceipts("worktree-provisions.jsonl"),
    implementChildTerminals: {
      attempt1:
        harness.repo.getCurrentTerminalResult(`${M5_EXIT_RUN_ID}:implement#1`)
          ?.status ?? null,
      attempt2:
        harness.repo.getCurrentTerminalResult(`${M5_EXIT_RUN_ID}:implement#2`)
          ?.status ?? null,
    },
    resumeSpawnKinds: harness.spawnKinds,
    reservations,
    warnings: harness.warnings,
    bundleDir: join(home, "run-evidence", M5_EXIT_RUN_ID),
  };
  harness.close();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (command === "crash") {
  await crash();
} else if (command === "resume") {
  await resume();
} else {
  throw new Error(`unsupported command: ${String(command)}`);
}
