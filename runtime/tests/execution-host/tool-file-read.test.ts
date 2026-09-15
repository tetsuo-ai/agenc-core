import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { clearSessionReadCache, clearSessionReadState, getSessionReadSnapshot, hasSessionRead,
  recordSessionRead, seedSessionReadState, snapshotTopRecentReads, withSignedSessionId } from "../../src/tools/system/filesystem.js";
import { changedFilesProducer } from "../../src/prompts/attachments/changed-files.js";
import type { GetAttachmentsOptions } from "../../src/prompts/attachments/orchestrator.js";
import * as editor from "../../src/workspace/mutation-coordinator.js";
import { TaskFiles } from "./task-files-fixture.js";
import { buildFileWriteApprovalPreview } from "../../src/permissions/file-write-preview.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import { ExecutionEnvironmentError } from "../../src/execution/types.js";

const roots: string[] = [], sessions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) clearSessionReadState(session);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(files: TaskFiles, container = "a") {
  const home = await mkdtemp(join(tmpdir(), "agenc-task-file-read-")); roots.push(home);
  files.put("/app", "", true); files.put("/root", "", true);
  const store = new ConfigStore({ home, cwd: "/app", projectRoot: "/app",
    workspaceFilesystem: new ExecutionConfigFilesystem(files.environment(container), { homePath: "/root" }) });
  await store.reload();
  const session = home; sessions.push(session);
  return { store, home, session };
}
function attachments(session: string): GetAttachmentsOptions {
  return { sessionKey: { sessionId: session }, cwd: "/app", signal: new AbortController().signal,
    userInput: null, loadedTools: [], messages: [], permissionContext: { mode: "default" }, subagentDepth: 0 } as GetAttachmentsOptions;
}

test("reads task text and notebooks without controller shadow files or editor buffers", async () => {
  const files = new TaskFiles(), { store, home, session } = await setup(files);
  const path = join(home, "shadow.txt");
  await writeFile(path, "controller secret"); files.put(path, "task α\nline two\n");
  files.put("/root/note.ipynb", JSON.stringify({ nbformat: 4, cells: [{ cell_type: "markdown", source: ["task notebook β"], metadata: {} }], metadata: {} }));
  await runWithCanonicalSettingsAuthority(store, async () => {
    vi.spyOn(editor, "workspaceAuthoritativeRead").mockImplementation(() => { throw new Error("unscoped editor consulted"); });
    const read = createFileReadTool({ allowedPaths: [home, "/root"] });
    const result = await read.execute(withSignedSessionId({ file_path: path }, session));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("task α"); expect(result.content).not.toContain("controller secret");
    expect(getSessionReadSnapshot(session, path)).toMatchObject({ rawContent: "task α\nline two\n", executionBinding: store.executionWorkspace!.environment.binding });
    const notebook = await read.execute(withSignedSessionId({ file_path: "~/note.ipynb" }, session));
    expect(notebook.isError).not.toBe(true); expect(notebook.content).toContain("task notebook β");
    expect(getSessionReadSnapshot(session, "/root/note.ipynb")?.executionBinding).toEqual(store.executionWorkspace!.environment.binding);
    files.put(path, "task changed γ\n");
    const changes = await changedFilesProducer(attachments(session), {} as never);
    expect(JSON.stringify(changes)).toContain("task changed γ");
    expect(JSON.stringify(changes)).not.toContain("controller secret");
    expect(await changedFilesProducer(attachments(session), {} as never)).toEqual([]);
    files.unavailable = true;
    await expect(changedFilesProducer(attachments(session), {} as never)).rejects.toMatchObject({ code: "environment_dead" });
  });
});

test("protected previews require a fresh full observed file and revalidate bytes without using host editor state", async () => {
  const files = new TaskFiles(), { store, home, session } = await setup(files);
  const path = "/app/file";
  files.put(path, "task preview α");
  let policy = createEmptyToolPermissionContext();
  const invocation = { turn: { cwd: "/app" }, session: { conversationId: session,
    services: { permissionModeRegistry: { current: () => policy } } } } as unknown as ToolInvocation;
  const preview = () => buildFileWriteApprovalPreview(invocation, { file_path: path });
  await runWithCanonicalSettingsAuthority(store, async () => {
    vi.spyOn(editor, "workspaceAuthoritativeRead").mockImplementation(() => { throw new Error("unscoped editor consulted"); });
    const read = createFileReadTool({ allowedPaths: ["/app"] });
    expect(await preview()).toMatchObject({ kind: "unavailable" });
    await read.execute(withSignedSessionId({ file_path: path }, session));
    expect(await preview()).toEqual({ kind: "existing", content: "task preview α" });
    clearSessionReadCache(session);
    expect(await preview()).toEqual({ kind: "existing", content: "task preview α" });
    const original = files.entries.get(path)!;
    files.put(path, "replacement");
    const replacement = files.entries.get(path)!;
    files.entries.set(path, { ...replacement, identity: { ...replacement.identity, mtimeNs: original.identity.mtimeNs } });
    expect(await preview()).toMatchObject({ kind: "unavailable", reason: "The file changed since its last full read." });
    await read.execute(withSignedSessionId({ file_path: path }, session));
    expect(await preview()).toEqual({ kind: "existing", content: "replacement" });
    // Even a dishonest backend retaining every metadata field cannot substitute bytes.
    files.entries.get(path)!.bytes.fill(120);
    expect(await preview()).toMatchObject({ kind: "unavailable" });
    const missing = home + "/missing.txt";
    // A controller file at this name is irrelevant to the protected missing state.
    await writeFile(missing, "host only"); files.put(home, "", true);
    policy = { ...policy, additionalWorkingDirectories: new Map([[home, { path: home, source: "session" }]]) };
    expect(await buildFileWriteApprovalPreview(invocation, { file_path: missing })).toEqual({ kind: "missing" });
    policy = { ...policy, alwaysDenyRules: { session: ["FileRead(/app/file)"] } };
    expect(await preview()).toMatchObject({ kind: "unavailable", reason: "Reading the target requires permission." });
    files.unavailable = true;
    await expect(preview()).rejects.toMatchObject({ code: "environment_dead" });
  });
});

