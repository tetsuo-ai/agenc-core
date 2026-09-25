import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdmissionJournalEvent,
  RuntimeAdmissionRequest,
} from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { ROLLOUT_SCHEMA_VERSION } from "../../src/session/event-log.js";
import {
  serializeRolloutItem,
  type RolloutItem,
} from "../../src/session/rollout-item.js";
import { backfillRolloutFile } from "../../src/state/backfill.js";
import { recoverExecutionAdmissionCanonicalJournals } from "../../src/state/execution-admission-canonical-recovery.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { validateCanonicalJournalText } from "../../src/state/recovery-journal-contract.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";

const { syncedSources } = vi.hoisted(() => ({
  syncedSources: [] as string[],
}));

// Count every explicit fsync the recovery asks of a leased rollout.
vi.mock("../../src/durability/offline-rollout.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/durability/offline-rollout.js")
    >();
  return {
    ...actual,
    withPinnedOfflineRolloutLease: ((options, operation) =>
      actual.withPinnedOfflineRolloutLease(options, (rollout) =>
        operation({
          ...rollout,
          sync: () => {
            syncedSources.push(rollout.sourcePath);
            rollout.sync();
          },
        }),
      )) as typeof actual.withPinnedOfflineRolloutLease,
  };
});

vi.mock(
  "../../src/state/recovery-journal-contract.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/state/recovery-journal-contract.js")
      >();
    return {
      ...actual,
      validateCanonicalJournalText: vi.fn(actual.validateCanonicalJournalText),
    };
  },
);

const RUN_ID = "projection-reuse-run";
const T0 = "2026-09-25T00:00:00.000Z";
const EPOCH = "0.18.0+test-commit+2026-09-25T00:00:00.000Z";
// Whole seconds, so a restored mtime reads back as the identical mtimeMs.
const MTIME_S = 1_790_000_000;

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let admissions: ExecutionAdmissionRepository;
let threads: StateThreadRepository;
let nextId = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-projection-reuse-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-projection-reuse-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  admissions = new ExecutionAdmissionRepository(driver, {
    now: () => new Date(T0),
    id: () => `projection-reuse-id-${++nextId}`,
    ownerId: "crashed-daemon",
    ownerPid: process.pid,
  });
  threads = new StateThreadRepository(driver);
  resetCounters();
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function resetCounters(): void {
  syncedSources.length = 0;
  vi.mocked(validateCanonicalJournalText).mockClear();
}

function validations(): number {
  return vi.mocked(validateCanonicalJournalText).mock.calls.length;
}

function request(stepId: string): RuntimeAdmissionRequest {
  return {
    step: { runId: RUN_ID, stepId },
    kind: "model_turn",
    estimate: { maxInputTokens: 1, maxOutputTokens: 1, maxCostUsd: 0 },
    model: "test-model",
    provider: "test-provider",
    workspaceId: "workspace",
    sessionId: RUN_ID,
    parentScopeId: RUN_ID,
    autonomous: false,
  };
}

function sessionMeta(timestamp: string, model: string): RolloutItem {
  return {
    type: "session_meta",
    payload: {
      sessionId: RUN_ID,
      timestamp,
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.18.0",
      model,
      modelProvider: "test-provider",
      rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
    },
    eventVersion: 1,
  } as RolloutItem;
}

function warning(seq: number, id: string): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      eventId: id,
      id,
      seq,
      msg: { type: "warning", payload: { cause: "fixture", message: id } },
    },
  } as RolloutItem;
}

function admissionEvent(
  seq: number,
  admission: AdmissionJournalEvent,
): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      eventId: admission.eventId,
      id: admission.eventId,
      seq,
      msg: { type: "execution_admission", payload: admission },
    },
  } as RolloutItem;
}

function rolloutPath(): string {
  const directory = join(driver.projectDir, "sessions", RUN_ID);
  mkdirSync(directory, { recursive: true });
  return join(directory, `rollout-${RUN_ID}.jsonl`);
}

function bind(sourcePath: string): void {
  const durability = new StateRunDurabilityRepository(driver);
  durability.ensureInitialEpoch({ runId: RUN_ID, openedAt: T0 });
  durability.bindJournalSource({
    runId: RUN_ID,
    epoch: 1,
    childRunId: RUN_ID,
    sessionId: RUN_ID,
    sourcePath,
    boundAt: T0,
  });
}

/**
 * A bound rollout that already holds its settled admission evidence, so
 * recovery appends nothing and a later pass sees the exact same bytes.
 */
