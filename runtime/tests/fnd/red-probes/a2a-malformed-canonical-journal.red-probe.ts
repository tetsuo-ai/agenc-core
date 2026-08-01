import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backfillPinnedRolloutContent } from "../../../src/state/backfill.js";
import { openStateDatabases } from "../../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../../src/state/threads.js";
import { openFndFixtureCatalog } from "../../helpers/fnd-fixtures.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "a2a-malformed-canonical-journal",
    task: "A2a",
    fingerprint: "A2A:RECOVERY:MALFORMED-CANONICAL-JOURNAL",
  });
  const catalog = await openFndFixtureCatalog();
  const raw = await catalog.text("journal.malformed-interior.v1");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agenc-a2a-red-"));
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
    const threads = new StateThreadRepository(driver);
    const rolloutPath = join(
      driver.projectDir,
      "rollout-2026-07-31T00-00-00-000Z-a2a.jsonl",
    );
    let kind = "accepted";
    try {
      backfillPinnedRolloutContent({
        rolloutPath,
        raw,
        threads,
        mtimeMs: 0,
        validateCanonical: () => {},
      });
    } catch (error: unknown) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("reasonCode" in error) ||
        error.reasonCode !== "malformed_json"
      ) {
        throw error;
      }
      kind = "malformed_json";
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
    Object.freeze({ kind: "malformed_json", itemsIndexed: 0 }),
  );
}
