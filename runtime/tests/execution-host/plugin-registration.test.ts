import { getAgentMemoryDir } from "../../src/tools/AgentTool/agentMemory.js";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import type { Command } from "../../src/commands.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { refreshPluginRegistrations } from "../../src/plugins/registration/manager.js";
import { loadPluginCommands, loadPluginSkills, loadPluginSkillDirectory, setActivePluginCommandSnapshot, setActivePluginSkillSnapshot } from "../../src/plugins/registration/load-plugin-commands.js";
import { loadPluginAgents, setActivePluginAgentSnapshot } from "../../src/plugins/registration/load-plugin-agents.js";
import { loadPluginOutputStyles } from "../../src/plugins/registration/load-plugin-output-styles.js";
import { loadPluginHooks } from "../../src/plugins/registration/load-plugin-hooks.js";
import { loadPluginMcpServers } from "../../src/plugins/registration/mcp-plugin-integration.js";
import { loadPluginLspServers } from "../../src/plugins/registration/lsp-plugin-integration.js";
import { runtimeIdentityKey } from "../../src/plugins/registration/common.js";
import { runWithCanonicalSettingsAuthority, resetCanonicalSettingsAuthorityForTesting } from "../../src/utils/settings/canonicalAuthority.js";
import { TaskFiles } from "./task-files-fixture.js";

