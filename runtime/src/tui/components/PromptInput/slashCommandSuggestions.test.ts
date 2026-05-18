import { describe, expect, it } from "vitest";
import { getCommandsSync, type Command } from "../../../commands.js";
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

  it("marks protocol extension commands with the protocol glyph", () => {
    const suggestions = generateCommandSuggestions("/", getCommandsSync());
    const byName = new Map(
      suggestions.map((suggestion) => [suggestion.displayText, suggestion]),
    );

    for (const name of ["claim", "delegate", "proof", "settle", "stake"]) {
      expect(byName.get(`/${name}`)).toMatchObject({
        tag: "◆",
        color: "worker",
        metadata: expect.objectContaining({
          kind: "protocol",
          source: "plugin",
          loadedFrom: "plugin",
        }),
      });
    }
  });
});
