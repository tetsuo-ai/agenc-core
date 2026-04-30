import { describe, expect, test } from "vitest";
import {
  loadAutoCompactModule,
  loadCompactModule,
  loadContextCollapseModule,
  loadContextNonInteractiveCommand,
  loadManualCompactCommand,
  loadMessageUtilityModule,
  loadMicroCompactModule,
  loadToolResultStorageModule,
} from "../src/agenc/adapters/dynamic-loaders.js";
import {
  compressToolHistory,
  getTiers,
} from "../src/agenc/upstream/services/api/compressToolHistory.js";

describe("OpenClaude compact loader contract", () => {
  test("loads every live compact surface without bun:bundle or copied UI imports", async () => {
    const autoCompact = await loadAutoCompactModule();
    const compact = await loadCompactModule();
    const collapse = await loadContextCollapseModule();
    const microcompact = await loadMicroCompactModule();
    const toolStorage = await loadToolResultStorageModule();
    const manual = await loadManualCompactCommand();
    const context = await loadContextNonInteractiveCommand();
    const messages = await loadMessageUtilityModule();

    expect(typeof autoCompact.autoCompactIfNeeded).toBe("function");
    expect(typeof compact.buildPostCompactMessages).toBe("function");
    expect(typeof collapse.recoverFromOverflow).toBe("function");
    expect(typeof microcompact.microcompactMessages).toBe("function");
    expect(typeof microcompact.resetMicrocompactState).toBe("function");
    expect(typeof toolStorage.applyToolResultBudget).toBe("function");
    expect(typeof manual.call).toBe("function");
    expect(typeof context.call).toBe("function");
    expect(typeof messages.createUserMessage).toBe("function");
    expect(typeof messages.createSyntheticUserCaveatMessage).toBe("function");
    expect(typeof messages.formatCommandInputTags).toBe("function");
  });

  test("provider compression imports as a standalone provider-layer module", () => {
    const messages = [{ role: "user", content: "hello" }];

    expect(compressToolHistory(messages, "gpt-4o")).toBe(messages);
    expect(getTiers(100_000)).toEqual({ recent: 5, mid: 10 });
  });
});
