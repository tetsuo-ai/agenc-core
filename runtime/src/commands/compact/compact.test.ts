import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runManualCompact: vi.fn(),
  finalizeManualCompactHistory: vi.fn(),
  path: new URL("../../session/manual-compact.js", import.meta.url).pathname,
}));

vi.mock(mocks.path, () => ({
  runManualCompact: mocks.runManualCompact,
  finalizeManualCompactHistory: mocks.finalizeManualCompactHistory,
}));

import { call } from "./compact.js";

describe("legacy compact command adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to session/manual-compact and replaces history locally", async () => {
    const setMessages = vi.fn();
    const context = {
      abortController: new AbortController(),
      messages: [{ role: "user", content: "hello" }],
      setMessages,
    };
    const compactResult = {
      type: "compact",
      compactionResult: {
        boundaryMarker: { role: "system", content: "boundary" },
        summaryMessages: [],
        attachments: [],
        hookResults: [],
      },
      displayText: "Compacted",
    };
    const finalized = {
      compactionResult: compactResult.compactionResult,
      messages: [{ role: "user", content: "finalized" }],
    };
    mocks.runManualCompact.mockResolvedValueOnce(compactResult);
    mocks.finalizeManualCompactHistory.mockReturnValueOnce(finalized);

    const result = await call("keep last answer", context as never);

    expect(mocks.runManualCompact).toHaveBeenCalledWith(
      "keep last answer",
      context,
    );
    expect(mocks.finalizeManualCompactHistory).toHaveBeenCalledWith(
      "keep last answer",
      "Compacted",
      compactResult.compactionResult,
    );
    expect(setMessages).toHaveBeenCalledTimes(1);
    const updater = setMessages.mock.calls[0]?.[0] as
      | ((prev: unknown[]) => unknown[])
      | undefined;
    expect(updater?.([{ role: "user", content: "stale" }])).toEqual(
      finalized.messages,
    );
    expect(result).toEqual({ type: "skip" });
  });
});
