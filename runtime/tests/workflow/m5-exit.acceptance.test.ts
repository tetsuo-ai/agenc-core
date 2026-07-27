/**
 * M5 exit proof — hermetic daemon-wiring acceptance lane.
 *
 * Runs in the default suite. It uses the same SIGKILL-at-
 * `after_spawn_before_effect_result` crash/restart flow as the controller
 * lane, but is assembled through the REAL daemon wiring
 * (`createDaemonWorkflowController`: per-run durability resolution,
 * multi-project resume sweep, real daemon evidence-ledger factory) —
 * model seams stay scripted by default; a real-model mode is a deliberate
 * non-goal for the default suite. Finishes with the B2 evidence-only
 * reconstruction over the exported bundle.
 */

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME } from "../../src/workflow/local-anchor.js";
import {
  assertBundleAndHiddenVerifier,
  assertExitReport,
  cleanupM5ExitStateDirs,
  crashPhase,
  makeStateDir,
  resumePhase,
} from "./fixtures/m5-exit-shared.js";
import { M5_EXIT_RUN_ID } from "./fixtures/m5-harness.js";

afterEach(() => {
  cleanupM5ExitStateDirs();
});

describe.sequential(
  "M5 exit proof — daemon-wiring acceptance lane",
  () => {
    it(
      "crash/restart through the real daemon wiring completes by adoption and reconstructs from evidence alone",
      { timeout: 300_000 },
      async () => {
        const stateDir = makeStateDir("agenc-m5-exit-acceptance-");
        await crashPhase("wiring", stateDir);
        const report = await resumePhase("wiring", stateDir);
        assertExitReport(report, M5_EXIT_RUN_ID);
        // B1-style bundle checks (patch onto a fresh clone + hidden
        // verifier) — includes the B2 reconstruction of the live bundle.
        await assertBundleAndHiddenVerifier(stateDir, report.bundleDir);
        // And the B2 reconstruction again over a SELF-CONTAINED copy of
        // the exported bundle (anchor material embedded).
        const exported = join(stateDir, "exported-bundle");
        mkdirSync(exported, { recursive: true, mode: 0o700 });
        const { cpSync, chmodSync } = await import("node:fs");
        cpSync(report.bundleDir, exported, { recursive: true });
        copyFileSync(
          join(
            join(stateDir, "home", "run-evidence"),
            WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME,
          ),
          join(exported, WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME),
        );
        const restrict = (root: string): void => {
          chmodSync(root, 0o700);
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            const target = join(root, entry.name);
            if (entry.isDirectory()) restrict(target);
            else chmodSync(target, 0o600);
          }
        };
        restrict(exported);
        const { reconstructVerifiedChange } = await import(
          "../../src/workflow/evidence-reconstruction.js"
        );
        const reconstruction = await reconstructVerifiedChange(exported);
        if (reconstruction.terminal.status !== "completed") {
          throw new Error(
            `acceptance reconstruction expected completed, got ${reconstruction.terminal.status}`,
          );
        }
      },
    );
  },
);
