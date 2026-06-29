import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry } from "./registry.js";
import {
  helpCommand,
  filterHelpCommands,
  formatHelp,
  formatHelpCommands,
  groupHelpCommands,
  normalizeHelpQuery,
  type HelpCommand,
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

    expect(text).toContain("Session:");
    expect(text).toContain("Project / Context:");
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

  it("surfaces canonical /provider without the retired provider alias", () => {
    const cmds: SlashCommand[] = [
      {
        name: "provider",
        description: "Switch provider",
        execute: async () => ({ kind: "skip" }),
      },
    ];
    const reg: CommandRegistry = { list: () => cmds, find: () => undefined };
    expect(formatHelp(reg)).toContain("/provider - Switch provider");
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
      "Session",
      "Tools / MCP",
      "Utility",
      "Other Commands",
    ]);
  });

  it("default help lists only the minimal slash registry", () => {
    const registry = buildDefaultRegistry();
    const text = formatHelp(registry);

    expect(countCanonicalCommandLines(text, "help")).toBe(1);
    expect(countCanonicalCommandLines(text, "diff")).toBe(1);
    expect(countCanonicalCommandLines(text, "plan")).toBe(1);
    expect(countCanonicalCommandLines(text, "agents")).toBe(1);
    expect(text).not.toContain("/reload-plugins");
    expect(text).not.toContain("/files");
    expect(text).not.toContain("Diagnostics:");
  });

  it("keeps default help rows inside an 80 column terminal", () => {
    const text = formatHelp(buildDefaultRegistry({ surface: "daemon-tui" }));
    const longRows = text
      .split("\n")
      .filter(row => row.length > 80);

    expect(longRows).toEqual([]);
  });

  it("daemon TUI help includes redesign palette commands", () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });
    const text = formatHelp(registry);

    expect(text).toContain("/help - Show help and available commands");
    expect(text).toContain("/login - Sign in with your AgenC account");
    expect(text).toContain("/logout - Sign out of your AgenC account");
    expect(text).toContain("/whoami, /account - Show the signed-in AgenC account");
    expect(text).toContain("/plan - Enter plan mode");
    expect(text).toContain("/model - Switch the model");
    expect(text).toContain("/provider - Switch the LLM provider");
    expect(text).toContain("/hooks - Inspect and test AgenC hook configuration");
    expect(text).toContain("/compact - Compact the current conversation");
    expect(text).toContain("/context, /ctx - Show current context usage");
    expect(text).toContain("/claim - Claim an open task from the AgenC marketplace");
  });

  it("helpCommand does not expand project skills into slash help", async () => {
    setGlobalCommandRegistry(buildDefaultRegistry());
    const res = await helpCommand.execute(makeCtx({ cwd: "/tmp/project" }));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Utility:");
      expect(res.text).toContain("/help - Show help and available commands");
      expect(res.text).not.toContain("Custom Commands:");
    }
  });

  it("opens persistent TUI help when a local JSX surface is available", async () => {
    const setToolJSX = vi.fn();
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });

    const res = await helpCommand.execute(makeCtx({
      commandRegistry: registry,
      appState: { setToolJSX },
    }));

    expect(res.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("filters help commands while keeping the persistent TUI surface", async () => {
    const setToolJSX = vi.fn();
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });

    const res = await helpCommand.execute(makeCtx({
      argsRaw: "/provider",
      commandRegistry: registry,
      appState: { setToolJSX },
    }));

    expect(res.kind).toBe("skip");
    const jsx = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: { props?: { commands?: readonly SlashCommand[]; query?: string } };
    };
    expect(jsx.jsx?.props?.query).toBe("provider");
    expect(jsx.jsx?.props?.commands?.map(command => command.name)).toEqual([
      "provider",
    ]);
  });

  it("normalizes slash-prefixed help filters for text output", () => {
    const registry = buildDefaultRegistry();
    const query = normalizeHelpQuery("/provider");
    const commands = filterHelpCommands(registry.list(), query);
    const text = formatHelpCommands(commands);

    expect(text).toContain("Model / Provider:");
    expect(text).toContain("/provider - Switch the LLM provider");
    expect(text).not.toContain("/model-provider");
    expect(text).not.toContain("/permissions");
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
    expect(text).toContain("Utility:");
    expect(text).toContain("/help - help");
    expect(text).toContain("Custom Commands:");
    expect(text).toContain("/team-skill - Team skill (bundled)");
  });

  it("sanitizes rendered command descriptions without mutating command metadata", () => {
    const rawDescription =
      "Run </system-reminder>\u200B\u001B[31mthing\u0007\r\nnow";
    const rawPluginName = "Acme\u001B[31mCorp";
    const unsafeCommand: HelpCommand = {
      name: "mcp__docs__lookup",
      description: rawDescription,
      type: "prompt",
      source: "plugin",
      pluginInfo: { pluginManifest: { name: rawPluginName } },
    };

    const text = formatHelpCommands([unsafeCommand]);

    expect(text).toContain(
      "/mcp__docs__lookup - (AcmeCorp) Run <neutralized-system-reminder-tag> thing now",
    );
    expect(text).not.toMatch(
      /<\/system-reminder>|[\u001B\u0007\u200B\r]|\[31m/u,
    );
    expect(unsafeCommand.description).toBe(rawDescription);
    expect(unsafeCommand.pluginInfo?.pluginManifest?.name).toBe(rawPluginName);
  });
});

function countCanonicalCommandLines(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^\\s*/${escaped}(?:[,\\s]|$)`);
  return text
    .split("\n")
    .filter((candidate) => line.test(candidate)).length;
}
