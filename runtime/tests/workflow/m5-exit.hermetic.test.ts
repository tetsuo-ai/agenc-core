/**
 * M5 exit proof — hermetic crash/restart acceptance for the verified-change
 * workflow (runs in the default PR suite; no network, no real model).
 *
 * A child-process daemon-like harness (real SQLite durability, real
 * execution-admission kernel, real evidence ledger, real git worktree,
 * scripted model seams) is SIGKILLed at `after_spawn_before_effect_result`
 * with the implement child's terminal ALREADY durably recorded (A1) and the
 * parent effect_result NOT yet journaled. Any attached client dies with the
 * process — the "disconnect". A fresh process then resumes:
 *
 *   - the run reaches terminal `completed` by ADOPTING the durable child
 *     terminal (never respawning the implementer),
 *   - exactly ONE implementer child ever ran (physical receipts + durable
 *     rows), exactly one worktree existed,
 *   - the crashed step's budget reservation is held (never silently freed),
 *   - reattach-by-cursor works through the run inspection/replay path,
 *   - `run.result`/`run.evidence` serve the durable terminal + sealed
 *     bundle,
 *   - the exported patch applies cleanly to a FRESH clone of the fixture
 *     repo, and a HIDDEN verifier script — kept outside the worktree and
 *     never present in any prompt or spec — passes against the patched
 *     clone.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { resolveStateDatabasePaths } from "../../src/state/sqlite-driver.js";
import {
  assertBundleAndHiddenVerifier,
  assertExitReport,
  assertReviewExitReport,
  cleanupM5ExitStateDirs,
  crashPhase,
  makeStateDir,
  resumePhase,
} from "./fixtures/m5-exit-shared.js";
import { M5_EXIT_RUN_ID } from "./fixtures/m5-harness.js";

afterEach(() => {
  cleanupM5ExitStateDirs();
});

describe.sequential("M5 exit proof — hermetic SIGKILL crash/restart", () => {
  it(
    "completes after a kill at after_spawn_before_effect_result by adopting the durable child terminal",
    { timeout: 240_000 },
    async () => {
      const stateDir = makeStateDir("agenc-m5-exit-");
      await crashPhase("controller", stateDir);
      const report = await resumePhase("controller", stateDir);
      assertExitReport(report, M5_EXIT_RUN_ID);

      // "Disconnect": the SIGKILL dropped any attached client with the
      // process. After restart, run inspection serves the durable terminal
      // and the sealed bundle, and reattach-by-cursor pages the journal.
      const home = join(stateDir, "home");
      const repo = join(stateDir, "repo");
      const inspection = new AgenCDaemonRunInspectionService({
        stateDatabasePaths: () => [
          resolveStateDatabasePaths({ cwd: repo, agencHome: home }),
        ],
        agencHome: home,
      });

      const result = inspection.result({ runId: M5_EXIT_RUN_ID });
      expect(result.terminal).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({ available: true, exitCode: 0 });

      const evidence = inspection.evidence({ runId: M5_EXIT_RUN_ID });
      expect(evidence.bundle).toBeDefined();
      expect(evidence.bundle!.sealed).toBe(true);
      expect(evidence.bundle!.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(evidence.bundle!.artifacts.length).toBeGreaterThan(0);

      // The durable workflow projection is served through run.status too.
      const status = inspection.status({ runId: M5_EXIT_RUN_ID });
      expect(status.workflow).toBeDefined();
      expect(
        status.workflow!.steps.every((step) => step.status === "committed"),
      ).toBe(true);

      // Reattach-by-cursor: page, continue from the returned cursor with
      // no overlap, and observe a clean empty tail.
      const first = inspection.replay({
        runId: M5_EXIT_RUN_ID,
        afterSequence: 0,
        limit: 5,
      });
      expect(first.gap).toBeNull();
      expect(first.events.length).toBeGreaterThan(0);
      const seenKeys = new Set(
        first.events.map((event) => `${event.sequence}:${event.eventId}`),
      );
      let cursor = first.nextAfterSequence;
      let hasMore = first.hasMore;
      while (hasMore) {
        const page = inspection.replay({
          runId: M5_EXIT_RUN_ID,
          afterSequence: cursor,
          limit: 5,
        });
        expect(page.gap).toBeNull();
        for (const event of page.events) {
          expect(event.sequence).toBeGreaterThan(cursor);
          const key = `${event.sequence}:${event.eventId}`;
          expect(seenKeys.has(key)).toBe(false);
          seenKeys.add(key);
        }
        cursor = page.nextAfterSequence;
        hasMore = page.hasMore;
      }
      const tail = inspection.replay({
        runId: M5_EXIT_RUN_ID,
        afterSequence: cursor,
        limit: 5,
      });
      expect(tail.events).toEqual([]);
      expect(tail.gap).toBeNull();

      await assertBundleAndHiddenVerifier(stateDir, report.bundleDir);
    },
  );

  it(
    "completes after a kill at before_review_commit by adopting the reviewer's durable terminal",
    { timeout: 240_000 },
    async () => {
      // The kill lands AFTER the reviewer settled and its terminal was
      // durably recorded, BEFORE the review effect_result committed. The
      // restart must complete the run by ADOPTION — never re-invoking the
      // reviewer — and the sealed bundle must still verify end to end.
      const stateDir = makeStateDir("agenc-m5-exit-review-");
      await crashPhase("controller", stateDir, "review");
      const report = await resumePhase("controller", stateDir, "review");
      assertReviewExitReport(report, M5_EXIT_RUN_ID);
      await assertBundleAndHiddenVerifier(stateDir, report.bundleDir);
    },
  );
});
