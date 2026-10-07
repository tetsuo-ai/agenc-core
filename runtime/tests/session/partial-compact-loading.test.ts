import { expect, it, vi } from "vitest";

const loading = vi.hoisted(() => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  compact: vi.fn(),
  project: vi.fn(),
}));
vi.mock("../../src/services/compact/compact.js", async () => {
  loading.entered.resolve();
  await loading.release.promise;
  return {
    partialCompactConversationAsync: loading.compact,
    buildPostCompactMessages: loading.project,
  };
});

import { Session } from "../../src/session/session.js";

it("cancels and releases the owned task when aborted while compaction code loads", async () => {
  const signal = new AbortController();
  const owner = {
    rolloutStore: { isDegraded: false },
    nextInternalSubId: () => "compact-load-test",
    beginIdleTask: vi.fn(async () => ({ subId: "compact-load-test" })),
    throwIfPartialCompactAborted: (value: AbortSignal) => value.throwIfAborted(),
    settleInterruptedTurnHandoff: vi.fn(),
    snapshotHistoryMessages: vi.fn(),
    partialCompactFailure: (code: string, message: string) => ({ ok: false, code, message }),
    onTaskFinished: vi.fn(),
  };
  const result = Session.prototype.partialCompactFromMessage.call(owner as unknown as Session, {
    messageOrdinal: 0,
    direction: "from",
    signal: signal.signal,
  });
  await loading.entered.promise;
  expect(owner.beginIdleTask).toHaveBeenCalledOnce();
  signal.abort(new DOMException("cancel while loading", "AbortError"));
  loading.release.resolve();
  await expect(result).resolves.toMatchObject({ ok: false, code: "ABORTED" });
  expect(loading.compact).not.toHaveBeenCalled();
  expect(loading.project).not.toHaveBeenCalled();
  expect(owner.settleInterruptedTurnHandoff).not.toHaveBeenCalled();
  expect(owner.snapshotHistoryMessages).not.toHaveBeenCalled();
  expect(owner.onTaskFinished).toHaveBeenCalledExactlyOnceWith("compact-load-test");
});
