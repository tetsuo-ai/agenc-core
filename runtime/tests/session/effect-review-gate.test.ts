import { expect, it } from "vitest";
import { EventLog, type Event } from "../../src/session/event-log.js";
import {
  EffectReviewRequiredError,
  isEffectReviewRequired,
  waitForEffectReview,
} from "../../src/session/effect-review-gate.js";
import type { Session } from "../../src/session/session.js";

function reviewSession(pending: () => boolean, abort = new AbortController()) {
  const eventLog = new EventLog();
  const session = {
    eventLog,
    abortController: abort,
    rolloutStore: { hasPendingEffectReviews: pending },
  } as unknown as Session;
  const emitResolved = () => {
    eventLog.emit({
      id: "review",
      msg: {
        type: "effect_review_resolved",
        payload: {
          runId: "root",
          stepId: "step",
          callId: "call",
          resolution: { workflowStatus: "resolved" },
        },
      },
    } as Event);
  };
  const emitUnrelated = () => {
    eventLog.emit({
      id: "turn",
      msg: { type: "turn_complete", payload: { turnId: "turn-1" } },
    } as Event);
  };
  return { session, emitResolved, emitUnrelated };
}

it("recognizes both the typed review error and the durable refusal text", () => {
  expect(isEffectReviewRequired(new EffectReviewRequiredError("blocked"))).toBe(true);
  expect(isEffectReviewRequired(
    new Error("run root requires effect review before model execution. Run /resolve call-1."),
  )).toBe(true);
  expect(isEffectReviewRequired(new Error("permission denied"))).toBe(false);
  expect(isEffectReviewRequired("requires effect review before model execution")).toBe(false);
});

it("allows immediately when no review is pending", async () => {
  const { session } = reviewSession(() => false);
  await expect(waitForEffectReview(session)).resolves.toBe(true);
});

it("refuses immediately when the session is already aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  const { session, emitResolved } = reviewSession(() => true, abort);
  await expect(waitForEffectReview(session)).resolves.toBe(false);
  emitResolved();
  await Promise.resolve();
});

it("stays blocked until the durable projection clears after a live review event", async () => {
  let pending = true;
  const { session, emitResolved, emitUnrelated } = reviewSession(() => pending);
  const allowed = waitForEffectReview(session);
  let settled: boolean | undefined;
  void allowed.then((value) => {
    settled = value;
  });
  emitUnrelated();
  emitResolved();
  await Promise.resolve();
  expect(settled).toBeUndefined();
  pending = false;
  emitResolved();
  await expect(allowed).resolves.toBe(true);
});

it("does not resume after abort even if reviews later clear", async () => {
  let pending = true;
  const abort = new AbortController();
  const { session, emitResolved } = reviewSession(() => pending, abort);
  const allowed = waitForEffectReview(session);
  abort.abort();
  await expect(allowed).resolves.toBe(false);
  pending = false;
  emitResolved();
  await Promise.resolve();
});
