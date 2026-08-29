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
  test("opens the bare slash palette from an explicit state snapshot", () => {
    const command: Command = {
      type: "prompt",
      name: "review",
      description: "Review the current changes",
      progressMessage: "reviewing",
      contentLength: 0,
      source: "plugin",
      getPromptForCommand: async () => [],
    };

    expect(
      generateCommandSuggestions("/", [command], {
        skillUsage: {
          review: { usageCount: 2, lastUsedAt: Date.now() },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        displayText: "/review",
        metadata: command,
      }),
    ]);
  });
});
