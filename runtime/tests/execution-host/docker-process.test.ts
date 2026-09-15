import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DockerExecutionProcesses, validateExecutionIdentity } from "../../src/execution/docker-process.js";
import { ExecutionHostClient } from "../../src/execution/host-client.js";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import type { ExecutionProcessSpecification } from "../../src/execution/types.js";

const binding = { kind: "docker" as const, containerId: "a".repeat(64), generation: "b".repeat(64), processHandleNamespace: "f".repeat(32) };
const operationId = "c".repeat(32);
const sessionId = 812345;
const processHandleNamespace = "f".repeat(32);
const identity = { runId: "run", callId: "call", attempt: 1 };
const spec: ExecutionProcessSpecification = {
  program: "/bin/tool", argv: ["", "α😃\n", "$(literal)"], cwd: "/app", environment: { TASK: "exact" },
  terminal: false, lifetime: "operation",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(handle?: (message: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<{
  client: ExecutionHostClient; messages: Record<string, unknown>[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "agenc-docker-client-"));
  const sockets = new Set<Socket>();
  const messages: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      received = Buffer.concat([received, bytes]);
      if (received.length < 4 || received.length < received.readUInt32BE(0) + 4) return;
      const message = JSON.parse(received.subarray(4).toString()) as Record<string, unknown>;
      messages.push(message);
      let response: Record<string, unknown> | undefined;
      if (message.method === "capabilities") response = { ok: true, protocolVersion: 1, runtime: "agenc-runc",
        processHandleNamespace,
        features: ["exact_environment", "argv0", "output_cursors", "terminal_resize", "authority_close", "operation_indexes", "held_task_files", "durable_process_handles"] };
      else if (message.method === "bind") response = { ok: true, binding: { ...binding, initPid: 42, cgroupPath: "/host/cgroup" } };
      else if (message.method === "authorize") response = { ok: true };
      else response = handle?.(message);
      if (response === undefined) { socket.destroy(); return; }
      const body = Buffer.from(JSON.stringify(response));
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32BE(body.length); body.copy(frame, 4);
      socket.end(frame);
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  });
  const path = join(directory, "host.sock");
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { client: new ExecutionHostClient(path), messages };
}

function connect(client: ExecutionHostClient) {
  return DockerExecutionProcesses.connect({ client, target: { container: "task" }, ownerId: "owner", authorityRevision: 7 });
}

function operation() {
  return { id: operationId, session_id: sessionId, generation: binding.generation, owner: "owner", authority_revision: 7,
    run_id: "run", call_id: "call", attempt: 1, operation_index: 0,
    spec: { args: [spec.program, ...spec.argv], env: ["TASK=exact"], cwd: spec.cwd, terminal: false, user: { uid: 0, gid: 0 } },
    detached: 0, leader_exited: 1, output_complete: 0, cleanup_proven: 1, exit_code: null, failure: "lost stream" };
}

it("binds immutable identity before authority and preserves exact task input without host variables", async () => {
  const { client, messages } = await fixture(() => ({ ok: true, operationId, sessionId }));
  const owner = await connect(client);
  expect(owner.binding).toEqual(binding);
  expect(Object.isFrozen(owner.binding)).toBe(true);
  const mutableSpec = { ...spec, argv: [...spec.argv], environment: { TASK: "exact" } };
  const pending = owner.launch(mutableSpec, identity);
  mutableSpec.argv[0] = "changed"; mutableSpec.environment.TASK = "changed";
  const process = await pending;
  expect(process.sessionId).toBe(sessionId);
  expect(owner.processHandleNamespace).toBe(processHandleNamespace);
  expect(process.specification).toEqual(spec);
  expect(messages.map((value) => value.method)).toEqual(["capabilities", "bind", "authorize", "launch"]);
  expect(messages[3]).toMatchObject({ owner: "owner", generation: binding.generation, authorityRevision: 7,
    processHandleNamespace,
    spec: { args: [spec.program, ...spec.argv], env: ["TASK=exact"], cwd: "/app" } });
});

