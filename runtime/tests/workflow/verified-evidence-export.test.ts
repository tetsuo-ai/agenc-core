import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgenCDaemonRunInspectionService,
  MAX_RUN_REPLAY_LIMIT,
} from "../../src/app-server/run-inspection.js";
import type {
  RunExportVerifiedParams,
  RunExportVerifiedResult as WireExportResult,
} from "../../src/app-server/protocol/index.js";
import {
  openStateDatabasePaths,
  resolveStateDatabasePaths,
} from "../../src/state/sqlite-driver.js";
import {
  canonicalizeJson,
  computeDocumentDigest,
} from "../../src/eval-contract/canonical-json.js";
import {
  exportVerifiedRunFromBundle,
  VerifiedEvidenceExportError,
  VERIFIED_EVIDENCE_EXPORT_MANIFEST_FILENAME,
} from "../../src/workflow/verified-evidence-export.js";
import {
  AgencClient,
  AgencMalformedResponseError,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencTransport,
} from "../../../packages/agenc-sdk/src/index.js";
import { createDaemonWorkflowEvidenceLedgerFactory } from "../../src/app-server/workflow/daemon-wiring.js";
import type { WorkflowSpec } from "../../src/contracts/run-contracts.js";
import type { VerifiedChangeRecord } from "../../src/workflow/evidence-record.js";
import { buildM5Harness, type M5Harness } from "./fixtures/m5-harness.js";
import { seedFixtureRepo } from "./fixtures/m5-exit-shared.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function completedRun(runId: string): Promise<{
  readonly root: string;
  readonly home: string;
  readonly repo: string;
  readonly bundleDir: string;
  readonly harness: M5Harness;
  readonly specDigest: `sha256:${string}`;
  readonly recordDigest: `sha256:${string}`;
  readonly exportRootDigest: `sha256:${string}`;
}> {
  const root = mkdtempSync(join(tmpdir(), "agenc-verified-export-"));
  roots.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(repo, { recursive: true });
  seedFixtureRepo(repo);
  const harness = buildM5Harness({
    home,
    repoPath: repo,
    receiptsDir: join(root, "receipts"),
    implementFix: {
      file: "lib/add.js",
      contents: "module.exports.add = (a, b) => a + b;\n",
    },
  });
  const started = await harness.controller.start({
    goal: "Fix the arithmetic bug.",
    repoPath: repo,
    reviewerModel: "scripted-reviewer",
    requiredVerification: [
      { id: "unit", label: "unit", script: "bash test.sh" },
    ],
    runId,
  });
  await harness.controller.awaitRun(runId);
  expect(harness.repo.getCurrentTerminalResult(runId)).toMatchObject({
    status: "completed",
  });
  const bundleDir = join(home, "run-evidence", runId);
  const record = JSON.parse(
    readFileSync(join(bundleDir, "verified-change-record.json"), "utf8"),
  ) as { specDigest: `sha256:${string}`; documentDigest: `sha256:${string}` };
  const manifest = JSON.parse(
    readFileSync(
      join(bundleDir, VERIFIED_EVIDENCE_EXPORT_MANIFEST_FILENAME),
      "utf8",
    ),
  ) as { exportRootDigest: `sha256:${string}` };
  return {
    root,
    home,
    repo,
    bundleDir,
    harness,
    specDigest: record.specDigest,
    recordDigest: record.documentDigest,
    exportRootDigest: manifest.exportRootDigest,
  };
}

class ExportTransport implements AgencTransport {
  constructor(private readonly result: WireExportResult) {}

