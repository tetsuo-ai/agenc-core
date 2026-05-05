import { describe, expect, test } from "vitest";
import {
  loadAutoCompactModule,
  loadCompactModule,
  loadManualCompactCommand,
  loadMessageUtilityModule,
  loadMicroCompactModule,
} from "../src/agenc/adapters/dynamic-loaders.js";
import { autoCompactIfNeeded } from "../src/services/compact/autoCompact.js";
import {
  buildPostCompactMessages,
  createSyntheticUserCaveatMessage,
  createUserMessage,
  formatCommandInputTags,
  manualCompactCall,
} from "../src/services/compact/compact.js";
import {
  microcompactMessages,
  resetMicrocompactState,
} from "../src/services/compact/microCompact.js";

describe("compact loader service contract", () => {
  test("loads compact, auto, micro, manual, and message helpers from service modules", async () => {
    await expect(loadAutoCompactModule()).resolves.toEqual({
      autoCompactIfNeeded,
    });
    await expect(loadCompactModule()).resolves.toEqual({
      buildPostCompactMessages,
    });
    await expect(loadMicroCompactModule()).resolves.toEqual({
      microcompactMessages,
      resetMicrocompactState,
    });
    await expect(loadManualCompactCommand()).resolves.toEqual({
      call: manualCompactCall,
    });
    await expect(loadMessageUtilityModule()).resolves.toEqual({
      createSyntheticUserCaveatMessage,
      createUserMessage,
      formatCommandInputTags,
    });
  });
});
