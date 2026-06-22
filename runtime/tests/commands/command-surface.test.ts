import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  "provider",
  "permissions",
  "plan",
  "agents",
  "tasks",
  "config",
  "hooks",
  "skills",
  "mcp",
  "plugins",
  "memory",
  "resume",
  "clear",
  "compact",
  "context",
  "diff",
  "claim",
  "delegate",
  "proof",
  "settle",
  "stake",
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
    expect(names.has("ctx")).toBe(true);
    expect(names.has("plugins")).toBe(true);
    expect(names.has("claim")).toBe(true);
    expect(names.has("files")).toBe(false);
    expect(names.has("reload-plugins")).toBe(false);
    expect(names.has("theme")).toBe(false);
    expect(names.has("color")).toBe(false);
    expect(names.has("ide")).toBe(false);
    expect(names.has("install-github-app")).toBe(false);
    expect(names.has("onboard-github")).toBe(false);
    expect(names.has("terminal-setup")).toBe(false);
    expect(names.has("add-dir")).toBe(false);
    expect(names.has("brief")).toBe(false);
    expect(names.has("export")).toBe(false);
    expect(names.has("sandbox")).toBe(false);
  });

  it("keeps remote and bridge allowlists on the minimal command set", () => {
    const commands = getCommandsSync();
    const byName = new Map(commands.map((command) => [command.name, command]));

    expect(filterCommandsForRemoteMode(commands).map((command) => command.name)).toEqual([
      "help",
      "status",
      "model",
      "provider",
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

  it("treats array-shaped plugin config as malformed for plugin command loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-command-config-"));
    const previousHome = process.env.AGENC_HOME;
    const previousPluginCache = process.env.AGENC_PLUGIN_CACHE_DIR;
    const pluginRoot = join(root, "plugins", "sample-plugin");
    const objectConfig = {
      plugins: {
        enabled: true,
        plugins: {
          sample: { path: pluginRoot },
        },
      },
    };
    const arrayConfig = Object.assign([], objectConfig);

    try {
      process.env.AGENC_HOME = join(root, "home");
      process.env.AGENC_PLUGIN_CACHE_DIR = join(root, "plugin-cache");
      clearCommandMemoizationCaches();
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        commands: {
          deploy: {
            source: "./commands/deploy.md",
            description: "Deploy the project",
          },
        },
      });
      await writeFileAt(
        join(pluginRoot, "commands", "deploy.md"),
        "Deploy $ARGUMENTS\n",
      );

      expect((await getCommands(root, arrayConfig)).map(command => command.name))
        .not.toContain("sample:deploy");
      expect((await getCommands(root, objectConfig)).map(command => command.name))
        .toContain("sample:deploy");
    } finally {
      if (previousHome === undefined) {
        delete process.env.AGENC_HOME;
      } else {
        process.env.AGENC_HOME = previousHome;
      }
      if (previousPluginCache === undefined) {
        delete process.env.AGENC_PLUGIN_CACHE_DIR;
      } else {
        process.env.AGENC_PLUGIN_CACHE_DIR = previousPluginCache;
      }
      clearCommandMemoizationCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unknown skill slash syntax is rejected instead of expanded", async () => {
    const outcome = await dispatchLine("/project-skill arg", "/tmp/project");

    expect(outcome.result).toEqual({
      kind: "error",
      message: "Unknown command: /project-skill",
    });
  });

  it("daemon TUI registry accepts redesign palette command dispatch", async () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });
    const parsed = parseSlashCommand("/model qwen3.6-27b-fp8");
    expect(parsed).not.toBeNull();

    const outcome = await dispatchSlashCommand(
      parsed!,
      fakeContext("/tmp/project"),
      registry,
    );

    expect(outcome.result).toEqual({
      kind: "text",
      text: "Model switching from the TUI is not yet supported when running against the daemon. Set `model` in config.toml or use `agenc config set model <name>`.",
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
