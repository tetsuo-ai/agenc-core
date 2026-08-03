import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import {
  CSV_REVIEW_EVIDENCE_PROJECTION_BYTES,
  CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES,
  CSV_REVIEW_REASON_PROJECTION_BYTES,
  CSV_REVIEW_SOURCE_DIGEST_PAGE_BYTES,
  CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES,
  CsvAgentJobsRepository,
} from "../../src/state/csv-agent-jobs.js";
import { CSV_MAX_RESULT_BYTES } from "../../src/contracts/csv-job-contract.js";
import { createOperatorEffectReviewResolution } from "../../src/state/effect-review.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

let agencHome = "";
let cwd = "";
let originalAgencHome: string | undefined;
let driver: StateSqliteDriver;
let repository: CsvAgentJobsRepository;

function item(itemId: string, rowIndex: number, sourceId: string) {
  const row = { id: sourceId };
  return {
    itemId,
    rowIndex,
    sourceId,
    contentSha256: createHash("sha256")
      .update(JSON.stringify(row))
      .digest("hex"),
    workerName: `csv_row_${rowIndex}`,
    row,
  };
}

function exactJsonObject(bytes: number): {
  readonly json: string;
  readonly value: Record<string, unknown>;
} {
  const empty = JSON.stringify({ data: "" });
  if (bytes < Buffer.byteLength(empty, "utf8")) {
    throw new Error("requested JSON fixture is too small");
  }
  const value = {
    data: "x".repeat(bytes - Buffer.byteLength(empty, "utf8")),
  };
  const json = JSON.stringify(value);
  expect(Buffer.byteLength(json, "utf8")).toBe(bytes);
  return { json, value };
}

function seedReviewProjectionFixtures(): void {
  const sourceAtMax = "s".repeat(CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES);
  const sourceOverMax = `t${"s".repeat(CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES)}`;
  const reasonAtMax = "r".repeat(CSV_REVIEW_REASON_PROJECTION_BYTES);
  const reasonOverMax = `u${"r".repeat(CSV_REVIEW_REASON_PROJECTION_BYTES)}`;
  const evidenceAtMax = exactJsonObject(CSV_REVIEW_EVIDENCE_PROJECTION_BYTES);
  const evidenceOverMax = exactJsonObject(
    CSV_REVIEW_EVIDENCE_PROJECTION_BYTES + 1,
  );

  repository.createJob(
    {
      id: "projection-job",
      name: "projection-job",
      instruction: "review bounded rows",
      autoExport: false,
      inputHeaders: ["id"],
      inputCsvPath: "/input.csv",
      outputCsvPath: "",
      idColumn: "id",
    },
    [item("at-max", 0, sourceAtMax), item("over-max", 1, sourceOverMax)],
  );
  repository.markJobRunning("projection-job");
  repository.markItemRunning("projection-job", "at-max");
  repository.acknowledgeItemDispatch("projection-job", "at-max", {});
  repository.markItemUnknownOutcome(
    "projection-job",
    "at-max",
    reasonAtMax,
    evidenceAtMax.value,
  );
  repository.markItemRunning("projection-job", "over-max");
  repository.acknowledgeItemDispatch("projection-job", "over-max", {});
  repository.markItemUnknownOutcome(
    "projection-job",
    "over-max",
    reasonOverMax,
    evidenceOverMax.value,
  );
  driver
    .prepareState(
      `UPDATE csv_agent_job_items SET review_evidence_json = ?
       WHERE job_id = 'projection-job' AND item_id = 'at-max'`,
    )
    .run(evidenceAtMax.json);
  driver
    .prepareState(
      `UPDATE csv_agent_job_items SET review_evidence_json = ?
       WHERE job_id = 'projection-job' AND item_id = 'over-max'`,
    )
    .run(evidenceOverMax.json);
}

