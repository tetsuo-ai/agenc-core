import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/bin/agenc-main.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { StateRecoveryIncidentRepository } from "../../src/state/recovery-incidents.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

const temporaryDirectories: string[] = [];
const originalArgv = process.argv.slice();
const originalCwd = process.cwd();
const originalAgenCHome = process.env.AGENC_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv.slice();
  process.chdir(originalCwd);
  if (originalAgenCHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgenCHome;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agenc main recovery operator bridge", () => {
  it("installs the strict mutation adapter for a normal quarantine rescan", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-main-recovery-operator-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "repository");
    const agencHome = join(root, "state");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const driver = openStateDatabases({ cwd, agencHome });
    const runId = "operator-recovery-run";
    const sessionDirectory = join(
      driver.projectDir,
      "sessions",
      "operator-recovery-session",
    );
    mkdirSync(sessionDirectory, { recursive: true });
    const sourcePath = join(sessionDirectory, "rollout-operator.jsonl");
    const corrupt = "{not-json}\n";
    writeFileSync(sourcePath, corrupt, { mode: 0o600 });
    const incident = new StateRecoveryIncidentRepository(
      driver,
    ).recordQuarantine({
      runId,
      sourceKind: "run_journal",
      sourcePath,
      reasonCode: "malformed_json",
      safeDetail: { message: "invalid JSON" },
      sourceSizeBytes: Buffer.byteLength(corrupt),
      sourceMtimeMs: 1,
      sourceSha256: digest(corrupt),
      detectedAtMs: 1,
    });
    const repaired = serializeRolloutItem({
      type: "event_msg",
      payload: {
        eventId: "operator-recovery-event",
        id: "operator-recovery-event",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "fixture", message: "repaired" },
        },
      },
    });
    writeFileSync(sourcePath, repaired, { mode: 0o600 });
    driver.close();

    process.chdir(cwd);
    process.env.AGENC_HOME = agencHome;
    process.argv = [
      process.execPath,
      "agenc",
      "state",
      "recovery",
      "quarantine",
      "rescan",
      incident.quarantineId,
      "--confirm-source-sha256",
      digest(repaired),
    ];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(main()).resolves.toBe(0);

    const verified = openStateDatabases({ cwd, agencHome });
    expect(
      new StateRecoveryIncidentRepository(verified).getQuarantine(
        incident.quarantineId,
      ),
    ).toMatchObject({ state: "repaired" });
    expect(
      verified
        .prepareState<[string], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM thread_rollout_items WHERE source_path = ?",
        )
        .get(sourcePath)?.count,
    ).toBe(1);
    verified.close();
  });
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