it("refuses a changed persisted generation before authorizing it", async () => {
  const { client, messages } = await fixture();
  await expect(DockerExecutionProcesses.connect({ client, target: { ...binding, generation: "d".repeat(64) },
    ownerId: "owner", authorityRevision: 7 })).rejects.toMatchObject({ code: "environment_dead" });
  expect(messages.map((value) => value.method)).toEqual(["capabilities", "bind"]);
});

it("retains the canonical UTF-8 identity bounds instead of imposing shorter transport IDs", () => {
  expect(() => validateExecutionIdentity({ ...identity, callId: "α".repeat(2048) })).not.toThrow();
  expect(() => validateExecutionIdentity({ ...identity, callId: "α".repeat(2049) })).toThrow();
  expect(() => validateExecutionIdentity({ ...identity, callId: "\ud800" })).toThrow();
});

it("retains legacy input identity when an explicit zero operation index is supplied", async () => {
  const { client, messages } = await fixture(() => ({ ok: true, operationId, sessionId }));
  const owner = await connect(client);
  const process = await owner.launch(spec, identity);
  await process.write(identity, Buffer.from("one"));
  await process.write({ ...identity, operationIndex: 0 }, Buffer.from("one"));
  await process.write({ ...identity, operationIndex: 1 }, Buffer.from("two"));
  const inputs = messages.filter((message) => message.method === "input");
  expect(inputs[0]!.inputId).toBe(inputs[1]!.inputId);
  expect(inputs[2]!.inputId).not.toBe(inputs[0]!.inputId);
});

it("snapshots held file capabilities and refuses writes to bound stdin before dispatch", async () => {
  const { client, messages } = await fixture(() => ({ ok: true, operationId, sessionId }));
  const owner = await connect(client);
  const files = { cwd: { workerId: "e".repeat(32), handle: 4 }, stdin: { workerId: "e".repeat(32), handle: 5 } };
  const pending = owner.launch(spec, identity, undefined, files);
  files.cwd.handle = 99;
  const process = await pending;
  expect(messages.at(-1)).toMatchObject({ bindings: { cwd: { handle: 4 }, stdin: { handle: 5 } } });
  const count = messages.length;
  await expect(process.write(identity, Buffer.from("not file input"))).rejects.toMatchObject({ code: "unsupported_operation", requestSent: false });
  await expect(owner.launch({ ...spec, terminal: true }, identity, undefined, files)).rejects.toMatchObject({ code: "invalid_request", requestSent: false });
  expect(messages.length).toBe(count);
});

it("dispatches several helpers with one canonical call and enumerates them without replay", async () => {
  let crossed = false;
  const secondId = "d".repeat(32);
  const { client, messages } = await fixture((message) => {
    if (message.method === "launch") {
      expect(crossed).toBe(true);
      return { ok: true, operationId: message.operationIndex === 0 ? operationId : secondId, sessionId: sessionId + Number(message.operationIndex) };
    }
    if (message.method === "call_operations") return { ok: true, operations: [
      { operationId, operationIndex: 0 }, { operationId: secondId, operationIndex: 1 },
    ] };
    if (message.method === "inspect") return { ok: true, operation: { ...operation(), id: message.operationId,
      session_id: message.operationId === operationId ? sessionId : sessionId + 1,
      operation_index: message.operationId === operationId ? 0 : 1 } };
    return undefined;
  });
  const owner = await connect(client);
  await withAdmittedExecutionCall(identity, { signal: new AbortController().signal, crossEffectBoundary: () => { crossed = true; } }, async () => {
    await owner.launchAdmitted(spec);
    await owner.launchAdmitted(spec);
  });
  const found = [];
  for await (const process of owner.reconnectCall(identity)) found.push(process.operationId);
  expect(found).toEqual([operationId, secondId]);
  expect(messages.filter((message) => message.method === "launch").map((message) => [message.callId, message.operationIndex]))
    .toEqual([["call", 0], ["call", 1]]);
});

