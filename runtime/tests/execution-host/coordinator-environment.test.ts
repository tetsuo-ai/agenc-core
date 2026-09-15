import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionCoordinatorPaths } from "../../src/execution/coordinator-paths.js";
import { canonicalWorkspaceRoot, WorkspaceMutationCoordinatorRegistry } from "../../src/workspace/mutation-coordinator.js";
import { TaskFiles } from "./task-files-fixture.js";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function authority(files: TaskFiles, root: string, container = "a") {
  files.put(root, "", true);
  return new ExecutionCoordinatorPaths({ environment: files.environment(container), projectRoot: root, memoryProjectRoot: root });
}

test("isolates task coordinator/editor state and durable quarantine from local and foreign environments", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-coordinator-env-")); temporary.push(home);
  const root = join(home, "work"), path = root + "/file", alias = root + "/alias";
  await mkdir(root); await writeFile(path, "controller shadow");
  const files = new TaskFiles(), otherFiles = new TaskFiles();
  const paths = authority(files, root), otherPaths = authority(otherFiles, root, "d");
  files.put(path, "task text"); files.put(alias, path);
  const link = files.entries.get(alias)!;
  files.entries.set(alias, { ...link, identity: { ...link.identity, mode: String(0o120777) } });
  otherFiles.put(path, "foreign task");
  const first = new WorkspaceMutationCoordinatorRegistry({ agencHome: home, executionPaths: paths });
  const second = new WorkspaceMutationCoordinatorRegistry({ agencHome: home, executionPaths: otherPaths });
  expect(() => first.getOrCreate(root)).toThrow(/protected preparation/);
  const native = realpathSync.native;
  const hostLookup = vi.spyOn(realpathSync, "native").mockImplementation((value, options) => {
    if (String(value).startsWith(root)) throw new Error("task path used host realpath");
    return native(value, options as never);
  });
  await first.preparePaths([root, path, alias], async () => {
    const coordinator = first.getOrCreate(root);
    const lease = first.acquireEditor(root, { workspaceRoot: root, editorInstanceId: "task-editor" });
    coordinator.sync({ workspaceRoot: root, editorInstanceId: "task-editor", leaseToken: lease.leaseToken,
      epoch: lease.epoch, sequence: 0, buffers: [{ path: alias, bufferHandle: 1, changedtick: 2,
        contentSha256: hash("unsaved task"), contentBytes: 12, dirty: true, content: "unsaved task" }] });
    expect(coordinator.authoritativeRead(alias)?.content).toBe("unsaved task");
    expect(first.findForPath(alias)).toBe(coordinator);
    await coordinator.flushQuarantinePersistence();
    await second.preparePaths([root, path], () => {
      expect(second.hasProtectedEditorAuthority(root)).toBe(false);
      const operation = second.beginToolOperation(root, "test-command");
      first.endToolOperation(operation);
      expect(() => second.acquireEditor(root, { workspaceRoot: root, editorInstanceId: "other" })).toThrow(/active tool/);
      second.endToolOperation(operation);
      const foreign = second.getOrCreate(root);
      second.acquireEditor(root, { workspaceRoot: root, editorInstanceId: "task-editor" });
      expect(() => foreign.sync({ workspaceRoot: root, editorInstanceId: "task-editor", leaseToken: lease.leaseToken,
        epoch: lease.epoch, sequence: 1, buffers: [] })).toThrow();
    });
  });
  expect(hostLookup).not.toHaveBeenCalled();
  const restarted = new WorkspaceMutationCoordinatorRegistry({ agencHome: home, executionPaths: paths });
  await restarted.preparePaths([root, path, alias], async () => {
    expect(restarted.hasProtectedEditorAuthority(root)).toBe(true);
    const coordinator = restarted.getOrCreate(root);
    expect(coordinator.authorityForPath(path)).toBe("stale_dirty");
    expect(() => restarted.acquireEditor(root, { workspaceRoot: root, editorInstanceId: "shell", requireUnprotectedWorkspace: true })).toThrow(/protected Editor/);
    await coordinator.flushQuarantinePersistence();
  });
  expect(hostLookup).not.toHaveBeenCalled(); hostLookup.mockRestore();
  expect(new WorkspaceMutationCoordinatorRegistry({ agencHome: home }).hasProtectedEditorAuthority(root)).toBe(false);
  expect(paths.storageHome(home)).not.toBe(otherPaths.storageHome(home));
});

