import { afterEach, describe, expect, it } from "vitest";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { getPreSamplingAutoCompactTokenLimit } from "../../src/session/run-turn-compaction.js";
import { runWithStartupProviderSelection } from "../../src/utils/model/providers.js";

afterEach(() => setAutoCompactImplForTests(null));

describe("daemon compaction window policy", () => {
  it.each([
    { source: "environment", window: 48_000, threshold: 35_000 },
    { source: "config", window: 48_000, threshold: 35_000 },
    { source: "config", window: 100_000, threshold: 75_000 },
  ])("persists the trigger's threshold for the $source window ($window)", async ({ source, window, threshold }) => {
    const environment = source === "environment" ? { AGENC_AUTO_COMPACT_WINDOW: "48000" } : {};
    const { session } = mkSession({ provider: mkProvider(), services: { providerEnvironment: environment } });
    const ctx = mkCtx({ modelInfo: {
      ...mkCtx().modelInfo, contextWindow: source === "config" ? window : 1_048_576,
      effectiveContextWindowPercent: 100,
    } });
    await runWithStartupProviderSelection({ provider: "deepseek", model: "deepseek-flash", environment }, async () => {
      expect(getPreSamplingAutoCompactTokenLimit(ctx)).toBe(threshold);
      await drain(runTurn(session, ctx, "hello"));
      expect(session.state.unsafePeek().previousTurnSettings?.autoCompactTokenLimit).toBe(threshold);
    });
  });

  it("does not enter proactive compaction when all compaction is disabled", async () => {
    const environment = { AGENC_DISABLE_COMPACT: "1", AGENC_AUTO_COMPACT_WINDOW: "48000" };
    await runWithStartupProviderSelection({ provider: "deepseek", model: "deepseek-flash", environment }, async () => {
      expect(getPreSamplingAutoCompactTokenLimit(mkCtx())).toBeUndefined();
    });
  });
});
