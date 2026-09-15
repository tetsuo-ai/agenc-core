import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ContentFilesystem } from "../../src/execution/content-filesystem.js";
import { ExecutionEnvironmentError } from "../../src/execution/types.js";
import { createPluginFromPath, discoverPluginRoots, discoverPluginSkillRootsWithProvenance, loadPlugins } from "../../src/plugins/loader.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { pluginFilesystemKey } from "../../src/plugins/directories.js";
import { TaskFiles } from "./task-files-fixture.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-content-")); directories.push(root); return root;
}
function taskPlugin(files: TaskFiles, root: string, name: string, extra: Record<string, unknown> = {}): void {
  files.put(join(root, ".agenc-plugin/plugin.json"), JSON.stringify({ name, ...extra }));
  files.put(join(root, "skills/example/SKILL.md"), "---\nname: example\ndescription: Task guidance\n---\nTask content α\r\n");
  files.put(join(root, "commands/example.md"), "Task command");
}
async function hostPlugin(root: string, name: string): Promise<void> {
  await mkdir(join(root, ".agenc-plugin"), { recursive: true });
  await mkdir(join(root, "skills/example"), { recursive: true });
  await writeFile(join(root, ".agenc-plugin/plugin.json"), JSON.stringify({ name }));
  await writeFile(join(root, "skills/example/SKILL.md"), "Controller skill");
}