it("recovers a lost launch reply by inspecting its original identity without another launch", async () => {
  const { client, messages } = await fixture((message) => {
    if (message.method === "lookup") return { ok: true, operationId };
    if (message.method === "inspect") return { ok: true, operation: operation() };
    return undefined;
  });
  const owner = await connect(client);
  await expect(owner.launch(spec, identity)).rejects.toMatchObject({ code: "unknown_outcome", requestSent: true });
  const process = await owner.reconnect(identity);
  expect(process?.sessionId).toBe(sessionId);
  expect(process?.specification).toEqual(spec);
  expect(await process?.inspect()).toEqual({ operationId, leaderExited: true, outputComplete: false,
    cleanupProven: true, exitCode: null, failure: "lost stream" });
  expect(messages.filter((message) => message.method === "launch")).toHaveLength(1);
});

it("carries the original store fence across the capability/bind race and subsequent calls", async () => {
  const { client, messages } = await fixture((message) => {
    expect(message.processHandleNamespace).toBe(processHandleNamespace);
    return { ok: false, code: "receipt_store_changed", message: "Original receipt store is unavailable" };
  });
  const owner = await connect(client);
  expect(messages.filter((message) => message.method !== "capabilities").every((message) => message.processHandleNamespace === processHandleNamespace)).toBe(true);
  await expect(owner.launch(spec, identity)).rejects.toMatchObject({ code: "receipt_store_changed" });
  const count = messages.length;
  await expect(owner.client.request({ method: "launch", processHandleNamespace: "0".repeat(32) })).rejects.toMatchObject({ code: "receipt_store_changed", requestSent: false });
  expect(messages).toHaveLength(count);
});

it("preserves bounded binary input and stable input identity and never resends a lost acknowledgement", async () => {
  const { client, messages } = await fixture((message) => message.method === "launch" ? { ok: true, operationId, sessionId } : undefined);
  const process = await (await connect(client)).launch(spec, identity);
  const bytes = Buffer.from([0, 255, 13, 10]);
  await expect(process.write({ ...identity, callId: "x".repeat(256) }, bytes, true)).rejects.toMatchObject({ code: "unknown_outcome" });
  const inputs = messages.filter((message) => message.method === "input");
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ data: bytes.toString("base64"), eof: true, authorityRevision: 7 });
  expect(inputs[0]!.inputId).toMatch(/^[a-f0-9]{64}$/);
});

it("does not infer output completion from cleanup and does not report unproven termination", async () => {
  const { client } = await fixture((message) => {
    if (message.method === "launch") return { ok: true, operationId, sessionId };
    if (message.method === "stop") return { ok: true, terminated: true, cleanupProven: false };
    if (message.method === "decoded_output") return { ok: true, stdout: "AP8=", stderr: "ZXJy", nextOffset: 21 };
    return undefined;
  });
  const process = await (await connect(client)).launch(spec, identity);
  expect(await process.output(0)).toEqual({ stdout: Buffer.from([0, 255]), stderr: Buffer.from("err"), nextOffset: 21 });
  await expect(process.terminate()).rejects.toMatchObject({ code: "cleanup_unproven" });
});

it.each([
  { terminal: false, stdout: "YQ==", stderr: "", nextOffset: 0 },
  { terminal: false, stdout: "", stderr: "", nextOffset: 8 },
  { terminal: false, stdout: "YR==", stderr: "", nextOffset: 9 },
  { terminal: false, stdout: "YQ==\n", stderr: "", nextOffset: 9 },
  { terminal: true, stdout: "YQ==", stderr: "", nextOffset: 9 },
])("rejects invalid encoded output or cursor receipt %j", async ({ terminal, ...receipt }) => {
  const { client } = await fixture((message) => message.method === "launch" ? { ok: true, operationId, sessionId }
    : message.method === "decoded_output" ? { ok: true, ...receipt } : undefined);
  const process = await (await connect(client)).launch({ ...spec, terminal }, identity);
  await expect(process.output(0)).rejects.toMatchObject({ code: "host_protocol" });
});

