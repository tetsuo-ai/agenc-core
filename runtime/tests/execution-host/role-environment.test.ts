import { resolveAgentRuntimeOptions, runWithAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { checkAgentMemorySnapshot, getSnapshotDirForAgent, initializeFromSnapshot, replaceFromSnapshot, markSnapshotSynced } from "../../src/tools/AgentTool/agentMemorySnapshot.js";
import { getAgentMemoryDir, loadAgentMemoryPrompt, readAgentMemoryPrompt } from "../../src/tools/AgentTool/agentMemory.js";
import { listAgentRoleDefinitions } from "../../src/agents/role-definitions.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { loadFreshAgentDefinitions, getAgentDefinitionsWithOverrides, bindAgentDefinitionToWorkspace } from "../../src/tools/AgentTool/loadAgentsDir.js";
import { createAgentRoleWorkspace, normalizeAgentRoleWorkspace } from "../../src/agents/role-workspace.js";
import { _resetAgentRolesForTesting, registerAgentRole, getAgentRole, loadRoleLayerToml } from "../../src/agents/role.js";
import { AgentRoleCatalog } from "../../src/agents/role-catalog.js";
import { executionMarkdownDirectories, readExecutionMarkdownTier } from "../../src/execution/markdown-content.js";
import { ExecutionEnvironmentError } from "../../src/execution/types.js";
import { TaskFiles } from "./task-files-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  _resetAgentRolesForTesting(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() { const root = await mkdtemp(join(tmpdir(), "agenc-role-environment-")); roots.push(root); return root; }
function markdown(name: string, content: string) { return `---\nname: ${name}\ndescription: ${name} guidance\n---\n${content}\n`; }
async function authority(files: TaskFiles, root: string, home: string, container = "a", generation = "b") {
  const store = new ConfigStore({ home, cwd: root, projectRoot: root,
    workspaceFilesystem: new ExecutionConfigFilesystem(files.environment(container, generation)) });
  await store.reload(); return store;
}
function git(files: TaskFiles, root: string) {
  files.put(root + "/.git/HEAD", "ref: refs/heads/main\n");
  files.put(root + "/.git/objects", "", true); files.put(root + "/.git/refs", "", true);
}

describe("role execution authority", () => {
  test("loads equal task/controller markdown paths as separate sources and constructs a bound catalog", async () => {
    const root = await temporary(), home = root + "/.agenc", files = new TaskFiles();
    const path = home + "/agents/shared.md";
    files.put(path, markdown("task-reviewer", "Protected task guidance"));
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, markdown("operator-reviewer", "Controller guidance"));
    const store = await authority(files, root, home);
    await runWithCanonicalSettingsAuthority(store, async () => {
      const definitions = await loadFreshAgentDefinitions(root, home + "/plugins");
      const task = definitions.activeAgents.find(agent => agent.agentType === "task-reviewer")!;
      const operator = definitions.activeAgents.find(agent => agent.agentType === "operator-reviewer")!;
      expect(task.getSystemPrompt()).toBe("Protected task guidance");
      expect(operator.getSystemPrompt()).toBe("Controller guidance");
      expect(task.executionBinding).toEqual(files.environment().binding); expect(operator.executionBinding).toBeUndefined();
      const workspace = createAgentRoleWorkspace(root, files.environment().binding);
      expect(definitions.agentRoleWorkspaceId).toBe(workspace.id);
      expect(new AgentRoleCatalog(workspace, definitions).require("task-reviewer").executionBinding).toEqual(workspace.executionBinding);
      expect(() => new AgentRoleCatalog(createAgentRoleWorkspace(root), definitions)).toThrow(/workspace mismatch/);
      files.put(path, markdown("task-reviewer", "Fresh protected guidance"));
      const refreshed = await getAgentDefinitionsWithOverrides(root, home + "/plugins");
      expect(refreshed.activeAgents.find(agent => agent.agentType === "task-reviewer")?.getSystemPrompt()).toBe("Fresh protected guidance");
      files.unavailable = true;
      await expect(loadFreshAgentDefinitions(root, home + "/plugins")).rejects.toMatchObject({ code: "environment_dead" });
    });
  });

  test("separates equal workspaces by container/generation and rejects incomplete provenance", () => {
    const files = new TaskFiles();
    const workspaces = [files.environment("a", "b"), files.environment("d", "b"), files.environment("a", "e")]
      .map(environment => createAgentRoleWorkspace("/app", environment.binding));
    expect(new Set(workspaces.map(workspace => workspace.id)).size).toBe(3);
    expect(normalizeAgentRoleWorkspace(workspaces[0])).toEqual(workspaces[0]);
    expect(() => normalizeAgentRoleWorkspace({ id: workspaces[0].id, cwd: "/app" })).toThrow();
    expect(createAgentRoleWorkspace("/app").id).toBe("/app");
    registerAgentRole(workspaces[0], { name: "private-role", config: { systemPrompt: "Owner A" } });
    expect(listAgentRoleDefinitions(workspaces[0]).find(role => role.agentType === "private-role")?.executionBinding).toEqual(workspaces[0].executionBinding);
    expect(listAgentRoleDefinitions(workspaces[1]).some(role => role.agentType === "private-role")).toBe(false);
    expect(getAgentRole(workspaces[1], "private-role")).toBeUndefined();
    expect(getAgentRole(workspaces[2], "private-role")).toBeUndefined();
    const definition = { agentType: "task", whenToUse: "task", source: "projectSettings" as const, getSystemPrompt: () => "task" };
    expect(() => bindAgentDefinitionToWorkspace(definition, workspaces[0])).toThrow(/provenance/);
    expect(() => bindAgentDefinitionToWorkspace({ ...definition, executionBinding: workspaces[1].executionBinding }, workspaces[0])).toThrow();
  });

  test("captures task role TOML asynchronously and preserves catalog snapshots and fresh fingerprints", async () => {
    const root = await temporary(), files = new TaskFiles(), path = root + "/role.toml";
    files.put(path, 'model = "task-model"\n'); await writeFile(path, 'model = "host-shadow"\n');
    const store = await authority(files, root, root + "/controller");
    const workspace = createAgentRoleWorkspace(root, files.environment().binding);
    registerAgentRole(workspace, { name: "operator-task-role", config: { configFile: path, description: "Bound role" } });
    expect(() => loadRoleLayerToml(getAgentRole(workspace, "operator-task-role")!)).toThrow(/captured/);
    await runWithCanonicalSettingsAuthority(store, async () => {
      const first = new AgentRoleCatalog(workspace, await loadFreshAgentDefinitions(root, root + "/plugins"));
      const role = first.require("operator-task-role");
      expect(role.config.model).toBe("task-model");
      expect(loadRoleLayerToml(role).model).toBe("task-model");
      const fingerprint = first.fingerprint(role);
      files.put(path, 'model = "changed-task-model"\n');
      const next = new AgentRoleCatalog(workspace, await loadFreshAgentDefinitions(root, root + "/plugins"));
      expect(next.require("operator-task-role").config.model).toBe("changed-task-model");
      expect(next.fingerprint(next.require("operator-task-role"))).not.toBe(fingerprint);
      expect(first.fingerprint(role)).toBe(fingerprint); expect(loadRoleLayerToml(role).model).toBe("task-model");
      files.put(path, "invalid = [");
      await expect(loadFreshAgentDefinitions(root, root + "/plugins")).rejects.toThrow();
    });
  });

  test("does not convert revoked task reads into a built-in-only catalog", async () => {
    const root = await temporary(), files = new TaskFiles();
    files.put(root + "/.agenc/agents/task.md", markdown("task-role", "Task"));
    const store = await authority(files, root, root + "/controller");
    files.filesystem.bindFileSnapshot = async () => { throw new ExecutionEnvironmentError("authority_revoked", "Revoked", false); };
    await runWithCanonicalSettingsAuthority(store, async () => {
      await expect(loadFreshAgentDefinitions(root, root + "/plugins")).rejects.toMatchObject({ code: "authority_revoked" });
    });
  });

  test("does not open controller project paths for task-scoped agent memory", async () => {
    const root = await temporary(), files = new TaskFiles(), home = root + "/controller";
    files.put(root, "", true);
    await mkdir(home + "/agents", { recursive: true });
    await writeFile(home + "/agents/memory.md", "---\nname: memory-role\ndescription: Operator memory role\nmemory: project\n---\nOperator guidance\n");
    const memoryPath = getAgentMemoryDir("memory-role", "project", root) + "MEMORY.md";
    files.put(memoryPath, "Protected task memory α");
    await mkdir(dirname(memoryPath), { recursive: true }); await writeFile(memoryPath, "Host shadow memory");
    const store = await authority(files, root, home);
    await runWithCanonicalSettingsAuthority(store, async () => {
      expect(() => loadAgentMemoryPrompt("memory-role", "project", root)).toThrow(/protected asynchronous/);
      const initial = await loadFreshAgentDefinitions(root, home + "/plugins");
      const prompt = initial.activeAgents.find(agent => agent.agentType === "memory-role")!.getSystemPrompt();
      expect(prompt).toContain("Operator guidance"); expect(prompt).toContain("Protected task memory α");
      expect(prompt).not.toContain("Host shadow");
      files.put(memoryPath, "Updated task memory β");
      const fresh = await loadFreshAgentDefinitions(root, home + "/plugins");
      expect(fresh.activeAgents.find(agent => agent.agentType === "memory-role")!.getSystemPrompt()).toContain("Updated task memory β");
      expect(initial.activeAgents.find(agent => agent.agentType === "memory-role")!.getSystemPrompt()).toBe(prompt);
      files.unavailable = true;
      await expect(readAgentMemoryPrompt("memory-role", "project", root)).rejects.toMatchObject({ code: "environment_dead" });
    });
  });
  test("namespaces explicitly configured remote memory by captured environment generation", async () => {
    const root = await temporary(), files = new TaskFiles(); files.put("/app", "", true);
    const left = await authority(files, "/app", root + "/left", "a", "b");
    const right = await authority(files, "/app", root + "/right", "a", "d");
    const runtimeOptions = resolveAgentRuntimeOptions({ AGENC_REMOTE_MEMORY_DIR: root + "/remote" });
    await runWithAgentRuntimeOptions(runtimeOptions, async () => {
      const paths: string[] = [];
      for (const [store, text] of [[left, "Left remote memory"], [right, "Right remote memory"]] as const) {
        await runWithCanonicalSettingsAuthority(store, async () => {
          const memoryDir = getAgentMemoryDir("worker", "local", "/app"); paths.push(memoryDir);
          expect(memoryDir.startsWith(root + "/remote/projects/")).toBe(true);
          await mkdir(memoryDir, { recursive: true }); await writeFile(memoryDir + "MEMORY.md", text);
          expect(await readAgentMemoryPrompt("worker", "local", "/app")).toContain(text);
        });
      }
      expect(paths[0]).not.toBe(paths[1]);
      await runWithCanonicalSettingsAuthority(left, async () => {
        await expect(readAgentMemoryPrompt("worker", "local", "/app", right.executionWorkspace!.environment)).rejects.toMatchObject({ code: "execution_environment_changed" });
      });
    });
  });

  test("checks task snapshot presence through protected reads and refuses unimplemented sync before mutation", async () => {
    const root = await temporary(), home = root + "/controller", files = new TaskFiles(); files.put(root, "", true);
    const snapshot = getSnapshotDirForAgent("memory-role", root) + "/snapshot.json";
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(snapshot, JSON.stringify({ updatedAt: "2026-09-14T00:00:00Z" }));
    const store = await authority(files, root, home);
    await runWithCanonicalSettingsAuthority(store, async () => {
      expect(await checkAgentMemorySnapshot("memory-role", "user", root)).toEqual({ action: "none" });
      const userMemory = getAgentMemoryDir("memory-role", "user", root) + "MEMORY.md";
      await mkdir(dirname(userMemory), { recursive: true }); await writeFile(userMemory, "Keep controller memory");
      files.put(snapshot, JSON.stringify({ updatedAt: "2026-09-14T00:00:00Z" }));
      await expect(checkAgentMemorySnapshot("memory-role", "user", root)).rejects.toMatchObject({ code: "environment_not_ready" });
      for (const mutate of [initializeFromSnapshot, replaceFromSnapshot, markSnapshotSynced]) {
        await expect(mutate("memory-role", "user", "2026-09-14T00:00:00Z", root)).rejects.toMatchObject({ code: "environment_not_ready" });
      }
      expect(await readFile(userMemory, "utf8")).toBe("Keep controller memory");
    });
  });

});

