/**
 * Shared driver for the M5 exit proofs: fixture-repo seeding, the
 * crash/resume child-process phases, and the common assertion blocks.
 * Used by the hermetic lane (default PR suite) and the env-gated
 * acceptance lane.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import {
  readBundleArtifact,
  reconstructVerifiedChange,
} from "../../../src/workflow/evidence-reconstruction.js";
import { M5_EXIT_RUN_ID } from "./m5-harness.js";

const FIXTURE = fileURLToPath(new URL("./m5-exit-child.ts", import.meta.url));
const NODE_TEST_LOADER = fileURLToPath(
  new URL("../../durability/fixtures/node-test-loader.mjs", import.meta.url),
);
const TSX_IMPORT = fileURLToPath(import.meta.resolve("tsx"));

export const M5_EXIT_FAILPOINT = "after_spawn_before_effect_result";

const HIDDEN_VERIFIER = `#!/usr/bin/env bash
# HIDDEN verifier: never present in the fixture repo, any prompt, or the
# spec. Proves the exported patch is the real fix, not output shaped to the
# visible test.
set -euo pipefail
cd "$1"
node -e "
const { add } = require('./lib/add.js');
if (add(2, 3) !== 5) process.exit(1);
if (add(-7, 7) !== 0) process.exit(1);
if (add(1000, 234) !== 1234) process.exit(1);
"
`;

export type M5ExitMode = "controller" | "wiring";

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface M5ExitReport {
  readonly mode: string;
  readonly preResume: {
    readonly implementOutcome: string | null;
    readonly implementChildTerminal: string | null;
    readonly terminal: string | null;
  };
  readonly resumed: readonly string[];
  readonly terminal: {
    readonly status: string;
    readonly stopReason: string | null;
    readonly finalMessage: string | null;
  } | null;
  readonly effects: readonly {
    readonly stepId: string;
    readonly outcome: string | null;
    readonly childRunId: string | null;
  }[];
  readonly implementReceipts: readonly unknown[];
  readonly worktreeProvisions: readonly {
    readonly path: string;
    readonly created: boolean;
  }[];
  readonly implementChildTerminals: {
    readonly attempt1: string | null;
    readonly attempt2: string | null;
  };
  readonly resumeSpawnKinds: readonly string[];
  readonly reservations: readonly {
    readonly id: string;
    readonly status: string;
  }[];
  readonly warnings: readonly string[];
  readonly bundleDir: string;
}

const directories: string[] = [];

/** Remove every state dir minted since the last cleanup (afterEach hook). */
export function cleanupM5ExitStateDirs(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENC_TEST_DURABILITY_FAILPOINT;
  delete env.AGENC_TEST_DURABILITY_FAILPOINT_TOKEN;
  delete env.AGENC_TEST_DURABILITY_FAILPOINT_ACTION;
  delete env.AGENC_TEST_DURABILITY_FAILPOINT_MARKER;
  return env;
}