const roots: string[] = [];
afterEach(async () => { resetCanonicalSettingsAuthorityForTesting(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-registration-")); roots.push(root); return root;
}
function taskPlugin(files: TaskFiles, root: string, body = "task command") {
  files.put(root + "/.agenc-plugin/plugin.json", JSON.stringify({ name: "library" }));
  files.put(root + "/commands/run.md", "---\nallowed-tools: [Bash(*)]\nmodel: privileged\n---\n" + body);
  files.put(root + "/skills/example/SKILL.md", "---\ndescription: task skill\n---\nTask skill α $ARGUMENTS at ${AGENC_SKILL_DIR}");
  files.put(root + "/agents/helper.md", "---\nname: helper\ndescription: task helper\ntools: [Bash]\nmodel: privileged\n---\nTask helper guidance");
  files.put(root + "/output-styles/style.md", "---\nforce-for-plugin: true\n---\nTask style must not activate");
}
async function prompt(command: Command, args = ""): Promise<string> {
  if (command.type !== "prompt" || !command.getPromptForCommand) throw new Error("Expected prompt command");
  return JSON.stringify(await command.getPromptForCommand(args, {}));
}

describe("plugin registration execution authority", () => {
  test("registers and renders task commands, skills and agents with controller packages at equal paths", async () => {
    const base = await temporary(), workspaceRoot = join(base, "workspace"), pluginStorageRoot = join(workspaceRoot, "plugins");
    const root = join(pluginStorageRoot, "shared"), files = new TaskFiles(); taskPlugin(files, root);
    await mkdir(root + "/.agenc-plugin", { recursive: true }); await mkdir(root + "/skills/example", { recursive: true });
    await mkdir(root + "/output-styles", { recursive: true });
    await writeFile(root + "/.agenc-plugin/plugin.json", JSON.stringify({ name: "operator" }));
    await writeFile(root + "/skills/example/SKILL.md", "Controller skill");
    await writeFile(root + "/output-styles/style.md", "Controller style");
    const options = { workspaceRoot, pluginStorageRoot, executionEnvironment: files.environment(), config: { plugins: { enabled: true } }, readOnly: true };
    const registered = await refreshPluginRegistrations(options);
    expect(registered.loadResult.errors).toEqual([]);
    expect(registered.commands.map((command) => command.name)).toEqual(["library:run"]);
    expect(await prompt(registered.commands[0])).toContain("task command");
    expect(registered.commands[0].executionBinding).toEqual(files.environment().binding);
    if (registered.commands[0].type === "prompt") {
      expect(registered.commands[0].allowedTools).toBeUndefined(); expect(registered.commands[0].model).toBeUndefined();
    }
    expect(registered.skills.map((command) => command.name)).toEqual(["library:example", "operator:example"]);
    expect(await prompt(registered.skills[0], "input")).toContain("Task skill α input at " + root + "/skills/example");
    expect(await prompt(registered.skills[1])).toContain("Controller skill");
    expect(registered.agents[0].getSystemPrompt()).toBe("Task helper guidance");
    expect(registered.agents[0].repositoryControlled).toBe(true);
    expect(registered.agents[0].executionBinding).toEqual(files.environment().binding);
    expect(registered.agents[0].tools).toBeUndefined(); expect(registered.agents[0].model).toBeUndefined();
    expect(registered.outputStyles.map((style) => style.prompt)).toEqual(["Controller style"]);
    expect(files.reads).not.toContain(root + "/output-styles/style.md");
    const task = registered.loadResult.enabled.find((plugin) => plugin.id === "library")!;
    const direct = await loadPluginSkillDirectory(task, root + "/skills/example", pluginStorageRoot, options.executionEnvironment);
    expect(await prompt(direct[0])).toContain("Task skill α");
    files.unavailable = true;
    await expect(prompt(registered.commands[0])).rejects.toMatchObject({ code: "environment_dead" });
    await expect(prompt(direct[0])).rejects.toMatchObject({ code: "environment_dead" });
  });

  test("captures operator plugin task memory before publishing synchronous prompts", async () => {
    const base = await temporary(), workspaceRoot = base + "/workspace", pluginStorageRoot = base + "/installed";
    const root = pluginStorageRoot + "/operator", files = new TaskFiles();
    const memoryPath = getAgentMemoryDir("operator:helper", "project", workspaceRoot) + "MEMORY.md";
    files.put(memoryPath, "Protected plugin memory");
    await mkdir(root + "/.agenc-plugin", { recursive: true }); await mkdir(root + "/agents", { recursive: true });
    await writeFile(root + "/.agenc-plugin/plugin.json", JSON.stringify({ name: "operator" }));
    await writeFile(root + "/agents/helper.md", "---\nname: helper\ndescription: Memory helper\nmemory: project\n---\nOperator role guidance");
    const store = new ConfigStore({ home: base + "/home", cwd: workspaceRoot, projectRoot: workspaceRoot,
      workspaceFilesystem: new ExecutionConfigFilesystem(files.environment()) });
    await store.reload();
    await runWithCanonicalSettingsAuthority(store, async () => {
      const options = { cwd: workspaceRoot, workspaceRoot, pluginStorageRoot, executionEnvironment: files.environment(), config: { plugins: { enabled: true } }, readOnly: true };
      const first = (await loadPluginAgents(options)).find(agent => agent.agentType === "operator:helper")!;
      expect(first.getSystemPrompt()).toContain("Operator role guidance");
      expect(first.getSystemPrompt()).toContain("Protected plugin memory");
      files.put(memoryPath, "Fresh plugin memory");
      const next = (await loadPluginAgents(options)).find(agent => agent.agentType === "operator:helper")!;
      expect(next.getSystemPrompt()).toContain("Fresh plugin memory");
      expect(first.getSystemPrompt()).toContain("Protected plugin memory");
    });
  });

  test("rejects missing, foreign and stale source bindings before reading or registering capabilities", async () => {
    const base = await temporary(), files = new TaskFiles(); taskPlugin(files, "/app/plugins/library");
    const options = { workspaceRoot: "/app", pluginStorageRoot: join(base, "installed"), executionEnvironment: files.environment(),
      config: { plugins: { enabled: true } }, readOnly: true };
    const plugins = (await loadPlugins(options)).enabled;
    const loaders = [loadPluginCommands, loadPluginSkills, loadPluginAgents, loadPluginOutputStyles, loadPluginHooks, loadPluginMcpServers, loadPluginLspServers];
    for (const load of loaders) {
      await expect(load({ ...options, plugins, executionEnvironment: files.environment("d") })).rejects.toMatchObject({ code: "execution_environment_changed" });
      await expect(load({ ...options, plugins, executionEnvironment: files.environment("a", "e") })).rejects.toMatchObject({ code: "execution_environment_changed" });
      await expect(load({ ...options, plugins: [{ ...plugins[0], executionBinding: undefined }] })).rejects.toMatchObject({ code: "invalid_execution_binding" });
      await expect(load({ ...options, plugins: [{ ...plugins[0], contentProvenance: "authority-controlled" }] })).rejects.toMatchObject({ code: "invalid_execution_binding" });
    }
    await expect(loadPluginSkillDirectory(plugins[0], "/app/plugins/library/skills/example", options.pluginStorageRoot))
      .rejects.toMatchObject({ code: "execution_environment_changed" });
  });

  test("active snapshots keep their discovery configuration and refresh task content without crossing /app environments", async () => {
    const base = await temporary(), left = new TaskFiles(), right = new TaskFiles();
    taskPlugin(left, "/app/plugins/library", "left"); taskPlugin(right, "/app/plugins/library", "right");
    const authority = new ConfigStore({ home: join(base, "home"), cwd: base, projectRoot: base });
    await authority.reload();
    await runWithCanonicalSettingsAuthority(authority, async () => {
      const common = { cwd: "/app", pluginStorageRoot: join(base, "installed"), config: { plugins: { enabled: true } }, readOnly: true };
      const first = { ...common, executionEnvironment: left.environment() }, second = { ...common, executionEnvironment: right.environment("d") };
      const initial = await refreshPluginRegistrations(first), other = await refreshPluginRegistrations(second);
      setActivePluginCommandSnapshot(first, initial.commands); setActivePluginCommandSnapshot(second, other.commands);
      setActivePluginSkillSnapshot(first, initial.skills); setActivePluginAgentSnapshot(first, initial.agents);
      expect(runtimeIdentityKey(first)).not.toBe(runtimeIdentityKey(second));
      left.put("/app/plugins/library/commands/run.md", "updated left");
      left.put("/app/plugins/library/skills/example/SKILL.md", "updated skill");
      left.put("/app/plugins/library/agents/helper.md", "updated helper");
      const implicit = { cwd: "/app", pluginStorageRoot: common.pluginStorageRoot, executionEnvironment: first.executionEnvironment };
      expect(await prompt((await loadPluginCommands(implicit))[0])).toContain("updated left");
      expect(await prompt((await loadPluginCommands({ ...implicit, executionEnvironment: second.executionEnvironment }))[0])).toContain("right");
      expect(await prompt((await loadPluginSkills(implicit))[0])).toContain("updated skill");
      expect((await loadPluginAgents(implicit))[0].getSystemPrompt()).toBe("updated helper");
      left.unavailable = true;
      await expect(loadPluginCommands(implicit)).rejects.toMatchObject({ code: "environment_dead" });
      await expect(loadPluginSkills(implicit)).rejects.toMatchObject({ code: "environment_dead" });
      await expect(loadPluginAgents(implicit)).rejects.toMatchObject({ code: "environment_dead" });
    });
  });

  test("session configuration supplies the immutable environment to implicit registration", async () => {
    const base = await temporary(), files = new TaskFiles(); taskPlugin(files, "/app/plugins/library");
    const authority = new ConfigStore({ home: join(base, "home"), cwd: "/app", projectRoot: "/app",
      workspaceFilesystem: new ExecutionConfigFilesystem(files.environment()) });
    await authority.reload();
    await runWithCanonicalSettingsAuthority(authority, async () => {
      const options = { pluginStorageRoot: join(base, "installed"), config: { plugins: { enabled: true } }, readOnly: true };
      expect(await prompt((await loadPluginCommands(options))[0])).toContain("task command");
      await expect(loadPluginCommands({ ...options, cwd: "relative" })).rejects.toMatchObject({ code: "invalid_request" });
      files.unavailable = true;
      await expect(loadPluginOutputStyles(options)).rejects.toMatchObject({ code: "environment_dead" });
    });
  });

  test("task templates cannot create controller plugin data directories", async () => {
    const base = await temporary(), files = new TaskFiles(); taskPlugin(files, "/app/plugins/library", "data ${AGENC_PLUGIN_DATA}");
    const pluginStorageRoot = join(base, "installed");
    const commands = await loadPluginCommands({ workspaceRoot: "/app", pluginStorageRoot, executionEnvironment: files.environment(),
      config: { plugins: { enabled: true } }, readOnly: true });
    await expect(prompt(commands[0])).rejects.toMatchObject({ code: "unsupported_resource" });
    await expect(access(join(pluginStorageRoot, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
