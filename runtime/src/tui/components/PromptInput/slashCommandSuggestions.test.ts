import { describe, expect, it } from "vitest";
import type { Command } from "../../../commands.js";
import { generateCommandSuggestions } from "../../../utils/suggestions/commandSuggestions.js";

function localCommand(opts: {
  name: string;
  description: string;
  aliases?: string[];
}): Command {
  return {
    type: "local",
    name: opts.name,
    description: opts.description,
    aliases: opts.aliases,
    load: async () => ({
      call: async () => ({ type: "text", value: "" }),
    }),
  };
}

describe("slash command suggestions", () => {
  it("does not suggest commands from description-only fuzzy matches", () => {
    const suggestions = generateCommandSuggestions("/history", [
      localCommand({
        name: "clear",
        aliases: ["reset", "new"],
        description: "Clear session history and caches",
      }),
    ]);

    expect(suggestions).toEqual([]);
  });

  it("keeps name and alias prefix matches", () => {
    const suggestions = generateCommandSuggestions("/prov", [
      localCommand({
        name: "model-provider",
        aliases: ["provider"],
        description: "Switch model provider",
      }),
      localCommand({
        name: "permissions",
        description: "Show or update permission settings",
      }),
    ]);

    expect(suggestions.map((suggestion) => suggestion.displayText)).toEqual([
      "/model-provider (provider)",
    ]);
  });
});
