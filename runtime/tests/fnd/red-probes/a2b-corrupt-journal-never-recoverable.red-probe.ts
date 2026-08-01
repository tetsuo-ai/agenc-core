import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertAgentRun } from "../../../src/state/agent-runs.js";
import { recoverDaemonStateOnStartup } from "../../../src/state/recovery.js";
import { StateRunDurabilityRepository } from "../../../src/state/run-durability.js";
import { openStateDatabases } from "../../../src/state/sqlite-driver.js";
import { openFndFixtureCatalog } from "../../helpers/fnd-fixtures.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "a2b-corrupt-journal-never-recoverable",
    task: "A2b",
    fingerprint: "A2B:RECOVERY:CORRUPT-JOURNAL-NONEXECUTABLE",
  });
  const runId = "malformed-interior-v1";
  const catalog = await openFndFixtureCatalog();
  const raw = await catalog.text("journal.malformed-interior.v1");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agenc-a2b-red-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
  let driver: ReturnType<typeof openStateDatabases> | undefined;
  let recoveredCorruptRun = false;

  try {
    driver = openStateDatabases({
      cwd: repositoryRoot,
      agencHome: join(temporaryRoot, "state"),
    });
    upsertAgentRun(driver, {
      id: runId,
      objective: "corrupt canonical journal must remain non-executable",
      status: "running",
      startedAt: "2026-07-31T00:00:00.000Z",
      lastActiveAt: "2026-07-31T00:01:00.000Z",
      currentSessionId: runId,
    });
    const sessionDirectory = join(driver.projectDir, "sessions", runId);
    mkdirSync(sessionDirectory, { recursive: true });
    const rolloutPath = join(
      sessionDirectory,
      `rollout-2026-07-31T00-00-00-000Z-${runId}.jsonl`,
    );
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const durability = new StateRunDurabilityRepository(driver);
    durability.ensureInitialEpoch({
      runId,
      openedAt: "2026-07-31T00:00:00.000Z",
    });
    durability.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: rolloutPath,
      boundAt: "2026-07-31T00:00:00.000Z",
    });

    const report = recoverDaemonStateOnStartup(driver);
    recoveredCorruptRun = report.recoveredRuns.some((run) => run.id === runId);
  } finally {
    driver?.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  expectDeepStrictEqualRedProbe(probeIdentity, recoveredCorruptRun, false);
}
