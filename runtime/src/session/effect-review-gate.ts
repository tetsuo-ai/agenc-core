import type { Session } from "./session.js";

export class EffectReviewRequiredError extends Error {
  readonly code = "effect_review_required";
}

export function isEffectReviewRequired(error: unknown): boolean {
  return error instanceof EffectReviewRequiredError ||
    (error instanceof Error &&
      /requires effect review before model execution/u.test(error.message));
}

/** Wait for committed review projection. No timers or model retries. */
export function waitForEffectReview(session: Pick<Session, "rolloutStore" | "eventLog" | "abortController">): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe = () => {};
    const finish = (allowed: boolean) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      session.abortController.signal.removeEventListener("abort", onAbort);
      resolve(allowed);
    };
    const onAbort = () => finish(false);
    const check = () => {
      if (session.abortController.signal.aborted) return finish(false);
      if (!session.rolloutStore?.hasPendingEffectReviews?.()) finish(true);
    };
    unsubscribe = session.eventLog.subscribe((event) => {
      if (event.msg.type === "effect_review_resolved") {
        // Live review emits before applying its durable database projection.
        queueMicrotask(check);
      }
    });
    session.abortController.signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}