describe("protected markdown traversal", () => {
  test("preserves nested repository boundaries and sparse worktree fallback", async () => {
    const files = new TaskFiles(); git(files, "/main"); git(files, "/main/nested");
    files.put("/main/.agenc/agents/main.md", "main"); files.put("/main/nested/.agenc/agents/nested.md", "nested");
    const workspace = { environment: files.environment(), projectRoot: "/main", memoryProjectRoot: "/main", homePath: "/home/task" };
    expect(await executionMarkdownDirectories("agents", "/main/nested", workspace)).toEqual(["/main/nested/.agenc/agents", "/main/.agenc/agents"]);
    files.put("/worktree/.git", "gitdir: /main/.git/worktrees/w\n");
    files.put("/main/.git/worktrees/w/commondir", "../..\n"); files.put("/main/.git/worktrees/w/gitdir", "/worktree/.git\n");
    expect(await executionMarkdownDirectories("agents", "/worktree", workspace)).toEqual(["/main/.agenc/agents"]);
    files.put("/worktree/.agenc/agents/local.md", "local");
    expect(await executionMarkdownDirectories("agents", "/worktree", workspace)).toEqual(["/worktree/.agenc/agents"]);
    files.put("/outside/.agenc/agents/outside.md", "outside");
    files.put("/outside/bare.git/HEAD", "ref: refs/heads/main\n");
    files.put("/outside/bare.git/objects", "", true); files.put("/outside/bare.git/refs", "", true);
    files.put("/outside/bare.git/.agenc/agents/bare.md", "bare");
    expect(await executionMarkdownDirectories("agents", "/outside/bare.git", workspace)).toEqual(["/outside/bare.git/.agenc/agents"]);
    files.put("/outside/fake/.git", "invalid marker"); files.put("/outside/fake/.agenc/agents/fake.md", "fake");
    expect(await executionMarkdownDirectories("agents", "/outside/fake", workspace)).toEqual(["/outside/fake/.agenc/agents", "/outside/.agenc/agents"]);
  });

  test("rejects links and special resources, releases raced reads and retains authority loss", async () => {
    const files = new TaskFiles(), root = "/app/.agenc/agents";
    files.put(root + "/normal.md", "normal"); files.put(root + "/hard.md", "hard");
    files.put(root + "/link.md", "link"); files.put(root + "/fifo.md", "fifo");
    for (const [name, mode, nlink] of [["hard", 0o100644, "2"], ["link", 0o120777, "1"], ["fifo", 0o010644, "1"]] as const) {
      const path = root + `/${name}.md`, entry = files.entries.get(path)!;
      files.entries.set(path, { ...entry, identity: { ...entry.identity, mode: String(mode), nlink } });
    }
    expect((await readExecutionMarkdownTier(root, files.environment())).map(file => file.content)).toEqual(["normal"]);
    expect(files.reads).toEqual([root + "/normal.md"]);
    const original = files.filesystem.bindFileSnapshot;
    files.filesystem.bindFileSnapshot = async path => { files.put(root, "", true); return original(path); };
    expect(await readExecutionMarkdownTier(root, files.environment())).toEqual([]);
    expect(files.released).toBeGreaterThan(0);
    files.unavailable = true;
    await expect(readExecutionMarkdownTier(root, files.environment())).rejects.toMatchObject({ code: "environment_dead" });
  });
});