test("partial task reads replace full snapshot bytes and failed release cannot grant a read", async () => {
  const files = new TaskFiles(), { store, session } = await setup(files);
  const path = "/app/file.ipynb";
  files.put(path, JSON.stringify({ nbformat: 4, metadata: {}, cells: [{ cell_type: "markdown", metadata: {}, source: ["first\nsecond\nthird\n"] }] }));
  await runWithCanonicalSettingsAuthority(store, async () => {
    const read = createFileReadTool({ allowedPaths: ["/app"] });
    await read.execute(withSignedSessionId({ file_path: path }, session));
    expect(getSessionReadSnapshot(session, path)?.rawContent).toContain("first");
    const partial = await read.execute(withSignedSessionId({ file_path: path, offset: 2, limit: 1 }, session));
    expect(partial.isError).not.toBe(true);
    expect(getSessionReadSnapshot(session, path)).toMatchObject({ viewKind: "partial", executionFile: { canonicalPath: path } });
    expect(getSessionReadSnapshot(session, path)?.rawContent).toBeUndefined();
    clearSessionReadCache(session);
    expect(getSessionReadSnapshot(session, path)?.rawContent).toBeUndefined();
    files.put("/app/release", "never published");
    const bind = files.filesystem.bindFileRead.bind(files.filesystem);
    vi.spyOn(files.filesystem, "bindFileRead").mockImplementation(async name => {
      const capability = await bind(name);
      return { ...capability, dispose: async () => { throw new ExecutionEnvironmentError("unknown_outcome", "release acknowledgement lost", true); } };
    });
    await expect(read.execute(withSignedSessionId({ file_path: "/app/release" }, session))).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(hasSessionRead(session, "/app/release")).toBe(false);
    expect((await read.execute({ file_path: "/app/missing" })).content).toContain("File does not exist");
    expect((await read.execute({ file_path: "/outside/no-grant" })).content).toContain("Permission denied");
  });
});

test("isolates read grants and persisted history by environment, including old unbound seeds", async () => {
  const left = new TaskFiles(), right = new TaskFiles();
  const first = await setup(left), second = await setup(right, "d");
  const session = first.session, path = "/app/file";
  left.put(path, "left task"); right.put(path, "right task");
  recordSessionRead(session, path, { content: "local", rawContent: "local", timestamp: 1 });
  const read = createFileReadTool({ allowedPaths: ["/app"] });
  await runWithCanonicalSettingsAuthority(first.store, async () => {
    expect(hasSessionRead(session, path)).toBe(false);
    expect(() => recordSessionRead(session, path, { content: "unbound" })).toThrow(/provenance/);
    seedSessionReadState(session, [{ path, content: "old transcript" }]);
    expect(hasSessionRead(session, path)).toBe(false);
    await read.execute(withSignedSessionId({ file_path: path }, session));
    expect(snapshotTopRecentReads({ sessionId: session, maxFiles: 2, perFileBudgetChars: 100, totalBudgetChars: 200 })[0]?.executionBinding).toEqual(first.store.executionWorkspace!.environment.binding);
  });
  await runWithCanonicalSettingsAuthority(second.store, async () => {
    expect(hasSessionRead(session, path)).toBe(false);
    await read.execute(withSignedSessionId({ file_path: path }, session));
    expect(getSessionReadSnapshot(session, path)?.rawContent).toBe("right task");
    expect(() => recordSessionRead(session, path, { executionBinding: first.store.executionWorkspace!.environment.binding })).toThrow();
  });
  clearSessionReadCache(session);
  await runWithCanonicalSettingsAuthority(first.store, async () => {
    expect(getSessionReadSnapshot(session, path)?.rawContent).toBe("left task");
  });
  await runWithCanonicalSettingsAuthority(second.store, async () => {
    expect(getSessionReadSnapshot(session, path)?.rawContent).toBe("right task");
  });
  expect(getSessionReadSnapshot(session, path)?.rawContent).toBe("local");
});

test("rejects parent/file replacement before publishing or caching a read, and preserves environment errors", async () => {
  const files = new TaskFiles(), { store, session } = await setup(files);
  files.put("/app/file", "original");
  await runWithCanonicalSettingsAuthority(store, async () => {
    const read = createFileReadTool({ allowedPaths: ["/app"], __testAfterFinalPathCheck: async () => { files.put("/app/file", "replacement"); } });
    expect((await read.execute(withSignedSessionId({ file_path: "/app/file" }, session))).isError).toBe(true);
    expect(hasSessionRead(session, "/app/file")).toBe(false);
    const lost = createFileReadTool({ allowedPaths: ["/app"], __testAfterFinalPathCheck: async () => { files.unavailable = true; } });
    await expect(lost.execute(withSignedSessionId({ file_path: "/app/file" }, session))).rejects.toMatchObject({ code: "environment_dead" });
    expect(hasSessionRead(session, "/app/file")).toBe(false);
  });
});