function bindConvergedRollout(): string {
  const queued = admissions.enqueue(request("model-1"));
  admissions.cancelStep(queued.record.key, { reason: "fixture_settled" });
  const journal = admissions.listJournal({ runId: RUN_ID });
  expect(journal).toHaveLength(2);
  const sourcePath = rolloutPath();
  writeFileSync(
    sourcePath,
    [
      sessionMeta("2026-09-25T00:00:01.000Z", "model-first"),
      warning(1, "existing-event"),
      ...journal.map((event, index) => admissionEvent(2 + index, event)),
      sessionMeta("2026-09-25T00:00:05.000Z", "model-latest"),
    ]
      .map(serializeRolloutItem)
      .join(""),
    { mode: 0o600 },
  );
  utimesSync(sourcePath, MTIME_S, MTIME_S);
  bind(sourcePath);
  return sourcePath;
}

function recover(epoch: string | undefined = EPOCH) {
  return recoverExecutionAdmissionCanonicalJournals(
    driver,
    admissions,
    epoch === undefined ? {} : { canonicalProjectionEpoch: epoch },
  );
}

function rows(sourcePath: string): {
  readonly id: number;
  readonly line_number: number;
  readonly item_type: string;
  readonly event_id: string | null;
}[] {
  return driver
    .prepareState<
      [string],
      {
        id: number;
        line_number: number;
        item_type: string;
        event_id: string | null;
      }
    >(
      `SELECT id, line_number, item_type, event_id FROM thread_rollout_items
       WHERE source_path = ? ORDER BY line_number`,
    )
    .all(sourcePath);
}

function ids(sourcePath: string): number[] {
  return rows(sourcePath).map((row) => row.id);
}