it("rejects unsupported or invalid operations before dispatch and closes the owner before awaiting cleanup", async () => {
  const { client, messages } = await fixture((message) => message.method === "launch" ? { ok: true, operationId, sessionId } : undefined);
  const owner = await connect(client);
  const before = messages.length;
  await expect(owner.launch({ ...spec, argv0: "invalid\0" }, identity)).rejects.toMatchObject({ code: "invalid_request", requestSent: false });
  await expect(owner.launch({ ...spec, environment: { __AGENC_EXECUTION_LEASE_V1: "forged" } }, identity)).rejects.toMatchObject({ code: "invalid_request" });
  expect(messages).toHaveLength(before);
  const process = await owner.launch(spec, identity);
  await expect(process.resize(80, 24)).rejects.toMatchObject({ code: "unsupported_operation", requestSent: false });
  const close = owner.close();
  await expect(owner.launch(spec, identity)).rejects.toMatchObject({ code: "invalid_authority", requestSent: false });
  await expect(close).rejects.toMatchObject({ code: "unknown_outcome" });
  expect(messages.filter((message) => message.method === "launch")).toHaveLength(1);
});

it("rejects a replacement receipt store before binding or authorizing an old session", async () => {
  const { client, messages } = await fixture();
  await expect(DockerExecutionProcesses.connect({ client, target: { ...binding, processHandleNamespace: "0".repeat(32) },
    ownerId: "owner", authorityRevision: 7 })).rejects.toMatchObject({ code: "receipt_store_changed", requestSent: false });
  expect(messages.map((message) => message.method)).toEqual(["capabilities"]);
});

it("fails closed when a restored Docker binding lost its receipt-store identity", async () => {
  const { client, messages } = await fixture();
  const { processHandleNamespace: _namespace, ...incomplete } = binding;
  await expect(DockerExecutionProcesses.connect({ client, target: incomplete as typeof binding,
    ownerId: "owner", authorityRevision: 7 })).rejects.toMatchObject({ code: "receipt_store_changed", requestSent: false });
  expect(messages.map((message) => message.method)).toEqual(["capabilities"]);
});

it("retains the original durable handle through a new controller connection", async () => {
  const { client, messages } = await fixture((message) => {
    if (message.method === "launch") return { ok: true, operationId, sessionId };
    if (message.method === "lookup") return { ok: true, operationId };
    if (message.method === "inspect") return { ok: true, operation: operation() };
    return undefined;
  });
  const original = await (await connect(client)).launch(spec, identity);
  const restoredOwner = await DockerExecutionProcesses.connect({ client, target: binding, ownerId: "owner", authorityRevision: 7 });
  const restored = await restoredOwner.reconnect(identity);
  expect(restored?.sessionId).toBe(original.sessionId);
  expect(restored?.operationId).toBe(original.operationId);
  expect(messages.filter((message) => message.method === "launch")).toHaveLength(1);
});

it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("does not invent a numeric handle after an invalid launch acknowledgement: %s", async (invalidId) => {
  const { client, messages } = await fixture(() => ({ ok: true, operationId, sessionId: invalidId }));
  await expect((await connect(client)).launch(spec, identity)).rejects.toMatchObject({ code: "unknown_outcome", requestSent: true });
  expect(messages.filter((message) => message.method === "launch")).toHaveLength(1);
});

it("detects reassignment of a retained operation's numeric handle", async () => {
  const { client } = await fixture((message) => message.method === "launch"
    ? { ok: true, operationId, sessionId }
    : { ok: true, operation: { ...operation(), session_id: sessionId + 1 } });
  const process = await (await connect(client)).launch(spec, identity);
  await expect(process.inspect()).rejects.toMatchObject({ code: "host_protocol" });
});

it.each([0, 1])("exposes observed residual termination only with proved cleanup: %s", async (cleanup) => {
  const { client } = await fixture((message) => message.method === "launch" ? { ok: true, operationId, sessionId }
    : { ok: true, operation: { ...operation(), cleanup_proven: cleanup, residual_processes_terminated: 1 } });
  const process = await (await connect(client)).launch(spec, identity);
  expect((await process.inspect()).residualProcessesTerminated).toBe(cleanup === 1 ? true : undefined);
});
