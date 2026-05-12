import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import { CommandRegistry, buildDefaultRegistry } from "./registry.js";
import type { SlashCommand, SlashCommandResult } from "./types.js";

const MINIMAL_REGISTRY_NAMES = [
  "help",
  "status",
  "model",
  "model-provider",
  "permissions",
  "config",
  "hooks",
  "skills",
  "mcp",
  "clear",
  "compact",
  "diff",
  "exit",
] as const;

const REMOVED_TUI_COMMANDS = [
  "agents",
  "branch",
  "cache-stats",
  "commit",
  "context",
  "copy",
  "cost",
  "doctor",
  "effort",
  "enter-worktree",
  "exit-worktree",
  "files",
  "fork",
  "heapdump",
  "init",
  "install",
  "keybindings",
  "knowledge",
  "memory",
  "plan",
  "plugin",
  "pr-comments",
  "release-notes",
  "reload-plugins",
  "rename",
  "resume",
  "review",
  "rewind",
  "stats",
  "tasks",
  "theme",
  "usage",
  "vim",
  "wiki",
] as const;

function mkCmd(name: string, aliases?: readonly string[]): SlashCommand {
  return {
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    description: `test ${name}`,
    execute: async () => ({ kind: "text", text: name } satisfies SlashCommandResult),
  };
}

describe("CommandRegistry", () => {
  let reg: CommandRegistry;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reg = new CommandRegistry();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("finds registered commands by name or alias case-insensitively", () => {
    const status = mkCmd("status", ["stat", "s"]);
    reg.register(status);

    expect(reg.find("status")).toBe(status);
    expect(reg.find("STATUS")).toBe(status);
    expect(reg.find("stat")).toBe(status);
    expect(reg.has("s")).toBe(true);
    expect(reg.has("missing")).toBe(false);
  });

  it("keeps registration order in list snapshots", () => {
    reg.register(mkCmd("zeta"));
    const first = reg.list();
    reg.register(mkCmd("alpha"));

    expect(first.map((command) => command.name)).toEqual(["zeta"]);
    expect(reg.list().map((command) => command.name)).toEqual([
      "zeta",
      "alpha",
    ]);
  });

  it("throws on duplicate names and name/alias collisions", () => {
    reg.register(mkCmd("status", ["stat"]));

    expect(() => reg.register(mkCmd("STATUS"))).toThrow(/duplicate/i);
    expect(() => reg.register(mkCmd("stat"))).toThrow(/existing alias/i);
    expect(() => reg.register(mkCmd("search", ["status"]))).toThrow(
      /existing command name/i,
    );
  });

  it("drops alias-to-alias collisions without replacing the first owner", () => {
    const first = mkCmd("status", ["s"]);
    const second = mkCmd("search", ["s"]);

    reg.register(first);
    reg.register(second);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(reg.find("s")).toBe(first);
    expect(reg.find("search")).toBe(second);
  });

  it("builds the exact minimal runtime slash surface", () => {
    const names = buildDefaultRegistry().list().map((command) => command.name);

    expect(names).toEqual(MINIMAL_REGISTRY_NAMES);
  });

  it("keeps only expected aliases for retained commands", () => {
    const registry = buildDefaultRegistry();

    expect(registry.has("provider")).toBe(true);
    expect(registry.find("provider")?.name).toBe("model-provider");
    expect(registry.has("quit")).toBe(true);
    expect(registry.has("reset")).toBe(true);
    expect(registry.has("approvals")).toBe(true);
  });

  it("does not register removed TUI slash commands", () => {
    const registry = buildDefaultRegistry();

    for (const name of REMOVED_TUI_COMMANDS) {
      expect(registry.has(name), `/${name} should not be registered`).toBe(false);
    }
  });
});
