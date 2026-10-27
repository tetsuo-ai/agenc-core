import { useCallback, useEffect, useRef, useState } from "react";
import { PendingEffectReviews } from "../../session/pending-effect-reviews.js";
import type { AgenCBridgeSession } from "../session-types.js";

export function usePendingEffectReviews(session: AgenCBridgeSession) {
  const projection = useRef(new PendingEffectReviews());
  const [reviews, setReviews] = useState(() => {
    for (const event of session.getInitialTranscriptEvents?.() ?? session.initialTranscriptEvents ?? []) {
      projection.current.apply(event);
    }
    return projection.current.reviews;
  });
  useEffect(() => {
    const apply = (event: unknown) => {
      if (projection.current.apply(event)) setReviews(projection.current.reviews);
    };
    projection.current = new PendingEffectReviews();
    for (const event of session.getInitialTranscriptEvents?.() ?? session.initialTranscriptEvents ?? []) projection.current.apply(event);
    setReviews(projection.current.reviews);
    try {
      return session.subscribeToEvents?.(apply) ?? session.eventLog?.subscribe(apply);
    } catch {
      // The transcript hook reports connection and replay failures. Retain
      // the snapshot's review block while that connection is unavailable.
      return undefined;
    }
  }, [session]);
  const noteRefusal = useCallback((error: unknown) => {
    projection.current.recordRefusal(error instanceof Error ? error.message : String(error));
    setReviews(projection.current.reviews);
  }, []);
  return { reviews, noteRefusal };
}
