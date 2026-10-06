import { describe, expect, test } from "vitest";
import { buildDefaultRegistry } from "../../src/commands/registry.js";
import { builtInCommandNames, isBuiltInCommandName } from "../../src/commands/builtin-command-names.js";
import { getCommand, getCommandName, hasCommand } from "../../src/commands/lookup.js";
import type { Command } from "../../src/commands.js";

describe("command startup leaves", () => {
  test("transcript classification contains every default name and alias in order", () => {
    const registryNames = new Set(buildDefaultRegistry().list().flatMap(
      command => [command.name, ...(command.aliases ?? [])],
    ));
    expect([...builtInCommandNames()]).toEqual([...registryNames]);
    for (const name of registryNames) expect(isBuiltInCommandName(name)).toBe(true);
    expect(isBuiltInCommandName("HELP")).toBe(false);
    expect(isBuiltInCommandName("custom:review")).toBe(false);
    builtInCommandNames().clear();
    expect(isBuiltInCommandName("help")).toBe(true);
  });

  test("lookup retains display names, aliases, precedence and missing-command errors", () => {
    const first = { name: "review", userFacingName: () => "Review", aliases: ["r"] } as Command;
    const second = { name: "r" } as Command;
    expect(getCommandName(first)).toBe("Review");
    expect(getCommand("r", [first, second])).toBe(second);
    expect(getCommand("Review", [first, second])).toBe(first);
    expect(hasCommand("r", [first])).toBe(true);
    expect(hasCommand("missing", [first])).toBe(false);
    expect(() => getCommand("missing", [first, second])).toThrow(
      new ReferenceError("Command missing not found. Available commands: r, Review (aliases: r)"),
    );
  });
});
