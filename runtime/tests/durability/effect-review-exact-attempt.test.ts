import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EffectReviewDisposition } from "../../src/contracts/run-contracts.js";
import type { Event } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import {
  createOperatorEffectReviewResolution,
  EffectReviewStaleError,
  resolveDurableEffectReview,
  resolveLiveDurableEffectReview,
  type EffectReviewExpectedAttempt,
  type LiveEffectReviewJournal,
} from "../../src/state/effect-review.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabasePaths,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

// Two attempts of one tool call share the call id: the first ended unknown,
// was reviewed as "no effect", and the retry ended unknown again. A review
// made for the first attempt must never settle the second one.
const OPENED_AT = "2026-09-26T00:00:00.000Z";
const CALL_ID = "call-1";
const STEP_A = "tool:turn-1:call-1";
const STEP_B = "tool:turn-2:call-1";
const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function review(disposition: EffectReviewDisposition, sha: string, at: string) {
  return createOperatorEffectReviewResolution({
    disposition,
    actorId: "operator-test",
    evidenceRef: `desktop-effect-review:sha256:${sha}`,
    evidenceSha256: sha,
    reviewedAt: at,
  });
}

function intent(runId: string, stepId: string, seq: number): Event {
  return {
    eventId: `intent-${stepId}`,
    id: `intent-${stepId}`,
    seq,
    msg: {
      type: "effect_intent",
      payload: {
        formatVersion: 2,
        minimumReaderRuntime: "0.14.0",
        runId,
        stepId,
        callId: CALL_ID,
        toolName: "browser_evaluate",
        recoveryCategory: "side-effecting",
        intentDigest: `digest-${stepId}`,
        attempt: 1,
        recordedAt: OPENED_AT,
      },
    },
  };
}

function unknown(runId: string, stepId: string, seq: number): Event {
  return {
    eventId: `unknown-${stepId}`,
    id: `unknown-${stepId}`,
    seq,
    msg: {
      type: "effect_unknown_outcome",
      payload: {
        formatVersion: 2,
        minimumReaderRuntime: "0.14.0",
        runId,
        stepId,
        callId: CALL_ID,
        toolName: "browser_evaluate",
        recoveryCategory: "side-effecting",
        intentEventSeq: seq - 1,
        outcome: "unknown_outcome",
        reason: "acknowledgement_lost",
        requiresReview: true,
        recordedAt: OPENED_AT,
      },
    },
  };
}

function attemptOf(runId: string, stepId: string, seq: number): EffectReviewExpectedAttempt {
  return {
    runId,
    stepId,
    unknownEventId: `unknown-${stepId}`,
    unknownSequence: seq,
  };
}

interface Fixture {
  readonly runId: string;
  readonly live: RolloutStore;
  readonly driver: StateSqliteDriver;
  readonly journal: LiveEffectReviewJournal;
  appends(): number;
  effect(stepId: string): ReturnType<StateRunDurabilityRepository["getEffect"]>;
}

/**
 * Attempt A (seq 1-2) is reviewed "no effect" (seq 3); the retry B (seq 4-5)
 * is pending review. The live journal counts appends so a refused request
 * can be shown to append nothing.
 */
function twoAttempts(runId: string): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-exact-attempt-"));
  created.push(cwd);
  const live = new RolloutStore({
    cwd,
    sessionId: runId,
    agencVersion: "0.6.2",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
  });
  live.open({
    sessionId: runId,
    timestamp: OPENED_AT,
    cwd,
    originator: "exact-attempt-test",
    agencVersion: "0.6.2",
  });
  const paths = resolveStateDatabasePaths({ cwd });
  created.push(paths.projectDir);
  const driver = openStateDatabasePaths(paths);
  let nextSeq = 1;
  let appends = 0;
  const record = (event: Event): void => {
    expect(event.seq).toBe(nextSeq);
    nextSeq += 1;
    expect(live.append(event, { durable: true })).toBe(true);
    live.recordEffectEvent(event);
  };
  const journal: LiveEffectReviewJournal = {
    readAll: () => live.readAll(),
    append: (eventId, payload) => {
      appends += 1;
      const event: Event = {
        eventId,
        id: eventId,
        seq: nextSeq,
        msg: { type: "effect_review_resolved", payload },
      };
      nextSeq += 1;
      expect(live.append(event, { durable: true })).toBe(true);
      return event;
    },
    project: (event) => live.recordEffectEvent(event),
  };
  record(intent(runId, STEP_A, 1));
  record(unknown(runId, STEP_A, 2));
  expect(
    resolveLiveDurableEffectReview(
      driver,
      {
        sessionId: runId,
        toolCallId: CALL_ID,
        resolution: review("confirmed_no_effect", "a".repeat(64), "2026-09-26T00:01:00.000Z"),
        expectedAttempt: attemptOf(runId, STEP_A, 2),
      },
      journal,
    ),
  ).toMatchObject({ kind: "resolved", stepId: STEP_A });
  record(intent(runId, STEP_B, 4));
  record(unknown(runId, STEP_B, 5));
  appends = 0;
  const repository = new StateRunDurabilityRepository(driver);
  return {
    runId,
    live,
    driver,
    journal,
    appends: () => appends,
    effect: (stepId) => repository.getEffect(runId, stepId),
  };
}