describe("canonical admission recovery reuses unchanged projections", () => {
  it("keeps the projection of an unchanged source on the next recovery", () => {
    const sourcePath = bindConvergedRollout();
    expect(recover().admissionEventsAppended).toBe(0);
    expect(validations()).toBe(1);
    const projected = ids(sourcePath);
    const thread = threads.getThread(RUN_ID);
    expect(projected).toHaveLength(5);
    expect(thread).toMatchObject({
      createdAt: "2026-09-25T00:00:01.000Z",
      updatedAt: "2026-09-25T00:00:05.000Z",
      model: "model-latest",
    });

    resetCounters();
    const second = recover();

    expect(second).toMatchObject({
      runsScanned: 1,
      sourcesScanned: 1,
      admissionEventsAppended: 0,
    });
    expect(validations()).toBe(0);
    expect(syncedSources).toEqual([]);
    expect(ids(sourcePath)).toEqual(projected);
    expect(threads.getThread(RUN_ID)).toEqual(thread);
  });

  it("still merges thread metadata another writer changed", () => {
    const sourcePath = bindConvergedRollout();
    recover();
    const thread = threads.getThread(RUN_ID)!;
    threads.upsertThread({
      ...thread,
      model: "changed-elsewhere",
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    const projected = ids(sourcePath);

    resetCounters();
    recover();

    expect(validations()).toBe(0);
    expect(ids(sourcePath)).toEqual(projected);
    expect(threads.getThread(RUN_ID)).toEqual(thread);
  });

  it.each([
    [
      "bytes were appended",
      (sourcePath: string) => {
        appendFileSync(sourcePath, serializeRolloutItem(warning(4, "later")));
        utimesSync(sourcePath, MTIME_S, MTIME_S);
      },
      6,
    ],
    [
      "only the mtime changed",
      (sourcePath: string) => utimesSync(sourcePath, MTIME_S, MTIME_S + 7),
      5,
    ],
    [
      "the source was truncated",
      (sourcePath: string) => {
        const lines = readFileSync(sourcePath, "utf8").split("\n");
        truncateSync(
          sourcePath,
          Buffer.byteLength(lines.slice(0, 4).join("\n")) + 1,
        );
        utimesSync(sourcePath, MTIME_S, MTIME_S);
      },
      4,
    ],
    [
      "the bytes changed at the same size and mtime",
      (sourcePath: string) => {
        const text = readFileSync(sourcePath, "utf8");
        writeFileSync(sourcePath, text.replace("model-latest", "model-LATEST"));
        utimesSync(sourcePath, MTIME_S, MTIME_S);
      },
      5,
    ],
  ])("re-validates and re-projects when %s", (_label, change, expected) => {
    const sourcePath = bindConvergedRollout();
    recover();
    const projected = ids(sourcePath);
    const before = readFileSync(sourcePath);
    const beforeMtimeMs = statSync(sourcePath).mtimeMs;

    change(sourcePath);
    const after = readFileSync(sourcePath);
    expect(
      !after.equals(before) || statSync(sourcePath).mtimeMs !== beforeMtimeMs,
    ).toBe(true);
    resetCounters();
    recover();

    expect(validations()).toBe(1);
    expect(syncedSources.length).toBeGreaterThan(0);
    const reprojected = ids(sourcePath);
    expect(reprojected).toHaveLength(expected);
    expect(Math.min(...reprojected)).toBeGreaterThan(Math.max(...projected));
    expect(threads.getBackfillFile(sourcePath)).toMatchObject({
      size: after.byteLength,
      mtimeMs: statSync(sourcePath).mtimeMs,
      sha256: createHash("sha256").update(after).digest("hex"),
    });
  });

  it("re-projects bytes another indexer projected after the canonical pass", () => {
    const sourcePath = bindConvergedRollout();
    recover();
    const original = readFileSync(sourcePath);

    // The tolerant indexer projects an appended tail, then the file returns
    // to the exact bytes and mtime the canonical pass validated.
    appendFileSync(sourcePath, serializeRolloutItem(warning(4, "tolerant")));
    backfillRolloutFile({ rolloutPath: sourcePath, threads });
    expect(rows(sourcePath).map((row) => row.event_id)).toContain("tolerant");
    truncateSync(sourcePath, original.byteLength);
    utimesSync(sourcePath, MTIME_S, MTIME_S);
    expect(readFileSync(sourcePath).equals(original)).toBe(true);

    resetCounters();
    recover();

    expect(validations()).toBe(1);
    expect(rows(sourcePath).map((row) => row.event_id)).not.toContain(
      "tolerant",
    );
    expect(rows(sourcePath)).toHaveLength(5);
  });

  it("refuses a journal whose matching receipt came from the tolerant indexer", () => {
    admissions.enqueue(request("model-1"));
    const admission = admissions.listJournal({ runId: RUN_ID })[0]!;
    const sourcePath = rolloutPath();
    // JSON.parse accepts the duplicate key; canonical validation does not.
    const duplicateKeyLine =
      '{"type":"event_msg","payload":{"eventId":"dup","id":"dup","seq":1,' +
      '"msg":{"type":"warning","payload":{"cause":"a","cause":"a","message":"dup"}}},' +
      '"eventVersion":1}\n';
    writeFileSync(
      sourcePath,
      duplicateKeyLine + serializeRolloutItem(admissionEvent(2, admission)),
      { mode: 0o600 },
    );
    bind(sourcePath);
    backfillRolloutFile({ rolloutPath: sourcePath, threads });
    const bytes = readFileSync(sourcePath);
    const receipt = threads.getBackfillFile(sourcePath)!;
    expect(receipt).toMatchObject({
      size: bytes.byteLength,
      mtimeMs: statSync(sourcePath).mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    expect(() => recover()).toThrow(/duplicate key/);
    expect(() => recover()).toThrow(/duplicate key/);
    expect(readFileSync(sourcePath).equals(bytes)).toBe(true);
  });

  it("does not reuse a projection another build validated", () => {
    const sourcePath = bindConvergedRollout();
    recover("build-a");
    const projected = ids(sourcePath);

    resetCounters();
    recover("build-b");
    expect(validations()).toBe(1);
    const reprojected = ids(sourcePath);
    expect(Math.min(...reprojected)).toBeGreaterThan(Math.max(...projected));

    resetCounters();
    recover(undefined);
    expect(validations()).toBe(1);

    // A pass without an epoch leaves no marker behind for the next one.
    resetCounters();
    recover("build-b");
    expect(validations()).toBe(1);
  });

  it("fsyncs and keeps the projection when the same bytes move to a new file", () => {
    const sourcePath = bindConvergedRollout();
    recover();
    const projected = ids(sourcePath);
    const before = statSync(sourcePath, { bigint: true });
    const copy = `${sourcePath}.restore`;
    copyFileSync(sourcePath, copy);
    renameSync(copy, sourcePath);
    utimesSync(sourcePath, MTIME_S, MTIME_S);
    const after = statSync(sourcePath, { bigint: true });
    expect(after.ino).not.toBe(before.ino);

    resetCounters();
    recover();

    expect(validations()).toBe(0);
    expect(ids(sourcePath)).toEqual(projected);
    // Once before the transaction (no marker covers this file yet) and once
    // before the marker moves to it.
    expect(syncedSources).toEqual([sourcePath, sourcePath]);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toMatchObject({
      dev: after.dev.toString(10),
      ino: after.ino.toString(10),
    });

    resetCounters();
    recover();
    expect(validations()).toBe(0);
    expect(syncedSources).toEqual([]);
  });

  it("reuses at bind time what startup recovery just validated", () => {
    const sourcePath = bindConvergedRollout();
    const kernel = new ExecutionAdmissionKernel({
      agencHome: home,
      canonicalProjectionEpoch: EPOCH,
    });
    try {
      expect(kernel.initializeExistingState().failures).toEqual([]);
      expect(validations()).toBe(1);
      const projected = ids(sourcePath);
      const thread = threads.getThread(RUN_ID)!;
      // Startup closed the idle project, so binding it recovers it again;
      // the merged thread row shows that second pass ran.
      threads.upsertThread({ ...thread, model: "changed-elsewhere" });

      resetCounters();
      const client = kernel.bindClient({
        cwd,
        scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
      });
      client.release?.();

      expect(validations()).toBe(0);
      expect(syncedSources).toEqual([]);
      expect(ids(sourcePath)).toEqual(projected);
      expect(threads.getThread(RUN_ID)).toEqual(thread);
    } finally {
      kernel.close();
    }
  });
});

describe("canonical projection marker", () => {
  const marker = {
    epoch: EPOCH,
    size: 10,
    mtimeMs: 1_790_000_000_000.5,
    sha256: "a".repeat(64),
    dev: "16777233",
    ino: "18446744073709551615",
  };

  function project(
    sourcePath: string,
    canonicalMarker?: typeof marker,
  ): void {
    threads.upsertThread({
      threadId: "marker-thread",
      createdAt: T0,
      updatedAt: T0,
    });
    threads.replaceRolloutItems({
      threadId: "marker-thread",
      sourcePath,
      items: [
        {
          lineNumber: 1,
          byteOffset: 0,
          itemIndex: 0,
          itemType: "event_msg",
          payloadJson: "{}",
          lineHash: "b".repeat(64),
        },
      ],
      mtimeMs: marker.mtimeMs,
      size: marker.size,
      sha256: marker.sha256,
      lineCount: 2,
      ...(canonicalMarker !== undefined ? { canonicalMarker } : {}),
    });
  }

  it("round-trips exact identities and is set only by the canonical writer", () => {
    const sourcePath = join(driver.projectDir, "sessions", "a", "rollout-a.jsonl");
    project(sourcePath);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();
    project(sourcePath, marker);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toEqual({
      threadId: "marker-thread",
      ...marker,
    });
  });

  it("is cleared by every other projection write and by deletion", () => {
    const sourcePath = join(driver.projectDir, "sessions", "a", "rollout-a.jsonl");
    const row = {
      lineNumber: 2,
      byteOffset: 5,
      itemIndex: 1,
      itemType: "event_msg",
      payloadJson: "{}",
      lineHash: "c".repeat(64),
    };

    project(sourcePath, marker);
    project(sourcePath);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();

    project(sourcePath, marker);
    threads.appendRolloutItems({
      threadId: "marker-thread",
      sourcePath,
      items: [row],
      mtimeMs: marker.mtimeMs + 1,
      size: marker.size + 5,
      sha256: marker.sha256,
      lineCount: 3,
      totalItemCount: 2,
    });
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();

    project(sourcePath, marker);
    threads.replaceRolloutItemsFromProducer({
      threadId: "marker-thread",
      sourcePath,
      expectedItemCount: 1,
      mtimeMs: marker.mtimeMs,
      size: marker.size,
      sha256: marker.sha256,
      lineCount: 2,
      produce: (insert) => insert({ ...row, lineNumber: 1, itemIndex: 0 }),
    });
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();

    project(sourcePath, marker);
    threads.deleteRolloutItemsForSource(sourcePath);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();
  });

  it("moves with its rows when the rollout is relocated", () => {
    const sourcePath = join(driver.projectDir, "sessions", "a", "rollout-a.jsonl");
    const archivedPath = join(
      driver.projectDir,
      "archived_sessions",
      "a",
      "rollout-a.jsonl",
    );
    project(sourcePath, marker);
    threads.relocateRolloutSource(sourcePath, archivedPath);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();
    expect(threads.getCanonicalProjectionMarker(archivedPath)).toMatchObject(
      marker,
    );
  });

  it("moves to a new file identity only while its content fields match", () => {
    const sourcePath = join(driver.projectDir, "sessions", "a", "rollout-a.jsonl");
    project(sourcePath, marker);
    expect(() =>
      threads.updateCanonicalProjectionIdentity(sourcePath, {
        ...marker,
        sha256: "d".repeat(64),
        ino: "7",
      }),
    ).toThrow(/changed while it was being reused/);
    threads.updateCanonicalProjectionIdentity(sourcePath, {
      ...marker,
      dev: "1",
      ino: "7",
    });
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toMatchObject({
      ...marker,
      dev: "1",
      ino: "7",
    });
  });
});