describe("plugin content execution authority", () => {
  test("keeps equal controller/task package and skill paths distinct, including dependency failures", async () => {
    const base = await temporary(), workspaceRoot = join(base, "workspace"), pluginStorageRoot = join(workspaceRoot, "plugins");
    const shared = join(pluginStorageRoot, "shared");
    await hostPlugin(shared, "operator-library");
    const files = new TaskFiles();
    taskPlugin(files, shared, "task-library", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "task-hook" }] }] },
      mcpServers: { task: { command: "task-mcp" } },
      lspServers: { task: { command: "task-lsp", extensionToLanguage: { ".ts": "typescript" } } },
      settings: { env: { CONTROLLER_SECRET: "replacement" } },
    });
    const options = { workspaceRoot, pluginStorageRoot, executionEnvironment: files.environment(),
      config: { plugins: { enabled: true } }, readOnly: true };
    const result = await loadPlugins(options);
    expect(result.errors).toEqual([]);
    expect(result.enabled).toHaveLength(2);
    const controller = result.enabled.find((plugin) => plugin.id === "operator-library")!;
    const task = result.enabled.find((plugin) => plugin.id === "task-library")!;
    expect(controller.executionBinding).toBeUndefined();
    expect(controller.contentProvenance).toBe("authority-controlled");
    expect(task.executionBinding).toEqual(options.executionEnvironment.binding);
    expect(task.contentProvenance).toBe("repository-controlled");
    expect(task.hookSources).toEqual([]);
    expect(task.mcpServers).toEqual({});
    expect(task.lspServers).toEqual({});
    expect(task.settings).toBeUndefined();
    expect(task.commands.map((command) => command.path)).toEqual([join(shared, "commands/example.md")]);
    const roots = await discoverPluginSkillRootsWithProvenance(options);
    expect(roots).toHaveLength(2);
    expect(roots.map((root) => root.path)).toEqual([join(shared, "skills"), join(shared, "skills")]);
    expect(roots.filter((root) => root.executionBinding)).toHaveLength(1);

    taskPlugin(files, shared, "task-library", { dependencies: ["absent-dependency"] });
    const changed = await loadPlugins(options);
    expect(changed.enabled.map((plugin) => plugin.id)).toEqual(["operator-library"]);
    expect(changed.disabled.map((plugin) => plugin.id)).toEqual(["task-library"]);
    expect(changed.enabled[0].errors).toEqual([]);
    expect(changed.disabled[0].errors).toContainEqual(expect.objectContaining({ type: "dependency", plugin: "task-library" }));
  });

  test("configured absolute paths cannot acquire controller install authority from their spelling", async () => {
    const base = await temporary(), pluginStorageRoot = join(base, "installed"), configured = join(pluginStorageRoot, "external");
    await hostPlugin(configured, "operator");
    const files = new TaskFiles(); files.put("/app", "", true);
    taskPlugin(files, configured, "task-external", { commands: { inline: { content: "task inline content" } } });
    const result = await loadPlugins({ workspaceRoot: "/app", pluginStorageRoot, executionEnvironment: files.environment(), readOnly: true,
      config: { plugins: { enabled: true, plugins: { configured: { path: configured } } } } });
    expect(result.enabled).toHaveLength(2);
    const task = result.enabled.find((plugin) => plugin.id === "configured")!;
    expect(task.name).toBe("task-external");
    expect(task.contentProvenance).toBe("repository-controlled");
    expect(task.commands[0].content).toBe("task inline content");
  });

  test("separates /app catalogs by environment and propagates loss instead of falling back", async () => {
    const base = await temporary(), left = new TaskFiles(), right = new TaskFiles();
    taskPlugin(left, "/app/plugins/example", "left"); taskPlugin(right, "/app/plugins/example", "right");
    const options = { workspaceRoot: "/app", pluginStorageRoot: join(base, "installed"), readOnly: true, config: { plugins: { enabled: true } } };
    const [a, b] = await Promise.all([loadPlugins({ ...options, executionEnvironment: left.environment("a") }),
      loadPlugins({ ...options, executionEnvironment: right.environment("d") })]);
    expect(a.enabled.map((plugin) => plugin.name)).toEqual(["left"]);
    expect(b.enabled.map((plugin) => plugin.name)).toEqual(["right"]);
    expect(a.enabled[0].executionBinding).not.toEqual(b.enabled[0].executionBinding);
    left.unavailable = true;
    await expect(loadPlugins({ ...options, executionEnvironment: left.environment() })).rejects.toMatchObject({ code: "environment_dead" });
    await expect(discoverPluginRoots({ ...options, workspaceRoot: "relative", executionEnvironment: right.environment() }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  test("preserves manifest, retired-file, and component diagnostics using task bytes", async () => {
    const files = new TaskFiles(), root = "/app/plugin";
    taskPlugin(files, root, "task", { agents: "./missing.md", skills: "./skills", outputStyles: "./styles" });
    files.put(root + "/styles/example.md", "Task style");
    const options = { source: "task", enabled: true, executionEnvironment: files.environment() };
    const loaded = await createPluginFromPath(root, options);
    expect(loaded.plugin?.skillsPaths).toEqual([root + "/skills"]);
    expect(loaded.plugin?.outputStylesPaths).toEqual([root + "/styles"]);
    expect(loaded.errors).toContainEqual(expect.objectContaining({ type: "path-not-found", component: "agents" }));
    files.put(root + "/settings.json", "{}");
    const retiredSettings = await createPluginFromPath(root, options);
    expect(retiredSettings.plugin?.enabled).toBe(false);
    expect(retiredSettings.plugin?.executionBinding).toEqual(options.executionEnvironment.binding);
    expect(retiredSettings.errors[0].message).toContain("Retired plugin settings");
    files.put(root + "/plugin.json", "{}");
    expect((await createPluginFromPath(root, options)).errors[0].message).toContain("Retired root plugin manifest");
  });

  test("task package names cannot trigger controller data migrations", async () => {
    const base = await temporary(), pluginStorageRoot = join(base, "installed"), files = new TaskFiles();
    await hostPlugin(join(pluginStorageRoot, "operator"), "operator_library");
    taskPlugin(files, "/app/plugins/task", "task_library");
    for (const name of ["operator_library", "task_library"]) {
      await mkdir(join(pluginStorageRoot, "data", name), { recursive: true });
      await writeFile(join(pluginStorageRoot, "data", name, "state"), name);
    }
    const result = await loadPlugins({ workspaceRoot: "/app", pluginStorageRoot,
      executionEnvironment: files.environment(), config: { plugins: { enabled: true } } });
    expect(result.enabled).toHaveLength(2);
    expect(await readFile(join(pluginStorageRoot, "data", "task_library", "state"), "utf8")).toBe("task_library");
    expect(await readFile(join(pluginStorageRoot, "data", pluginFilesystemKey("operator_library"), "state"), "utf8")).toBe("operator_library");
  });

  test("authority errors at discovery, manifest, and component boundaries remain fatal", async () => {
    const files = new TaskFiles(); taskPlugin(files, "/app/plugins/example", "task");
    const base = await temporary(), original = files.environment();
    for (const failingPath of ["/app/.git", "/app/plugins", "/app/plugins/example/.agenc-plugin/plugin.json",
      "/app/plugins/example/.mcp.json", "/app/plugins/example/skills"]) {
      const environment = { ...original, filesystem: { ...original.filesystem, describePath: async (path: string) => {
        if (path === failingPath) throw new ExecutionEnvironmentError("authority_revoked", "Revoked task authority", false);
        return original.filesystem.describePath(path);
      } } };
      await expect(loadPlugins({ workspaceRoot: "/app", pluginStorageRoot: join(base, "installed"), readOnly: true,
        config: { plugins: { enabled: true } }, executionEnvironment: environment })).rejects.toMatchObject({ code: "authority_revoked" });
    }
  });
});

describe("protected content reads", () => {
  test("retains exact UTF-8 content and rejects oversized JSON and special resources before reading", async () => {
    const files = new TaskFiles(), path = "/app/content", text = "\ufeffcontent α\r\n\r\n";
    files.put(path, text);
    const filesystem = new ContentFilesystem(files.environment());
    expect(await filesystem.readText(path)).toBe(text);
    files.put("/app/.agenc-plugin/plugin.json", "x".repeat(1_048_577));
    await expect(loadPluginManifest("/app", filesystem)).rejects.toThrow("Plugin JSON file is too large");
    expect(files.reads).not.toContain("/app/.agenc-plugin/plugin.json");
    files.put("/app/fifo", "");
    const entry = files.entries.get("/app/fifo")!;
    files.entries.set("/app/fifo", { ...entry, identity: { ...entry.identity, mode: String(0o010644) } });
    await expect(filesystem.readText("/app/fifo")).rejects.toMatchObject({ code: "unsupported_resource" });
    expect(files.reads).not.toContain("/app/fifo");
    expect(files.released).toBe(1);
  });

  test("rejects directory and file swaps across descriptor acquisition and releases capabilities", async () => {
    const files = new TaskFiles(); files.put("/app/file", "original");
    const original = files.environment();
    const environment = { ...original, filesystem: { ...original.filesystem, bindFileSnapshot: async (path: string) => {
      files.put(path, "replacement"); return original.filesystem.bindFileSnapshot(path);
    } } };
    await expect(new ContentFilesystem(environment).readText("/app/file")).rejects.toMatchObject({ code: "path_conflict" });
    expect(files.reads).toEqual([]);
    files.beforeDirectoryBind = (path) => { files.put(path, "", true); };
    await expect(new ContentFilesystem(original).readDirectory("/app")).rejects.toMatchObject({ code: "path_conflict" });
    expect(files.enumerated).toBe(0);
    expect(files.released).toBe(2);
  });

  test("preserves read and release failures together, including execution authority loss", async () => {
    const files = new TaskFiles(); files.put("/app/file", "initial");
    const original = files.environment(), readError = new ExecutionEnvironmentError("environment_dead", "Task died", false);
    const releaseError = new ExecutionEnvironmentError("transport_error", "Supervisor connection closed", false);
    const environment = { ...original, filesystem: { ...original.filesystem, bindFileSnapshot: async (path: string) => {
      const held = await original.filesystem.bindFileSnapshot(path);
      return { ...held, readFile: async () => { throw readError; }, dispose: async () => { throw releaseError; } };
    } } };
    await expect(new ContentFilesystem(environment).readText("/app/file")).rejects.toMatchObject({ errors: [readError, releaseError], cause: readError });
  });
});
