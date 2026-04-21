import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runManualCompact: vi.fn(),
  path: new URL("../../session/manual-compact.js", import.meta.url).pathname,
}));

vi.mock(mocks.path, () => ({
  runManualCompact: mocks.runManualCompact,
}));

import { call } from "./compact.js";

describe("legacy compact command adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to session/manual-compact", async () => {
    const context = {
      abortController: new AbortController(),
      messages: [{ role: "user", content: "hello" }],
    };
    const expected = {
      type: "compact",
      compactionResult: {
        boundaryMarker: { role: "system", content: "boundary" },
        summaryMessages: [],
        attachments: [],
        hookResults: [],
      },
      displayText: "Compacted",
    };
    mocks.runManualCompact.mockResolvedValueOnce(expected);

    const result = await call("keep last answer", context as never);

    expect(mocks.runManualCompact).toHaveBeenCalledWith(
      "keep last answer",
      context,
    );
    expect(result).toBe(expected);
  });
});
