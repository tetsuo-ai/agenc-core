import { afterEach, describe, expect, it } from "vitest";
import { buildDefaultRegistry } from "./registry.js";
import helpCommand, {
  formatHelp,
  formatHelpCommands,
  groupHelpCommands,
} from "./help.js";
import {
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

  it("formats visible commands by the minimal categories", () => {
    const cmds: SlashCommand[] = [
      {
        name: "zeta",
        description: "last letter",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "status",
        description: "show status",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "config",
        description: "configure AgenC",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "diff",
        description: "show diff",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "hidden",
        userInvocable: false,
        description: "hidden",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "disabled",
        isEnabled: () => false,
        description: "disabled",
        execute: async () => ({ kind: "skip" }),
      },
    ];
    const reg: CommandRegistry = {
      list: () => cmds,
      find: (n) => cmds.find((c) => c.name === n),
    };

    const text = formatHelp(reg);

    expect(text).toContain("Getting Started:");
    expect(text).toContain("Configuration:");
    expect(text).toContain("Context & Files:");
    expect(text).toContain("Other Commands:");
    expect(text).toContain("/status - show status");
    expect(text).toContain("/config - configure AgenC");
    expect(text).toContain("/diff - show diff");
    expect(text).toContain("/zeta - last letter");
    expect(text).not.toContain("/hidden");
    expect(text).not.toContain("/disabled");
  });

  it("deduplicates commands by canonical name before formatting", () => {
    const cmds: SlashCommand[] = [
      {
        name: "alpha",
        description: "first",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "alpha",
        description: "duplicate",
        execute: async () => ({ kind: "skip" }),
      },
    ];
    const reg: CommandRegistry = { list: () => cmds, find: () => undefined };
    const text = formatHelp(reg);
    expect(text.match(/\/alpha/g)).toHaveLength(1);
    expect(text).toContain("first");
    expect(text).not.toContain("duplicate");
  });

  it("handles an empty registry", () => {
    const reg: CommandRegistry = {
      list: () => [],
      find: () => undefined,
    };
    expect(formatHelp(reg)).toMatch(/No slash commands/);
  });

  it("surfaces canonical /model-provider and alias /provider together", () => {
    const cmds: SlashCommand[] = [
      {
        name: "model-provider",
        aliases: ["provider"],
        description: "Switch provider",
        execute: async () => ({ kind: "skip" }),
      },
    ];
    const reg: CommandRegistry = { list: () => cmds, find: () => undefined };
    expect(formatHelp(reg)).toContain("/model-provider, /provider");
  });

  it("groups only retained built-in categories before custom commands", () => {
    const cmds: SlashCommand[] = [
      {
        name: "help",
        description: "help",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "skills",
        description: "skills",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "clear",
        description: "clear",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "custom",
        description: "custom",
        execute: async () => ({ kind: "skip" }),
      },
    ];
    const reg: CommandRegistry = { list: () => cmds, find: () => undefined };
    expect(groupHelpCommands(reg.list()).map((group) => group.title)).toEqual([
      "Getting Started",
      "Configuration",
      "Session",
      "Other Commands",
    ]);
  });

  it("default help lists only the minimal slash registry", () => {
    const registry = buildDefaultRegistry();
    const text = formatHelp(registry);

    expect(countCanonicalCommandLines(text, "help")).toBe(1);
    expect(countCanonicalCommandLines(text, "diff")).toBe(1);
    expect(text).not.toContain("/reload-plugins");
    expect(text).not.toContain("/agents");
    expect(text).not.toContain("/files");
    expect(text).not.toContain("Diagnostics:");
  });

  it("helpCommand does not expand project skills into slash help", async () => {
    setGlobalCommandRegistry(buildDefaultRegistry());
    const res = await helpCommand.execute(makeCtx({ cwd: "/tmp/project" }));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Getting Started:");
      expect(res.text).toContain("/help - Show help and available commands");
      expect(res.text).not.toContain("Custom Commands:");
    }
  });

  it("formats custom commands separately when built-in names are supplied", () => {
    const text = formatHelpCommands(
      [
        { name: "help", description: "help" },
        {
          name: "team-skill",
          description: "Team skill",
          type: "prompt",
          source: "bundled",
        },
      ],
      { builtInCommandNames: new Set(["help"]) },
    );
    expect(text).toContain("Getting Started:");
    expect(text).toContain("/help - help");
    expect(text).toContain("Custom Commands:");
    expect(text).toContain("/team-skill - Team skill (bundled)");
  });
});

function countCanonicalCommandLines(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^\\s*/${escaped}(?:[,\\s]|$)`);
  return text
    .split("\n")
    .filter((candidate) => line.test(candidate)).length;
}
