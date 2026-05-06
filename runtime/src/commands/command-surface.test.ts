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
import { formatCacheStats } from "./cache-stats.js";
import { collectContextFiles } from "./files.js";
import { loadReleaseNotes } from "./release-notes.js";
import { formatRuntimeStats } from "./stats.js";
import { formatUsage } from "./usage.js";
import { collectDoctorChecks, formatDoctorReport } from "./doctor.js";
import {
  reloadPluginSurfaces,
  setActivePluginRefresherForTesting,
  setRemoteSettingsSyncForTesting,
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
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { createSessionAppStateBridge } from "../tui/session-app-state.js";

interface CacheStatsTrackerForTest {
  recordRequest(
    metrics: {
      readonly read: number;
      readonly created: number;
      readonly total: number;
      readonly hitRate: number | null;
      readonly supported: boolean;
    },
    label: string,
  ): void;
  resetSessionCacheStats(): void;
}

async function loadCacheStatsTrackerForTest(): Promise<CacheStatsTrackerForTest> {
  const trackerModulePath: string =
    "../agenc/upstream/services/api/cacheStatsTracker.js";
  return import(trackerModulePath) as Promise<CacheStatsTrackerForTest>;
}

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
    nextInternalSubId: () => "sub-1",
    emit: vi.fn(),
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

  it("preserves non-interactive and enablement metadata on projected built-ins", async () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
      const commands = getCommandsSync();
      const reloadPlugins = commands.find(command => command.name === "reload-plugins");
      const files = commands.find(command => command.name === "files");
      const keybindings = commands.find(command => command.name === "keybindings");
      expect(reloadPlugins?.type).toBe("local");
      expect(reloadPlugins?.supportsNonInteractive).toBe(false);
      expect(files?.supportsNonInteractive).toBe(true);
      expect(files?.isEnabled?.()).toBe(false);
      expect(keybindings?.supportsNonInteractive).toBe(false);

      await expect(getCommands("/tmp")).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "files" })]),
      );
      process.env.USER_TYPE = "ant";
      await expect(getCommands("/tmp")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "files" })]),
      );
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
    }
  });

  it("publishes the live AppState setter alongside model and expanded-view setters", () => {
    const setModel = vi.fn();
    const setExpandedView = vi.fn();
    let state = { value: 1 } as never;
    const setAppState = vi.fn((updater: (prev: never) => never) => {
      state = updater(state);
    });

    const bridge = createSessionAppStateBridge(
      setModel,
      setExpandedView,
      setAppState,
    );

    bridge.setModel?.("grok-4");
    bridge.setExpandedView?.("tasks");
    bridge.setAppState?.((prev) => ({
      ...(prev as Record<string, unknown>),
      value: 2,
    }));

    expect(setModel).toHaveBeenCalledWith("grok-4");
    expect(setExpandedView).toHaveBeenCalledWith("tasks");
    expect(setAppState).toHaveBeenCalledOnce();
    expect(state).toEqual({ value: 2 });
  });

  it("rejects disabled commands through the runtime dispatcher", async () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
      const outcome = await dispatchLine("/files", "/tmp/project");
      expect(outcome.result.kind).toBe("error");
      if (outcome.result.kind === "error") {
        expect(outcome.result.message).toContain("disabled");
      }
      process.env.USER_TYPE = "ant";
      await expect(dispatchLine("/files", "/tmp/project")).resolves.toMatchObject({
        result: { kind: "text", text: "No files in context." },
      });
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
    }
  });

  it("does not mis-map prompt results through the legacy local adapter", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "default" }),
    );
    const session = fakeSession({
      services: { permissionModeRegistry: registry },
    });
    const plan = getCommandsSync().find(command => command.name === "plan");
    expect(plan?.type).toBe("local");
    const loaded = await (plan as Extract<Command, { type: "local" }>).load();
    await expect(
      loaded.call("design the cache", {
        session,
        cwd: "/tmp/project",
        home: "/tmp",
        agencHome: "/tmp/agenc",
      }),
    ).rejects.toThrow(/follow-up prompt/);
    expect(registry.current().mode).toBe("plan");
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

  it("discovers bundled and plugin skills without compatibility providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-plugin-skills-"));
    const pluginSkillDir = join(
      dir,
      ".agents",
      "plugins",
      "ops",
      "skills",
      "plugin-demo",
    );
    await mkdir(pluginSkillDir, { recursive: true });
    await writeFile(
      join(pluginSkillDir, "SKILL.md"),
      [
        "---",
        "description: Demo plugin skill",
        "when_to_use: Use for plugin command tests",
        "---",
        "Plugin demo skill.",
      ].join("\n"),
      "utf8",
    );

    clearCommandMemoizationCaches();
    const disabledCommands = await getCommands(dir, {
      plugins: { enabled: false },
    });
    expect(disabledCommands.find(command => command.name === "plugin-demo"))
      .toBeUndefined();

    const commands = await getCommands(dir, {
      plugins: { enabled: true },
    });
    expect(commands.find(command => command.name === "debug")?.loadedFrom)
      .toBe("bundled");
    expect(commands.find(command => command.name === "plugin-demo")).toMatchObject({
      type: "prompt",
      loadedFrom: "plugin",
      description: "Demo plugin skill",
    });

    const disabledAfterEnabled = await getCommands(dir, {
      plugins: { enabled: false },
    });
    expect(disabledAfterEnabled.find(command => command.name === "plugin-demo"))
      .toBeUndefined();
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

  it("returns an explicit release-notes fallback when no local notes exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-release-empty-"));
    await expect(loadReleaseNotes(dir)).resolves.toBe(
      "No local release notes were found for this checkout.",
    );
  });

  it("formats cache stats from tracker-backed request history", async () => {
    let tracker: CacheStatsTrackerForTest;
    try {
      tracker = await loadCacheStatsTrackerForTest();
    } catch {
      await expect(formatCacheStats()).resolves.toContain("Cache stats");
      return;
    }
    tracker.resetSessionCacheStats();
    try {
      tracker.recordRequest(
        {
          read: 1_200,
          created: 300,
          total: 2_000,
          hitRate: 0.6,
          supported: true,
        },
        "grok-4",
      );
      tracker.recordRequest(
        {
          read: 0,
          created: 0,
          total: 0,
          hitRate: null,
          supported: false,
        },
        "local-provider",
      );
      const text = await formatCacheStats();
      expect(text).toContain("Current turn:");
      expect(text).toContain("Session total:");
      expect(text).toContain("read=1.2k");
      expect(text).toContain("created=300");
      expect(text).toContain("hit=60%");
      expect(text).toContain("Recent requests (2):");
      expect(text).toContain("grok-4");
      expect(text).toContain("[Cache: N/A]");
      expect(text).toContain("N/A rows: provider API does not expose cache usage.");
    } finally {
      tracker.resetSessionCacheStats();
    }
  });

  it("formats usage, stats, and doctor output with concrete runtime values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-command-output-"));
    const session = fakeSession({
      state: {
        history: [{ id: 1 }, { id: 2 }],
        totalTokenUsage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 3,
        },
      },
      budgetTracker: { emitted: 25, remaining: 75 },
    });

    expect(formatUsage(session)).toContain("total tokens: 15");
    expect(formatUsage(session)).toContain("budget remaining: 75");
    expect(formatRuntimeStats(session, dir)).toContain("transcript items: 2");
    expect(formatRuntimeStats(session, dir)).toContain("registered tools: 2");
    const doctorReport = formatDoctorReport(
      collectDoctorChecks(fakeContext(dir, session)),
    );
    expect(doctorReport).toContain("AgenC doctor");
    expect(doctorReport).toContain("provider: xai / grok-4");
    expect(doctorReport).toContain(`working directory: ${dir}`);
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

  it("clears skill caches, refreshes active plugin surfaces, and refreshes MCP/LSP config", async () => {
    const clearSkillCaches = vi.fn();
    const refreshFromConfig = vi.fn(async () => undefined);
    const refreshLspFromConfig = vi.fn(async () => undefined);
    const baseConfig = {
      mcp_servers: {
        base: { command: "node", args: ["base.js"] },
      },
      lsp_servers: {
        base: {
          command: "node",
          args: ["base-lsp.js"],
          extensionToLanguage: { ".ts": "typescript" },
        },
      },
    };
    const refreshActivePlugins = vi.fn(async () => ({
      enabled_count: 1,
      disabled_count: 0,
      command_count: 2,
      agent_count: 3,
      hook_count: 4,
      mcp_count: 5,
      lsp_count: 6,
      output_style_count: 7,
      error_count: 0,
      mcp_servers: {
        "plugin:sample:local": { command: "node", args: ["plugin.js"] },
      },
      lsp_servers: {
        "plugin:sample:typescript": {
          command: "node",
          args: ["plugin-lsp.js"],
          extensionToLanguage: { ".ts": "typescript" },
        },
      },
    }));
    const restore = setActivePluginRefresherForTesting(refreshActivePlugins);
    const session = fakeSession({
      services: {
        skillsManager: { clearSkillCaches },
        mcpManager: { refreshFromConfig },
        lspManager: { refreshFromConfig: refreshLspFromConfig },
        configStore: { current: () => baseConfig },
      },
    });
    try {
      const summary = await reloadPluginSurfaces(fakeContext("/tmp", session));
      expect(summary).toContain("2 skill commands");
      expect(summary).toContain("7 plugin output styles");
      expect(clearSkillCaches).toHaveBeenCalled();
      expect(refreshActivePlugins).toHaveBeenCalledOnce();
      expect(refreshFromConfig).toHaveBeenCalledOnce();
      expect(refreshFromConfig).toHaveBeenCalledWith({
        mcp_servers: {
          ...baseConfig.mcp_servers,
          "plugin:sample:local": { command: "node", args: ["plugin.js"] },
        },
        lsp_servers: {
          ...baseConfig.lsp_servers,
          "plugin:sample:typescript": {
            command: "node",
            args: ["plugin-lsp.js"],
            extensionToLanguage: { ".ts": "typescript" },
          },
        },
      });
      expect(refreshLspFromConfig).toHaveBeenCalledOnce();
      expect(refreshLspFromConfig).toHaveBeenCalledWith({
        mcp_servers: {
          ...baseConfig.mcp_servers,
          "plugin:sample:local": { command: "node", args: ["plugin.js"] },
        },
        lsp_servers: {
          ...baseConfig.lsp_servers,
          "plugin:sample:typescript": {
            command: "node",
            args: ["plugin-lsp.js"],
            extensionToLanguage: { ".ts": "typescript" },
          },
        },
      });
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
        output_style_count: 0,
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

  it("redownloads remote user settings before refreshing plugin surfaces", async () => {
    const order: string[] = [];
    const redownloadUserSettings = vi.fn(async () => {
      order.push("settings");
      return true;
    });
    const notifySettingsChange = vi.fn(() => {
      order.push("notify");
    });
    const refreshActivePlugins = vi.fn(async () => {
      order.push("plugins");
      return {
        enabled_count: 0,
        disabled_count: 0,
        command_count: 0,
        agent_count: 0,
        hook_count: 0,
        mcp_count: 0,
        lsp_count: 0,
        output_style_count: 0,
        error_count: 0,
      };
    });
    const previousRemote = process.env.AGENC_REMOTE;
    const restoreSync = setRemoteSettingsSyncForTesting({
      redownloadUserSettings,
      notifySettingsChange,
    });
    const restoreRefresh = setActivePluginRefresherForTesting(refreshActivePlugins);
    try {
      process.env.AGENC_REMOTE = "1";
      await reloadPluginSurfaces(fakeContext("/tmp"));
      expect(redownloadUserSettings).toHaveBeenCalledOnce();
      expect(notifySettingsChange).toHaveBeenCalledWith("userSettings");
      expect(refreshActivePlugins).toHaveBeenCalledOnce();
      expect(order).toEqual(["settings", "notify", "plugins"]);
    } finally {
      restoreRefresh();
      restoreSync();
      if (previousRemote === undefined) {
        delete process.env.AGENC_REMOTE;
      } else {
        process.env.AGENC_REMOTE = previousRemote;
      }
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
      output_style_count: 0,
      error_count: 0,
    }));
    const previousUserType = process.env.USER_TYPE;
    try {
      process.env.USER_TYPE = "ant";
      const expectations = new Map([
        ["/cache-stats", "Cache stats"],
        ["/cost", "Cost tracking is not enabled"],
        ["/doctor", "AgenC doctor"],
        ["/effort high", "Reasoning effort set to high"],
        ["/files", "No files in context."],
        ["/release-notes", "- shipped"],
        ["/reload-plugins", "Reloaded plugin surfaces:"],
        ["/stats", "registered tools: 2"],
        ["/usage", "total tokens: 15"],
        ["/wiki status", "not initialized"],
      ]);
      for (const [line, expectedText] of expectations) {
        const outcome = await dispatchLine(line, dir, session);
        expect(outcome.result.kind, line).toBe("text");
        if (outcome.result.kind === "text") {
          expect(outcome.result.text, line).toContain(expectedText);
        }
      }
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
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
