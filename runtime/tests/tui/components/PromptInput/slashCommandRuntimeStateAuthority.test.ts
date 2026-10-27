import { describe, expect, test, vi } from "vitest";

import type { Command } from "../../../commands.js";
import { generateCommandSuggestions } from "../../../utils/suggestions/commandSuggestions.js";

vi.mock("../../../utils/config.js", () => ({
  getRuntimeState: () => {
    throw new Error("ambient runtime state is forbidden in slash suggestions");
  },
  updateRuntimeState: () => {
    throw new Error("ambient runtime state is forbidden in slash suggestions");
  },
}));

describe("slash command runtime-state authority", () => {
  const command: Command = {
    type: "prompt",
    name: "review",
    description: "Review the current changes",
    progressMessage: "reviewing",
    contentLength: 0,
    source: "plugin",
    getPromptForCommand: async () => [],
  };
  const snapshot = {
    skillUsage: {
      review: { usageCount: 2, lastUsedAt: Date.now() },
    },
  };

  test("ranks typed matches from an explicit state snapshot", () => {
    expect(generateCommandSuggestions("/rev", [command], snapshot)).toEqual([
      expect.objectContaining({
        displayText: "/review",
        metadata: command,
      }),
    ]);
  });

  test("opens the bare slash palette without reading ambient state", () => {
    // A bare '/' lists built-in commands and project skills only, so a
    // plugin command waits for typed text even when it was used recently.
    expect(generateCommandSuggestions("/", [command], snapshot)).toEqual([]);
  });
});
