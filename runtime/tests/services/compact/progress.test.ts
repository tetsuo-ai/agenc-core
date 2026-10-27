import { expect, test } from "vitest";
import { createCompactionProgress, readCompactionProgressEvent, subscribeToCompactionProgress } from "../../../src/services/compact/progress.js";
import type { CompactContext, CompactionProgressEvent } from "../../../src/services/compact/types.js";

test("progress observers cannot fail the operation and map/reduce progress never regresses", () => {
  const session = {};
  const events: CompactionProgressEvent[] = [];
  const unsubscribe = subscribeToCompactionProgress(session, (event) => events.push(event));
  subscribeToCompactionProgress(session, () => { throw new Error("observer failure"); });
  const context = { admissionSession: session, onCompactProgress: () => { throw new Error("UI failure"); } } as unknown as CompactContext;
  const progress = createCompactionProgress(context, "compact-proof", 12_000);
  progress.summary(0, 2, 50, 100, true);
  progress.summary(1, 2, 0, 100, true);
  progress.summary(1, 2, 30, 100, true);
  progress.send("validate", 85);
  progress.send("commit", 95, { afterTokens: 3_000 });
  progress.send("complete", 100, { afterTokens: 3_000 });
  expect(events.map((event) => event.percent)).toEqual([0, 27.5, 45, 55.5, 85, 95, 100]);
  expect(events[3]?.summaryTokensReceived).toBe(80);
  expect(readCompactionProgressEvent({ type: "compact_progress", payload: events.at(-1) })).toEqual(events.at(-1));
  expect(readCompactionProgressEvent({ payload: null })).toBeUndefined();
  expect(readCompactionProgressEvent({ ...events[0], percent: Infinity })).toBeUndefined();
  unsubscribe();
});