  async request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>> {
    if (request.method !== "run.exportVerified") {
      throw new Error(`unexpected SDK method ${request.method}`);
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: this.result,
    } as AgencDaemonResponse<Method>;
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("public verified evidence export", () => {
  it("returns identical complete bytes across restart through the public SDK", async () => {
    const run = await completedRun("wf-verified-export-sdk");
    const constraints = {
      coreRunId: "wf-verified-export-sdk",
      expectedSpecDigest: run.specDigest,
      expectedRecordDigest: run.recordDigest,
      expectedEvidenceDigest: run.exportRootDigest,
    } as const;
    const first = await exportVerifiedRunFromBundle(run.bundleDir, constraints);
    run.harness.close();

    // A fresh service reads only durable DB/ledger state: no model session,
    // repository network, or verification rerun survives this boundary.
    const service = new AgenCDaemonRunInspectionService({
      agencHome: run.home,
      stateDatabasePaths: () => [
        resolveStateDatabasePaths({ cwd: run.repo, agencHome: run.home }),
      ],
    });
    const summary = service.evidence({ runId: constraints.coreRunId });
    expect(summary.bundle?.exportRootDigest).toBe(run.exportRootDigest);
    expect(summary.bundle?.artifacts).toHaveLength(8);
    const wire = await service.exportVerified({
      runId: constraints.coreRunId,
      expectedSpecDigest: constraints.expectedSpecDigest,
      expectedRecordDigest: constraints.expectedRecordDigest,
      expectedEvidenceDigest: constraints.expectedEvidenceDigest,
    });
    const client = new AgencClient({ transport: new ExportTransport(wire) });
    const restarted = await client.exportVerifiedRun(constraints);

    expect(restarted.schemaVersion).toBe("agenc.core.verified-export.v1");
    expect(restarted.recordBytes).toEqual(first.recordBytes);
    expect(restarted.evidenceEnvelopeBytes).toEqual(
      first.evidenceEnvelopeBytes,
    );
    expect(digest(restarted.evidenceEnvelopeBytes)).toBe(
      run.exportRootDigest,
    );
    expect(restarted.verificationOutputs).toHaveLength(1);
    expect(restarted.verificationOutputs[0]).toMatchObject({
      checkId: "unit",
      commandDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(
      restarted.artifacts.map((artifact) => artifact.pointer.role).sort(),
    ).toEqual([
      "base_state",
      "changed_files",
      "cost_usage",
      "effect_log",
      "independent_review",
      "patch",
      "risk_register",
      "test_result",
    ]);
  });

  it("exports the complete root when the public replay view exceeds one page", async () => {
    const run = await completedRun("wf-verified-export-beyond-replay-page");
    const constraints = {
      coreRunId: "wf-verified-export-beyond-replay-page",
      expectedSpecDigest: run.specDigest,
      expectedRecordDigest: run.recordDigest,
      expectedEvidenceDigest: run.exportRootDigest,
    } as const;
    const direct = await exportVerifiedRunFromBundle(
      run.bundleDir,
      constraints,
    );
    run.harness.close();

    // The public replay surface is intentionally capped at 200 events. Seed a
    // larger canonical projection after the evidence ledger has been sealed;
    // the strict export must remain independent from that paged view.
    const statePaths = resolveStateDatabasePaths({
      cwd: run.repo,
      agencHome: run.home,
    });
    const replayDriver = openStateDatabasePaths(statePaths);
    try {
      const binding = replayDriver
        .prepareState<
          [string],
          { readonly child_run_id: string; readonly source_path: string }
        >(
          `SELECT child_run_id, source_path
           FROM run_journal_bindings
           WHERE run_id = ?
           ORDER BY epoch DESC
           LIMIT 1`,
        )
        .get(constraints.coreRunId);
      const fallbackSourcePath = `/test/${constraints.coreRunId}.jsonl`;
      replayDriver
        .prepareState(
          `INSERT OR IGNORE INTO threads(
             thread_id, created_at, updated_at, rollout_path
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          constraints.coreRunId,
          "2026-08-20T00:00:00.000Z",
          "2026-08-20T00:00:00.000Z",
          fallbackSourcePath,
        );
      const thread = replayDriver
        .prepareState<
          [string],
          {
            readonly thread_id: string;
            readonly rollout_path: string | null;
            readonly archived_rollout_path: string | null;
          }
        >(
          `SELECT thread_id, rollout_path, archived_rollout_path
           FROM threads
           WHERE thread_id = ?
           LIMIT 1`,
        )
        .get(constraints.coreRunId);
      expect(thread).toBeDefined();
      const sourcePath =
        binding?.source_path ??
        thread!.rollout_path ??
        thread!.archived_rollout_path ??
        fallbackSourcePath;
      const bounds = replayDriver
        .prepareState<
          [string, string],
          {
            readonly event_sequence: number;
            readonly line_number: number;
            readonly byte_offset: number;
            readonly item_index: number;
          }
        >(
          `SELECT COALESCE(MAX(event_seq), 0) AS event_sequence,
                  COALESCE(MAX(line_number), 0) AS line_number,
                  COALESCE(MAX(byte_offset), 0) AS byte_offset,
                  COALESCE(MAX(item_index), -1) AS item_index
           FROM thread_rollout_items
           WHERE thread_id = ? AND source_path = ?`,
        )
        .get(thread!.thread_id, sourcePath)!;
      const insert = replayDriver.prepareState(
        `INSERT INTO thread_rollout_items(
           thread_id, source_path, line_number, byte_offset, item_index,
           item_type, event_id, event_seq, payload_json, line_hash
         ) VALUES (?, ?, ?, ?, ?, 'event_msg', ?, ?, ?, ?)`,
      );
      for (let index = 0; index <= MAX_RUN_REPLAY_LIMIT; index += 1) {
        const sequence = bounds.event_sequence + index + 1;
        const eventId = `page-limit-event-${sequence}`;
        insert.run(
          thread!.thread_id,
          sourcePath,
          bounds.line_number + index + 1,
          bounds.byte_offset + index + 1,
          bounds.item_index + index + 1,
          eventId,
          sequence,
          JSON.stringify({
            eventId,
            id: eventId,
            seq: sequence,
            msg: {
              type: "turn_started",
              payload: { turnId: `page-limit-step-${sequence}` },
            },
          }),
          "0".repeat(64),
        );
      }
    } finally {
      replayDriver.close();
    }

    const service = new AgenCDaemonRunInspectionService({
      agencHome: run.home,
      stateDatabasePaths: () => [statePaths],
    });
    const firstReplayPage = service.evidence({
      runId: constraints.coreRunId,
      limit: MAX_RUN_REPLAY_LIMIT,
    });
    expect(firstReplayPage.hasMore).toBe(true);
    expect(firstReplayPage.source.completeness).toBe("partial");

    const wire = await service.exportVerified({
      runId: constraints.coreRunId,
      expectedSpecDigest: constraints.expectedSpecDigest,
      expectedRecordDigest: constraints.expectedRecordDigest,
      expectedEvidenceDigest: constraints.expectedEvidenceDigest,
    });
    const client = new AgencClient({ transport: new ExportTransport(wire) });
    const exported = await client.exportVerifiedRun(constraints);

    expect(exported.exportRootDigest).toBe(direct.exportRootDigest);
    expect(exported.recordBytes).toEqual(direct.recordBytes);
    expect(exported.evidenceEnvelopeBytes).toEqual(
      direct.evidenceEnvelopeBytes,
    );
    expect(exported.verificationOutputs).toHaveLength(1);
  });

  it("fails with a typed mismatch and byte-limit error", async () => {
    const run = await completedRun("wf-verified-export-constraints");
    await expect(
      exportVerifiedRunFromBundle(run.bundleDir, {
        coreRunId: "wf-verified-export-constraints",
        expectedSpecDigest: run.specDigest,
        expectedRecordDigest: run.recordDigest,
        expectedEvidenceDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject<Partial<VerifiedEvidenceExportError>>({
      code: "EXPORT_MISMATCH",
    });
    await expect(
      exportVerifiedRunFromBundle(run.bundleDir, {
        coreRunId: "wf-verified-export-constraints",
        maximumBytes: 1,
      }),
    ).rejects.toMatchObject<Partial<VerifiedEvidenceExportError>>({
      code: "EXPORT_LIMIT",
    });
    run.harness.close();
  });

  it("rejects a changed exact stdout payload without rerunning the check", async () => {
    const run = await completedRun("wf-verified-export-stream-tamper");
    const record = JSON.parse(
      readFileSync(join(run.bundleDir, "verified-change-record.json"), "utf8"),
    ) as {
      steps: Array<{
        artifacts: Array<{ role: string; digest: string }>;
      }>;
    };
    const stdout = record.steps
      .flatMap((step) => step.artifacts)
      .find((artifact) => artifact.role === "verification_stdout")!;
    const payloadDirectory = readdirSync(run.bundleDir).find((entry) =>
      entry.endsWith(".payloads"),
    )!;
    const payloadPath = join(
      run.bundleDir,
      payloadDirectory,
      `sha256-${stdout.digest.slice("sha256:".length)}.bin`,
    );
    const bytes = readFileSync(payloadPath);
    if (bytes.length === 0) {
      writeFileSync(payloadPath, Buffer.from([1]));
    } else {
      bytes[0]! ^= 1;
      writeFileSync(payloadPath, bytes);
    }
    await expect(
      exportVerifiedRunFromBundle(run.bundleDir, {
        coreRunId: "wf-verified-export-stream-tamper",
      }),
    ).rejects.toMatchObject<Partial<VerifiedEvidenceExportError>>({
      code: "EXPORT_CORRUPT",
    });
    run.harness.close();
  });

  it("rejects duplicate singleton pointers even with a self-consistent record digest", async () => {
    const run = await completedRun("wf-verified-export-duplicate");
    const recordPath = join(run.bundleDir, "verified-change-record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
      string,
      unknown
    > & {
      documentDigest: string;
      steps: Array<{ artifacts: unknown[] }>;
    };
    const baseState = record.steps
      .flatMap((step) => step.artifacts)
      .find(
        (artifact) =>
          (artifact as { role?: unknown }).role === "base_state",
      )!;
    record.steps[0]!.artifacts.push(structuredClone(baseState));
    const { documentDigest: _old, ...body } = record;
    record.documentDigest = computeDocumentDigest(body);
    writeFileSync(recordPath, `${canonicalizeJson(record)}\n`, { mode: 0o600 });

    await expect(
      exportVerifiedRunFromBundle(run.bundleDir, {
        coreRunId: "wf-verified-export-duplicate",
        expectedRecordDigest: record.documentDigest,
      }),
    ).rejects.toMatchObject<Partial<VerifiedEvidenceExportError>>({
      code: "EXPORT_CORRUPT",
    });
    run.harness.close();
  });

  it("rejects malformed SDK collections with the typed protocol error", async () => {
    const run = await completedRun("wf-verified-export-sdk-malformed");
    const service = new AgenCDaemonRunInspectionService({
      agencHome: run.home,
      stateDatabasePaths: () => [
        resolveStateDatabasePaths({ cwd: run.repo, agencHome: run.home }),
      ],
    });
    const constraints = {
      coreRunId: "wf-verified-export-sdk-malformed",
      expectedSpecDigest: run.specDigest,
      expectedRecordDigest: run.recordDigest,
      expectedEvidenceDigest: run.exportRootDigest,
    } as const;
    const wire = await service.exportVerified({
      runId: constraints.coreRunId,
      expectedSpecDigest: constraints.expectedSpecDigest,
      expectedRecordDigest: constraints.expectedRecordDigest,
      expectedEvidenceDigest: constraints.expectedEvidenceDigest,
    });
    const malformed = { ...wire, artifacts: null } as unknown as WireExportResult;
    const client = new AgencClient({
      transport: new ExportTransport(malformed),
    });

    await expect(client.exportVerifiedRun(constraints)).rejects.toBeInstanceOf(
      AgencMalformedResponseError,
    );
    run.harness.close();
  });

  it("requires the immutable installed manifest at the public daemon boundary", async () => {
    const run = await completedRun("wf-verified-export-manifest-required");
    rmSync(
      join(run.bundleDir, VERIFIED_EVIDENCE_EXPORT_MANIFEST_FILENAME),
    );
    const service = new AgenCDaemonRunInspectionService({
      agencHome: run.home,
      stateDatabasePaths: () => [
        resolveStateDatabasePaths({ cwd: run.repo, agencHome: run.home }),
      ],
    });

    await expect(
      service.exportVerified({
        runId: "wf-verified-export-manifest-required",
        expectedSpecDigest: run.specDigest,
        expectedRecordDigest: run.recordDigest,
        expectedEvidenceDigest: run.exportRootDigest,
      }),
    ).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
    run.harness.close();
  });

  it("publishes exactly one immutable record under a conflicting writer race", async () => {
    const run = await completedRun("wf-verified-export-record-race");
    const recordPath = join(run.bundleDir, "verified-change-record.json");
    const manifestPath = join(
      run.bundleDir,
      VERIFIED_EVIDENCE_EXPORT_MANIFEST_FILENAME,
    );
    const original = JSON.parse(
      readFileSync(recordPath, "utf8"),
    ) as VerifiedChangeRecord;
    const conflicting = structuredClone(original) as VerifiedChangeRecord;
    (conflicting.terminal as { finalMessage: string | null }).finalMessage =
      "conflicting but otherwise valid terminal message";
    const { documentDigest: _oldDigest, ...conflictingBody } = conflicting;
    (conflicting as { documentDigest: `sha256:${string}` }).documentDigest =
      computeDocumentDigest(conflictingBody);
    rmSync(recordPath);
    rmSync(manifestPath);

    const factory = createDaemonWorkflowEvidenceLedgerFactory({
      agencHome: run.home,
    });
    const [left, right] = await Promise.all([
      factory(original.spec as WorkflowSpec),
      factory(original.spec as WorkflowSpec),
    ]);
    const settled = await Promise.allSettled([
      left.persistRecord(original),
      right.persistRecord(conflicting),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    const installed = JSON.parse(
      readFileSync(recordPath, "utf8"),
    ) as VerifiedChangeRecord;
    expect([original.documentDigest, conflicting.documentDigest]).toContain(
      installed.documentDigest,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      recordDigest: string;
    };
    expect(manifest.recordDigest).toBe(installed.documentDigest);
    run.harness.close();
  });
});
