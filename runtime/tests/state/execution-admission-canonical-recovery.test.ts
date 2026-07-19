import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import type { Event } from "../../src/session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
} from "../../src/session/rollout-item.js";
import { recoverExecutionAdmissionCanonicalJournals } from "../../src/state/execution-admission-canonical-recovery.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const RUN_ID = "admission-recovery-run";
const T0 = "2026-07-18T00:00:00.000Z";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let admissions: ExecutionAdmissionRepository;
let nextId = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-admission-canonical-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-admission-canonical-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  admissions = new ExecutionAdmissionRepository(driver, {
    now: () => new Date(T0),
    id: () => `admission-recovery-id-${++nextId}`,
    ownerId: "crashed-daemon",
    ownerPid: process.pid,
  });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function request(stepId: string): RuntimeAdmissionRequest {
  return {
    step: { runId: RUN_ID, stepId },
    kind: "model_turn",
    estimate: {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0,
    },
    model: "test-model",
    provider: "test-provider",
    workspaceId: "workspace",
    sessionId: RUN_ID,
    parentScopeId: RUN_ID,
    autonomous: false,
  };
}

function bindRollout(events: readonly Event[]): string {
  const directory = join(driver.projectDir, "sessions", RUN_ID);
  mkdirSync(directory, { recursive: true });
  const sourcePath = join(directory, `rollout-${RUN_ID}.jsonl`);
  writeFileSync(
    sourcePath,
    events
      .map((event) =>
        serializeRolloutItem({ type: "event_msg", payload: event }),
      )
      .join(""),
    { mode: 0o600 },
  );
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
  return sourcePath;
}

function readEvents(sourcePath: string): Event[] {
  return readFileSync(sourcePath, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      const item = parseRolloutLine(line);
      return item?.type === "event_msg" ? [item.payload] : [];
    });
}

describe("canonical execution-admission recovery", () => {
  it("backfills the exact SQLite event under the run sequence lease", () => {
    const sourcePath = bindRollout([
      {
        eventId: "existing-event",
        id: "existing-event",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "fixture", message: "existing" },
        },
      },
    ]);
    const queued = admissions.enqueue(request("model-1"));
    const admission = admissions.listJournal({ runId: RUN_ID })[0]!;

    const first = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );
    const second = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );

    expect(queued.record.status).toBe("queued");
    expect(first.admissionEventsAppended).toBe(1);
    expect(second.admissionEventsAppended).toBe(0);
    expect(readEvents(sourcePath)).toMatchObject([
      { eventId: "existing-event", seq: 1 },
      {
        eventId: admission.eventId,
        id: admission.eventId,
        seq: 2,
        msg: { type: "execution_admission", payload: admission },
      },
    ]);
    expect(
      driver
        .prepareState<[string], { readonly event_id: string }>(
          `SELECT event_id FROM thread_rollout_items
           WHERE source_path = ? AND event_seq = 2`,
        )
        .get(sourcePath),
    ).toEqual({ event_id: admission.eventId });
  });

  it("refuses conflicting canonical identity evidence", () => {
    admissions.enqueue(request("model-conflict"));
    const admission = admissions.listJournal({ runId: RUN_ID })[0]!;
    bindRollout([
      {
        eventId: admission.eventId,
        id: admission.eventId,
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "conflict", message: "not admission evidence" },
        },
      },
    ]);
    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions),
    ).toThrow(/conflicting canonical evidence/);
  });

  it("tolerates distinct legacy-unsequenced events sharing a synthetic id", () => {
    // Legacy rollouts predate durable event identities: their `id` is not
    // unique (synthetic ids like "system" recur). Two DIFFERENT events
    // sharing it is the legacy format, not corruption — recovery must not
    // abort daemon startup (observed: daemon died on a pre-0.7.0 session).
    bindRollout([
      {
        id: "system",
        msg: { type: "warning", payload: { cause: "a", message: "first" } },
      } as Event,
      {
        id: "system",
        msg: { type: "warning", payload: { cause: "a", message: "first" } },
      } as Event,
      {
        id: "system",
        msg: { type: "warning", payload: { cause: "b", message: "second" } },
      } as Event,
    ]);
    const queued = admissions.enqueue(request("model-legacy"));
    expect(queued.record.status).toBe("queued");

    const result = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );
    expect(result.admissionEventsAppended).toBe(1);
    // Idempotent on re-run despite the disambiguated ids.
    expect(
      recoverExecutionAdmissionCanonicalJournals(driver, admissions)
        .admissionEventsAppended,
    ).toBe(0);
  });

  it("refuses to append committed admission evidence after a terminal tail", () => {
    const otherRun = "terminal-admission-recovery-run";
    const directory = join(driver.projectDir, "sessions", otherRun);
    mkdirSync(directory, { recursive: true });
    const sourcePath = join(directory, `rollout-${otherRun}.jsonl`);
    writeFileSync(
      sourcePath,
      serializeRolloutItem({
        type: "event_msg",
        payload: {
          eventId: "terminal-event",
          id: "terminal-event",
          seq: 1,
          msg: {
            type: "run_terminal",
            payload: {
              runId: otherRun,
              epoch: 1,
              status: "completed",
              exitCode: 0,
              stopReason: "done",
              finalMessage: "done",
              usage: null,
              lastSequenceBeforeTerminal: null,
              finishedAt: T0,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const durability = new StateRunDurabilityRepository(driver);
    durability.ensureInitialEpoch({ runId: otherRun, openedAt: T0 });
    durability.bindJournalSource({
      runId: otherRun,
      epoch: 1,
      childRunId: otherRun,
      sessionId: otherRun,
      sourcePath,
      boundAt: T0,
    });
    admissions.enqueue({
      ...request("model-terminal"),
      step: { runId: otherRun, stepId: "model-terminal" },
      sessionId: otherRun,
      parentScopeId: otherRun,
    });

    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions),
    ).toThrow(/terminal tail precedes 1 committed admission event/);
  });

  it("fails closed when its configured event-work bound is exceeded", () => {
    bindRollout([]);
    admissions.enqueue(request("model-1"));
    const claimed = admissions.claim();
    expect(claimed.kind).toBe("claimed");

    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions, {
        maxEventsPerRun: 1,
      }),
    ).toThrow(/bounded event limit \(1\)/);
  });

  it("refuses a canonical lifecycle with committed admissions but no binding", () => {
    admissions.enqueue(request("model-unbound"));
    new StateRunDurabilityRepository(driver).ensureInitialEpoch({
      runId: RUN_ID,
      openedAt: T0,
    });

    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions),
    ).toThrow(/canonical lifecycle but no journal binding/);
  });
});
