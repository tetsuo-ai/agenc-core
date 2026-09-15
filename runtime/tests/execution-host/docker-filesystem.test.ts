import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DockerExecutionFilesystem } from "../../src/execution/docker-filesystem.js";
import { DockerExecutionProcesses } from "../../src/execution/docker-process.js";
import { ExecutionHostClient, type ExecutionHostRequestOptions } from "../../src/execution/host-client.js";
import { ExecutionEnvironmentError } from "../../src/execution/types.js";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import { WorkspaceBoundReadFileTooLargeError } from "../../src/workspace/bound-read-error.js";
import { bindWorkspaceDirectoryReadCapability, bindWorkspaceFileReadCapability, bindWorkspaceDirectoryMutation,
  captureWorkspaceFilePathTransactionGuard, executeWorkspaceFileMutation } from "../../src/workspace/file-mutation-transaction.js";
import { runWithCanonicalSettingsAuthority, type CanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import * as coordination from "../../src/workspace/mutation-coordinator.js";

const binding = { kind: "docker", containerId: "a".repeat(64), generation: "b".repeat(64) };
const workerId = "c".repeat(32);
const identity = { runId: "run", callId: "file-write", attempt: 1 };

class HostFixture extends ExecutionHostClient {
  readonly messages: Record<string, unknown>[] = [];
  readonly handles = new Map<number, Buffer>();
  readonly released: number[] = [];
  readonly file: Buffer;
  next = 0;
  changed = false;
  loseWriteAck = false;
  missingParents = false;
  writes = 0;
  crossed = false;
  entryMode = 0o100644;
  features = ["exact_environment", "argv0", "output_cursors", "terminal_resize", "authority_close", "operation_indexes", "filesystem_original_guard", "filesystem_recursive_guard", "filesystem_directory_mutations", "filesystem_create_directory", "filesystem_bound_readlink", "filesystem_path_metadata", "filesystem_path_description", "held_task_files", "durable_process_handles"];
  readonly modes = new Map<number, number>();
  directoryPages: unknown[][] = [];
  constructor(content = Buffer.from("original")) { super("/unused-fixture.sock"); this.file = content; }
  metadata() { return { dev: "1", ino: "2", mode: "33188", size: this.file.length, mtimeMs: this.changed ? 2 : 1, ctimeMs: 1 }; }
  override async request<T extends Readonly<Record<string, unknown>>>(message: Readonly<Record<string, unknown>>,
    options: ExecutionHostRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw new ExecutionEnvironmentError("aborted", "cancelled", false);
    options.beforeSend?.();
    this.messages.push(message);
    const respond = (value: Record<string, unknown>) => ({ ok: true, ...value }) as unknown as T;
    if (message.method === "capabilities") return respond({ protocolVersion: 1, runtime: "agenc-runc",
      processHandleNamespace: "f".repeat(32),
      features: this.features });
    if (message.method === "bind") return respond({ binding });
    if (message.method === "authorize") return respond({});
    if (message.method === "filesystem_effect") return respond({ effect: { id: "d".repeat(32), state: "intent", result: null } });
    if (message.method === "call_operations") return respond({ operations: [{ operationIndex: 0, operationId: "d".repeat(32) }] });
    expect(message.method).toBe("filesystem");
    expect(message).toMatchObject({ owner: "owner", generation: binding.generation, authorityRevision: 1 });
    if (message.operation === "connect") return respond({ workerId });
    expect(message.workerId).toBe(workerId);
    const args = message.arguments as Record<string, unknown>;
    const handle = args.handle as number;
    switch (message.operation) {
      case "list": return respond({ entries: this.directoryPages.shift() ?? [] });
      case "inspect_path": return respond({ stats: this.metadata() });
      case "describe_path": case "describe_handle": return respond({ canonicalPath: args.path === "/app" || this.modes.get(handle) === 0o040755 ? "/app" : "/app/file", identity: {
        dev: "1", ino: this.changed ? "3" : "2", mode: String(args.path === "/app" || this.modes.get(handle) === 0o040755 ? 0o040755 : this.entryMode), size: String(this.file.length), nlink: "1",
        mtimeNs: "10000000001234567890", ctimeNs: "-12345678901234567890",
      } });
      case "bind": case "capture": case "bind_entry": {
        if (args.path === "missing") throw new ExecutionEnvironmentError("not_found", "missing", true, false);
        if (args.path === "special") throw new ExecutionEnvironmentError("unsupported_resource", "special", true, false);
        const id = ++this.next;
        this.handles.set(id, Buffer.from(this.file));
        const mode = args.kind === "directory" ? 0o040755 : message.operation === "bind_entry" ? this.entryMode : 0o100644;
        this.modes.set(id, mode);
        const missing = message.operation === "capture" && this.missingParents;
        return respond({ handle: id, existed: !missing, missingParents: missing,
          stats: { ...this.metadata(), mode: String(mode) } });
      }
      case "stat": return respond({ stats: { ...this.metadata(), mode: String(this.modes.get(handle) ?? 0o100644) } });
      case "readlink": return respond({ data: Buffer.from("/app/target").toString("base64") });
      case "read": case "expected": return respond({ data: this.handles.get(handle)!
        .subarray(args.offset as number, (args.offset as number) + (args.maximum as number)).toString("base64") });
      case "release": this.handles.delete(handle); this.released.push(handle); return respond({});
      case "stage": this.handles.set(++this.next, Buffer.alloc(0)); return respond({ handle: this.next });
      case "append": {
        const previous = this.handles.get(handle)!;
        expect(args.offset).toBe(previous.length);
        this.handles.set(handle, Buffer.concat([previous, Buffer.from(args.data as string, "base64")])); return respond({});
      }
      case "seal": case "assert": case "assert_original": return respond({});
      case "write": case "remove": case "rename_file": case "remove_directory": case "remove_symlink": case "create_directory": {
        expect(this.crossed).toBe(true);
        this.writes++;
        if (this.loseWriteAck) throw new ExecutionEnvironmentError("unknown_outcome", "lost original write acknowledgement", true);
        return respond({ stats: this.metadata() });
      }
      default: throw new Error(`Unexpected test RPC ${message.operation}`);
    }
  }
}
async function fixture(content?: Buffer) {
  const host = new HostFixture(content);
  const processes = await DockerExecutionProcesses.connect({ client: host, target: { container: "task" }, ownerId: "owner", authorityRevision: 1 });
  return { host, filesystem: await DockerExecutionFilesystem.connect(processes) };
}

function authorityFor(filesystem: DockerExecutionFilesystem): CanonicalSettingsAuthority {
  return { executionWorkspace: { environment: { binding: { ...binding, kind: "docker", processHandleNamespace: "f".repeat(32) }, filesystem },
    projectRoot: "/app", memoryProjectRoot: "/app" } } as CanonicalSettingsAuthority;
}

it("dispatches shared filesystem factories through the selected backend and releases rejected identities", async () => {
  const { host, filesystem } = await fixture();
  await runWithCanonicalSettingsAuthority(authorityFor(filesystem), async () => {
    const directory = await bindWorkspaceDirectoryReadCapability("/app", { expectedIdentity: { dev: "1", ino: "2", mode: String(0o040755) } });
    expect((await directory.readRelativeFile("file", 100)).content.toString()).toBe("original");
    await directory.dispose();
    const file = await bindWorkspaceFileReadCapability("/app/file", { expectedIdentity: { dev: "1", ino: "2", mode: "33188" } });
    expect((await file.readFile(100)).content.toString()).toBe("original"); await file.dispose();
    await expect(bindWorkspaceFileReadCapability("/app/file", { expectedIdentity: { dev: "1", ino: "999", mode: "33188" } })).rejects.toThrow(/identity/);
    await expect(bindWorkspaceDirectoryReadCapability("/app", { expectedIdentity: { dev: "1", ino: "999", mode: String(0o040755) } })).rejects.toThrow(/identity/);
    const mutation = await bindWorkspaceDirectoryMutation({ parent: { path: "/app", dev: 1, ino: 2, mode: 0o040755 }, targetPath: "/app/file" });
    await mutation.dispose();
    const guard = await captureWorkspaceFilePathTransactionGuard("/app/file");
    expect(guard.backupContent?.toString()).toBe("original"); await guard.dispose();
    expect(host.handles.size).toBe(0); expect(host.writes).toBe(0);
  });
});

it("keeps an unacknowledged mutation unknown even when inspection finds the old bytes", async () => {
  const { host, filesystem } = await fixture();
  const begin = vi.spyOn(coordination, "beginWorkspaceMutation").mockImplementation(() => {});
  const cancel = vi.spyOn(coordination, "cancelWorkspaceMutation").mockImplementation(() => {});
  const reconcile = vi.spyOn(coordination, "reconcileUnknownMutation").mockResolvedValue();
  const commit = vi.spyOn(coordination, "commitWorkspaceMutation").mockResolvedValue();
  try {
    host.loseWriteAck = true;
    await runWithCanonicalSettingsAuthority(authorityFor(filesystem), async () => {
      const token = { tokenId: "test-token", workspaceRoot: "/app", path: "/app/file" } as coordination.WorkspaceMutationToken;
      await expect(admitted(host, () => executeWorkspaceFileMutation({ admission: { decision: "allow", token },
        path: "/app/file", afterText: "new", writeUsesBoundMutation: true,
        write: async (_assert, _existed, bound) => bound.writeContent(Buffer.from("new")),
      }))).rejects.toMatchObject({ code: "unknown_outcome" });
      expect(begin).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledWith(token, { kind: "content", content: "original" }, undefined);
      expect(host.writes).toBe(1); expect(host.handles.size).toBe(0);
      const before = host.messages.length;
      await expect(executeWorkspaceFileMutation({ admission: { decision: "uncoordinated" }, path: "/app/file",
        afterText: "unsafe", write: async () => { throw new Error("must not dispatch"); } })).rejects.toMatchObject({ code: "unsupported_operation", requestSent: false });
      expect(host.messages).toHaveLength(before);
    });
  } finally { begin.mockRestore(); cancel.mockRestore(); reconcile.mockRestore(); commit.mockRestore(); }
});

it("retains preflight guards across admission and rejects foreign or reused guards before dispatch", async () => {
  const { host, filesystem } = await fixture();
  const authority = authorityFor(filesystem);
  const admission = { decision: "uncoordinated" as const };
  await runWithCanonicalSettingsAuthority(authority, async () => {
    const guard = await captureWorkspaceFilePathTransactionGuard("/app/file");
    const invoke = (path = "/app/file") => executeWorkspaceFileMutation({ admission, path, afterText: "new",
      preflightGuard: guard, writeUsesBoundMutation: true,
      write: async (assertOriginal) => { await assertOriginal(); throw new Error("stopped before mutation"); },
    });
    const captured = host.messages.filter(message => message.operation === "capture").length;
    const before = host.messages.length;
    await expect(invoke("/app/other")).rejects.toMatchObject({ code: "stale_capability", requestSent: false });
    await runWithCanonicalSettingsAuthority(authorityFor(filesystem), async () => {
      await expect(invoke()).rejects.toMatchObject({ code: "stale_capability", requestSent: false });
    });
    expect(host.messages).toHaveLength(before);
    await expect(invoke()).rejects.toThrow("stopped before mutation");
    expect(host.messages.filter(message => message.operation === "capture")).toHaveLength(captured);
    expect(host.handles.has(1)).toBe(true); // Caller retains the original guard.
    await expect(invoke()).rejects.toMatchObject({ code: "stale_capability", requestSent: false });
    await guard.dispose();
    expect(host.handles.size).toBe(0); expect(host.writes).toBe(0);
  });
});

it("cannot cancel a parent-creating effect merely because the final file is absent", async () => {
  const { host, filesystem } = await fixture();
  host.missingParents = true;
  const cancel = vi.spyOn(coordination, "cancelWorkspaceMutation");
  try {
    await runWithCanonicalSettingsAuthority(authorityFor(filesystem), async () => {
      await expect(admitted(host, () => executeWorkspaceFileMutation({ admission: { decision: "uncoordinated" },
        path: "/app/absent/child/file", afterText: "new", writeUsesBoundMutation: true,
        write: async (_assert, _existed, bound) => bound.writeContent(Buffer.from("new")),
      }))).rejects.toMatchObject({ code: "unknown_outcome" });
      expect(host.writes).toBe(1); expect(cancel).not.toHaveBeenCalled(); expect(host.handles.size).toBe(0);
    });
  } finally { cancel.mockRestore(); }
});

it("rejects hosts without recursive guard evidence before connecting a worker", async () => {
  const host = new HostFixture();
  host.features = host.features.filter(feature => feature !== "filesystem_recursive_guard");
  const owner = await DockerExecutionProcesses.connect({ client: host, target: { container: "task" }, ownerId: "owner", authorityRevision: 1 });
  await expect(DockerExecutionFilesystem.connect(owner)).rejects.toMatchObject({ code: "unsupported_host", requestSent: false });
  expect(host.messages.some(message => message.method === "filesystem")).toBe(false);
});

it("reads only the observed symlink and releases capabilities on stale identity or malformed output", async () => {
  const { host, filesystem } = await fixture();
  host.entryMode = 0o120777;
  const observed = await filesystem.describePath("/app/file", { followSymlinks: false });
  expect(await filesystem.readLink(observed)).toBe("/app/target");
  expect(host.handles.size).toBe(0);
  const reads = host.messages.filter(message => message.operation === "readlink").length;
  host.changed = true;
  await expect(filesystem.readLink(observed)).rejects.toMatchObject({ code: "path_conflict" });
  expect(host.messages.filter(message => message.operation === "readlink")).toHaveLength(reads);
  expect(host.handles.size).toBe(0);
  host.changed = false;
  const originalRpc = filesystem.rpc.bind(filesystem);
  filesystem.rpc = async (operation, args, onEffectStart) => operation === "readlink"
    ? { data: Buffer.from([255]).toString("base64") } : originalRpc(operation, args, onEffectStart);
  await expect(filesystem.readLink(observed)).rejects.toMatchObject({ code: "unsupported_resource" });
  expect(host.handles.size).toBe(0);
  expect(host.writes).toBe(0);
});

it("rejects symlink reads from an older host before acquiring handles", async () => {
  const host = new HostFixture();
  host.features = host.features.filter(feature => feature !== "filesystem_bound_readlink");
  const processes = await DockerExecutionProcesses.connect({ client: host, target: { container: "task" }, ownerId: "owner", authorityRevision: 1 });
  const filesystem = await DockerExecutionFilesystem.connect(processes);
  host.entryMode = 0o120777;
  const observed = await filesystem.describePath("/app/file", { followSymlinks: false });
  const count = host.messages.length;
  await expect(filesystem.readLink(observed)).rejects.toMatchObject({ code: "unsupported_host", requestSent: false });
  expect(host.messages).toHaveLength(count);
});

it("streams a held directory in bounded pages without consuming later output on early return", async () => {
  const { host, filesystem } = await fixture();
  host.directoryPages = [Array.from({ length: 128 }, (_, i) => ({ name: `file-${i}`, type: 8 })), [{ name: "later", type: 4 }]];
  const directory = await filesystem.bindDirectorySnapshot("/app");
  try {
    for await (const entry of directory.entries()) { expect(entry).toEqual({ name: "file-0", kind: "file" }); break; }
    expect(host.messages.filter((m) => m.operation === "list").map((m) => m.arguments)).toEqual([{ handle: 1, maximum: 128 }]);
    expect(host.directoryPages).toHaveLength(1);
    await expect(Array.fromAsync(directory.entries())).rejects.toMatchObject({ code: "invalid_request" });
  } finally { await directory.dispose(); }
  await directory.dispose();
  expect(host.released).toEqual([1]);
  const count = host.messages.length;
  await expect(Array.fromAsync(directory.entries())).rejects.toMatchObject({ code: "stale_capability" });
  await expect(directory.describe()).rejects.toMatchObject({ code: "stale_capability" });
  expect(host.messages).toHaveLength(count);
});

it("materializes all directory pages when requested and releases malformed pages", async () => {
  const { host, filesystem } = await fixture();
  host.directoryPages = [Array.from({ length: 128 }, (_, i) => ({ name: `file-${i}`, type: 8 })),
    [{ name: "directory", type: 4 }, { name: "symlink", type: 10 }, { name: "unknown", type: 0 }]];
  const entries = await filesystem.readDirectory("/app");
  expect(entries).toHaveLength(131);
  expect(entries.slice(-3)).toEqual([{ name: "directory", kind: "directory" }, { name: "symlink", kind: "symlink" }, { name: "unknown", kind: "other" }]);
  for (const bad of [{ name: "../escape", type: 8 }, { name: "\ud800", type: 4 }, { name: "valid", type: -1 }]) {
    host.directoryPages = [[bad]];
    await expect(filesystem.readDirectory("/app")).rejects.toMatchObject({ code: "host_protocol" });
  }
  expect(host.handles.size).toBe(0);
  expect(host.released).toEqual([1, 2, 3, 4]);
});
function admitted<T>(host: HostFixture, action: () => Promise<T>) {
  return withAdmittedExecutionCall(identity, { signal: new AbortController().signal,
    crossEffectBoundary: () => { host.crossed = true; } }, action);
}

it("inspects metadata through the bound owner and worker without allocating capabilities or admitting effects", async () => {
  const { host, filesystem } = await fixture();
  expect(await filesystem.inspectPath("/app/absolute")).toEqual(host.metadata());
  expect(await filesystem.inspectPath("/app/absolute", { followSymlinks: false })).toEqual(host.metadata());
  const messages = host.messages.filter((message) => message.operation === "inspect_path");
  expect(messages.map((message) => message.arguments)).toEqual([
    { path: "/app/absolute", followSymlinks: true }, { path: "/app/absolute", followSymlinks: false },
  ]);
  expect(messages.every((message) => message.effect === undefined)).toBe(true);
  expect(host.handles.size).toBe(0);
  const count = host.messages.length;
  for (const path of ["relative", "/app/\0", "/app/\ud800"]) {
    await expect(filesystem.inspectPath(path)).rejects.toMatchObject({ code: "invalid_request", requestSent: false });
  }
  for (const followSymlinks of [null, 0, "false"]) {
    await expect(filesystem.inspectPath("/app/absolute", { followSymlinks: followSymlinks as unknown as boolean }))
      .rejects.toMatchObject({ code: "invalid_request", requestSent: false });
  }
  expect(host.messages.length).toBe(count);
});

it("refuses an execution host without protected path metadata before creating its worker", async () => {
  const host = new HostFixture();
  host.features = host.features.filter((feature) => feature !== "filesystem_path_metadata");
  const processes = await DockerExecutionProcesses.connect({ client: host, target: { container: "task" }, ownerId: "owner", authorityRevision: 1 });
  await expect(DockerExecutionFilesystem.connect(processes)).rejects.toMatchObject({ code: "unsupported_host", requestSent: false });
  expect(host.messages.some((message) => message.method === "filesystem")).toBe(false);
});

it("retains exact instruction metadata and ties snapshot reads to a released owner capability", async () => {
  const { host, filesystem } = await fixture();
  const description = await filesystem.describePath("/app/file");
  expect(description.identity).toMatchObject({ nlink: "1", mtimeNs: "10000000001234567890", ctimeNs: "-12345678901234567890" });
  const file = await filesystem.bindFileSnapshot("/app/file");
  expect(await file.describe()).toEqual(description);
  expect(await file.readFile(8)).toEqual(Buffer.from("original"));
  await expect(file.readFile(7)).rejects.toBeInstanceOf(WorkspaceBoundReadFileTooLargeError);
  await file.dispose();
  await expect(file.describe()).rejects.toMatchObject({ code: "stale_capability", requestSent: false });
  await expect(file.readFile(8)).rejects.toMatchObject({ code: "stale_capability", requestSent: false });
  expect(host.handles.size).toBe(0);
});

it("reads bytes through an owner and worker epoch, enforces bounds and releases auxiliary handles", async () => {
  const content = Buffer.concat([Buffer.alloc(65537, 255), Buffer.from("α\0")]);
  const { host, filesystem } = await fixture(content);
  const capability = await filesystem.bindDirectoryRead("/app");
  await expect(capability.readRelativeFile("binary", 5)).rejects.toBeInstanceOf(WorkspaceBoundReadFileTooLargeError);
  expect((await capability.readRelativeFile("binary", 5, { truncate: true })).content).toEqual(content.subarray(0, 5));
  expect((await capability.readRelativeFile("binary", content.length)).content).toEqual(content);
  expect(await capability.readRelativeFileIfExists("missing", 5)).toBeUndefined();
  await expect(capability.readRelativeFileIfExists("special", 5)).rejects.toMatchObject({ code: "unsupported_resource" });
  const count = host.messages.length;
  await expect(capability.readRelativeFile("../escape", 5)).rejects.toMatchObject({ requestSent: false });
  expect(host.messages.length).toBe(count);
  expect(host.handles.size).toBe(1);
  await capability.dispose();
  await capability.dispose();
  await expect(capability.readRelativeFile("binary", 5)).rejects.toMatchObject({ code: "stale_capability" });
  expect(host.handles.size).toBe(0);
});

it("does not broaden exact-file capabilities and detects mutation even on zero-byte reads", async () => {
  const { host, filesystem } = await fixture(Buffer.alloc(0));
  const file = await filesystem.bindFileRead("/app/empty");
  await expect(file.readRelativeFile("neighbor", 5)).rejects.toMatchObject({ requestSent: false });
  await expect(file.readRelativeFileIfExists("neighbor", 5)).rejects.toMatchObject({ requestSent: false });
  host.changed = true;
  await expect(file.readFile(0)).rejects.toMatchObject({ code: "path_conflict" });
  await file.dispose();
});

it("streams bounded text windows across CRLF and Unicode chunk boundaries without retaining skipped lines", async () => {
  const raw = Buffer.from("x".repeat(65535) + "\r\nα😃\rthird\nfourth\n");
  const { filesystem } = await fixture(raw);
  const file = await filesystem.bindFileRead("/app/text");
  expect(await file.readTextWindow(2, 2, 12)).toMatchObject({ content: "α😃\nthird", startLine: 2, endLine: 3,
    totalLines: 3, numLines: 2, binarySample: raw.subarray(0, 8192) });
  await expect(file.readTextWindow(2, 2, 11)).rejects.toBeInstanceOf(WorkspaceBoundReadFileTooLargeError);
  expect(await file.readTextWindow(10, 3, 1)).toMatchObject({ content: "", totalLines: 4, numLines: 0, endLine: 10 });
  await file.dispose();
});

it("retains immutable backup bytes and gives multiple effects distinct coordinates under one admitted call", async () => {
  const { host, filesystem } = await fixture();
  const guard = await filesystem.captureFileGuard("/app/file");
  guard.backupContent!.fill(0);
  expect(guard.backupContent).toEqual(Buffer.from("original"));
  await guard.assertOriginalState();
  await admitted(host, async () => {
    await guard.writeBoundContent({ kind: "content", content: Buffer.from("original") }, Buffer.from("new\0\xff"));
    await guard.writeBoundContent({ kind: "content", content: Buffer.from("new\0\xff") }, guard.backupContent!);
  });
  const writes = host.messages.filter((message) => message.operation === "write");
  expect(writes.map((message) => message.effect)).toEqual([{ ...identity, operationIndex: 0 }, { ...identity, operationIndex: 1 }]);
  expect(host.handles.size).toBe(1);
  await guard.dispose();
  expect(host.handles.size).toBe(0);
});

it("never repeats a write after acknowledgement loss and inspects its retained original effect", async () => {
  const { host, filesystem } = await fixture();
  const guard = await filesystem.captureFileGuard("/app/file");
  host.loseWriteAck = true;
  await expect(admitted(host, () => guard.writeBoundContent({ kind: "missing" }, Buffer.from("new"))))
    .rejects.toMatchObject({ code: "unknown_outcome", requestSent: true });
  const receipts = await Array.fromAsync(filesystem.reconnectCall(identity));
  expect(receipts).toEqual([{ identity: { ...identity, operationIndex: 0 }, receipt: { id: "d".repeat(32), state: "intent", result: null } }]);
  expect(host.writes).toBe(1);
  expect(host.handles.size).toBe(1);
  await guard.dispose();
});

it("requires active admission for mutation and bound search and rejects invalid paths before dispatch", async () => {
  const { host, filesystem } = await fixture();
  const guard = await filesystem.captureFileGuard("/app/file");
  await expect(guard.removeBoundEntry({ kind: "content", content: Buffer.from("original") }))
    .rejects.toMatchObject({ code: "missing_admission", requestSent: false });
  expect(host.writes).toBe(0);
  const directory = await filesystem.bindDirectoryRead("/app");
  const count = host.messages.length;
  await expect(filesystem.bindDirectoryMutation({ path: "/app", dev: 1, ino: 2, mode: 0o40755 }, "../file"))
    .rejects.toMatchObject({ code: "invalid_request", requestSent: false });
  await expect(directory.runRipgrep({ program: "rg", args: [], env: {}, timeoutMs: 1000, maxOutputBytes: 10 }))
    .rejects.toMatchObject({ code: "missing_admission", requestSent: false });
  expect(host.messages.length).toBe(count);
  await guard.dispose(); await directory.dispose();
});

it("checks directory/source identities and content before admitting a native rename", async () => {
  const { host, filesystem } = await fixture();
  const parent = { path: "/app", dev: 1, ino: 2, mode: 0o40755 };
  await expect(filesystem.bindDirectoryMutation({ ...parent, ino: 9 }, "file")).rejects.toMatchObject({ code: "EDITOR_LEASE_MISMATCH" });
  const mutation = await filesystem.bindDirectoryMutation(parent, "file");
  const source = { dev: 1, ino: 2, mode: 0o100644, size: 8, mtimeMs: 1, ctimeMs: 1,
    contentSha256: createHash("sha256").update("original").digest("hex") };
  await expect(admitted(host, () => mutation.renameRegularFile("target", { ...source, contentSha256: "bad" })))
    .rejects.toMatchObject({ code: "EDITOR_LEASE_MISMATCH" });
  expect(host.writes).toBe(0);
  expect(await admitted(host, () => mutation.renameRegularFile("target", source))).toEqual({ dev: 1, ino: 2, mode: 0o100644 });
  const request = host.messages.find((message) => message.operation === "rename_file");
  expect(request).toMatchObject({ effect: { ...identity, operationIndex: 0 }, arguments: { path: "/app/file", target: "target" } });
  await mutation.dispose();
  expect(host.handles.size).toBe(0);
});

it("records unique deletion names and refuses mismatched symlink content before mutation", async () => {
  const { host, filesystem } = await fixture();
  const parent = { path: "/app", dev: 1, ino: 2, mode: 0o40755 };
  const mutation = await filesystem.bindDirectoryMutation(parent, "entry");
  host.entryMode = 0o120777;
  const expected = { dev: 1, ino: 2, mode: host.entryMode };
  await expect(admitted(host, () => mutation.removeSymlink(expected, "/wrong"))).rejects.toMatchObject({ code: "EDITOR_LEASE_MISMATCH" });
  expect(host.writes).toBe(0);
  await admitted(host, () => mutation.removeSymlink(expected, "/app/target"));
  host.entryMode = 0o40755;
  await admitted(host, () => mutation.removeDirectory(parent));
  const requests = host.messages.filter((message) => ["remove_symlink", "remove_directory"].includes(message.operation as string));
  const first = (requests[0]!.arguments as Record<string, unknown>).quarantine;
  const second = (requests[1]!.arguments as Record<string, unknown>).quarantine;
  expect(first).toMatch(/^\.agenc-delete-[a-f0-9-]+$/);
  expect(second).not.toBe(first);
  await mutation.dispose();
  await expect(mutation.removeDirectory(parent)).rejects.toMatchObject({ code: "stale_capability", requestSent: false });
});

it("admits exclusive directory creation, retains uncertain receipts, and refuses stale parents without dispatch", async () => {
  const { host, filesystem } = await fixture();
  const parent = await filesystem.describePath("/app");
  await expect(filesystem.createDirectory(parent, "memory", 0o700)).rejects.toMatchObject({ code: "missing_admission" });
  expect(host.writes).toBe(0);
  const create = (callId = identity.callId) => withAdmittedExecutionCall({ ...identity, callId }, {
    signal: new AbortController().signal, crossEffectBoundary: () => { host.crossed = true; },
  }, () => filesystem.createDirectory(parent, "memory", 0o700));
  await create();
  expect(host.messages.find(message => message.operation === "create_directory")).toMatchObject({
    effect: { ...identity, operationIndex: 0 }, arguments: { path: "/app", name: "memory", mode: 0o700 },
  });
  host.loseWriteAck = true;
  await expect(create("uncertain-directory")).rejects.toMatchObject({ code: "unknown_outcome" });
  expect(host.writes).toBe(2);
  expect(await filesystem.inspectEffect({ ...identity, callId: "uncertain-directory" })).toMatchObject({ state: "intent", result: null });
  host.changed = true;
  await expect(create("stale-parent")).rejects.toMatchObject({ code: "path_conflict", requestSent: false });
  expect(host.writes).toBe(2);
  expect(host.handles.size).toBe(0);
  const messages = host.messages.length;
  await expect(filesystem.createDirectory(parent, "../escape", 0o700)).rejects.toMatchObject({ code: "invalid_request" });
  await expect(filesystem.createDirectory(parent, "memory", 0o4700)).rejects.toMatchObject({ code: "invalid_request" });
  expect(host.messages).toHaveLength(messages);
});

it("refuses directory creation on an older host before acquiring or dispatching capabilities", async () => {
  const { filesystem } = await fixture();
  const parent = await filesystem.describePath("/app");
  const host = new HostFixture();
  host.features = host.features.filter(feature => feature !== "filesystem_create_directory");
  const processes = await DockerExecutionProcesses.connect({ client: host, target: { container: "task" }, ownerId: "owner", authorityRevision: 1 });
  const old = await DockerExecutionFilesystem.connect(processes);
  const messages = host.messages.length;
  await expect(old.createDirectory(parent, "memory", 0o700)).rejects.toMatchObject({ code: "unsupported_host", requestSent: false });
  expect(host.messages).toHaveLength(messages);
});
