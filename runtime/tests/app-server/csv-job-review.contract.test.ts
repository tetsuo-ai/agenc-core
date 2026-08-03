import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgencClient,
  type AgencTransport,
} from "../../../packages/agenc-sdk/src/index.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import {
  AgenCCsvJobReviewError,
  AgenCCsvJobReviewStateService,
} from "../../src/app-server/csv-job-review.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import { CsvAgentJobsRepository } from "../../src/state/csv-agent-jobs.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

const EVIDENCE_DIGEST = "a".repeat(64);

let agencHome = "";
let originalAgencHome: string | undefined;
let workspace = "";

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-csv-review-home-"));
  workspace = mkdtempSync(join(tmpdir(), "agenc-csv-review-workspace-"));
  mkdirSync(join(workspace, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
  seedUnknownOutcomes();
});

afterEach(() => {
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("AgenCCsvJobReviewStateService", () => {
  it("pages bounded unknown outcomes and reads one review", async () => {
    const service = new AgenCCsvJobReviewStateService();
    const first = await service.list({ cwd: workspace, jobId: "job", limit: 1 });

    expect(first.reviews).toHaveLength(1);
    expect(first.reviews[0]).toMatchObject({
      itemId: "item-0",
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.list({
      cwd: workspace,
      jobId: "job",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.reviews[0]).toMatchObject({ itemId: "item-1" });

    const shown = await service.show({
      cwd: workspace,
      jobId: "job",
      itemId: "item-0",
    });
    expect(shown.review).toMatchObject({
      contractVersion: 1,
      jobId: "job",
      itemId: "item-0",
      reviewStatus: "pending",
      reviewReason: "dispatch acknowledgement was ambiguous",
    });
  });

  it("persists exact A1 evidence and treats an identical restart replay as idempotent", async () => {
    const request = {
      cwd: workspace,
      jobId: "job",
      itemId: "item-0",
      disposition: "confirmed_committed" as const,
      evidenceRef: "operator-ticket://INC-42",
      evidenceSha256: EVIDENCE_DIGEST,
      reviewer: "operator@example.test",
      reason: "provider receipt proves the operation committed",
      result: { receipt: "provider-123" },
    };
    const firstService = new AgenCCsvJobReviewStateService();
    const first = await firstService.resolve(request);

    expect(first.outcome).toBe("resolved");
    expect(first.review).toMatchObject({
      status: "completed",
      resultAvailability: "available",
      disposition: "confirmed_committed",
      domainAction: "mark_completed",
      reviewStatus: "resolved",
      evidence: {
        truncated: false,
        value: {
          version: 1,
          kind: "effect_review_resolution",
          disposition: "confirmed_committed",
          actorKind: "operator",
          actorId: "operator@example.test",
          evidenceKind: "operator_evidence",
          evidenceRef: "operator-ticket://INC-42",
          evidenceSha256: EVIDENCE_DIGEST,
          workflowStatus: "resolved",
          domainAction: "mark_completed",
        },
      },
    });

    const restartedService = new AgenCCsvJobReviewStateService();
    const replay = await restartedService.resolve(request);
    expect(replay.outcome).toBe("already_resolved");

    await expect(
      restartedService.resolve({
        ...request,
        evidenceSha256: "b".repeat(64),
      }),
    ).rejects.toMatchObject<AgenCCsvJobReviewError>({
      code: "CSV_REVIEW_CONFLICT",
    });
  });

  it("derives the only valid retry and abandon actions from disposition", async () => {
    const service = new AgenCCsvJobReviewStateService();
    const retried = await service.resolve({
      cwd: workspace,
      jobId: "job",
      itemId: "item-1",
      disposition: "confirmed_no_effect",
      evidenceRef: "lookup://operation-key",
      evidenceSha256: EVIDENCE_DIGEST,
      reviewer: "operator",
      reason: "authoritative lookup found no effect",
    });
    expect(retried.review).toMatchObject({
      status: "pending",
      reviewStatus: "resolved",
      domainAction: "retry_new_attempt",
    });

    const abandoned = await service.resolve({
      cwd: workspace,
      jobId: "job",
      itemId: "item-2",
      disposition: "remains_unknown",
      evidenceRef: "ticket://unresolved",
      evidenceSha256: EVIDENCE_DIGEST,
      reviewer: "operator",
      reason: "no authoritative settlement source exists",
    });
    expect(abandoned.review).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "abandoned",
      domainAction: "abandon_item",
    });
    expect(abandoned.job).toMatchObject({
      status: "running",
      unknownOutcomeItems: 2,
      reviewPendingItems: 1,
    });
  });

  it("rejects malformed or unbounded operator evidence at the service boundary", async () => {
    const service = new AgenCCsvJobReviewStateService();
    const base = {
      cwd: workspace,
      jobId: "job",
      itemId: "item-0",
      disposition: "confirmed_no_effect" as const,
      evidenceRef: "lookup://operation-key",
      evidenceSha256: EVIDENCE_DIGEST,
      reviewer: "operator",
      reason: "authoritative lookup found no effect",
    };

    await expect(
      service.resolve({ ...base, evidenceSha256: "not-a-digest" }),
    ).rejects.toMatchObject({ code: "CSV_REVIEW_INVALID" });
    await expect(
      service.resolve({ ...base, evidenceRef: "x".repeat(4_097) }),
    ).rejects.toMatchObject({ code: "CSV_REVIEW_INVALID" });
  });

  it("connects the SDK through the real dispatcher and durable service", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const transport = new AgenCInProcessDaemonTransport({ dispatcher });
    const client = createAgencClient({
      transport: transport as unknown as AgencTransport,
    });
    try {
      await client.initialize();
      const listed = await client.listCsvJobReviews({
        cwd: workspace,
        jobId: "job",
        limit: 2,
      });
      expect(listed.reviews).toHaveLength(2);

      const resolved = await client.resolveCsvJobReview({
        cwd: workspace,
        jobId: "job",
        itemId: "item-0",
        disposition: "confirmed_no_effect",
        evidenceRef: "lookup://operation-key",
        evidenceSha256: EVIDENCE_DIGEST,
        reviewer: "operator",
        reason: "authoritative lookup found no effect",
      });
      expect(resolved).toMatchObject({
        outcome: "resolved",
        review: {
          status: "pending",
          reviewStatus: "resolved",
          domainAction: "retry_new_attempt",
        },
      });

      await expect(
        client.showCsvJobReview({
          cwd: workspace,
          jobId: "job",
          itemId: "item-0",
        }),
      ).resolves.toMatchObject({
        review: { itemId: "item-0", reviewStatus: "resolved" },
      });
    } finally {
      await client.close();
    }
  });
});

function seedUnknownOutcomes(): void {
  const driver = openStateDatabases({ cwd: workspace });
  try {
    const repository = new CsvAgentJobsRepository(driver);
    repository.createJob(
      {
        id: "job",
        name: "operator review contract",
        instruction: "process the row",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/input.csv",
        outputCsvPath: "",
      },
      [0, 1, 2].map((rowIndex) => ({
        itemId: `item-${rowIndex}`,
        rowIndex,
        contentSha256: createHash("sha256")
          .update(String(rowIndex))
          .digest("hex"),
        workerName: `worker_${rowIndex}`,
        row: { value: String(rowIndex) },
      })),
    );
    repository.markJobRunning("job");
    for (const rowIndex of [0, 1, 2]) {
      const itemId = `item-${rowIndex}`;
      repository.beginItemDispatch("job", itemId, {});
      repository.acknowledgeItemDispatch("job", itemId, {
        threadId: `thread-${rowIndex}`,
      });
      repository.markItemUnknownOutcome(
        "job",
        itemId,
        "dispatch acknowledgement was ambiguous",
      );
    }
  } finally {
    driver.close();
  }
}
