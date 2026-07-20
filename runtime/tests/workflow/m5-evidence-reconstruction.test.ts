/**
 * M5 exit proof — evidence-only reconstruction.
 *
 * Runs a complete verified-change workflow through the scripted harness
 * (real ledger, real git, real admission), copies the exported bundle
 * directory elsewhere, and reconstructs the run from those bytes alone —
 * no daemon, no SQLite, no rollout files. The reconstruction must agree
 * with what the run reported, and a single tampered CAS byte must make it
 * fail loudly.
 */

import {
  chmodSync,
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceReconstructionError,
  readBundleArtifact,
  reconstructVerifiedChange,
} from "../../src/workflow/evidence-reconstruction.js";
import { WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME } from "../../src/workflow/local-anchor.js";
import { buildM5Harness, type M5Harness } from "./fixtures/m5-harness.js";
import { seedFixtureRepo } from "./fixtures/m5-exit-shared.js";

const RUN_ID = "wf-m5-reconstruct";

let stateDir: string;
let harness: M5Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
  rmSync(stateDir, { recursive: true, force: true });
});

async function runCompletedWorkflow(): Promise<{
  readonly home: string;
  readonly bundleDir: string;
}> {
  stateDir = mkdtempSync(join(tmpdir(), "agenc-m5-reconstruct-"));
  const home = join(stateDir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const repo = join(stateDir, "repo");
  mkdirSync(repo, { recursive: true });
  seedFixtureRepo(repo);
  harness = buildM5Harness({
    home,
    repoPath: repo,
    receiptsDir: join(stateDir, "receipts"),
    implementFix: {
      file: "lib/add.js",
      contents: "module.exports.add = (a, b) => a + b;\n",
    },
  });
  const started = await harness.controller.start({
    goal: "Fix the arithmetic bug in lib/add.js so the required script passes.",
    repoPath: repo,
    reviewerModel: "scripted-reviewer",
    requiredVerification: [{ label: "unit", script: "bash test.sh" }],
    maxImplementAttempts: 2,
    runId: RUN_ID,
  });
  await harness.controller.awaitRun(started.runId);
  expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
    status: "completed",
  });
  return { home, bundleDir: join(home, "run-evidence", RUN_ID) };
}

/** Self-contained export: the bundle dir plus its anchor material. */
function exportBundle(home: string, bundleDir: string): string {
  const exported = join(stateDir, "exported-bundle");
  mkdirSync(exported, { recursive: true, mode: 0o700 });
  cpSync(bundleDir, exported, { recursive: true });
  copyFileSync(
    join(home, "run-evidence", WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME),
    join(exported, WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME),
  );
  // cpSync creates directories under the ambient umask; the ledger's
  // private-chain checks demand 0700/0600 exactly like the live export.
  restrictModes(exported);
  return exported;
}

function restrictModes(root: string): void {
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) {
      restrictModes(target);
    } else {
      chmodSync(target, 0o600);
    }
  }
}

describe("M5 evidence-only reconstruction", () => {
  it("reconstructs a completed run from the exported bundle bytes alone", async () => {
    const { home, bundleDir } = await runCompletedWorkflow();
    const terminal = harness!.repo.getCurrentTerminalResult(RUN_ID)!;
    const record = JSON.parse(
      readFileSync(join(bundleDir, "verified-change-record.json"), "utf8"),
    ) as { documentDigest: string; specDigest: string; baseCommit: string };

    const exported = exportBundle(home, bundleDir);
    const reconstruction = await reconstructVerifiedChange(exported);

    // The summary matches what the run reported.
    expect(reconstruction.runId).toBe(RUN_ID);
    expect(reconstruction.specDigest).toBe(record.specDigest);
    expect(reconstruction.baseCommit).toBe(record.baseCommit);
    expect(reconstruction.terminal.status).toBe("completed");
    expect(reconstruction.terminal.stopReason).toBeNull();
    expect(terminal.finalMessage).toContain(
      reconstruction.ledger.sealDigest,
    );
    expect(terminal.finalMessage).toContain(record.documentDigest);
    expect(reconstruction.verificationCommands).toEqual([
      expect.objectContaining({
        label: "unit",
        script: "bash test.sh",
        exitCode: 0,
        timedOut: false,
      }),
    ]);
    expect(reconstruction.review).toMatchObject({
      reviewerModel: "scripted-reviewer",
      overallCorrectness: "correct",
      blockerCount: 0,
    });
    expect(reconstruction.reviewBlockers).toEqual([]);
    expect(reconstruction.unresolvedRisks).toEqual([]);
    const roles = new Set(
      reconstruction.artifacts.map((artifact) => artifact.role),
    );
    for (const required of [
      "patch",
      "changed_files",
      "test_result",
      "independent_review",
    ]) {
      expect(roles.has(required as never)).toBe(true);
    }
    // The reconstructed patch bytes carry the real fix.
    const patch = reconstruction.artifacts.find(
      (artifact) => artifact.role === "patch",
    )!;
    const patchText = new TextDecoder().decode(
      await readBundleArtifact(exported, patch.digest),
    );
    expect(patchText).toContain("a + b");
  });

  it("fails loudly when one CAS byte is tampered", async () => {
    const { home, bundleDir } = await runCompletedWorkflow();
    const exported = exportBundle(home, bundleDir);
    const clean = await reconstructVerifiedChange(exported);
    const patch = clean.artifacts.find(
      (artifact) => artifact.role === "patch",
    )!;
    // Locate and tamper the patch payload file: flip exactly one byte.
    const hex = patch.digest.slice("sha256:".length);
    const payloadDir = readdirSync(exported).find((entry) =>
      entry.endsWith(".payloads"),
    )!;
    const payloadPath = join(exported, payloadDir, `sha256-${hex}.bin`);
    const bytes = readFileSync(payloadPath);
    bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
    writeFileSync(payloadPath, bytes);

    // The eval-contract ledger inspection verifies payload bytes against
    // the chained payload digests, so a flipped CAS byte already fails the
    // hash-chain verification; the reconstruction's own digest recompute is
    // defense-in-depth behind it. Either way: loud, typed failure.
    const failure = await reconstructVerifiedChange(exported).then(
      () => {
        throw new Error("tampered bundle must not reconstruct");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EvidenceReconstructionError);
    expect([
      "ledger_verification_failed",
      "artifact_digest_mismatch",
    ]).toContain((failure as EvidenceReconstructionError).failure);
  });

  it("refuses a bundle whose anchor material is absent", async () => {
    const { home, bundleDir } = await runCompletedWorkflow();
    const exported = exportBundle(home, bundleDir);
    rmSync(join(exported, WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME));
    await expect(reconstructVerifiedChange(exported)).rejects.toMatchObject({
      failure: "anchor_material_missing",
    });
  });
});
