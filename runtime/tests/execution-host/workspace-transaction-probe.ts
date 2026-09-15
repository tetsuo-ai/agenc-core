import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ExecutionEnvironmentError, type ExecutionEnvironment } from "../../src/execution/types.js";
import type { DockerExecutionFilesystem } from "../../src/execution/docker-filesystem.js";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import { ExecutionCoordinatorPaths } from "../../src/execution/coordinator-paths.js";
import { getCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { bindWorkspaceDirectoryReadCapability, bindWorkspaceFileReadCapability,
  captureWorkspaceFilePathTransactionGuard, executeWorkspaceFileMutation } from "../../src/workspace/file-mutation-transaction.js";
import { prepareWorkspaceMutation, workspaceMutationCoordinators } from "../../src/workspace/mutation-coordinator.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createFileEditTool, createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { getSessionReadSnapshot, withSignedSessionId } from "../../src/tools/system/filesystem.js";

export async function workspaceTransactionProbe(environment: ExecutionEnvironment, root: string, home: string): Promise<void> {
  const path = root + "/transaction.txt";
  const filesystem = environment.filesystem as DockerExecutionFilesystem;
  const fileIdentity = await filesystem.describePath(path);
  const read = await bindWorkspaceFileReadCapability(path, { expectedIdentity: fileIdentity.identity });
  try { assert.equal((await read.readFile(100)).content.toString(), "original task"); }
  finally { await read.dispose(); }
  const directory = await bindWorkspaceDirectoryReadCapability(root, { expectedIdentity: (await filesystem.describePath(root)).identity });
  try { assert.equal((await directory.readRelativeFile("transaction.txt", 100)).content.toString(), "original task"); }
  finally { await directory.dispose(); }
  const held = await captureWorkspaceFilePathTransactionGuard(path);
  try { assert.equal(held.backupContent?.toString(), "original task"); }
  finally { await held.dispose(); }
  const runId = randomUUID();
  const admitted = <T>(callId: string, operation: () => Promise<T>) => withAdmittedExecutionCall({ runId, callId, attempt: 1 },
    { signal: new AbortController().signal, crossEffectBoundary: () => {} }, operation);
  const writePath = root + "/write-tool.txt";
  await writeFile(writePath, "controller Write shadow");
  await workspaceMutationCoordinators.preparePaths([root], () => workspaceMutationCoordinators.getOrCreate(root));
  const writer = createFileWriteTool(); // Default cwd/root must come from the task binding.
  const reader = createFileReadTool({ allowedPaths: [root], maxTokens: 25_000 });
  const nestedPath = root + "/write-nested/one/two/file.txt";
  const nested = await admitted("tool-create-parents", () => writer.execute(withSignedSessionId({
    file_path: nestedPath, content: "nested task α\n" }, "nested-writer")));
  assert.notEqual(nested.isError, true, JSON.stringify(nested));
  assert.equal((await filesystem.readFile(nestedPath, 100)).toString(), "nested task α\n");
  assert.ok(getSessionReadSnapshot("nested-writer", nestedPath)?.executionFile);
  const faultPath = root + "/write-failed-parents/one/file.txt";
  const faultWriter = createFileWriteTool({ __testWrite: async ({ write }) => {
    await write(); throw new Error("Post-write fault after creating ancestors");
  } });
  await assert.rejects(admitted("tool-parent-fault", () => faultWriter.execute(withSignedSessionId({
    file_path: faultPath, content: "preserved for review" }, "parent-fault-writer"))),
    (error: unknown) => error instanceof ExecutionEnvironmentError && error.code === "unknown_outcome");
  assert.equal((await filesystem.readFile(faultPath, 100)).toString(), "preserved for review");
  assert.equal(getSessionReadSnapshot("parent-fault-writer", faultPath), undefined);
  const write = (callId: string, session: string, content: string) => admitted(callId,
    () => writer.execute(withSignedSessionId({ file_path: "write-tool.txt", content }, session)));
  const created = await write("tool-create", "writer", "created α\r\nsecond β\n");
  assert.notEqual(created.isError, true, JSON.stringify(created));
  assert.equal((await filesystem.readFile(writePath, 100)).toString(), "created α\r\nsecond β\n");
  assert.equal(await readFile(writePath, "utf8"), "controller Write shadow");
  assert.ok(getSessionReadSnapshot("writer", writePath)?.executionFile);
  assert.equal((await write("tool-overwrite", "writer", "updated α\nsecond β\n")).isError, undefined);
  const unread = await write("tool-unread", "foreign-reader", "must not write");
  assert.equal(unread.isError, true);
  assert.match(String(unread.content), /Read it first/);
  assert.equal((await reader.execute(withSignedSessionId({ file_path: writePath, offset: 1, limit: 1 }, "partial-writer"))).isError, undefined);
  assert.equal((await write("tool-partial", "partial-writer", "partial read authorizes overwrite\n")).isError, undefined);
  assert.equal((await write("tool-stale", "writer", "must not write")).isError, true);
  assert.equal((await filesystem.readFile(writePath, 100)).toString(), "partial read authorizes overwrite\n");
  // A competing write in the final-check window must not be overwritten by
  // recapturing a new guard after preflight/admission.
  const racingWriter = createFileWriteTool({ __testAfterPreWriteCheck: async () => {
    const concurrent = await filesystem.captureFileGuard(writePath);
    try { await concurrent.writeBoundContent({ kind: "content", content: concurrent.backupContent! }, Buffer.from("concurrent task version")); }
    finally { await concurrent.dispose(); }
  } });
  assert.equal((await admitted("tool-race", () => racingWriter.execute({ file_path: writePath,
    content: "must not overwrite concurrent task version", __agencSessionId: "partial-writer" }))).isError, true);
  assert.equal((await filesystem.readFile(writePath, 100)).toString(), "concurrent task version");
  assert.equal(await readFile(writePath, "utf8"), "controller Write shadow");
  await reader.execute(withSignedSessionId({ file_path: writePath }, "partial-writer"));
  const writeRpc = filesystem.rpc.bind(filesystem);
  let toolWrites = 0;
  filesystem.rpc = async (operation, args, onEffectStart) => {
    const result = await writeRpc(operation, args, onEffectStart);
    if (operation === "write") {
      toolWrites++;
      throw new ExecutionEnvironmentError("unknown_outcome", "Lost actual Write acknowledgement", true);
    }
    return result;
  };
  try {
    await assert.rejects(write("tool-lost-ack", "partial-writer", "uncertain actual Write"),
      (error: unknown) => error instanceof ExecutionEnvironmentError && error.code === "unknown_outcome");
    assert.equal(toolWrites, 1);
    assert.equal((await filesystem.readFile(writePath, 100)).toString(), "uncertain actual Write");
    assert.equal(getSessionReadSnapshot("partial-writer", writePath)?.rawContent, "concurrent task version");
  } finally { filesystem.rpc = writeRpc; }
  // The actual Edit/MultiEdit tools share the protected preflight, admission,
  // bound mutation and post-edit verification. A controller shadow at the same
  // name is never consulted and never modified.
  const editPath = root + "/edit-tool.txt";
  await writeFile(editPath, "controller Edit shadow");
  const editor = createFileEditTool({ allowedPaths: [root] });
  const multi = createFileMultiEditTool({ allowedPaths: [root] });
  const edit = (callId: string, session: string, oldString: string, newString: string, replaceAll = false) => admitted(callId,
    () => editor.execute(withSignedSessionId({ file_path: "edit-tool.txt", old_string: oldString, new_string: newString, replace_all: replaceAll }, session)));
  const seeded = await admitted("edit-seed", () => writer.execute(withSignedSessionId({ file_path: "edit-tool.txt", content: "first α\r\nsecond β\r\n" }, "editor")));
  assert.notEqual(seeded.isError, true, JSON.stringify(seeded));
  const edited = await edit("edit-replace", "editor", "second β", "third γ");
  assert.notEqual(edited.isError, true, JSON.stringify(edited));
  assert.equal((await filesystem.readFile(editPath, 100)).toString(), "first α\r\nthird γ\r\n");
  assert.equal(await readFile(editPath, "utf8"), "controller Edit shadow");
  assert.equal(getSessionReadSnapshot("editor", editPath)?.rawContent, "first α\nthird γ\n");
  const unreadEdit = await edit("edit-unread", "foreign-editor", "third", "3rd");
  assert.equal(unreadEdit.isError, true);
  assert.match(String(unreadEdit.content), /Read it first/);
  assert.equal((await reader.execute(withSignedSessionId({ file_path: editPath, offset: 2, limit: 1 }, "partial-editor"))).isError, undefined);
  assert.equal((await edit("edit-partial", "partial-editor", "first", "1st", true)).isError, undefined);
  assert.equal((await edit("edit-stale", "editor", "third", "3rd")).isError, true);
  assert.equal((await filesystem.readFile(editPath, 100)).toString(), "1st α\r\nthird γ\r\n");
  const nestedEdit = root + "/edit-nested/one/file.txt";
  const createdByEdit = await admitted("edit-create-parents", () => editor.execute(withSignedSessionId({
    file_path: nestedEdit, old_string: "", new_string: "edit created ε\n" }, "creator")));
  assert.notEqual(createdByEdit.isError, true, JSON.stringify(createdByEdit));
  assert.equal((await filesystem.readFile(nestedEdit, 100)).toString(), "edit created ε\n");
  assert.ok(getSessionReadSnapshot("creator", nestedEdit)?.executionFile);
  await reader.execute(withSignedSessionId({ file_path: editPath }, "batch"));
  const refusedBatch = await admitted("multi-refused", () => multi.execute(withSignedSessionId({ file_path: editPath,
    edits: [{ old_string: "1st", new_string: "one" }, { old_string: "absent", new_string: "x" }] }, "batch")));
  assert.equal(refusedBatch.isError, true);
  assert.match(String(refusedBatch.content), /all-or-nothing/);
  assert.equal((await filesystem.readFile(editPath, 100)).toString(), "1st α\r\nthird γ\r\n");
  const batch = await admitted("multi-applied", () => multi.execute(withSignedSessionId({ file_path: editPath,
    edits: [{ old_string: "1st", new_string: "one" }, { old_string: "third", new_string: "three" }] }, "batch")));
  assert.notEqual(batch.isError, true, JSON.stringify(batch));
  assert.equal((await filesystem.readFile(editPath, 100)).toString(), "one α\r\nthree γ\r\n");
  const faultyEditor = createFileEditTool({ allowedPaths: [root], __testWrite: async ({ write }) => {
    await write(); throw new Error("verified post-edit fault");
  } });
  const rolledBack = await admitted("edit-rollback", () => faultyEditor.execute(withSignedSessionId({
    file_path: editPath, old_string: "one", new_string: "1" }, "batch")));
  assert.equal(rolledBack.isError, true);
  assert.match(String(rolledBack.content), /verified post-edit fault/);
  assert.equal((await filesystem.readFile(editPath, 100)).toString(), "one α\r\nthree γ\r\n");
  await reader.execute(withSignedSessionId({ file_path: editPath }, "batch"));
  let toolEdits = 0;
  filesystem.rpc = async (operation, args, onEffectStart) => {
    const result = await writeRpc(operation, args, onEffectStart);
    if (operation === "write") {
      toolEdits++;
      throw new ExecutionEnvironmentError("unknown_outcome", "Lost actual Edit acknowledgement", true);
    }
    return result;
  };
  try {
    await assert.rejects(edit("edit-lost-ack", "batch", "three", "uncertain"),
      (error: unknown) => error instanceof ExecutionEnvironmentError && error.code === "unknown_outcome");
    assert.equal(toolEdits, 1);
    assert.equal((await filesystem.readFile(editPath, 100)).toString(), "one α\r\nuncertain γ\r\n");
    assert.match(String(getSessionReadSnapshot("batch", editPath)?.rawContent), /three/);
  } finally { filesystem.rpc = writeRpc; }
  assert.equal(await readFile(editPath, "utf8"), "controller Edit shadow");
  await workspaceMutationCoordinators.preparePaths([root, path], async () => {
    const coordinator = workspaceMutationCoordinators.getOrCreate(root);
    const apply = async (beforeText: string, afterText: string, fault = false) => {
      const admission = await prepareWorkspaceMutation({ path, source: "file_write", beforeText, afterText });
      assert.equal(admission.decision, "allow");
      await executeWorkspaceFileMutation({ admission, path, afterText, writeUsesBoundMutation: true,
        write: async (_assert, _existed, bound) => bound.writeContent(Buffer.from(afterText)),
        ...(fault ? { testHooks: { __testWrite: async ({ write }: { write(): Promise<void> }) => { await write(); throw new Error("verified post-write fault"); } } } : {}),
      });
    };
    await admitted("confirmed", () => apply("original task", "confirmed task"));
    assert.equal((await filesystem.readFile(path, 100)).toString(), "confirmed task");
    await assert.rejects(admitted("rollback", () => apply("confirmed task", "rolled back", true)), /verified post-write fault/);
    assert.equal((await filesystem.readFile(path, 100)).toString(), "confirmed task");
    const rpc = filesystem.rpc.bind(filesystem);
    let writes = 0;
    filesystem.rpc = async (operation, args, onEffectStart) => {
      const result = await rpc(operation, args, onEffectStart);
      if (operation === "write") {
        writes++;
        throw new ExecutionEnvironmentError("unknown_outcome", "Injected loss of mutation acknowledgement", true);
      }
      return result;
    };
    try {
      await assert.rejects(admitted("lost-ack", () => apply("confirmed task", "uncertain task")),
        (error: unknown) => error instanceof ExecutionEnvironmentError && error.code === "unknown_outcome");
      assert.equal(writes, 1, "An unacknowledged mutation must not trigger another write");
    } finally { filesystem.rpc = rpc; }
    assert.equal((await filesystem.readFile(path, 100)).toString(), "uncertain task");
    await coordinator.flushQuarantinePersistence();
    const workspace = getCanonicalSettingsAuthority()!.executionWorkspace!;
    const key = createHash("sha256").update(root).digest("hex").slice(0, 32);
    const ledger = new ExecutionCoordinatorPaths(workspace).storageHome(home) + "/workspace-mutations/" + key + "/ledger-v1.jsonl";
    const entries = (await readFile(ledger, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(entries.some(entry => entry.path === path && entry.status === "applied"));
    assert.ok(entries.some(entry => entry.path === path && entry.status === "unknown_outcome"));
    assert.ok(entries.some(entry => entry.path === writePath && entry.status === "applied"));
    assert.ok(entries.some(entry => entry.path === writePath && entry.status === "unknown_outcome"));
    assert.ok(entries.some(entry => entry.path === nestedPath && entry.status === "applied"));
    assert.ok(entries.some(entry => entry.path === faultPath && entry.status === "unknown_outcome"));
    assert.ok(entries.some(entry => entry.path === editPath && entry.status === "applied"));
    assert.ok(entries.some(entry => entry.path === editPath && entry.status === "unknown_outcome"));
    assert.ok(entries.some(entry => entry.path === nestedEdit && entry.status === "applied"));
  });
  assert.equal(await readFile(path, "utf8"), "controller transaction shadow");
}
