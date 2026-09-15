/** Real TypeScript backend + native worker probe. This is not an AgenC session. */
import assert from "node:assert/strict";
import { permissionPathProbe } from "./permission-path-probe.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DockerExecutionEnvironment } from "../../src/execution/docker-environment.js";
import { EnvironmentProcessManager } from "../../src/unified-exec/environment-process-manager.js";
import { ExecutionHostClient } from "../../src/execution/host-client.js";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import { WorkspacePathIdentityChangedError } from "../../src/workspace/mutation-error.js";
import { WorkspaceBoundReadFileTooLargeError } from "../../src/workspace/bound-read-error.js";
import type { WorkspaceBoundRegularFileIdentity } from "../../src/workspace/file-mutation-transaction.js";
import { managedRecoveryProbe } from "./managed-recovery-probe.js";
import { configProbe } from "./config-probe.js";
import { instructionProbe } from "./instruction-probe.js";
import { liveInstructionProbe } from "./live-instruction-probe.js";
import { pluginContentProbe } from "./plugin-content-probe.js";
import { roleContentProbe } from "./role-content-probe.js";

if (process.argv[2] === "--managed-recovery-start" || process.argv[2] === "--managed-recovery-restore") {
  await managedRecoveryProbe(process.argv[2] === "--managed-recovery-start" ? "start" : "restore");
  process.exit(0);
}

const ownerId = `typescript-probe-${randomUUID()}`;
const environment = await DockerExecutionEnvironment.connect({ client: new ExecutionHostClient("/run/agenc-execution/controller.sock"),
  target: { container: "agenc-task" }, ownerId, authorityRevision: 0 });
const { processes, filesystem } = environment;
const runId = randomUUID();
let call = 0, effectBoundaries = 0;
function admitted<T>(callId: string, action: () => Promise<T>) {
  return withAdmittedExecutionCall({ runId, callId, attempt: 1 }, { signal: new AbortController().signal,
    crossEffectBoundary: () => { effectBoundaries++; } }, action);
}
async function python(source: string, args: readonly string[] = [], expectedExit = 0) {
  const process = await admitted(`process-${++call}`, () => processes.launchAdmitted({
    program: "/usr/local/bin/python3", argv: ["-c", source, ...args], cwd: "/",
    environment: { PATH: "/usr/local/bin:/usr/bin:/bin" }, terminal: false, lifetime: "operation" }));
  const deadline = Date.now() + 15000;
  for (;;) {
    const receipt = await process.inspect();
    if (receipt.outputComplete && receipt.cleanupProven) {
      assert.equal(receipt.exitCode, expectedExit, JSON.stringify(receipt));
      const output = await process.output(0);
      assert.equal(output.stderr.length, 0, output.stderr.toString());
      return output.stdout;
    }
    assert.ok(Date.now() < deadline, JSON.stringify(receipt));
    await delay(20);
  }
}
async function entryIdentity(path: string): Promise<WorkspaceBoundRegularFileIdentity> {
  return JSON.parse((await python("import os,sys,json,stat,hashlib\np=sys.argv[1]; s=os.lstat(p)\n" +
    "print(json.dumps(dict(dev=s.st_dev,ino=s.st_ino,mode=s.st_mode,size=s.st_size,mtimeMs=s.st_mtime_ns/1000000," +
    "ctimeMs=s.st_ctime_ns/1000000,contentSha256=hashlib.sha256(open(p,'rb').read()).hexdigest() if stat.S_ISREG(s.st_mode) else '')))",
    [path])).toString());
}