function collectChild(child: ChildProcess): Promise<ChildExit> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function seedFixtureRepo(repo: string): string {
  mkdirSync(join(repo, "lib"), { recursive: true });
  git(repo, "init");
  git(repo, "config", "user.email", "m5-exit@example.com");
  git(repo, "config", "user.name", "M5 Exit");
  // The seeded bug: subtraction instead of addition.
  writeFileSync(
    join(repo, "lib", "add.js"),
    "module.exports.add = (a, b) => a - b;\n",
  );
  // The REAL runnable required-verification script.
  writeFileSync(
    join(repo, "test.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'node -e "const { add } = require(\'./lib/add.js\'); process.exit(add(2, 3) === 5 ? 0 : 1)"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed: broken add + runnable test");
  return git(repo, "rev-parse", "HEAD").trim();
}

export function makeStateDir(prefix: string): string {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(stateDir);
  // The evidence ledger enforces a private directory chain; a group-writable
  // umask (e.g. 007) must not leak into the daemon home.
  mkdirSync(join(stateDir, "home"), { recursive: true, mode: 0o700 });
  const repo = join(stateDir, "repo");
  mkdirSync(repo, { recursive: true });
  seedFixtureRepo(repo);
  // The hidden verifier lives OUTSIDE the repo/worktree and never enters
  // any prompt or spec.
  writeFileSync(join(stateDir, "hidden-verifier.sh"), HIDDEN_VERIFIER, {
    mode: 0o755,
  });
  return stateDir;
}

function spawnFixture(
  command: "crash" | "resume",
  mode: M5ExitMode,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--loader",
      NODE_TEST_LOADER,
      "--import",
      TSX_IMPORT,
      FIXTURE,
      command,
      mode,
      stateDir,
    ],
    { cwd: stateDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

export async function crashPhase(
  mode: M5ExitMode,
  stateDir: string,
): Promise<void> {
  const marker = join(stateDir, "failpoint-reached.json");
  const env = cleanChildEnvironment();
  // Only the marker path is armed from outside; the child arms the
  // failpoint NAME itself, strictly after the implement child's terminal is
  // durable — that engineered ordering IS the exit-criterion window.
  env.AGENC_TEST_DURABILITY_FAILPOINT_MARKER = marker;
  const child = spawnFixture("crash", mode, stateDir, env);
  const exitPromise = collectChild(child);
  const deadline = Date.now() + 120_000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      const result = await exitPromise;
      throw new Error(
        `timed out waiting for the M5 failpoint marker\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = await exitPromise;
  expect(
    result,
    `crash child output:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  ).toMatchObject({ code: null, signal: "SIGKILL" });
  expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
    failpoint: M5_EXIT_FAILPOINT,
  });
}

export async function resumePhase(
  mode: M5ExitMode,
  stateDir: string,
): Promise<M5ExitReport> {
  const child = spawnFixture("resume", mode, stateDir, cleanChildEnvironment());
  const result = await collectChild(child);
  expect(
    result,
    `resume child output:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  ).toMatchObject({ code: 0, signal: null });
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines.at(-1)!) as M5ExitReport;
}

export function assertExitReport(report: M5ExitReport, runId: string): void {
  // The engineered kill window: child terminal durable, parent result not.
  expect(report.preResume).toEqual({
    implementOutcome: null,
    implementChildTerminal: "completed",
    terminal: null,
  });
  expect(report.resumed).toContain(runId);
  // Terminal `completed` after restart + resume.
  expect(report.terminal?.status).toBe("completed");
  expect(report.terminal?.finalMessage).toContain("verified change completed");
  // Exactly ONE implementer child ever ran: one physical receipt, one
  // durable child-terminal row, one durable implement effect, and NO
  // implement respawn during resume (adoption, never respawn).
  expect(report.implementReceipts).toHaveLength(1);
  expect(report.implementChildTerminals).toEqual({
    attempt1: "completed",
    attempt2: null,
  });
  expect(
    report.effects.filter((effect) =>
      effect.stepId.startsWith("workflow.implement"),
    ),
  ).toEqual([
    {
      stepId: "workflow.implement",
      outcome: "committed",
      childRunId: `${runId}:implement#1`,
    },
  ]);
  expect(report.resumeSpawnKinds).not.toContain("implement");
  expect(report.resumeSpawnKinds).toContain("verify_agent");
  // Exactly one worktree ever existed: every provision resolved the same
  // path and only the first created it.
  const paths = new Set(report.worktreeProvisions.map((entry) => entry.path));
  expect(paths.size).toBe(1);
  expect(
    report.worktreeProvisions.filter((entry) => entry.created),
  ).toHaveLength(1);
  // Budget: every reservation reconciled-or-held; the reservation the kill
  // orphaned mid-dispatch is HELD, never silently freed.
  expect(report.reservations.length).toBeGreaterThan(0);
  for (const reservation of report.reservations) {
    expect(["reconciled", "held_unknown", "voided"]).toContain(
      reservation.status,
    );
  }
  expect(
    report.reservations.filter(
      (reservation) => reservation.status === "held_unknown",
    ).length,
  ).toBeGreaterThanOrEqual(1);
}

export async function assertBundleAndHiddenVerifier(
  stateDir: string,
  bundleDir: string,
): Promise<void> {
  const repo = join(stateDir, "repo");
  // Evidence-only reconstruction of the exported bundle.
  const reconstruction = await reconstructVerifiedChange(bundleDir);
  expect(reconstruction.runId).toBe(M5_EXIT_RUN_ID);
  expect(reconstruction.terminal.status).toBe("completed");
  expect(reconstruction.reviewBlockers).toEqual([]);
  expect(reconstruction.verificationCommands).toHaveLength(1);
  expect(reconstruction.verificationCommands[0]).toMatchObject({
    label: "unit",
    exitCode: 0,
    timedOut: false,
  });
  // The hidden verifier is invisible to the recorded spec and prompts.
  const recordText = readFileSync(
    join(bundleDir, "verified-change-record.json"),
    "utf8",
  );
  expect(recordText).not.toContain("hidden-verifier");
  // The exported patch applies cleanly to a FRESH clone at the recorded
  // base commit, and the hidden verifier passes against the patched clone.
  const patchArtifact = reconstruction.artifacts.find(
    (artifact) => artifact.role === "patch",
  );
  expect(patchArtifact).toBeDefined();
  const patchBytes = await readBundleArtifact(bundleDir, patchArtifact!.digest);
  const cloneDir = join(stateDir, "fresh-clone");
  execFileSync("git", ["clone", repo, cloneDir], { encoding: "utf8" });
  git(cloneDir, "checkout", "--detach", reconstruction.baseCommit);
  const patchFile = join(stateDir, "exported.patch");
  writeFileSync(patchFile, patchBytes);
  git(cloneDir, "apply", patchFile);
  execFileSync("bash", [join(stateDir, "hidden-verifier.sh"), cloneDir], {
    encoding: "utf8",
  });
}
