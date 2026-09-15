import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionConfigFilesystem, findConfigWorkspaceRoot } from "../../src/config/workspace-filesystem.js";
import { loadLayeredConfig } from "../../src/config/repository.js";
import { ConfigStore } from "../../src/config/store.js";
import * as trust from "../../src/permissions/trust/project-trust.js";
import { ExecutionEnvironmentError, type ExecutionEnvironment, type ExecutionFilesystem } from "../../src/execution/types.js";
import type { WorkspaceBoundReadFileStats } from "../../src/workspace/file-mutation-transaction.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class TaskFiles {
  readonly files = new Map<string, { content: Buffer; ino: string; mode: string; target?: string }>();
  readonly calls: string[] = [];
  next = 1;
  unavailable = false;
  afterRead?: () => void;
  released = 0;
  directory(path: string) {
    const parent = dirname(path);
    if (parent !== path && !this.files.has(parent)) this.directory(parent);
    this.files.set(path, { content: Buffer.alloc(0), ino: String(this.next++), mode: String(0o040755) });
  }
  put(path: string, content: string, target?: string) {
    if (!this.files.has(dirname(path))) this.directory(dirname(path));
    this.files.set(path, { content: Buffer.from(content), ino: String(this.next++), mode: String(target ? 0o120777 : 0o100600), ...(target ? { target } : {}) });
  }
  private file(path: string, follow = true) {
    if (this.unavailable) throw new ExecutionEnvironmentError("environment_dead", "Original task is gone", false);
    const file = this.files.get(path);
    if (!file) throw new ExecutionEnvironmentError("not_found", "Missing task file", false);
    return file.target && follow ? this.files.get(file.target)! : file;
  }
  private stats(file: ReturnType<TaskFiles["file"]>): WorkspaceBoundReadFileStats {
    return { dev: "7", ino: file.ino, mode: file.mode, size: file.content.length, mtimeMs: 1, ctimeMs: 1 };
  }
  readonly filesystem = {
    describePath: async (path: string) => {
      const file = this.file(path);
      return { canonicalPath: this.files.get(path)?.target ?? path,
        identity: { dev: "7", ino: file.ino, mode: file.mode, size: String(file.content.length), nlink: "1", mtimeNs: "1000000", ctimeNs: "1000000" } };
    },
    inspectPath: async (path: string, options?: { followSymlinks?: boolean }) => {
      this.calls.push(path); return this.stats(this.file(path, options?.followSymlinks !== false));
    },
    bindFileSnapshot: async (path: string) => {
      const file = this.file(path);
      return { describe: async () => ({ canonicalPath: this.files.get(path)?.target ?? path,
        identity: { dev: "7", ino: file.ino, mode: file.mode, size: String(file.content.length), nlink: "1", mtimeNs: "1000000", ctimeNs: "1000000" } }),
      readFile: async () => {
        const read = Buffer.from(file.content);
        this.afterRead?.(); return read;
      }, dispose: async () => { this.released++; } };
    },
  } as unknown as ExecutionFilesystem;
  environment(digit = "a"): ExecutionEnvironment {
    return { binding: { kind: "docker", containerId: digit.repeat(64), generation: "b".repeat(64), processHandleNamespace: "c".repeat(32) },
      filesystem: this.filesystem, ownerId: "config-owner", authorityRevision: 0, processHandleNamespace: "c".repeat(32),
      launch: vi.fn(), reconnect: vi.fn(), close: vi.fn() };
  }
}

function controller() {
  const root = mkdtempSync(join(tmpdir(), "agenc-config-workspace-")); roots.push(root);
  const home = join(root, "home"); mkdirSync(home);
  writeFileSync(join(home, "config.toml"), 'config_version = 2\nmodel = "controller-model"\n', { mode: 0o600 });
  return { root, home, options: { env: { AGENC_HOME: home, HOME: root }, cwd: "/app/nested",
    managedConfigPath: join(root, "managed.toml"), managedDropInDir: join(root, "managed.d") } };
}

it("loads separate /app configuration views while retaining controller-owned user settings", async () => {
  const host = controller();
  for (const [digit, model] of [["a", "task-one"], ["d", "task-two"]]) {
    const files = new TaskFiles(); files.put("/app/package.json", "{}");
    files.put("/app/.agenc/config.toml", `config_version = 2\nmodel = "${model}"\n`);
    const workspaceFilesystem = new ExecutionConfigFilesystem(files.environment(digit));
    const loaded = await loadLayeredConfig({ ...host.options, workspaceFilesystem, projectTrusted: true });
    expect(loaded.projectRoot).toBe("/app");
    expect(loaded.config.model).toBe(model);
    expect(loaded.sources.find((layer) => layer.scope === "user")?.config.model).toBe("controller-model");
    expect(files.calls).not.toContain(join(host.home, "config.toml"));
  }
});

