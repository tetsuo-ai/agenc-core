import { afterEach, expect, test, vi } from "vitest";
import * as debug from "../../src/utils/debug.js";
import {
  subscribeChildEffectReviews,
  watchChildEffectReviews,
} from "../../src/session/child-effect-reviews.js";
import type { Event, Session } from "../../src/session/session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeSession(): { readonly session: Session; readonly emit: (event: Event) => void } {
  const subscribers = new Set<(event: Event) => void>();
  const session = {
    eventLog: {
      subscribe: (listener: (event: Event) => void) => {
        subscribers.add(listener);
        return () => { subscribers.delete(listener); };
      },
    },
  } as unknown as Session;
  return { session, emit: (event) => { for (const listener of subscribers) listener(event); } };
}

test("a throwing review listener neither escapes its microtask nor starves the other owners", async () => {
  // The daemon exits on uncaughtException; record anything the fan-out lets escape.
  const escaped: unknown[] = [];
  const realQueueMicrotask = globalThis.queueMicrotask;
  vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
    realQueueMicrotask(() => {
      try { callback(); } catch (error) { escaped.push(error); }
    });
  });
  const logged = vi.spyOn(debug, "logForDebugging").mockImplementation(() => {});
  const grandparent = fakeSession();
  const parent = fakeSession();
  const child = fakeSession();
  const calls: string[] = [];
  subscribeChildEffectReviews(parent.session, () => {
    calls.push("parent-stopped");
    throw new Error("AgenC daemon agent not running: agent-1");
  });
  subscribeChildEffectReviews(parent.session, () => { calls.push("parent-other"); });
  subscribeChildEffectReviews(grandparent.session, () => { calls.push("grandparent"); });
  watchChildEffectReviews(grandparent.session, parent.session);
  watchChildEffectReviews(parent.session, child.session);

  child.emit({ id: "unknown-1", msg: { type: "effect_unknown_outcome", payload: {} } } as unknown as Event);
  await new Promise((resolve) => setImmediate(resolve));

  expect(escaped).toEqual([]);
  expect(calls).toEqual(["parent-stopped", "parent-other", "grandparent"]);
  expect(logged).toHaveBeenCalledWith(
    expect.stringContaining("AgenC daemon agent not running: agent-1"),
    { level: "error" },
  );
});
