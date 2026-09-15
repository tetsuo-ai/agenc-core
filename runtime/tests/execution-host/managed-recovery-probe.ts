/** Disposable controller crash/restart fixture; not a canonical AgenC session. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import { DockerExecutionEnvironment } from "../../src/execution/docker-environment.js";
import { ExecutionHostClient } from "../../src/execution/host-client.js";
import { EnvironmentProcessManager } from "../../src/unified-exec/environment-process-manager.js";
import { readExecutionProcessRecoveryState } from "../../src/unified-exec/process-recovery.js";

const path = "/controller/managed-recovery.json";
const socket = "/run/agenc-execution/controller.sock";

export async function managedRecoveryProbe(phase: "start" | "restore"): Promise<void> {
  if (phase === "start") {
    const owner = `managed-recovery-${randomUUID()}`;
    const root = "/app/" + owner;
    const environment = await DockerExecutionEnvironment.connect({ client: new ExecutionHostClient(socket),
      target: { container: "agenc-task" }, ownerId: owner, authorityRevision: 0 });
    const manager = new EnvironmentProcessManager({ executionEnvironment: environment, cwd: "/app" });
    const source = `import os,time\nr=${JSON.stringify(root)}\nos.mkdir(r)\n` +
      "with open(r+'/starts','x') as f: f.write('1')\n" +
      "os.write(1,b'delivered:'+bytes([0xe2]))\nos.write(2,b'error:'+bytes([0xf0,0x90]))\n" +
      "while not os.path.exists(r+'/release'): time.sleep(0.02)\n" +
      "os.write(1,bytes([0x82,0xac])+b'-retained')\nos.write(2,bytes([0x80,0x80]))\n" +
      "while True: time.sleep(1)\n";
    const command = "exec /usr/local/bin/python3 -c '" + source.replaceAll("'", "'\\''") + "'";
    const initial = await withAdmittedExecutionCall({ runId: owner, callId: "original", attempt: 1 },
      { signal: new AbortController().signal, crossEffectBoundary: () => {} },
      () => manager.execCommand({ ownerId: owner, cmd: command, yield_time_ms: 1000 }));
    assert.equal(initial.stdout, "delivered:"); assert.equal(initial.stderr, "error:");
    const state = manager.captureExecutionProcesses();
    assert.equal(state.entries[0].delivered.stdoutCarry, "4g==");
    assert.equal(state.entries[0].delivered.stderrCarry, "8JA=");
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ root, state })); await file.sync(); }
    finally { await file.close(); }
    // Exact fixture PID only. No lifecycle cleanup runs; the real host must
    // retain its original operation and bytes for the next controller process.
    process.kill(process.pid, "SIGKILL");
    throw new Error("Fixture SIGKILL unexpectedly returned");
  }

  const saved = JSON.parse(await readFile(path, "utf8"));
  const state = readExecutionProcessRecoveryState(saved.state);
  const environment = await DockerExecutionEnvironment.connect({ client: new ExecutionHostClient(socket),
    target: state.binding, ownerId: state.ownerId, authorityRevision: state.authorityRevision });
  const manager = new EnvironmentProcessManager({ executionEnvironment: environment, cwd: "/" });
  try {
    await manager.restoreExecutionProcesses(state);
    const id = state.entries[0].sessionId;
    assert.deepEqual(manager.listProcesses("foreign"), []);
    assert.equal(manager.listProcesses(state.ownerId)[0].session_id, id);
    assert.equal((await environment.filesystem.readFile(saved.root + "/starts", 8)).toString(), "1");
    const guard = await environment.filesystem.captureFileGuard(saved.root + "/release");
    try {
      await withAdmittedExecutionCall({ runId: state.ownerId, callId: "release-output", attempt: 1 },
        { signal: new AbortController().signal, crossEffectBoundary: () => {} },
        () => guard.writeBoundContent({ kind: "missing" }, Buffer.from("release")));
    } finally { await guard.dispose(); }
    const deadline = Date.now() + 10000;
    while (!manager.listBackgroundProcesses()[0].outputTail.includes("€-retained")) {
      assert.ok(Date.now() < deadline, "Restored manager did not observe original retained output");
      await delay(20);
    }
    assert.equal(manager.listProcesses(state.ownerId)[0].session_id, id);
    assert.deepEqual(await manager.terminateProcess({ ownerId: state.ownerId, processId: id }), { terminated: true });
    const result = await manager.writeStdin({ ownerId: state.ownerId, session_id: id });
    assert.equal(result.stdout, "€-retained"); assert.equal(result.stderr, "𐀀");
    assert.equal(result.exitCode, 137);
    assert.deepEqual(manager.captureExecutionProcesses().entries, []);
    assert.deepEqual(await manager.terminateProcess({ ownerId: state.ownerId, processId: id }), { terminated: false });
    assert.equal((await environment.filesystem.readFile(saved.root + "/starts", 8)).toString(), "1");
    console.log("Managed process recovery after controller SIGKILL: original handle, separate UTF-8 carries, retained output, strict cleanup and one task start passed");
  } finally { await manager.closeAll(); }
}