it("does not confuse equal controller/task paths or consult host project trust", async () => {
  const host = controller();
  const project = join(host.root, "project"); mkdirSync(join(project, ".agenc"), { recursive: true });
  writeFileSync(join(project, ".agenc", "config.toml"), 'config_version = 2\nmodel = "host-shadow"\n');
  writeFileSync(join(project, ".agenc", "settings.json"), "retired host shadow");
  const files = new TaskFiles(); files.put(join(project, ".agenc", "config.toml"), 'config_version = 2\nmodel = "task"\n');
  // Explicit --config and user config have the same spelling in different namespaces.
  files.put(join(host.home, "config.toml"), 'config_version = 2\nmodel = "task-explicit"\n');
  const workspaceFilesystem = new ExecutionConfigFilesystem(files.environment());
  const hostTrust = vi.spyOn(trust, "isProjectTrustedSync");
  const store = new ConfigStore({ ...host.options, cwd: project, projectRoot: project, workspaceFilesystem,
    flagConfigPath: join(host.home, "config.toml") });
  await store.reload();
  expect(store.current().model).toBe("task-explicit");
  expect(store.sources("project")[0].config.model).toBeUndefined();
  expect(store.ignored()).toContainEqual(expect.objectContaining({ scope: "project", key: "model", reason: expect.stringContaining("trusted") }));
  expect(hostTrust).not.toHaveBeenCalled();
});

it("detects retired task inputs using metadata without reading or migrating them", async () => {
  const host = controller(); const files = new TaskFiles();
  files.put("/app/package.json", "{}"); files.put("/app/.mcp.json", "not JSON");
  const fs = new ExecutionConfigFilesystem(files.environment());
  const read = vi.spyOn(fs, "readStableFile");
  await expect(loadLayeredConfig({ ...host.options, workspaceFilesystem: fs })).rejects.toMatchObject({ code: "retired-input" });
  expect(read.mock.calls.some(([path]) => path.endsWith(".mcp.json"))).toBe(false);
  expect(files.files.get("/app/.mcp.json")?.content.toString()).toBe("not JSON");
});

it("rejects aliases within a task authority while allowing absolute task symlinks", async () => {
  const host = controller(); const files = new TaskFiles();
  files.put("/app/package.json", "{}"); files.put("/app/shared.toml", 'config_version = 2\nmodel = "shared"\n');
  files.put("/app/.agenc/config.toml", "", "/app/shared.toml");
  const workspaceFilesystem = new ExecutionConfigFilesystem(files.environment());
  expect((await workspaceFilesystem.readStableFile("/app/.agenc/config.toml", { allowLeafSymlink: true }))?.resolvedPath).toBe("/app/shared.toml");
  expect((await loadLayeredConfig({ ...host.options, workspaceFilesystem, projectTrusted: true })).config.model).toBe("shared");
  await expect(loadLayeredConfig({ ...host.options, workspaceFilesystem, flagConfigPath: "../shared.toml" }))
    .rejects.toMatchObject({ code: "invalid-source" });
  await expect(workspaceFilesystem.readStableFile("/app/.agenc/config.toml"))
    .rejects.toMatchObject({ code: "symbolic-link" });
});

it("rejects a parent/leaf identity exchange and releases the original capability", async () => {
  const files = new TaskFiles(); files.put("/app/config.toml", "original");
  const fs = new ExecutionConfigFilesystem(files.environment());
  files.afterRead = () => files.put("/app/config.toml", "replacement");
  await expect(fs.readStableFile("/app/config.toml")).rejects.toMatchObject({ code: "identity-changed" });
  expect(files.released).toBe(1);
});

it("propagates environment loss and never loads an existing host shadow", async () => {
  const host = controller(); const path = join(host.home, "config.toml");
  const files = new TaskFiles(); files.unavailable = true;
  const fs = new ExecutionConfigFilesystem(files.environment());
  await expect(fs.readStableFile(path)).rejects.toMatchObject({ code: "environment_dead" });
  await expect(loadLayeredConfig({ ...host.options, workspaceFilesystem: fs })).rejects.toMatchObject({ code: "environment_dead" });
});

it("uses only the task home boundary for discovery and never defaults task cwd to the controller cwd", async () => {
  const files = new TaskFiles(); files.put("/root/package.json", "{}"); files.put("/package.json", "{}");
  const fs = new ExecutionConfigFilesystem(files.environment(), { homePath: "/root" });
  expect(await findConfigWorkspaceRoot(fs, "/root/project", ["package.json"])).toBeUndefined();
  expect(files.calls).not.toContain("/root/package.json");
  expect(await findConfigWorkspaceRoot(fs, "/root", ["package.json"])).toBe("/root");
  expect(() => new ConfigStore({ workspaceFilesystem: fs })).toThrow(/explicit cwd/);
  expect(() => new ConfigStore({ workspaceFilesystem: fs, cwd: "/app", loader: async () => ({}) })).toThrow(/host loader/);
  const host = controller();
  await expect(loadLayeredConfig({ ...host.options, cwd: undefined, workspaceFilesystem: fs })).rejects.toThrow(/explicit cwd/);
});
