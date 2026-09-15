import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createFileEditTool, createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { clearSessionReadState, getSessionReadSnapshot, withSignedSessionId } from "../../src/tools/system/filesystem.js";
import * as editor from "../../src/workspace/mutation-coordinator.js";
import * as lsp from "../../src/services/lsp/fileNotifications.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import type { Tool } from "../../src/tools/Tool.js";
import { TaskFiles } from "./task-files-fixture.js";

const roots: string[] = [], sessions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) clearSessionReadState(session);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(files: TaskFiles) {
  const home = await mkdtemp(join(tmpdir(), "agenc-task-file-edit-")); roots.push(home);
  files.put("/app", "", true); files.put("/root", "", true);
  const store = new ConfigStore({ home, cwd: "/app", projectRoot: "/app",
    workspaceFilesystem: new ExecutionConfigFilesystem(files.environment("a"), { homePath: "/root" }) });
  await store.reload();
  const session = home; sessions.push(session);
  return { store, home, session };
}
const text = (files: TaskFiles, path: string) => files.entries.get(path)?.bytes.toString("utf8");

test("edits, creates and batches task files through the selected environment without controller paths, editor buffers or LSP feedback", async () => {
  const files = new TaskFiles(), { store, home, session } = await setup(files);
  const path = join(home, "shadow.txt");
  await writeFile(path, "controller shadow");
  files.put(path, "first α\r\nsecond β\r\n");
  await runWithCanonicalSettingsAuthority(store, async () => {
    vi.spyOn(editor, "workspaceAuthoritativeRead").mockImplementation(() => { throw new Error("unscoped editor consulted"); });
    const feedback = vi.spyOn(lsp, "collectEditFeedback").mockImplementation(async () => { throw new Error("unmigrated LSP helper consulted"); });
    const roots = [home, "/app"];
    const read = createFileReadTool({ allowedPaths: roots });
    const edit = createFileEditTool({ allowedPaths: roots });
    const multi = createFileMultiEditTool({ allowedPaths: roots });
    const unread = await edit.execute(withSignedSessionId({ file_path: path, old_string: "second β", new_string: "third γ" }, session));
    expect(unread.isError).toBe(true); expect(unread.content).toContain("Read it first");
    expect(unread.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    expect(files.writes).toBe(0);
    await read.execute(withSignedSessionId({ file_path: path }, session));
    const edited = await edit.execute(withSignedSessionId({ file_path: path, old_string: "second β", new_string: "third γ" }, session));
    expect(edited.isError).not.toBe(true); expect(edited.content).toContain("updated successfully");
    expect(text(files, path)).toBe("first α\r\nthird γ\r\n");
    expect(getSessionReadSnapshot(session, path)).toMatchObject({ rawContent: "first α\nthird γ\n", viewKind: "full",
      executionFile: { canonicalPath: path }, executionBinding: store.executionWorkspace!.environment.binding });
    // The published post-edit snapshot authorizes the next edit without a fresh read.
    const again = await edit.execute(withSignedSessionId({ file_path: path, old_string: "first", new_string: "1st", replace_all: true }, session));
    expect(again.isError).not.toBe(true); expect(again.content).toContain("All occurrences");
    expect(text(files, path)).toBe("1st α\r\nthird γ\r\n");
    // Equal bytes under a new task identity still require a fresh observation.
    files.put(path, "1st α\r\nthird γ\r\n");
    const stale = await edit.execute(withSignedSessionId({ file_path: path, old_string: "third", new_string: "3rd" }, session));
    expect(stale.isError).toBe(true); expect(stale.content).toContain("modified since read");
    expect(text(files, path)).toBe("1st α\r\nthird γ\r\n");
    const absent = await edit.execute(withSignedSessionId({ file_path: "/app/new/dir/file.txt", old_string: "x", new_string: "y" }, session));
    expect(absent.isError).toBe(true); expect(absent.content).toContain("File does not exist");
    expect(absent.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    // A relative target resolves against the task role cwd, and missing task
    // ancestors are created by the protected write itself.
    const created = await edit.execute(withSignedSessionId({ file_path: "new/dir/file.txt", old_string: "", new_string: "created δ\n" }, session));
    expect(created.isError).not.toBe(true); expect(created.content).toContain("Created file");
    expect(text(files, "/app/new/dir/file.txt")).toBe("created δ\n");
    expect(getSessionReadSnapshot(session, "/app/new/dir/file.txt")).toMatchObject({ rawContent: "created δ\n", executionFile: { canonicalPath: "/app/new/dir/file.txt" } });
    const occupied = await edit.execute(withSignedSessionId({ file_path: "/app/new/dir/file.txt", old_string: "", new_string: "again" }, session));
    expect(occupied.isError).toBe(true); expect(occupied.content).toContain("file already exists");
    const refused = await multi.execute(withSignedSessionId({ file_path: "/app/new/dir/file.txt",
      edits: [{ old_string: "created", new_string: "made" }, { old_string: "absent", new_string: "x" }] }, session));
    expect(refused.isError).toBe(true); expect(refused.content).toContain("Edit 2 of 2 failed");
    expect(refused.content).toContain("all-or-nothing"); expect(refused.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    expect(text(files, "/app/new/dir/file.txt")).toBe("created δ\n");
    const batched = await multi.execute(withSignedSessionId({ file_path: "/app/new/dir/file.txt",
      edits: [{ old_string: "created", new_string: "made" }, { old_string: "δ", new_string: "ε" }] }, session));
    expect(batched.isError).not.toBe(true); expect(batched.content).toContain("2 edits applied with 2 replacements");
    expect(text(files, "/app/new/dir/file.txt")).toBe("made ε\n");
    expect(await readFile(path, "utf8")).toBe("controller shadow");
    expect(feedback).not.toHaveBeenCalled();
    expect(files.writes).toBe(4);
  });
});

test("a lost acknowledgement stays unknown without replay, a verified post-edit fault rolls back, and environment loss propagates", async () => {
  const files = new TaskFiles(), { store, session } = await setup(files);
  files.put("/app/file", "keep\nchange\n");
  await runWithCanonicalSettingsAuthority(store, async () => {
    const read = createFileReadTool({ allowedPaths: ["/app"] });
    await read.execute(withSignedSessionId({ file_path: "/app/file" }, session));
    const faulty = createFileEditTool({ allowedPaths: ["/app"], __testWrite: async ({ write }) => { await write(); throw new Error("verified post-edit fault"); } });
    const rolled = await faulty.execute(withSignedSessionId({ file_path: "/app/file", old_string: "change", new_string: "changed" }, session));
    expect(rolled.isError).toBe(true); expect(rolled.content).toContain("verified post-edit fault");
    expect(rolled.effectDisposition).toBeUndefined();
    expect(text(files, "/app/file")).toBe("keep\nchange\n");
    expect(files.writes).toBe(2);
    expect(getSessionReadSnapshot(session, "/app/file")?.rawContent).toBe("keep\nchange\n");
    // The rollback republished the task inode, so the prior observation is stale.
    const edit = createFileEditTool({ allowedPaths: ["/app"] });
    expect((await edit.execute(withSignedSessionId({ file_path: "/app/file", old_string: "change", new_string: "changed" }, session))).content).toContain("modified since read");
    await read.execute(withSignedSessionId({ file_path: "/app/file" }, session));
    files.loseWriteAck = true;
    await expect(edit.execute(withSignedSessionId({ file_path: "/app/file", old_string: "change", new_string: "uncertain" }, session)))
      .rejects.toMatchObject({ code: "unknown_outcome" });
    expect(files.writes).toBe(3);
    expect(text(files, "/app/file")).toBe("keep\nuncertain\n");
    expect(getSessionReadSnapshot(session, "/app/file")?.rawContent).toBe("keep\nchange\n");
    files.loseWriteAck = false;
    files.unavailable = true;
    await expect(edit.execute(withSignedSessionId({ file_path: "/app/file", old_string: "a", new_string: "b" }, session)))
      .rejects.toMatchObject({ code: "environment_dead" });
  });
});

test("task permission checks resolve relative targets against the role cwd and keep the task home editable", async () => {
  const files = new TaskFiles(), { store } = await setup(files);
  files.put("/app/file", "task"); files.put("/root/note.md", "home");
  const policy = { ...createEmptyToolPermissionContext(), mode: "acceptEdits" as const };
  const toolContext = { getAppState: () => ({ toolPermissionContext: policy }) } as Parameters<NonNullable<Tool["checkPermissions"]>>[1];
  await runWithCanonicalSettingsAuthority(store, async () => {
    for (const selected of [createFileEditTool({ allowedPaths: ["/app", "/root"] }), createFileMultiEditTool({ allowedPaths: ["/app", "/root"] }), createFileEditTool({})]) {
      const input = (file_path: string) => ({ file_path, old_string: "task", new_string: "edited", edits: [{ old_string: "task", new_string: "edited" }] });
      expect((await selected.checkPermissions!(input("file"), toolContext)).behavior, selected.name).toBe("allow");
      expect((await selected.checkPermissions!(input("/app/file"), toolContext)).behavior, selected.name).toBe("allow");
      expect((await selected.checkPermissions!(input("/outside/file"), toolContext)).behavior, selected.name).not.toBe("allow");
    }
    const home = createFileEditTool({ allowedPaths: ["/app", "/root"] });
    expect((await home.checkPermissions!({ file_path: "/root/note.md", old_string: "home", new_string: "edited" }, toolContext)).behavior).toBe("allow");
    expect(files.reads).toEqual([]);
  });
});