function close(fixture: Fixture): void {
  fixture.driver.close();
  fixture.live.close();
}

describe("effect review exact-attempt precondition", () => {
  it("refuses a stale review of the first attempt instead of settling the retry that shares its call id", () => {
    const fixture = twoAttempts("run-stale-live");
    try {
      expect(fixture.effect(STEP_A)).toMatchObject({ reviewStatus: "resolved" });
      expect(fixture.effect(STEP_B)).toMatchObject({ reviewStatus: "pending" });
      const before = readFileSync(fixture.live.rolloutPath, "utf8");
      // The card still shows attempt A and the user answers "It did take effect".
      expect(() =>
        resolveLiveDurableEffectReview(
          fixture.driver,
          {
            sessionId: fixture.runId,
            toolCallId: CALL_ID,
            resolution: review("confirmed_committed", "c".repeat(64), "2026-09-26T00:02:00.000Z"),
            expectedAttempt: attemptOf(fixture.runId, STEP_A, 2),
          },
          fixture.journal,
        ),
      ).toThrow(EffectReviewStaleError);
      expect(fixture.appends()).toBe(0);
      expect(readFileSync(fixture.live.rolloutPath, "utf8")).toBe(before);
      expect(fixture.effect(STEP_B)).toMatchObject({ reviewStatus: "pending" });
      expect(fixture.effect(STEP_B)?.review).toBeUndefined();
    } finally {
      close(fixture);
    }
  });

  it("answers a repeated identical review of the first attempt without touching the retry", () => {
    const fixture = twoAttempts("run-repeat-live");
    try {
      expect(
        resolveLiveDurableEffectReview(
          fixture.driver,
          {
            sessionId: fixture.runId,
            toolCallId: CALL_ID,
            resolution: review("confirmed_no_effect", "a".repeat(64), "2026-09-26T00:01:00.000Z"),
            expectedAttempt: attemptOf(fixture.runId, STEP_A, 2),
          },
          fixture.journal,
        ),
      ).toMatchObject({ kind: "already_resolved", stepId: STEP_A });
      expect(fixture.appends()).toBe(0);
      expect(fixture.effect(STEP_B)).toMatchObject({ reviewStatus: "pending" });
    } finally {
      close(fixture);
    }
  });

  it("refuses an attempt whose unknown event, sequence, call or session differs from the record", () => {
    const fixture = twoAttempts("run-mismatch-live");
    try {
      const resolution = review("confirmed_no_effect", "d".repeat(64), "2026-09-26T00:02:00.000Z");
      const mismatches: { toolCallId: string; sessionId: string; attempt: EffectReviewExpectedAttempt }[] = [
        { toolCallId: CALL_ID, sessionId: fixture.runId, attempt: { ...attemptOf(fixture.runId, STEP_B, 5), unknownEventId: `unknown-${STEP_A}` } },
        { toolCallId: CALL_ID, sessionId: fixture.runId, attempt: { ...attemptOf(fixture.runId, STEP_B, 5), unknownSequence: 2 } },
        { toolCallId: CALL_ID, sessionId: fixture.runId, attempt: attemptOf(fixture.runId, "tool:turn-3:call-1", 5) },
        { toolCallId: CALL_ID, sessionId: fixture.runId, attempt: attemptOf("run-other", STEP_B, 5) },
        { toolCallId: "call-2", sessionId: fixture.runId, attempt: attemptOf(fixture.runId, STEP_B, 5) },
        { toolCallId: CALL_ID, sessionId: "session-other", attempt: attemptOf(fixture.runId, STEP_B, 5) },
      ];
      for (const mismatch of mismatches) {
        expect(() =>
          resolveLiveDurableEffectReview(
            fixture.driver,
            {
              sessionId: mismatch.sessionId,
              toolCallId: mismatch.toolCallId,
              resolution,
              expectedAttempt: mismatch.attempt,
            },
            fixture.journal,
          ),
        ).toThrow(EffectReviewStaleError);
      }
      expect(fixture.appends()).toBe(0);
      expect(fixture.effect(STEP_B)).toMatchObject({ reviewStatus: "pending" });
    } finally {
      close(fixture);
    }
  });

  it("settles the exact current attempt", () => {
    const fixture = twoAttempts("run-exact-live");
    try {
      expect(
        resolveLiveDurableEffectReview(
          fixture.driver,
          {
            sessionId: fixture.runId,
            toolCallId: CALL_ID,
            resolution: review("remains_unknown", "e".repeat(64), "2026-09-26T00:02:00.000Z"),
            expectedAttempt: attemptOf(fixture.runId, STEP_B, 5),
          },
          fixture.journal,
        ),
      ).toMatchObject({ kind: "resolved", stepId: STEP_B, sequence: 6 });
      expect(fixture.appends()).toBe(1);
      expect(fixture.effect(STEP_B)).toMatchObject({
        reviewStatus: "abandoned",
        review: { disposition: "remains_unknown", evidenceSha256: "e".repeat(64) },
      });
      expect(fixture.effect(STEP_A)?.review).toMatchObject({ disposition: "confirmed_no_effect" });
    } finally {
      close(fixture);
    }
  });

  it("keeps the earlier rule for a request without an attempt: the pending attempt for the call id", () => {
    const fixture = twoAttempts("run-legacy-live");
    try {
      expect(
        resolveLiveDurableEffectReview(
          fixture.driver,
          {
            sessionId: fixture.runId,
            toolCallId: CALL_ID,
            resolution: review("confirmed_committed", "f".repeat(64), "2026-09-26T00:02:00.000Z"),
          },
          fixture.journal,
        ),
      ).toMatchObject({ kind: "resolved", stepId: STEP_B });
    } finally {
      close(fixture);
    }
  });

  it("applies the same precondition on the offline path, under its write transaction", () => {
    const fixture = twoAttempts("run-stale-offline");
    const rolloutPath = fixture.live.rolloutPath;
    fixture.live.close();
    try {
      const before = readFileSync(rolloutPath, "utf8");
      expect(() =>
        resolveDurableEffectReview(fixture.driver, {
          sessionId: fixture.runId,
          toolCallId: CALL_ID,
          resolution: review("confirmed_committed", "c".repeat(64), "2026-09-26T00:02:00.000Z"),
          expectedAttempt: attemptOf(fixture.runId, STEP_A, 2),
        }),
      ).toThrow(EffectReviewStaleError);
      expect(() =>
        resolveDurableEffectReview(fixture.driver, {
          sessionId: fixture.runId,
          toolCallId: CALL_ID,
          resolution: review("confirmed_committed", "c".repeat(64), "2026-09-26T00:02:00.000Z"),
          expectedAttempt: { ...attemptOf(fixture.runId, STEP_B, 5), unknownSequence: 4 },
        }),
      ).toThrow(EffectReviewStaleError);
      expect(readFileSync(rolloutPath, "utf8")).toBe(before);
      expect(fixture.effect(STEP_B)).toMatchObject({ reviewStatus: "pending" });
      expect(
        resolveDurableEffectReview(fixture.driver, {
          sessionId: fixture.runId,
          toolCallId: CALL_ID,
          resolution: review("confirmed_committed", "c".repeat(64), "2026-09-26T00:02:00.000Z"),
          expectedAttempt: attemptOf(fixture.runId, STEP_B, 5),
        }),
      ).toMatchObject({ kind: "resolved", stepId: STEP_B });
      expect(fixture.effect(STEP_B)).toMatchObject({ reviewStatus: "resolved" });
    } finally {
      fixture.driver.close();
    }
  });
});
