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
import { registerCommandProvider, type Command } from "../commands.js";

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

  it("formats commands grouped by category with aliases", () => {
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
        name: "alpha",
        aliases: ["a"],
        description: "first letter",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "config",
        description: "configure AgenC",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "doctor",
        isEnabled: () => false,
        description: "disabled",
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
    const text = formatHelp(reg);
    expect(text).toContain("Getting Started:");
    expect(text).toContain("Configuration:");
    expect(text).toContain("Other Commands:");
    expect(text).toMatch(/\/status - show status/);
    expect(text).toMatch(/\/config - configure AgenC/);
    expect(text).toMatch(/\/alpha, \/a/);
    expect(text).toMatch(/\/zeta/);
    expect(text).not.toMatch(/\/middle/); // hidden
    expect(text).not.toMatch(/\/doctor/); // disabled
    const idxStatus = text.indexOf("Getting Started:");
    const idxConfig = text.indexOf("Configuration:");
    const idxOther = text.indexOf("Other Commands:");
    expect(idxStatus).toBeLessThan(idxConfig);
    expect(idxConfig).toBeLessThan(idxOther);
    const idxAlpha = text.indexOf("/alpha");
    const idxZeta = text.indexOf("/zeta");
    expect(idxAlpha).toBeLessThan(idxZeta);
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

  it("formatHelp produces stable ordering across registry order changes", () => {
    const a: SlashCommand = {
      name: "a",
      description: "a desc",
      execute: async () => ({ kind: "skip" }),
    };
    const b: SlashCommand = {
      name: "b",
      description: "b desc",
      execute: async () => ({ kind: "skip" }),
    };
    const usage: SlashCommand = {
      name: "usage",
      description: "usage desc",
      execute: async () => ({ kind: "skip" }),
    };
    const left: CommandRegistry = {
      list: () => [b, usage, a],
      find: () => undefined,
    };
    const right: CommandRegistry = {
      list: () => [a, b, usage],
      find: () => undefined,
    };
    expect(formatHelp(left)).toBe(formatHelp(right));
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

  it("exposes grouped commands for slash palettes and text help", () => {
    const cmds: SlashCommand[] = [
      {
        name: "usage",
        description: "usage",
        execute: async () => ({ kind: "skip" }),
      },
      {
        name: "help",
        description: "help",
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
      "Diagnostics",
      "Other Commands",
    ]);
  });

  it("lists /files with visible default registry commands", () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
      const registry = buildDefaultRegistry();
      const visibleNames = registry
        .list()
        .filter(
          (command) =>
            command.userInvocable !== false && command.isEnabled?.() !== false,
        )
        .map((command) => command.name);
      const text = formatHelp(registry);
      expect(visibleNames).toContain("files");
      expect(text).toContain("Context & Files:");
      expect(countCanonicalCommandLines(text, "files")).toBe(1);
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
    }
  });

  it("helpCommand includes custom commands from the full command surface", async () => {
    const unregister = registerCommandProvider(() => [
      promptCommand({
        name: "project-skill",
        description: "Project skill",
        source: "plugin",
      }),
    ]);
    try {
      setGlobalCommandRegistry(buildDefaultRegistry());
      const res = await helpCommand.execute(makeCtx({ cwd: "/tmp/project" }));
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toContain("Custom Commands:");
        expect(res.text).toContain("/project-skill - Project skill (plugin)");
        expect(res.text).toContain("Getting Started:");
        expect(res.text).toContain("/help - Show help and available commands");
      }
    } finally {
      unregister();
    }
  });

  it("formats custom commands separately when built-in names are supplied", () => {
    const text = formatHelpCommands(
      [
        { name: "usage", description: "usage" },
        {
          name: "team-skill",
          description: "Team skill",
          type: "prompt",
          source: "bundled",
        },
      ],
      { builtInCommandNames: new Set(["usage"]) },
    );
    expect(text).toContain("Diagnostics:");
    expect(text).toContain("/usage - usage");
    expect(text).toContain("Custom Commands:");
    expect(text).toContain("/team-skill - Team skill (bundled)");
  });
});

function promptCommand(overrides: Partial<Command> = {}): Command {
  return {
    type: "prompt",
    name: "skill-alpha",
    description: "Alpha skill",
    progressMessage: "running",
    contentLength: 10,
    getPromptForCommand: async () => [],
    ...overrides,
  } as Command;
}

function countCanonicalCommandLines(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^\\s*/${escaped}(?:[,\\s]|$)`);
  return text
    .split("\n")
    .filter((candidate) => line.test(candidate)).length;
}
