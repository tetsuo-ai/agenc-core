import { afterEach, describe, expect, it } from "vitest";
import helpCommand, { formatHelp } from "./help.js";
import {
  getGlobalCommandRegistry,
  setGlobalCommandRegistry,
  type CommandRegistry,
  type SlashCommand,
  type SlashCommandContext,
} from "./types.js";

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    session: {} as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp",
    home: "/home/test",
    ...overrides,
  };
}

afterEach(() => setGlobalCommandRegistry(null));

describe("helpCommand", () => {
  it("returns 'registry pending' when no registry is installed", async () => {
    setGlobalCommandRegistry(null);
    const res = await helpCommand.execute(makeCtx());
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toBe("registry pending");
  });

  it("formats a registry of commands alphabetically with aliases", async () => {
    const cmds: SlashCommand[] = [
      { name: "zeta", description: "last letter", execute: async () => ({ kind: "skip" }) },
      {
        name: "alpha",
        aliases: ["a"],
        description: "first letter",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "middle",
        userInvocable: false,
        description: "hidden",
        execute: async () => ({ kind: "skip" }),
      },
    ];
    const reg: CommandRegistry = {
      list: () => cmds,
      find: (n) => cmds.find((c) => c.name === n),
    };
    setGlobalCommandRegistry(reg);
    const res = await helpCommand.execute(makeCtx());
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/\/alpha, \/a/);
      expect(res.text).toMatch(/\/zeta/);
      expect(res.text).not.toMatch(/\/middle/); // hidden
      const idxAlpha = res.text.indexOf("/alpha");
      const idxZeta = res.text.indexOf("/zeta");
      expect(idxAlpha).toBeLessThan(idxZeta);
    }
  });

  it("handles an empty registry", async () => {
    setGlobalCommandRegistry({
      list: () => [],
      find: () => undefined,
    });
    expect(getGlobalCommandRegistry()).not.toBeNull();
    const res = await helpCommand.execute(makeCtx());
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toMatch(/No slash commands/);
  });

  it("formatHelp is deterministic for identical inputs", () => {
    const cmds: SlashCommand[] = [
      { name: "b", description: "b desc", execute: async () => ({ kind: "skip" }) },
      { name: "a", description: "a desc", execute: async () => ({ kind: "skip" }) },
    ];
    const reg: CommandRegistry = { list: () => cmds, find: () => undefined };
    expect(formatHelp(reg)).toBe(formatHelp(reg));
  });
});
