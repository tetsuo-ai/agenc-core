import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  clearCommandMemoizationCaches,
  builtInCommandNames,
  type Command,
} from "../commands.js";
import { buildDefaultRegistry } from "./registry.js";
import {
  applyReasoningEffort,
  clearReasoningEffort,
  formatReasoningEffortStatus,
} from "./effort.js";
import { collectContextFiles } from "./files.js";
import { loadReleaseNotes } from "./release-notes.js";
import {
  reloadPluginSurfaces,
  setActivePluginRefresherForTesting,
} from "./reload-plugins.js";
import { handleWikiCommand } from "./wiki.js";
import type { SlashCommandContext } from "./types.js";
import {
  dispatchSlashCommand,
  parseSlashCommand,
  type DispatchOutcome,
} from "./dispatcher.js";
import {
  clearSessionReadState,
  recordSessionRead,
} from "../tools/system/filesystem.js";

function fakeSession(overrides: {
  conversationId?: string;
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
    conversationId: overrides.conversationId ?? "session-1",
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

async function dispatchLine(
  line: string,
  cwd: string,
  session = fakeSession(),
): Promise<DispatchOutcome> {
  const parsed = parseSlashCommand(line);
  expect(parsed).not.toBeNull();
  return dispatchSlashCommand(parsed!, fakeContext(cwd, session), buildDefaultRegistry());
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

  it("preserves the callable builtInCommandNames shim API for upstream consumers", () => {
    const names = builtInCommandNames();
    expect(names).toBeInstanceOf(Set);
    expect(names.has("help")).toBe(true);
    expect(names.has("provider")).toBe(true);
  });

  it("adapts projected built-in load calls through the AgenC dispatcher", async () => {
    const session = fakeSession();
    const cost = getCommandsSync().find(command => command.name === "cost");
    expect(cost?.type).toBe("local");
    const loaded = await (cost as Extract<Command, { type: "local" }>).load();
    await expect(
      loaded.call("", {
        session,
        cwd: "/tmp/project",
        home: "/tmp",
        agencHome: "/tmp/agenc",
      }),
    ).resolves.toEqual({
      type: "text",
      value: "Cost tracking is not enabled for this session.",
    });
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

  it("discovers project skills through the production local skill loader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-skills-"));
    const skillDir = join(dir, ".agenc", "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "description: Demo local skill",
        "argument-hint: <topic>",
        "---",
        "Use this local skill for project work.",
      ].join("\n"),
      "utf8",
    );

    clearCommandMemoizationCaches();
    const commands = await getCommands(dir);
    const demo = commands.find(command => command.name === "demo");
    expect(demo?.type).toBe("prompt");
    expect(demo?.description).toBe("Demo local skill");
    await expect(demo?.getPromptForCommand?.("testing", {})).resolves.toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("ARGUMENTS: testing"),
      }),
    ]);
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
    expect(formatReasoningEffortStatus(session)).toContain("high");
    await expect(clearReasoningEffort(session)).resolves.toContain("model default");
    expect(formatReasoningEffortStatus(session)).toContain("model default");
  });

  it("lists files from tracked read state instead of path-like history text", () => {
    const conversationId = "files-read-state";
    clearSessionReadState(conversationId);
    recordSessionRead(conversationId, "/tmp/project/src/tracked.ts", {
      content: "tracked",
      timestamp: Date.now(),
      viewKind: "full",
    });
    const session = fakeSession({
      conversationId,
      state: {
        history: [
          { type: "file", path: "/tmp/project/src/not-tracked.ts" },
          { content: [{ type: "text", text: "also mention ./not-real.ts" }] },
        ],
      },
    });
    try {
      expect(collectContextFiles(session)).toEqual([
        "/tmp/project/src/tracked.ts",
      ]);
    } finally {
      clearSessionReadState(conversationId);
    }
  });

  it("loads local release notes from the checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-release-"));
    await writeFile(join(dir, "CHANGELOG.md"), "# Changes\n\n- one\n", "utf8");
    await expect(loadReleaseNotes(dir)).resolves.toContain("- one");
  });

  it("initializes and reports project wiki state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-wiki-"));
    await expect(handleWikiCommand(dir, "status")).resolves.toContain("not initialized");
    await expect(handleWikiCommand(dir, "init")).resolves.toContain("Created files:");
    await expect(readFile(join(dir, ".agenc", "wiki", "schema.md"), "utf8"))
      .resolves.toContain("AgenC Wiki Schema");
    await expect(handleWikiCommand(dir, "status")).resolves.toContain("Pages: 1");
  });

  it("ingests local files into wiki sources and updates the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-wiki-ingest-"));
    await writeFile(join(dir, "notes.md"), "# Notes\n\nImportant runtime notes.\n", "utf8");

    await expect(handleWikiCommand(dir, "ingest notes.md")).resolves
      .toContain("Ingested notes.md");
    const sources = await readdir(join(dir, ".agenc", "wiki", "sources"));
    expect(sources).toHaveLength(1);
    await expect(readFile(join(dir, ".agenc", "wiki", "index.md"), "utf8"))
      .resolves.toContain("sources/");
    await expect(readFile(join(dir, ".agenc", "wiki", "log.md"), "utf8"))
      .resolves.toContain("Ingested `notes.md`");
  });

  it("clears skill caches, refreshes active plugin surfaces, and refreshes MCP config", async () => {
    const clearSkillCaches = vi.fn();
    const refreshFromConfig = vi.fn(async () => undefined);
    const refreshActivePlugins = vi.fn(async () => ({
      enabled_count: 1,
      disabled_count: 0,
      command_count: 2,
      agent_count: 3,
      hook_count: 4,
      mcp_count: 5,
      lsp_count: 6,
      error_count: 0,
    }));
    const restore = setActivePluginRefresherForTesting(refreshActivePlugins);
    const session = fakeSession({
      services: {
        skillsManager: { clearSkillCaches },
        mcpManager: { refreshFromConfig },
      },
    });
    try {
      await expect(reloadPluginSurfaces(fakeContext("/tmp", session))).resolves
        .toContain("2 skill commands");
      expect(clearSkillCaches).toHaveBeenCalled();
      expect(refreshActivePlugins).toHaveBeenCalledOnce();
      expect(refreshFromConfig).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("passes live AppState updates through reload plugin refresh", async () => {
    const refreshActivePlugins = vi.fn(async (ctx: SlashCommandContext) => {
      ctx.appState?.setAppState?.((prev) => ({
        ...(prev as Record<string, unknown>),
        pluginReconnectKey: 1,
      }));
      return {
        enabled_count: 0,
        disabled_count: 0,
        command_count: 0,
        agent_count: 0,
        hook_count: 0,
        mcp_count: 0,
        lsp_count: 0,
        error_count: 0,
      };
    });
    const restore = setActivePluginRefresherForTesting(refreshActivePlugins);
    let appState: Record<string, unknown> = { pluginReconnectKey: 0 };
    try {
      await reloadPluginSurfaces({
        ...fakeContext("/tmp"),
        appState: {
          setAppState: (updater) => {
            appState = updater(appState) as Record<string, unknown>;
          },
        },
      });
      expect(appState.pluginReconnectKey).toBe(1);
    } finally {
      restore();
    }
  });

  it("dispatches the absorbed command batch through the runtime dispatcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-dispatch-"));
    await writeFile(join(dir, "CHANGELOG.md"), "# Changes\n\n- shipped\n", "utf8");
    const session = fakeSession({
      state: {
        history: [{ type: "file", path: join(dir, "src", "index.ts") }],
        totalTokenUsage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 3,
        },
      },
    });
    const restore = setActivePluginRefresherForTesting(async () => ({
      enabled_count: 0,
      disabled_count: 0,
      command_count: 0,
      agent_count: 0,
      hook_count: 0,
      mcp_count: 0,
      lsp_count: 0,
      error_count: 0,
    }));
    try {
      for (const line of [
        "/cache-stats",
        "/cost",
        "/doctor",
        "/effort high",
        "/files",
        "/release-notes",
        "/reload-plugins",
        "/stats",
        "/usage",
        "/wiki status",
      ]) {
        const outcome = await dispatchLine(line, dir, session);
        expect(outcome.result.kind, line).toBe("text");
      }
    } finally {
      restore();
    }
  });

  it("returns command help/errors and performs wiki ingest through dispatcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-dispatch-wiki-"));
    await writeFile(join(dir, "source.md"), "# Source\n\nDispatcher ingest.\n", "utf8");

    await expect(dispatchLine("/effort impossible", dir)).resolves.toMatchObject({
      result: { kind: "error" },
    });
    await expect(dispatchLine("/wiki --help", dir)).resolves.toMatchObject({
      result: { kind: "text", text: expect.stringContaining("Usage: /wiki") },
    });

    const ingested = await dispatchLine("/wiki ingest source.md", dir);
    expect(ingested.result).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Ingested source.md"),
    });
    const sources = await readdir(join(dir, ".agenc", "wiki", "sources"));
    expect(sources).toHaveLength(1);
  });
});