function seedUnknownReviewWithIdentifiers(options: {
  readonly jobId: string;
  readonly itemId: string;
  readonly effect?: {
    readonly runId: string;
    readonly stepId: string;
    readonly epoch: number;
  };
  readonly reason?: string;
}): void {
  const row = { value: "input" };
  repository.createJob(
    {
      id: options.jobId,
      name: "identifier-bounds",
      instruction: "review bounded identifiers",
      autoExport: false,
      inputHeaders: ["value"],
      inputCsvPath: "/input.csv",
      outputCsvPath: "",
    },
    [
      {
        itemId: options.itemId,
        rowIndex: 0,
        contentSha256: createHash("sha256")
          .update(JSON.stringify(row))
          .digest("hex"),
        workerName: "csv_row_0",
        row,
      },
    ],
  );
  repository.markJobRunning(options.jobId);
  repository.beginItemDispatch(options.jobId, options.itemId, {
    ...(options.effect !== undefined ? { effect: options.effect } : {}),
  });
  repository.acknowledgeItemDispatch(options.jobId, options.itemId, {});
  repository.markItemUnknownOutcome(
    options.jobId,
    options.itemId,
    options.reason ?? "ambiguous",
  );
}

function seedUnknownEffect(runId: string): {
  readonly rolloutPath: string;
  readonly effect: {
    readonly runId: string;
    readonly stepId: string;
    readonly epoch: 1;
  };
} {
  const createStore = (resume: boolean) =>
    new RolloutStore({
      cwd,
      sessionId: runId,
      agencVersion: "0.13.0",
      autoStartScheduler: false,
      ...(resume ? { resume: true } : {}),
    });
  const original = createStore(false);
  original.open({
    sessionId: runId,
    timestamp: "2026-08-03T00:00:00.000Z",
    cwd,
    originator: "csv-review-abort-test",
    agencVersion: "0.13.0",
  });
  const event: Event = {
    eventId: `${runId}:intent`,
    id: `${runId}:intent`,
    seq: 1,
    msg: {
      type: "effect_intent",
      payload: {
        runId,
        stepId: "tool:turn-1:call-1",
        callId: "call-1",
        toolName: "csv_worker",
        recoveryCategory: "side-effecting",
        intentDigest: `${runId}:intent-digest`,
        attempt: 1,
        recordedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  };
  expect(original.append(event, { durable: true })).toBe(true);
  original.close();
  const recovered = createStore(true);
  recovered.open({
    sessionId: runId,
    timestamp: "2026-08-03T00:00:01.000Z",
    cwd,
    originator: "csv-review-abort-test",
    agencVersion: "0.13.0",
  });
  const rolloutPath = recovered.rolloutPath;
  recovered.close();
  return {
    rolloutPath,
    effect: { runId, stepId: "tool:turn-1:call-1", epoch: 1 },
  };
}

function terminalReviewEventCount(rolloutPath: string): number {
  return (
    readFileSync(rolloutPath, "utf8").match(/"type":"effect_review_resolved"/gu)
      ?.length ?? 0
  );
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-csv-review-bridge-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-csv-review-bridge-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
  driver = openStateDatabases({ cwd });
  repository = new CsvAgentJobsRepository(driver);
});

afterEach(() => {
  driver.close();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("CSV public review repository bridge", () => {
  it("bounds max and plus-one review fields without selecting row or result blobs", () => {
    seedReviewProjectionFixtures();
    const prepare = vi.spyOn(driver, "prepareState");
    prepare.mockClear();

    const atMax = repository.getReviewProjection("projection-job", "at-max");
    const overMax = repository.getReviewProjection(
      "projection-job",
      "over-max",
    );
    const firstPage = repository.listReviewProjectionsPage({
      jobId: "projection-job",
      limit: 1,
    });
    const secondPage = repository.listReviewProjectionsPage({
      jobId: "projection-job",
      cursor: firstPage.nextCursor,
      limit: 1,
    });

    expect(atMax).toMatchObject({
      itemId: "at-max",
      sourceIdBytes: CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES,
      reviewReasonBytes: CSV_REVIEW_REASON_PROJECTION_BYTES,
      reviewEvidence: {
        bytes: CSV_REVIEW_EVIDENCE_PROJECTION_BYTES,
        truncated: false,
      },
      lookupEvidence: {
        bytes: CSV_REVIEW_EVIDENCE_PROJECTION_BYTES,
        truncated: false,
      },
    });
    expect(atMax?.sourceIdTruncated).toBeUndefined();
    expect(atMax?.reviewReasonTruncated).toBeUndefined();
    expect(atMax?.reviewEvidence?.sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(atMax.reviewEvidence.value))
        .digest("hex"),
    );

    expect(overMax).toMatchObject({
      itemId: "over-max",
      sourceIdBytes: CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES + 1,
      sourceIdTruncated: true,
      reviewReasonBytes: CSV_REVIEW_REASON_PROJECTION_BYTES + 1,
      reviewReasonTruncated: true,
      reviewEvidence: {
        bytes: CSV_REVIEW_EVIDENCE_PROJECTION_BYTES + 1,
        truncated: true,
      },
      lookupEvidence: {
        bytes: CSV_REVIEW_EVIDENCE_PROJECTION_BYTES + 1,
        truncated: true,
      },
    });
    expect(Buffer.byteLength(overMax?.sourceId ?? "", "utf8")).toBe(
      CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES,
    );
    expect(Buffer.byteLength(overMax?.reviewReason ?? "", "utf8")).toBe(
      CSV_REVIEW_REASON_PROJECTION_BYTES,
    );
    expect(overMax?.reviewEvidence?.sha256).toBe(
      createHash("sha256")
        .update(exactJsonObject(CSV_REVIEW_EVIDENCE_PROJECTION_BYTES + 1).json)
        .digest("hex"),
    );
    expect(overMax?.sourceIdDigest).toBe(
      createHash("sha256")
        .update(`t${"s".repeat(CSV_REVIEW_SOURCE_ID_PROJECTION_BYTES)}`)
        .digest("hex"),
    );
    expect(overMax?.reviewEvidence?.value).toBeUndefined();
    expect(overMax?.lookupEvidence?.value).toBeUndefined();

    expect(firstPage.reviews.map((review) => review.itemId)).toEqual([
      "at-max",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.reviews.map((review) => review.itemId)).toEqual([
      "over-max",
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(firstPage.reviews[0]?.reviewEvidence).toBeUndefined();
    expect(firstPage.reviews[0]?.lookupEvidence).toBeUndefined();

    const projectionSql = prepare.mock.calls.map(([sql]) => String(sql));
    expect(projectionSql.length).toBeGreaterThan(0);
    for (const sql of projectionSql) {
      expect(sql).not.toMatch(/\b(?:row_json|result_json)\b/u);
      expect(sql).toContain("job.import_state = 'visible'");
      expect(sql).toContain("job.retired_at IS NULL");
    }
    const listSql = projectionSql.find((sql) =>
      sql.includes("ORDER BY item.row_index ASC"),
    );
    expect(listSql).toBeDefined();
    expect(listSql).not.toMatch(
      /\b(?:review_evidence_json|lookup_evidence_json)\b/u,
    );
  });

  it("fails closed before admitting oversized job, item, or effect identifiers", () => {
    const oversized = "x".repeat(CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES + 1);
    seedUnknownReviewWithIdentifiers({
      jobId: "oversized-first-item",
      itemId: oversized,
    });
    expect(() =>
      repository.listReviewProjectionsPage({
        jobId: "oversized-first-item",
        limit: 1,
      }),
    ).toThrow(
      `CSV review item id exceeds ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES} UTF-8 bytes`,
    );

    seedUnknownReviewWithIdentifiers({
      jobId: oversized,
      itemId: "row-a",
    });
    expect(() =>
      repository.listReviewProjectionsPage({ jobId: oversized, limit: 1 }),
    ).toThrow(
      `CSV review job id exceeds ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES} UTF-8 bytes`,
    );

    seedUnknownReviewWithIdentifiers({
      jobId: "oversized-effect-run",
      itemId: "row-a",
      effect: { runId: oversized, stepId: "step-a", epoch: 1 },
    });
    expect(() =>
      repository.listReviewProjectionsPage({
        jobId: "oversized-effect-run",
        limit: 1,
      }),
    ).toThrow(
      `CSV review effect run id exceeds ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES} UTF-8 bytes`,
    );

    seedUnknownReviewWithIdentifiers({
      jobId: "oversized-effect-step",
      itemId: "row-a",
      effect: { runId: "run-a", stepId: oversized, epoch: 1 },
    });
    expect(() =>
      repository.listReviewProjectionsPage({
        jobId: "oversized-effect-step",
        limit: 1,
      }),
    ).toThrow(
      `CSV review effect step id exceeds ${CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES} UTF-8 bytes`,
    );
  });

  it("never admits an over-budget first review projection", () => {
    const identifier = "z".repeat(CSV_REVIEW_IDENTIFIER_PROJECTION_BYTES - 24);
    const jobId = `job-${identifier}`;
    seedUnknownReviewWithIdentifiers({
      jobId,
      itemId: `item-${identifier}`,
      effect: {
        runId: `run-${identifier}`,
        stepId: `step-${identifier}`,
        epoch: 1,
      },
      reason: "r".repeat(CSV_REVIEW_REASON_PROJECTION_BYTES),
    });

    expect(() =>
      repository.listReviewProjectionsPage({ jobId, limit: 1 }),
    ).toThrow(/CSV review item projection is \d+ bytes; limit is 8192/u);
  });

  it("keyset-pages source digests within a fixed full-input byte budget", () => {
    const sourceBytes = Math.floor(CSV_REVIEW_SOURCE_DIGEST_PAGE_BYTES / 2) + 1;
    const firstSource = "a".repeat(sourceBytes);
    const secondSource = "b".repeat(sourceBytes);
    repository.createJob(
      {
        id: "source-digest-budget",
        name: "source-digest-budget",
        instruction: "review bounded source digests",
        autoExport: false,
        inputHeaders: ["id"],
        inputCsvPath: "/input.csv",
        outputCsvPath: "",
        idColumn: "id",
      },
      [item("row-a", 0, firstSource), item("row-b", 1, secondSource)],
    );
    repository.markJobRunning("source-digest-budget");
    for (const itemId of ["row-a", "row-b"]) {
      repository.markItemRunning("source-digest-budget", itemId);
      repository.acknowledgeItemDispatch("source-digest-budget", itemId, {});
      repository.markItemUnknownOutcome(
        "source-digest-budget",
        itemId,
        "ambiguous",
      );
    }

    const first = repository.listReviewProjectionsPage({
      jobId: "source-digest-budget",
      limit: 2,
    });
    expect(first.reviews).toHaveLength(1);
    expect(first.reviews[0]?.sourceIdDigest).toBe(
      createHash("sha256").update(firstSource).digest("hex"),
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = repository.listReviewProjectionsPage({
      jobId: "source-digest-budget",
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.reviews).toHaveLength(1);
    expect(second.reviews[0]?.sourceIdDigest).toBe(
      createHash("sha256").update(secondSource).digest("hex"),
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it("rejects a pre-aborted review before validation or durable work", async () => {
    const pauseAfterResultValidation = vi.fn(async () => {});
    repository = new CsvAgentJobsRepository(driver, {
      pauseAfterResultValidation,
    });
    const controller = new AbortController();
    const cancellation = new Error("cancelled before CSV review");
    controller.abort(cancellation);
    const prepare = vi.spyOn(driver, "prepareState");
    prepare.mockClear();

    await expect(
      repository.resolveUnknownOutcome(
        {
          jobId: "never-read",
          itemId: "never-read",
          disposition: "confirmed_committed",
          domainAction: "mark_completed",
          evidence: {},
          actor: "operator",
          reason: "not reached",
          result: { value: "not reached" },
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(cancellation);
    expect(pauseAfterResultValidation).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("cannot use the post-validation pause hook to substitute invalid output", async () => {
    const outputSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const;
    repository.createJob(
      {
        id: "real-validation-before-pause",
        name: "real-validation-before-pause",
        instruction: "review the row",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/input.csv",
        outputCsvPath: "",
        outputSchema,
      },
      [
        {
          itemId: "row-a",
          rowIndex: 0,
          contentSha256: createHash("sha256").update("row-a").digest("hex"),
          workerName: "csv_row_0",
          row: { value: "input" },
        },
      ],
    );
    repository.markItemRunning("real-validation-before-pause", "row-a");
    repository.acknowledgeItemDispatch(
      "real-validation-before-pause",
      "row-a",
      {},
    );
    repository.markItemUnknownOutcome(
      "real-validation-before-pause",
      "row-a",
      "ambiguous",
    );
    const pauseAfterResultValidation = vi.fn(async () => {});
    repository = new CsvAgentJobsRepository(driver, {
      pauseAfterResultValidation,
    });

    await expect(
      repository.resolveUnknownOutcome({
        jobId: "real-validation-before-pause",
        itemId: "row-a",
        disposition: "confirmed_committed",
        domainAction: "mark_completed",
        evidence: { reference: "invalid-output" },
        actor: "test-operator",
        reason: "must remain pending",
        result: { value: 42 },
      }),
    ).rejects.toThrow(/does not match/u);
    expect(pauseAfterResultValidation).not.toHaveBeenCalled();
    expect(
      repository.getReviewProjection("real-validation-before-pause", "row-a"),
    ).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
      resultAvailability: "not_produced",
    });
  });

  it("fails closed instead of materializing legacy evidence above its storage bound", () => {
    seedReviewProjectionFixtures();
    const oversized = exactJsonObject(CSV_MAX_RESULT_BYTES + 1).json;
    driver
      .prepareState(
        `UPDATE csv_agent_job_items SET review_evidence_json = ?
         WHERE job_id = 'projection-job' AND item_id = 'at-max'`,
      )
      .run(oversized);

    expect(() =>
      repository.getReviewProjection("projection-job", "at-max"),
    ).toThrow(`exceeds the ${CSV_MAX_RESULT_BYTES} byte storage bound`);
  });

  it("cannot append A1 or commit CSV state after cancellation during validation", async () => {
    const outputSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const;
    const seeded = seedUnknownEffect("run-cancel-during-validation");
    repository.createJob(
      {
        id: "cancel-during-validation",
        name: "cancel-during-validation",
        instruction: "review the row",
        autoExport: false,
        inputHeaders: ["value"],
        inputCsvPath: "/input.csv",
        outputCsvPath: "",
        outputSchema,
      },
      [
        {
          itemId: "row-a",
          rowIndex: 0,
          contentSha256: createHash("sha256").update("row-a").digest("hex"),
          workerName: "csv_row_0",
          row: { value: "input" },
        },
      ],
    );
    repository.markJobRunning("cancel-during-validation");
    repository.beginItemDispatch("cancel-during-validation", "row-a", {
      effect: seeded.effect,
    });
    repository.acknowledgeItemDispatch("cancel-during-validation", "row-a", {});
    repository.markItemUnknownOutcome(
      "cancel-during-validation",
      "row-a",
      "ambiguous",
      { reference: "lookup" },
    );

    const validationPause = Promise.withResolvers<void>();
    const enteredValidation = Promise.withResolvers<void>();
    repository = new CsvAgentJobsRepository(driver, {
      pauseAfterResultValidation() {
        enteredValidation.resolve();
        return validationPause.promise;
      },
    });
    const controller = new AbortController();
    const cancellation = new Error("cancelled during CSV result validation");
    const review = createOperatorEffectReviewResolution({
      disposition: "confirmed_committed",
      actorId: "test-operator",
      evidenceRef: "ticket:cancelled-review",
      evidenceSha256: "a".repeat(64),
      reviewedAt: "2026-08-03T00:01:00.000Z",
    });
    const pending = repository.resolveUnknownOutcome(
      {
        jobId: "cancel-during-validation",
        itemId: "row-a",
        disposition: "confirmed_committed",
        domainAction: "mark_completed",
        evidence: review as unknown as Record<string, unknown>,
        actor: "test-operator",
        reason: "provider evidence confirms commit",
        effectReview: review,
        result: { value: "confirmed" },
      },
      { signal: controller.signal },
    );

    await enteredValidation.promise;
    controller.abort(cancellation);
    validationPause.resolve();
    await expect(pending).rejects.toBe(cancellation);

    expect(terminalReviewEventCount(seeded.rolloutPath)).toBe(0);
    expect(
      driver
        .prepareState<[string, string], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM csv_agent_job_review_history
           WHERE job_id = ? AND item_id = ?`,
        )
        .get("cancel-during-validation", "row-a")?.count,
    ).toBe(1);
    expect(
      repository.getReviewProjection("cancel-during-validation", "row-a"),
    ).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
      resultAvailability: "not_produced",
    });
  });
});
