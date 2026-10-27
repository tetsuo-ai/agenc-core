import { expect, test, vi } from "vitest";
import { awaitSubmissionTerminal } from "../../src/tui/submission-terminal.js";

function events() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    session: { subscribeToEvents(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } },
    emit(event: unknown) { for (const listener of [...listeners]) listener(event); },
  };
}

test("only the bound submission's daemon terminal can settle a pending RPC", async () => {
  const source = events();
  const rpc = Promise.withResolvers<void>();
  const finished = vi.fn();
  const waiting = awaitSubmissionTerminal(source.session, "current", () => rpc.promise).then(finished);
  source.emit({ type: "turn_started", clientMessageId: "current", payload: { turnId: "current-turn" } });
  source.emit({ type: "turn_aborted", payload: { reason: "interrupted" } });
  source.emit({ type: "turn_complete", payload: { turnId: "old-turn" } });
  source.emit({ type: "turn_complete", clientMessageId: "sibling", payload: { turnId: "current-turn" } });
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  source.emit({ type: "turn_aborted", payload: { turnId: "current-turn", reason: "approval_denied" } });
  await waiting;
  expect(finished).toHaveBeenCalledOnce();
  expect(source.listeners.size).toBe(0);
  // The losing RPC remains observed and cannot become an unhandled rejection.
  rpc.reject(new Error("late socket failure"));
  await Promise.resolve();
});

test("a matching terminal delivered synchronously during submission is observed", async () => {
  const source = events();
  await awaitSubmissionTerminal(source.session, "current", async () => {
    source.emit({ type: "turn_complete", clientMessageId: "current", payload: { turnId: "fast-turn" } });
    await new Promise<void>(() => {});
  });
  expect(source.listeners.size).toBe(0);
});

test("an RPC rejection before a terminal remains an error and unsubscribes", async () => {
  const source = events();
  await expect(awaitSubmissionTerminal(source.session, "current", async () => {
    throw new Error("not admitted");
  })).rejects.toThrow("not admitted");
  expect(source.listeners.size).toBe(0);
});
