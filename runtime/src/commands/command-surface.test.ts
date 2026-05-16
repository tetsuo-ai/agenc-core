import { describe, expect, it, vi } from "vitest";

import {
  BRIDGE_SAFE_COMMANDS,
  REMOTE_SAFE_COMMANDS,
  builtInCommandNames,
  clearCommandMemoizationCaches,
  filterCommandsForRemoteMode,
  formatDescriptionWithSource,
  getCommands,
  getCommandsSync,
  isBridgeSafeCommand,
  registerCommandProvider,
  type Command,
} from "../commands.js";
import { buildDefaultRegistry } from "./registry.js";
import {
  dispatchSlashCommand,
  parseSlashCommand,
  type DispatchOutcome,
} from "./dispatcher.js";
import type { SlashCommandContext } from "./types.js";

const MINIMAL_NAMES = [
  "help",
  "status",
  "model",
  "model-provider",
  "permissions",
  "plan",
  "agents",
  "tasks",
  "config",
  "hooks",
  "skills",
  "mcp",
  "clear",
  "compact",
  "diff",
  "exit",
] as const;

function promptCommand(overrides: Partial<Command> = {}): Command {
  return {
    type: "prompt",
    name: "skill-alpha",
    description: "Alpha skill",
    progressMessage: "working",
    contentLength: 10,
    source: "plugin",
    loadedFrom: "plugin",
    hasUserSpecifiedDescription: true,
    getPromptForCommand: async () => [],
    ...overrides,
  } as Command;
}

function fakeContext(cwd: string): SlashCommandContext {
  return {
    session: {
      conversationId: "session-1",
      services: {
        skillsManager: {
          resolveSkill: vi.fn(async (name: string) =>
            name === "project-skill"
              ? { name: "project-skill", userInvocable: true }
              : null,
          ),
          renderSkill: vi.fn(async () => ({
            skill: { name: "project-skill", path: "/tmp/SKILL.md" },
            content: "skill body",
          })),
        },
      },
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd,
    home: cwd,
    agencHome: `${cwd}/.agenc`,
  };
}

async function dispatchLine(line: string, cwd: string): Promise<DispatchOutcome> {
  const parsed = parseSlashCommand(line);
  expect(parsed).not.toBeNull();
  return dispatchSlashCommand(parsed!, fakeContext(cwd), buildDefaultRegistry());
}

describe("AgenC command surface compatibility", () => {
  it("uses the minimal retained runtime registry", () => {
    expect(buildDefaultRegistry().list().map((command) => command.name)).toEqual(
      MINIMAL_NAMES,
    );
    expect(getCommandsSync().map((command) => command.name)).toEqual(
      MINIMAL_NAMES,
    );
  });

  it("exposes retained slash commands through built-in names", () => {
    const names = builtInCommandNames();

    expect(names.has("help")).toBe(true);
    expect(names.has("provider")).toBe(true);
    expect(names.has("agents")).toBe(true);
    expect(names.has("tasks")).toBe(true);
    expect(names.has("jobs")).toBe(true);
    expect(names.has("plan")).toBe(true);
    expect(names.has("files")).toBe(false);
    expect(names.has("reload-plugins")).toBe(false);
  });

  it("keeps remote and bridge allowlists on the minimal command set", () => {
    const commands = getCommandsSync();
    const byName = new Map(commands.map((command) => [command.name, command]));

    expect(filterCommandsForRemoteMode(commands).map((command) => command.name)).toEqual([
      "help",
      "status",
      "model",
      "model-provider",
      "clear",
      "exit",
    ]);
    expect(REMOTE_SAFE_COMMANDS.has(byName.get("help")!)).toBe(true);
    expect(REMOTE_SAFE_COMMANDS.has(byName.get("permissions")!)).toBe(false);
    expect(BRIDGE_SAFE_COMMANDS.has(byName.get("diff")!)).toBe(true);
    expect(isBridgeSafeCommand(byName.get("diff")!)).toBe(true);
    expect(isBridgeSafeCommand(byName.get("compact")!)).toBe(false);
  });

  it("keeps custom command providers model-facing without adding TUI slash commands", async () => {
    const unregister = registerCommandProvider(() => [
      promptCommand({ name: "project-skill" }),
    ]);
    try {
      const commands = await getCommands("/tmp/project");
      const names = commands.map((command) => command.name);

      expect(names).toContain("project-skill");
      expect(names).toContain("help");
      expect(getCommandsSync().map((command) => command.name)).not.toContain(
        "project-skill",
      );
    } finally {
      unregister();
    }
  });

  it("unknown skill slash syntax is rejected instead of expanded", async () => {
    const outcome = await dispatchLine("/project-skill arg", "/tmp/project");

    expect(outcome.result).toEqual({
      kind: "error",
      message: "Unknown command: /project-skill",
    });
  });

  it("daemon TUI registry rejects runtime-only command dispatch", async () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });
    const parsed = parseSlashCommand("/model qwen3.6-27b-fp8");
    expect(parsed).not.toBeNull();

    const outcome = await dispatchSlashCommand(
      parsed!,
      fakeContext("/tmp/project"),
      registry,
    );

    expect(outcome.result).toEqual({
      kind: "error",
      message: "Unknown command: /model",
    });
  });

  it("clearCommandMemoizationCaches remains the non-throwing cache reset API", () => {
    expect(() => clearCommandMemoizationCaches()).not.toThrow();
  });

  it("formats plugin and bundled command descriptions for model-facing surfaces", () => {
    expect(
      formatDescriptionWithSource(
        promptCommand({
          name: "plugin-skill",
          description: "Plugin skill",
          source: "plugin",
          pluginInfo: { pluginManifest: { name: "sample" } },
        }),
      ),
    ).toBe("(sample) Plugin skill");
    expect(
      formatDescriptionWithSource(
        promptCommand({
          name: "bundled-skill",
          description: "Bundled skill",
          source: "bundled",
        }),
      ),
    ).toBe("Bundled skill (bundled)");
  });
});
