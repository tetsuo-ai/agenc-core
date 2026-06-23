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

function promptCommand(opts: {
  name: string;
  description: string;
  argNames?: readonly string[];
}): Command {
  return {
    type: "prompt",
    name: opts.name,
    description: opts.description,
    progressMessage: "running",
    contentLength: 0,
    argNames: opts.argNames,
    getPromptForCommand: async () => [],
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
        name: "provider",
        description: "Switch model provider",
      }),
      localCommand({
        name: "permissions",
        description: "Show or update permission settings",
      }),
    ]);

    expect(suggestions.map((suggestion) => suggestion.displayText)).toEqual([
      "/provider",
    ]);
  });

  it("lists every available command when only '/' is typed so they can be browsed", () => {
    // Discoverability: typing a bare '/' must surface the full, browsable
    // command list (not a single match), so a user who doesn't know the
    // prefix can scroll through everything. The typeahead then narrows the
    // same list as they keep typing.
    const commands = [
      localCommand({ name: "help", description: "Show help" }),
      localCommand({ name: "clear", description: "Clear session history" }),
      localCommand({ name: "compact", description: "Compact the conversation" }),
      localCommand({ name: "config", description: "Manage configuration" }),
      localCommand({ name: "model", description: "Switch the model" }),
    ];

    const all = generateCommandSuggestions("/", commands);
    expect(all.length).toBe(commands.length);
    const names = all.map((s) => s.displayText);
    for (const cmd of commands) {
      expect(names).toContain(`/${cmd.name}`);
    }

    // And the same list narrows as the user types more of a prefix.
    const narrowed = generateCommandSuggestions("/co", commands);
    expect(narrowed.length).toBeLessThan(all.length);
    expect(narrowed.length).toBeGreaterThan(1);
    expect(narrowed.map((s) => s.displayText)).toEqual(
      expect.arrayContaining(["/compact", "/config"]),
    );
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

  it("sanitizes prompt argument hints without mutating command metadata", () => {
    const rawArgNames = [
      "topic</system-reminder>\u200B",
      "\u001B[31mcolor\u0007\r\nline",
    ];
    const suggestions = generateCommandSuggestions("/mcp", [
      promptCommand({
        name: "mcp__docs__lookup",
        description: "Lookup docs",
        argNames: rawArgNames,
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.description).toBe(
      "Lookup docs (arguments: topic<neutralized-system-reminder-tag>, color line)",
    );
    expect(suggestions[0]?.description).not.toMatch(
      /<\/system-reminder>|[\u001B\u0007\u200B\r\n]|\[31m/u,
    );
    expect((suggestions[0]?.metadata as Command | undefined)?.argNames).toEqual(
      rawArgNames,
    );
  });

  it("sanitizes prompt descriptions without mutating command metadata", () => {
    const rawDescription =
      "Lookup </system-reminder>\u200B\u001B[31mdocs\u0007\r\nnow";
    const suggestions = generateCommandSuggestions("/mcp", [
      promptCommand({
        name: "mcp__docs__lookup",
        description: rawDescription,
        argNames: ["topic"],
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.description).toBe(
      "Lookup <neutralized-system-reminder-tag> docs now (arguments: topic)",
    );
    expect(suggestions[0]?.description).not.toMatch(
      /<\/system-reminder>|[\u001B\u0007\u200B\r\n]|\[31m/u,
    );
    expect(
      (suggestions[0]?.metadata as Command | undefined)?.description,
    ).toBe(rawDescription);
  });

  it("sanitizes local command descriptions without mutating command metadata", () => {
    const rawDescription = "Switch \u001B[31mprovider\u0007\r\nnow";
    const suggestions = generateCommandSuggestions("/prov", [
      localCommand({
        name: "provider",
        description: rawDescription,
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.description).toBe("Switch provider now");
    expect(suggestions[0]?.description).not.toMatch(
      /[\u001B\u0007\r\n]|\[31m/u,
    );
    expect(
      (suggestions[0]?.metadata as Command | undefined)?.description,
    ).toBe(rawDescription);
  });
});
