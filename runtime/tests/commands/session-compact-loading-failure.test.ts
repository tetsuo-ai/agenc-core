import { describe, expect, it, vi } from "vitest";
import type { SlashCommandContext } from "../../src/commands/types.js";

vi.mock("../../src/commands/session-compact.js", () => {
  throw new Error("compaction implementation unavailable");
});

import { compactCommand, contextCommand } from "../../src/commands/session-compact-commands.js";

describe("compaction command import failures", () => {
  it.each([compactCommand, contextCommand])("returns an error result for /$name", async command => {
    const result = await command.execute({} as SlashCommandContext);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message.length).toBeGreaterThan(0);
  });
});