try {
  const root = `/app/${ownerId}`;
  await python("import os,sys\nr=sys.argv[1]\nos.makedirs(r+'/dir')\nopen(r+'/dir/file','wb').write(b'original')\n" +
    "open(r+'/text','wb').write(('x'*65535+'\\r\\nα😃\\rthird\\nfourth\\n').encode())\n" +
    "os.symlink(r+'/dir/file',r+'/absolute')\nos.mkfifo(r+'/fifo')", [root]);
  assert.deepEqual(await filesystem.readFile(root + "/absolute", 32), Buffer.from("original"));
  await configProbe(environment, root, python);
  await instructionProbe(environment, root, python);
  await liveInstructionProbe(environment, root, python);
  await pluginContentProbe(environment, root, python);
  await roleContentProbe(environment, root, python);
  assert.ok((await filesystem.readDirectory(root)).some((entry) => entry.name === "absolute" && entry.kind === "symlink"));
  await assert.rejects(filesystem.readFile(root + "/fifo", 32), { code: "unsupported_resource" });
  await assert.rejects(filesystem.readFile("/proc/self/status", 4096), { code: "unsupported_resource" });
  const text = await filesystem.bindFileRead(root + "/text");
  assert.deepEqual((await text.readTextWindow(2, 2, 12)).content, "α😃\nthird");
  await assert.rejects(text.readTextWindow(2, 2, 11), WorkspaceBoundReadFileTooLargeError);
  await text.dispose();

  const createParent = await filesystem.describePath(root);
  await assert.rejects(filesystem.createDirectory(createParent, "unadmitted", 0o700), { code: "missing_admission" });
  await admitted("mkdir-protected", () => filesystem.createDirectory(createParent, "created-memory", 0o700));
  assert.equal(BigInt((await filesystem.describePath(root + "/created-memory")).identity.mode) & 0o777n, 0o700n);
  const mkdirReceipt = await filesystem.inspectEffect({ runId, callId: "mkdir-protected", attempt: 1 });
  assert.equal(mkdirReceipt?.result?.ok, true);
  const currentCreateParent = await filesystem.describePath(root);
  await assert.rejects(admitted("mkdir-protected", () => filesystem.createDirectory(
    currentCreateParent, "created-again", 0o700)), { code: "operation_exists" });
  await assert.rejects(admitted("mkdir-existing", () => filesystem.createDirectory(
    currentCreateParent, "created-memory", 0o700)), { code: "path_conflict", mutationStarted: false });
  await assert.rejects(admitted("mkdir-symlink", () => filesystem.createDirectory(
    currentCreateParent, "absolute", 0o700)), { code: "path_conflict", mutationStarted: false });
  await assert.rejects(filesystem.describePath(root + "/unadmitted"), { code: "not_found" });
  await assert.rejects(filesystem.describePath(root + "/created-again"), { code: "not_found" });
  await python("import os,sys\nos.mkdir(sys.argv[1]+'/mkdir-parent')\nos.mkdir(sys.argv[1]+'/mkdir-outside')", [root]);
  const racedParent = await filesystem.describePath(root + "/mkdir-parent");
  const originalRpc = filesystem.rpc.bind(filesystem);
  filesystem.rpc = async (operation, args, onEffectStart) => {
    if (operation === "create_directory") {
      await python("import os,sys\nr=sys.argv[1]\nos.rename(r+'/mkdir-parent',r+'/mkdir-moved')\nos.symlink(r+'/mkdir-outside',r+'/mkdir-parent')", [root]);
    }
    return originalRpc(operation, args, onEffectStart);
  };
  try {
    await assert.rejects(admitted("mkdir-parent-swap", () => filesystem.createDirectory(racedParent, "escape", 0o700)),
      { code: "path_conflict", mutationStarted: false });
  } finally { filesystem.rpc = originalRpc; }
  await assert.rejects(filesystem.describePath(root + "/mkdir-outside/escape"), { code: "not_found" });
  await assert.rejects(filesystem.describePath(root + "/mkdir-moved/escape"), { code: "not_found" });
  console.log("Protected directory creation: private mode, strict admission, original receipts/no replay, occupied/symlink rejection and held-parent swap fencing passed");
  await permissionPathProbe(environment, root, python);

  const guard = await filesystem.captureFileGuard(root + "/dir/file");
  await guard.assertOriginalState();
  const original = { kind: "content" as const, content: Buffer.from("original") };
  const changed = { kind: "content" as const, content: Buffer.from([0, 255, 0xc3, 0xb1]) };
  await admitted("write-and-rollback", async () => {
    await guard.writeBoundContent(original, changed.content);
    assert.deepEqual(await guard.observeState(), changed);
    assert.deepEqual(await python("import sys; sys.stdout.buffer.write(open(sys.argv[1],'rb').read())", [root + "/dir/file"]), changed.content);
    await guard.writeBoundContent(changed, original.content);
  });
  await guard.assertOriginalState();
  const effects = await Array.fromAsync(filesystem.reconnectCall({ runId, callId: "write-and-rollback", attempt: 1 }));
  assert.deepEqual(effects.map((effect) => effect.identity.operationIndex), [0, 1]);
  assert.ok(effects.every((effect) => effect.receipt.state === "acknowledged" && effect.receipt.result?.ok === true));
  await admitted("delete-and-restore", async () => {
    await guard.removeBoundEntry(original);
    assert.deepEqual(await guard.observeState(), { kind: "missing" });
    await guard.writeBoundContent({ kind: "missing" }, original.content);
  });
  await assert.rejects(guard.assertOriginalState(), WorkspacePathIdentityChangedError);
  await guard.dispose();

  const current = await filesystem.captureFileGuard(root + "/dir/file");
  const directory = await filesystem.bindDirectoryRead(root + "/dir");
  await python("import os,sys\nr=sys.argv[1]\nos.rename(r+'/dir',r+'/moved')\nos.mkdir(r+'/dir')\nopen(r+'/dir/file','wb').write(b'replacement')", [root]);
  assert.deepEqual((await directory.readRelativeFile("file", 32)).content, original.content);
  let mutationStarted = false;
  await assert.rejects(admitted("parent-conflict", () => current.writeBoundContent(original, changed.content,
    () => { mutationStarted = true; })), WorkspacePathIdentityChangedError);
  assert.equal(mutationStarted, false);
  assert.deepEqual(await current.observeState(), { kind: "unreadable" });
  assert.deepEqual(await filesystem.readFile(root + "/dir/file", 32), Buffer.from("replacement"));
  await current.dispose(); await directory.dispose();

  await python("import os,sys\nr=sys.argv[1]+'/topology'\nos.makedirs(r+'/tree/nested')\n" +
    "open(r+'/source','wb').write(b'rename me')\nopen(r+'/occupied','wb').write(b'keep')\n" +
    "open(r+'/tree/nested/file','wb').write(b'delete')\nos.symlink(r+'/occupied',r+'/tree/nested/absolute')\n" +
    "os.symlink('occupied',r+'/link')", [root]);
  const topology = root + "/topology";
  const parent = { ...await entryIdentity(topology), path: topology };
  const source = await entryIdentity(topology + "/source");
  const rename = await filesystem.bindDirectoryMutation(parent, "source");
  let renameStarted = false;
  await assert.rejects(admitted("rename-occupied", () => rename.renameRegularFile("occupied", source,
    () => { renameStarted = true; })), WorkspacePathIdentityChangedError);
  assert.equal(renameStarted, false);
  assert.deepEqual(await filesystem.readFile(topology + "/occupied", 32), Buffer.from("keep"));
  const renamed = await admitted("rename-free", () => rename.renameRegularFile("destination", source));
  assert.deepEqual(renamed, { dev: source.dev, ino: source.ino, mode: source.mode });
  assert.deepEqual(await filesystem.readFile(topology + "/destination", 32), Buffer.from("rename me"));
  await assert.rejects(filesystem.readFile(topology + "/source", 32), { code: "not_found" });
  await rename.dispose();
  const link = await filesystem.bindDirectoryMutation(parent, "link");
  const linkState = await entryIdentity(topology + "/link");
  await admitted("remove-link", () => link.removeSymlink(linkState, "occupied"));
  await link.dispose();
  const tree = await filesystem.bindDirectoryMutation(parent, "tree");
  const treeState = await entryIdentity(topology + "/tree");
  await admitted("remove-tree", () => tree.removeDirectory(treeState));
  await tree.dispose();
  assert.deepEqual(await filesystem.readFile(topology + "/occupied", 32), Buffer.from("keep"));
  assert.deepEqual((await filesystem.readDirectory(topology)).map((entry) => entry.name).sort(), ["destination", "occupied"]);
  const removal = await filesystem.inspectEffect({ runId, callId: "remove-tree", attempt: 1 });
  assert.equal(removal?.request?.operation, "remove_directory");
  assert.match((removal?.request?.arguments as { quarantine: string }).quarantine, /^\.agenc-delete-/);

  await python("import os,sys\np=sys.argv[1]\nos.mkdir(p)\nos.mkfifo(p+'/fifo')", [topology + "/special-tree"]);
  const unsupported = await filesystem.bindDirectoryMutation(parent, "special-tree");
  const unsupportedState = await entryIdentity(topology + "/special-tree");
  let partialStarted = false;
  await assert.rejects(admitted("remove-special-tree", () => unsupported.removeDirectory(unsupportedState,
    () => { partialStarted = true; })), { code: "unsupported_resource", mutationStarted: true });
  assert.equal(partialStarted, true);
  const failedRemoval = await filesystem.inspectEffect({ runId, callId: "remove-special-tree", attempt: 1 });
  assert.deepEqual(failedRemoval?.result, { ok: false, code: "unsupported_resource", mutationStarted: true });
  const failedArguments = failedRemoval?.request?.arguments as Record<string, unknown>;
  assert.equal(typeof failedArguments.quarantine, "string");
  assert.ok((await filesystem.readDirectory(topology)).some((entry) => entry.name === failedArguments.quarantine));
  assert.ok(!(await filesystem.readDirectory(topology)).some((entry) => entry.name === "special-tree"));
  await assert.rejects(admitted("remove-special-tree", () => filesystem.rpc("remove_directory", failedArguments)), { code: "operation_exists" });
  await unsupported.dispose();
  assert.deepEqual(await filesystem.readFile(topology + "/occupied", 32), Buffer.from("keep"));
  console.log("Native partial directory failure retains its original quarantine request and cannot be replayed");

  // A parent captured before the exchange must not redirect topology effects.
  const staleParent = await filesystem.bindDirectoryMutation(parent, "occupied");
  const occupied = await entryIdentity(topology + "/occupied");
  await python("import os,sys\np=sys.argv[1]\nos.rename(p,p+'-moved')\nos.mkdir(p)\nopen(p+'/occupied','wb').write(b'untouched')", [topology]);
  let topologyStarted = false;
  await assert.rejects(admitted("topology-parent-swap", () => staleParent.renameRegularFile("destination", occupied,
    () => { topologyStarted = true; })), WorkspacePathIdentityChangedError);
  assert.equal(topologyStarted, false);
  assert.deepEqual(await filesystem.readFile(topology + "/occupied", 32), Buffer.from("untouched"));
  await staleParent.dispose();
  console.log("TypeScript/native directory mutations: exclusive rename, symlink removal, recursive non-following deletion, retained request and parent-swap rejection passed");

  await python("import os,sys\np=sys.argv[1]\nos.mkdir(p)\nopen(p+'/input','wb').write(b'held\\x00\\xffinput')", [root + "/bound"]);
  const heldDirectory = await filesystem.bind(root + "/bound", "directory");
  const heldInput = await filesystem.bind(root + "/bound/input", "file");
  await python("import os,sys\np=sys.argv[1]\nos.rename(p,p+'-moved')\nos.mkdir(p)\nopen(p+'/input','wb').write(b'replacement')", [root + "/bound"]);
  const bindings = { cwd: { workerId: filesystem.workerId, handle: heldDirectory.handle },
    stdin: { workerId: filesystem.workerId, handle: heldInput.handle } };
  const boundProcess = await admitted("held-files", () => processes.launchAdmitted({
    program: "/usr/local/bin/python3", argv: ["-c", "import os,sys\nassert os.getcwd()==sys.argv[1]\nsys.stdout.buffer.write(sys.stdin.buffer.read())", root + "/bound-moved"],
    cwd: root + "/bound", environment: {}, terminal: false, lifetime: "operation" }, bindings));
  // The lease has its own descriptors, independent of the read capabilities.
  await filesystem.release(heldDirectory.handle); await filesystem.release(heldInput.handle);
  const boundDeadline = Date.now() + 15000;
  for (;;) {
    const receipt = await boundProcess.inspect();
    if (receipt.cleanupProven && receipt.outputComplete) {
      assert.equal(receipt.exitCode, 0, JSON.stringify(receipt));
      break;
    }
    assert.ok(Date.now() < boundDeadline, JSON.stringify(receipt));
    await delay(20);
  }
  assert.deepEqual((await boundProcess.output(0)).stdout, Buffer.from([104, 101, 108, 100, 0, 255, 105, 110, 112, 117, 116]));
  await assert.rejects(boundProcess.write({ runId, callId: "bound-input", attempt: 1 }, Buffer.from("not input")),
    { code: "unsupported_operation", requestSent: false });
  const reconnected = await processes.reconnect({ runId, callId: "held-files", attempt: 1 });
  assert.equal(reconnected?.operationId, boundProcess.operationId);
  assert.equal(reconnected?.sessionId, boundProcess.sessionId);
  await assert.rejects(reconnected!.write({ runId, callId: "bound-reconnected-input", attempt: 1 }, Buffer.from("not input")),
    { code: "unsupported_operation", requestSent: false });
  console.log("TypeScript/native held task cwd and binary input survive parent swaps and capability release without replay");

  await python("import os,sys\np=sys.argv[1]\nos.mkdir(p)\nopen(p+'/one.txt','w').write('needle α\\nsecond needle\\n')", [root + "/search"]);
  const searchDirectory = await filesystem.bindDirectoryRead(root + "/search");
  const searchFile = await filesystem.bindFileRead(root + "/search/one.txt");
  await python("import os,sys\np=sys.argv[1]\nos.rename(p,p+'-moved')\nos.mkdir(p)\nopen(p+'/replacement.txt','w').write('needle replacement')", [root + "/search"]);
  const search = { program: "/usr/local/bin/rg", env: {}, timeoutMs: 10000, maxOutputBytes: 100000 };
  const discovery = await admitted("bound-search-discovery", () => searchDirectory.runRipgrep({ ...search,
    args: ["--no-config", "--no-follow", "--null", "--files-with-matches", "needle", "."],
    structuredLineLimit: { outputMode: "files_with_matches", maximumLines: 10, maximumRecordBytes: 1024 } }));
  assert.equal(discovery.exitCode, 0, JSON.stringify(discovery));
  assert.equal(discovery.spawnError, undefined);
  assert.deepEqual(discovery.stdout, Buffer.from("./one.txt\0"));
  const fileSearch = await admitted("bound-search-file", () => searchFile.runRipgrep({ ...search,
    args: ["--no-config", "--text", "needle", "-"], relativeInputFile: "one.txt" }));
  assert.equal(fileSearch.exitCode, 0, JSON.stringify(fileSearch));
  assert.deepEqual(fileSearch.stdout, Buffer.from("needle α\nsecond needle\n"));
  const supplied = Buffer.concat([Buffer.alloc(200000, 120), Buffer.from("\nneedle α\n")]);
  const suppliedSearch = await admitted("bound-search-supplied", () => searchDirectory.runRipgrep({ ...search,
    args: ["--no-config", "--text", "--count", "needle", "-"], stdin: supplied }));
  assert.equal(suppliedSearch.exitCode, 0, JSON.stringify(suppliedSearch));
  assert.deepEqual(suppliedSearch.stdout, Buffer.from("1\n"));
  const contentSearch = await admitted("bound-search-json", () => searchDirectory.runRipgrep({ ...search,
    args: ["--no-config", "--no-follow", "--json", "needle", "."],
    structuredLineLimit: { outputMode: "content", maximumLines: 1, maximumRecordBytes: 4096 } }));
  assert.equal(contentSearch.spawnError, undefined);
  assert.equal(contentSearch.killedAfterLimit, true);
  assert.match(contentSearch.stdout.toString(), /needle α/);
  assert.doesNotMatch(contentSearch.stdout.toString(), /second needle/);
  const originalSearch = await processes.reconnect({ runId, callId: "bound-search-json", attempt: 1 });
  assert.equal((await originalSearch!.inspect()).cleanupProven, true);
  const spoolRoot = await mkdtemp(join(tmpdir(), "agenc-kernel-search-spool-"));
  try {
    const spoolPath = join(spoolRoot, "candidates");
    const spooled = await admitted("bound-search-spool", () => searchDirectory.runRipgrep({ ...search,
      args: ["--no-config", "--no-follow", "--null", "--files-with-matches", "needle", "."],
      maxOutputBytes: 1, stdoutSpoolPath: spoolPath, maxSpoolBytes: 1000 }));
    assert.equal(spooled.exitCode, 0, JSON.stringify(spooled));
    assert.equal(spooled.stdout.length, 0);
    assert.equal(spooled.spooledBytes, Buffer.byteLength("./one.txt\0"));
    assert.deepEqual(await readFile(spoolPath), Buffer.from("./one.txt\0"));
  } finally { await rm(spoolRoot, { recursive: true, force: true }); }
  // Task-controlled replacements/helpers still run in the search command's
  // scope. Timeout and caller cancellation must drain their descendants.
  for (const reason of ["timeout", "aborted"] as const) {
    const pidPath = root + "/search-" + reason + ".pid";
    const cancel = new AbortController();
    const callId = "bound-search-" + reason;
    const pending = admitted(callId, () => searchDirectory.runRipgrep({ ...search,
      program: "/usr/local/bin/python3", timeoutMs: reason === "timeout" ? 1500 : 10000,
      signal: cancel.signal,
      args: ["-c", "import os,sys,time\nif os.fork()==0:\n os.setsid()\n" +
        " open(sys.argv[1],'w').write(str(os.getpid()))\n time.sleep(60)\nelse: time.sleep(60)", pidPath] }));
    // Observe this specific descendant before cancellation; no timing-only
    // assumption stands in for evidence that the command actually launched.
    if (reason === "aborted") {
      const startedBy = Date.now() + 5000;
      for (;;) {
        try { await filesystem.readFile(pidPath, 32); break; }
        catch (error) { if ((error as { code?: string }).code !== "not_found") throw error; }
        assert.ok(Date.now() < startedBy, "Bound search helper did not start");
        await delay(20);
      }
      cancel.abort();
    }
    const stopped = await pending;
    assert.equal(stopped.stopReason, reason, JSON.stringify(stopped));
    const receipt = await (await processes.reconnect({ runId, callId, attempt: 1 }))!.inspect();
    assert.equal(receipt.cleanupProven, true);
    await python("import os,sys\np=open(sys.argv[1]).read()\n" +
      "assert not os.path.exists('/proc/'+p+'/stat') or open('/proc/'+p+'/stat').read().split()[2]=='Z'", [pidPath]);
  }
  await searchDirectory.dispose(); await searchFile.dispose();
  console.log("Real task ripgrep: held directory/file searches, multi-chunk Unicode input, structured limits, private spooling and descendant cleanup on timeout/cancellation passed");

  const managerOwner = ownerId + "-manager";
  const managerEnvironment = await DockerExecutionEnvironment.connect({ client: processes.client,
    target: environment.binding, ownerId: managerOwner, authorityRevision: 0 });
  const manager = new EnvironmentProcessManager({ executionEnvironment: managerEnvironment, cwd: root,
    baseEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  try {
    const cleanupPath = root + "/agenc-manager-cleanup-2477.py";
    await python("import sys\nopen(sys.argv[1],'w').write(\"import os,signal\\nfor entry in os.listdir('/proc'):\\n " +
      "if entry.isdigit():\\n  try:\\n   if b'agenc-manager-cleanup-2477.py' in open('/proc/'+entry+'/cmdline','rb').read(): os.kill(int(entry),signal.SIGKILL)\\n  except OSError: pass\\n\")", [cleanupPath]);
    const selfKilled = await admitted("manager-self-kill", () => manager.execCommand({ ownerId: managerOwner,
      cmd: "/usr/local/bin/python3 " + cleanupPath, yield_time_ms: 10000 }));
    assert.equal(selfKilled.exitCode, 137, JSON.stringify(selfKilled));
    const following = await admitted("manager-following", () => manager.execCommand({ ownerId: managerOwner,
      cmd: "printf manager-survived", yield_time_ms: 10000 }));
    assert.equal(following.exitCode, 0, JSON.stringify(following));
    assert.equal(following.stdout, "manager-survived");
    assert.equal(following.residual_processes_terminated, undefined);
    assert.match((await managerEnvironment.filesystem.readFile(cleanupPath, 4096)).toString(), /os.kill/);

    const forkingPath = root + "/manager-double-fork.py";
    const forkingSource = "import os,time\nr,w=os.pipe()\nif os.fork()==0:\n os.close(r)\n os.setsid()\n " +
      "if os.fork()==0:\n  os.write(w,b'1')\n  os.close(w)\n  time.sleep(60)\n os._exit(0)\n" +
      "os.close(w)\nassert os.read(r,1)==b'1'\nos.close(r)\nprint('leader finished')\n";
    await python("import sys\nopen(sys.argv[1],'w').write(sys.argv[2])", [forkingPath, forkingSource]);
    const descendants = await admitted("manager-double-fork", () => manager.execCommand({ ownerId: managerOwner,
      cmd: "/usr/local/bin/python3 " + forkingPath, yield_time_ms: 10000 }));
    assert.equal(descendants.exitCode, 0, JSON.stringify(descendants));
    assert.equal(descendants.stdout, "leader finished\n");
    assert.equal(descendants.residual_processes_terminated, true);

    const releasePath = root + "/manager-release";
    const background = await admitted("manager-background", () => manager.execCommand({ ownerId: managerOwner,
      cmd: `while [ ! -f '${releasePath}' ]; do sleep 0.02; done; printf manager-retained; sleep 60`, yield_time_ms: 250 }));
    assert.equal(background.stdout, "");
    assert.equal(typeof background.session_id, "number");
    const originalHandle = await managerEnvironment.reconnect({ runId, callId: "manager-background", attempt: 1 });
    assert.equal(originalHandle?.sessionId, background.session_id);
    await assert.rejects(manager.writeStdin({ ownerId: "foreign", session_id: background.session_id! }), { code: "owner_denied" });
    await assert.rejects(manager.terminateProcess({ ownerId: "foreign", processId: background.session_id! }), { code: "owner_denied" });
    assert.deepEqual(manager.listProcesses("foreign"), []);
    await python("import sys\nopen(sys.argv[1],'w').close()", [releasePath]);
    const outputDeadline = Date.now() + 5000;
    while (!manager.listBackgroundProcesses().some((entry) => entry.outputTail.includes("manager-retained"))) {
      assert.ok(Date.now() < outputDeadline, "Manager did not capture task output");
      await delay(20);
    }
    assert.equal(manager.listProcesses(managerOwner)[0].session_id, background.session_id);
    assert.equal(manager.listProcesses(managerOwner)[0].session_id, background.session_id);
    assert.deepEqual(await manager.terminateProcess({ ownerId: managerOwner, processId: background.session_id! }), { terminated: true });
    const polled = await manager.writeStdin({ ownerId: managerOwner, session_id: background.session_id! });
    assert.equal(polled.stdout, "manager-retained");
    assert.equal(polled.exitCode, 137, JSON.stringify(polled));
    assert.deepEqual(await manager.terminateProcess({ ownerId: managerOwner, processId: background.session_id! }), { terminated: false });

    const terminal = await admitted("manager-terminal", () => manager.execCommand({ ownerId: managerOwner,
      cmd: 'read value; printf "received:%s" "$value"', tty: true, yield_time_ms: 250 }));
    assert.equal(typeof terminal.session_id, "number");
    const terminalResult = await admitted("manager-input", () => manager.writeStdin({ ownerId: managerOwner,
      session_id: terminal.session_id!, chars: "α\n", yield_time_ms: 10000 }));
    assert.equal(terminalResult.exitCode, 0, JSON.stringify(terminalResult));
    assert.match(terminalResult.stdout, /received:α/);
    const restoredEnvironment = await DockerExecutionEnvironment.connect({ client: new ExecutionHostClient(processes.client.socketPath),
      target: managerEnvironment.binding, ownerId: managerOwner, authorityRevision: 0 });
    const restoredHandle = await restoredEnvironment.reconnect({ runId, callId: "manager-background", attempt: 1 });
    assert.equal(restoredHandle?.sessionId, background.session_id);
    assert.equal(restoredHandle?.operationId, originalHandle?.operationId);
    assert.deepEqual(await restoredHandle!.terminate(), { terminated: false, cleanupProven: true });
    const replacementManager = new EnvironmentProcessManager({ executionEnvironment: restoredEnvironment, cwd: root,
      baseEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
    try {
      const newer = await admitted("manager-new-controller", () => replacementManager.execCommand({ ownerId: managerOwner,
        cmd: "sleep 60", yield_time_ms: 250 }));
      assert.ok(newer.session_id! > background.session_id!);
      assert.deepEqual(await replacementManager.terminateProcess({ ownerId: managerOwner, processId: background.session_id! }), { terminated: false });
      await assert.rejects(replacementManager.writeStdin({ ownerId: managerOwner, session_id: background.session_id! }), { code: "unknown_process" });
      assert.equal(replacementManager.listProcesses(managerOwner)[0].session_id, newer.session_id);
      assert.deepEqual(await replacementManager.terminateProcess({ ownerId: managerOwner, processId: newer.session_id! }), { terminated: true });
    } finally { await replacementManager.closeAll(); }
    console.log("Environment process manager: self-kill/subsequent call, double-fork/setsid cleanup receipt, protected filesystem, durable owned numeric handles across controller connections, stale-handle isolation, non-consuming listing, strict kill/poll and Unicode PTY input passed");
  } finally { await manager.closeAll(); }

  const serviceOwner = ownerId + "-service";
  const serviceEnvironment = await DockerExecutionEnvironment.connect({ client: processes.client,
    target: environment.binding, ownerId: serviceOwner, authorityRevision: 0 });
  const serviceManager = new EnvironmentProcessManager({ executionEnvironment: serviceEnvironment, cwd: root,
    baseEnv: { PATH: "/usr/local/bin:/usr/bin:/bin", TASK_SERVICE: "α" } });
  const serviceScript = root + "/detached-service.py";
  const startsPath = root + "/detached-starts";
  const serviceSource = "import os,time,fcntl\nassert os.read(0,1)==b''\nassert os.environ['TASK_SERVICE']=='α'\n" +
    "for fd in (3,4,5,6):\n try: fcntl.fcntl(fd,fcntl.F_GETFD)\n except OSError: pass\n else: raise AssertionError(fd)\n" +
    "with open(" + JSON.stringify(startsPath) + ",'a') as f: f.write('started\\n');f.flush();os.fsync(f.fileno())\n" +
    "print('service-pid:'+str(os.getpid()),flush=True)\ncounter=0\nwhile True:\n counter+=1\n " +
    "print('heartbeat:'+str(counter),flush=True)\n os.write(2,b'stderr\\n')\n time.sleep(.05)\n";
  await python("import sys\nopen(sys.argv[1],'w').write(sys.argv[2])", [serviceScript, serviceSource]);
  try {
    const service = await admitted("detached-service", () => serviceManager.startDetachedProcess({ ownerId: serviceOwner,
      cmd: "exec /usr/local/bin/python3 " + serviceScript, yield_time_ms: 250 }));
    assert.equal(service.detached, true);
    assert.equal(service.exitCode, null, JSON.stringify(service));
    assert.equal(service.session_id, undefined);
    assert.ok(service.pid && service.pid > 1, JSON.stringify(service));
    assert.match(service.stdout, new RegExp("service-pid:" + service.pid));
    assert.match(service.stdout, /heartbeat:/);
    assert.match(service.stdout, /stderr/);
    assert.deepEqual(serviceManager.listProcesses(serviceOwner), []);
    const original = await serviceEnvironment.reconnect({ runId, callId: "detached-service", attempt: 1 });
    assert.ok(original);
    const forkScript = root + "/detached-fork-service.py";
    const forkStarts = root + "/detached-fork-starts";
    const forkSource = "import os,time\nr,w=os.pipe()\nif os.fork()!=0:\n os.close(w)\n assert os.read(r,1)==b'1'\n os._exit(0)\n" +
      "os.close(r)\nos.setsid()\nif os.fork()!=0: os._exit(0)\nos.write(w,b'1')\nos.close(w)\n" +
      "with open(" + JSON.stringify(forkStarts) + ",'a') as f: f.write('started\\n');f.flush();os.fsync(f.fileno())\n" +
      "print('fork-child-pid:'+str(os.getpid()),flush=True)\nwhile True:\n print('fork-heartbeat',flush=True)\n time.sleep(.05)\n";
    await python("import sys\nopen(sys.argv[1],'w').write(sys.argv[2])", [forkScript, forkSource]);
    const forked = await admitted("detached-fork", () => serviceManager.startDetachedProcess({ ownerId: serviceOwner,
      cmd: "exec /usr/local/bin/python3 " + forkScript, yield_time_ms: 10000 }));
    assert.equal(forked.exitCode, 0, JSON.stringify(forked));
    assert.equal(forked.pid, undefined);
    const forkProcess = await serviceEnvironment.reconnect({ runId, callId: "detached-fork", attempt: 1 });
    assert.ok(forkProcess);
    let childPid: number | undefined;
    const forkDeadline = Date.now() + 5000;
    while (childPid === undefined) {
      const output = (await forkProcess.output(0, 65536)).stdout.toString();
      const matched = /fork-child-pid:(\d+)/.exec(output);
      if (matched) childPid = Number(matched[1]);
      else { assert.ok(Date.now() < forkDeadline, output); await delay(20); }
    }
    await serviceManager.closeAll();
    const afterClose = await original.inspect();
    assert.equal(afterClose.cleanupProven, false);
    assert.equal(afterClose.detachedService?.pid, service.pid);
    assert.equal((await forkProcess.inspect()).cleanupProven, false);
    await assert.rejects(original.write({ runId, callId: "no-detached-input", attempt: 1 }, Buffer.from("x")), { code: "invalid_authority" });
    // This is fixture evidence on the controller host, never a task-selected path.
    await writeFile("/controller/detached-restart.json", JSON.stringify({ owner: serviceOwner,
      operationId: original.operationId, sessionId: original.sessionId, binding: serviceEnvironment.binding,
      runId, callId: "detached-service", attempt: 1, pid: service.pid, logPath: service.log_path, startsPath,
      fork: { operationId: forkProcess.operationId, sessionId: forkProcess.sessionId, pid: childPid,
        logPath: forked.log_path, startsPath: forkStarts } }));
    console.log("Actual environment manager detached launch: task PID/log, closed stdin, no private descriptors, owner shutdown and no model handle passed");
  } finally { await serviceManager.closeAll(); }

  // The actual TypeScript process and filesystem adapters remain alive when
  // filename matching kills the task process carrying that filename in argv.
  const cleanup = "import os,signal\nfor entry in os.listdir('/proc'):\n if entry.isdigit():\n  try:\n" +
    "   if b'agenc-typescript-self-cleanup-2477.py' in open('/proc/'+entry+'/cmdline','rb').read(): os.kill(int(entry),signal.SIGKILL)\n" +
    "  except OSError: pass\n";
  await python(cleanup, ["agenc-typescript-self-cleanup-2477.py"], 137);
  assert.deepEqual(await filesystem.readFile(root + "/dir/file", 32), Buffer.from("replacement"));
  assert.deepEqual(await python("print('typescript-subsequent-call',end='')"), Buffer.from("typescript-subsequent-call"));
  assert.ok(effectBoundaries >= 10);
  console.log("TypeScript process/filesystem adapters: bound reads, original guards, write/rollback receipts, parent swaps and task self-kill passed");
} finally {
  await processes.close();
}
