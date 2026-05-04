import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  BRIDGE_SAFE_COMMANDS,
  filterCommandsForRemoteMode,
  formatDescriptionWithSource,
  getCommands,
  getCommandsSync,
  getMcpSkillCommands,
  getSkillToolCommands,
  getSlashCommandToolSkills,
  isBridgeSafeCommand,
  registerCommandProvider,
  REMOTE_SAFE_COMMANDS,
  type Command,
} from "../commands.js";
import { buildDefaultRegistry } from "./registry.js";
import { applyReasoningEffort } from "./effort.js";
import { collectContextFiles } from "./files.js";
import { loadReleaseNotes } from "./release-notes.js";
import { reloadPluginSurfaces } from "./reload-plugins.js";
import { handleWikiCommand } from "./wiki.js";
import type { SlashCommandContext } from "./types.js";

function fakeSession(overrides: {
  state?: Record<string, unknown>;
  services?: Record<string, unknown>;
  budgetTracker?: Record<string, unknown>;
} = {}) {
  const state = {
    sessionConfiguration: {
      cwd: "/tmp/project",
      provider: { slug: "xai" },
      collaborationMode: { model: "grok-4" },
    },
    history: [],
    ...overrides.state,
  };
  const services = {
    registry: { tools: [{ name: "read" }, { name: "exec" }] },
    mcpManager: { getConnectedServers: () => ["local"] },
    skillsManager: { clearSkillCaches: vi.fn() },
    configStore: { agencHome: "/tmp/agenc", current: () => ({}) },
    ...overrides.services,
  };
  return {
    conversationId: "session-1",
    state: {
      unsafePeek: () => state,
      with: async (fn: (value: typeof state) => void) => fn(state),
    },
    services,
    budgetTracker: overrides.budgetTracker ?? { emitted: 10, remaining: 90 },
  } as never;
}

function fakeContext(cwd: string, session = fakeSession()): SlashCommandContext {
  return {
    session,
    argsRaw: "",
    cwd,
    home: cwd,
    agencHome: join(cwd, ".agenc"),
  };
}

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

describe("AgenC command surface compatibility", () => {
  it("registers the first T-10 absorbed command batch", () => {
    const names = buildDefaultRegistry().list().map(command => command.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "cache-stats",
        "cost",
        "doctor",
        "effort",
        "files",
        "release-notes",
        "reload-plugins",
        "stats",
        "usage",
        "wiki",
      ]),
    );
  });

  it("keeps remote filtering independent of object identity", () => {
    const commands = getCommandsSync().map(command => ({ ...command }));
    const filteredNames = filterCommandsForRemoteMode(commands).map(
      command => command.name,
    );
    expect(filteredNames).toEqual(
      expect.arrayContaining(["help", "cost", "usage"]),
    );
    expect(filteredNames).not.toContain("doctor");
  });

  it("keeps exported command allowlists compatible with stable command instances", () => {
    const commands = getCommandsSync();
    const help = commands.find(command => command.name === "help");
    const files = commands.find(command => command.name === "files");
    expect(help).toBeDefined();
    expect(files).toBeDefined();
    expect(REMOTE_SAFE_COMMANDS.has(help!)).toBe(true);
    expect(BRIDGE_SAFE_COMMANDS.has(files!)).toBe(true);
  });

  it("uses bridge-safe names for local commands and allows prompt commands", () => {
    const commands = getCommandsSync();
    expect(isBridgeSafeCommand(commands.find(command => command.name === "files")!)).toBe(true);
    expect(isBridgeSafeCommand(commands.find(command => command.name === "doctor")!)).toBe(false);
    expect(isBridgeSafeCommand(promptCommand())).toBe(true);
  });

  it("discovers dynamic prompt commands through compatibility providers", async () => {
    const pluginSkill = promptCommand({
      name: "plugin-skill",
      pluginInfo: { pluginManifest: { name: "ops" } },
    });
    const bundledSkill = promptCommand({
      name: "bundled-skill",
      source: "bundled",
      loadedFrom: "bundled",
    });
    const unregister = registerCommandProvider(() => [pluginSkill, bundledSkill]);
    try {
      await expect(getCommands("/tmp")).resolves.toEqual(
        expect.arrayContaining([pluginSkill, bundledSkill]),
      );
      await expect(getSkillToolCommands("/tmp")).resolves.toEqual(
        expect.arrayContaining([pluginSkill, bundledSkill]),
      );
      await expect(getSlashCommandToolSkills("/tmp")).resolves.toEqual(
        expect.arrayContaining([pluginSkill, bundledSkill]),
      );
      expect(formatDescriptionWithSource(pluginSkill)).toBe("(ops) Alpha skill");
      expect(formatDescriptionWithSource(bundledSkill)).toBe("Alpha skill (bundled)");
    } finally {
      unregister();
    }
  });

  it("filters MCP skill commands to model-invocable MCP prompts", () => {
    const active = promptCommand({ name: "mcp-active", source: "mcp", loadedFrom: "mcp" });
    const disabled = promptCommand({
      name: "mcp-disabled",
      source: "mcp",
      loadedFrom: "mcp",
      disableModelInvocation: true,
    });
    const local = promptCommand({ name: "local-skill", loadedFrom: "skills" });
    expect(getMcpSkillCommands([active, disabled, local])).toEqual([active]);
  });
});

describe("absorbed T-10 command behavior", () => {
  it("sets reasoning effort on the session configuration", async () => {
    const session = fakeSession();
    await expect(applyReasoningEffort(session, "high")).resolves.toContain("high");
    expect(
      (session as any).state.unsafePeek().sessionConfiguration.collaborationMode
        .reasoningEffort,
    ).toBe("high");
  });

  it("collects file references from session history", () => {
    const session = fakeSession({
      state: {
        history: [
          { type: "file", path: "/tmp/project/src/index.ts" },
          { content: [{ type: "text", text: "plain text" }] },
        ],
      },
    });
    expect(collectContextFiles(session)).toEqual(["/tmp/project/src/index.ts"]);
  });

  it("loads local release notes from the checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-release-"));
    await writeFile(join(dir, "CHANGELOG.md"), "# Changes\n\n- one\n", "utf8");
    await expect(loadReleaseNotes(dir)).resolves.toContain("- one");
  });

  it("initializes and reports project wiki state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-wiki-"));
    await expect(handleWikiCommand(dir, "status")).resolves.toContain("not initialized");
    await expect(handleWikiCommand(dir, "init")).resolves.toContain("initialized");
    await expect(readFile(join(dir, ".agenc", "wiki", "README.md"), "utf8"))
      .resolves.toContain("AgenC Project Wiki");
  });

  it("clears skill caches and refreshes MCP config on reload", async () => {
    const clearSkillCaches = vi.fn();
    const refreshFromConfig = vi.fn(async () => undefined);
    const session = fakeSession({
      services: {
        skillsManager: { clearSkillCaches },
        mcpManager: { refreshFromConfig },
      },
    });
    await expect(reloadPluginSurfaces(fakeContext("/tmp", session))).resolves
      .toContain("skill caches cleared");
    expect(clearSkillCaches).toHaveBeenCalledOnce();
    expect(refreshFromConfig).toHaveBeenCalledOnce();
  });
});