test("preparation preserves task symlink traversal, rejects races and never outlives its scope", async () => {
  const files = new TaskFiles(), paths = authority(files, "/app");
  files.put("/app/dir", "", true); files.put("/app/file", "task"); files.put("/app/link", "/app/dir");
  const link = files.entries.get("/app/link")!;
  files.entries.set("/app/link", { ...link, identity: { ...link.identity, mode: String(0o120777) } });
  await paths.prepare(["/app/link/../file"], () => {
    expect(paths.canonicalize("/app/link/../file")).toBe("/app/file");
    expect(paths.canonicalize("/app/file")).toBe("/app/file");
    expect(() => paths.canonicalize("/app/unprepared")).toThrow(/protected preparation/);
  });
  expect(() => paths.canonicalize("/app/file")).toThrow(/protected preparation/);
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  let inherited!: Promise<string>;
  await paths.prepare(["/app/file"], () => { inherited = settled.then(() => paths.canonicalize("/app/file")); });
  release();
  await expect(inherited).rejects.toMatchObject({ code: "environment_not_ready" });
  files.put("/app/later", "later");
  const describe = files.filesystem.describePath.bind(files.filesystem);
  let changed = false, entered = false;
  vi.spyOn(files.filesystem, "describePath").mockImplementation(async (path, options) => {
    if (path === "/app/later" && !changed) { changed = true; files.put("/app/file", "replacement"); }
    return describe(path, options);
  });
  await expect(paths.prepare(["/app/file", "/app/later"], () => { entered = true; })).rejects.toMatchObject({ code: "path_conflict" });
  expect(entered).toBe(false);
  files.unavailable = true;
  await expect(paths.prepare(["/app/file"], () => { entered = true; })).rejects.toMatchObject({ code: "environment_dead" });
  expect(entered).toBe(false);
});

test("public workspace root validation resolves task symlinks before dot-dot and propagates environment death", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-coordinator-root-")); temporary.push(home);
  const files = new TaskFiles(); files.put("/app", "", true); files.put("/outside/nested", "", true);
  files.put("/app/link", "/outside/nested");
  const link = files.entries.get("/app/link")!;
  files.entries.set("/app/link", { ...link, identity: { ...link.identity, mode: String(0o120777) } });
  const store = new ConfigStore({ home, cwd: "/app", projectRoot: "/app",
    workspaceFilesystem: new ExecutionConfigFilesystem(files.environment()) });
  await store.reload();
  await runWithCanonicalSettingsAuthority(store, async () => {
    expect(await canonicalWorkspaceRoot("/app/link/..")).toBe("/outside");
    files.put("/app/file", "text");
    await expect(canonicalWorkspaceRoot("/app/file")).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    expect(() => new WorkspaceMutationCoordinatorRegistry({ agencHome: home })).toThrow(/explicit execution path authority/);
    files.unavailable = true;
    await expect(canonicalWorkspaceRoot("/app")).rejects.toMatchObject({ code: "environment_dead" });
  });
});

test("shared coordinator identity uses the calling filesystem owner, cwd and home", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-coordinator-owner-")); temporary.push(home);
  const oldFiles = new TaskFiles(), paths = authority(oldFiles, "/old");
  const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome: home, executionPaths: paths });
  oldFiles.unavailable = true;
  const current = new TaskFiles(); current.put("/new", "", true); current.put("/home/task/file", "current owner");
  const workspace = { environment: current.environment(), projectRoot: "/new", memoryProjectRoot: "/new", homePath: "/home/task" };
  await registry.preparePaths(["~/file"], () => {
    expect(paths.canonicalize("~/file")).toBe("/home/task/file");
    expect(registry.getOrCreate("/new").workspaceRoot).toBe("/new");
  }, workspace);
  let entered = false;
  await expect(registry.preparePaths(["/new"], () => { entered = true; },
    { ...workspace, environment: current.environment("d") })).rejects.toMatchObject({ code: "execution_environment_changed" });
  expect(entered).toBe(false);
});
