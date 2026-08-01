import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeRolloutItem } from "../../../src/session/rollout-item.js";
import { backfillRolloutFile } from "../../../src/state/backfill.js";
import { openStateDatabases } from "../../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../../src/state/threads.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "e1a-recovery-line-byte-limit",
    task: "E1a",
    fingerprint: "E1A:RECOVERY:LINE-BYTE-LIMIT",
  });
  const maximumRecoveryLineBytes = 4_194_304;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agenc-e1a-red-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
  let driver: ReturnType<typeof openStateDatabases> | undefined;
  let observed: Readonly<{ kind: string; itemsIndexed: number }> =
    Object.freeze({ kind: "accepted", itemsIndexed: -1 });

  try {
    driver = openStateDatabases({
      cwd: repositoryRoot,
      agencHome: join(temporaryRoot, "state"),
    });
    const sessionDirectory = join(driver.projectDir, "sessions", "e1a");
    mkdirSync(sessionDirectory, { recursive: true });
    const rolloutPath = join(
      sessionDirectory,
      "rollout-2026-07-31T00-00-00-000Z-e1a.jsonl",
    );
    writeFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "response_item",
        payload: {
          role: "user",
          content: "x".repeat(maximumRecoveryLineBytes),
        },
      }),
      { mode: 0o600 },
    );
    const threads = new StateThreadRepository(driver);
    let kind = "accepted";
    try {
      backfillRolloutFile({ rolloutPath, threads });
    } catch (error: unknown) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("reasonCode" in error) ||
        error.reasonCode !== "line_limit"
      ) {
        throw error;
      }
      kind = "line_limit";
    }
    const itemsIndexed =
      driver
        .prepareState<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM thread_rollout_items",
        )
        .get()?.count ?? -1;
    observed = Object.freeze({ kind, itemsIndexed });
  } finally {
    driver?.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    observed,
    Object.freeze({ kind: "line_limit", itemsIndexed: 0 }),
  );
}
