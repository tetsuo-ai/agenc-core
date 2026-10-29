import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { describeStableNode, installStableNode, stableNodePath } from "../lib/stable-node.mjs";
import { beginRuntimeUpdate, endRuntimeUpdate, recordRuntimeActivation, pruneRuntimes, runtimeProcessInventory } from "../lib/runtime-maintenance.mjs";

const mac = process.platform === "darwin";
const runnableNode = Buffer.from(`#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-stable-test-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "runtime"), { mode: 0o700 });
  return home;
}
function runtime(home, version, bytes = Buffer.from(`node-${version}`)) {
  const key = `darwin-arm64-native-node-abi-147-sha256-${sha(Buffer.from(version))}`;
  const tree = join(home, "runtime", version, key);
  const source = join(tree, "node_modules/.agenc-node/bin/node");
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
  writeFileSync(source, bytes, { mode: 0o755 });
  writeFileSync(join(dirname(dirname(source)), "identity.json"), JSON.stringify({
    schemaVersion: 1, executable: "bin/node", executableSha256: sha(bytes), executableBytes: bytes.length,
  }));
  writeFileSync(join(tree, ".agenc-runtime-ok"), key.slice(-64));
  return { tree, source };
}

test("stable path preserves bytes, replaces inode and rolls back", { skip: !mac }, (t) => {
  const home = fixture(t);
  const a = runtime(home, "1.0.0"), b = runtime(home, "2.0.0");
  const path = installStableNode(home, describeStableNode(home, a.source));
  const inode = statSync(path).ino;
  assert.equal(path, stableNodePath(home));
  installStableNode(home, describeStableNode(home, b.source));
  assert.notEqual(statSync(path).ino, inode);
  assert.deepEqual(readFileSync(path), readFileSync(b.source));
  installStableNode(home, describeStableNode(home, a.source));
  assert.deepEqual(readFileSync(path), readFileSync(a.source));
});

for (const step of ["node-staged", "node-replaced"]) {
  test(`crash boundary ${step} leaves a complete executable and retries`, { skip: !mac }, (t) => {
    const home = fixture(t);
    const a = runtime(home, "1.0.0"), b = runtime(home, "2.0.0");
    installStableNode(home, describeStableNode(home, a.source));
    assert.throws(() => installStableNode(home, describeStableNode(home, b.source), (at) => {
      if (at === step) throw new Error("crash");
    }), /crash/);
    assert.deepEqual(readFileSync(stableNodePath(home)), readFileSync(step === "node-staged" ? a.source : b.source));
    installStableNode(home, describeStableNode(home, b.source));
    assert.deepEqual(readFileSync(stableNodePath(home)), readFileSync(b.source));
  });
}

test("rejects tampered source, symlink destination and forged journal hash", { skip: !mac }, (t) => {
  const home = fixture(t), a = runtime(home, "1.0.0");
  const description = describeStableNode(home, a.source);
  assert.throws(() => installStableNode(home, { ...description, sha256: "0".repeat(64) }), /journal hash/);
  mkdirSync(join(home, "bin"));
  symlinkSync(a.source, stableNodePath(home));
  assert.throws(() => installStableNode(home, description), /regular/);
  rmSync(stableNodePath(home));
  writeFileSync(a.source, "tampered");
  assert.throws(() => installStableNode(home, description), /identity/);
});

test("pruning keeps current, previous, running and unrecognized trees and reports bytes", async (t) => {
  const home = fixture(t);
  const old = runtime(home, "0.19.6"), busy = runtime(home, "0.19.7");
  runtime(home, "0.19.14"); runtime(home, "0.19.15");
  recordRuntimeActivation(home, "0.19.15", "0.19.14");
  const outside = join(home, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(home, "runtime/0.19.8"));
  const expectedBytes = [old.source, join(dirname(dirname(old.source)), "identity.json"),
    join(old.tree, ".agenc-runtime-ok")].reduce((sum, path) => sum + statSync(path).size, 0);
  const result = await pruneRuntimes(home, { inventory: () => busy.source });
  assert.deepEqual(result.removed, [old.tree]);
  assert.equal(result.freedBytes, expectedBytes);
  assert.ok(existsSync(busy.source)); assert.ok(existsSync(outside));
  recordRuntimeActivation(home, "0.19.14", "0.19.15");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "runtime/.activation-history.json"))), { current: "0.19.14", previous: "0.19.15" });
});

test("live update lease, interrupted activation, inventory failure and extraction residue defer pruning", async (t) => {
  const home = fixture(t), old = runtime(home, "0.19.6");
  recordRuntimeActivation(home, "0.19.15", "0.19.14");
  const lease = await beginRuntimeUpdate(home);
  assert.match((await pruneRuntimes(home, { inventory: () => "" })).skipped, /progress/);
  endRuntimeUpdate(lease);
  const journal = join(home, "runtime/.activation-transaction.json");
  writeFileSync(journal, "{}");
  assert.match((await pruneRuntimes(home)).skipped, /recovery/);
  rmSync(journal);
  assert.match((await pruneRuntimes(home, { inventory: () => { throw new Error("unavailable"); } })).skipped, /unavailable/);
  mkdirSync(join(dirname(old.tree), ".interrupted.install-1"));
  assert.equal((await pruneRuntimes(home, { inventory: () => "" })).removed.length, 0);
  assert.ok(existsSync(old.source));
});

test("a killed updater lease is reclaimed without deleting the two retained versions", async (t) => {
  const home = fixture(t), old = runtime(home, "0.19.6");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const lease = await beginRuntimeUpdate(home, child.pid);
  child.kill("SIGKILL");
  await new Promise((done) => child.once("exit", done));
  recordRuntimeActivation(home, "0.19.15", "0.19.14");
  const result = await pruneRuntimes(home, { inventory: () => "" });
  assert.deepEqual(result.removed, [old.tree]);
  assert.equal(existsSync(lease), false);
});

test("a real old daemon remains usable after stable replacement and is retained by process inventory", { skip: !mac }, async (t) => {
  const home = fixture(t), old = runtime(home, "0.19.6", runnableNode);
  const helperPath = join(home, "inventory");
  execFileSync(process.env.CC || "cc", ["-Wall", "-Wextra", "-Werror", "-o", helperPath,
    new URL("../../../runtime/native/agenc-runtime-inventory.c", import.meta.url).pathname, "-lproc"]);
  const inventory = (root) => runtimeProcessInventory(root, { helperPath });
  const entry = join(old.tree, "daemon.cjs");
  writeFileSync(entry, "process.stdout.write('ready\\n'); setInterval(()=>{},1000);");
  const child = spawn(old.source, [entry], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise((done, reject) => { child.stdout.once("data", done); child.once("error", reject); });
  installStableNode(home, describeStableNode(home, old.source));
  const next = runtime(home, "0.19.15", runnableNode);
  installStableNode(home, describeStableNode(home, next.source));
  recordRuntimeActivation(home, "0.19.15", "0.19.14");
  const result = await pruneRuntimes(home, { inventory });
  assert.equal(result.skipped, undefined);
  assert.equal(existsSync(old.source), true);
  assert.equal(child.exitCode, null);
  child.kill(); await new Promise((done) => child.once("exit", done));
  const after = await pruneRuntimes(home, { inventory });
  assert.ok(after.removed.includes(old.tree), JSON.stringify(after));
});

for (const step of ["prune-recorded", "prune-quarantined", "prune-removed"]) {
  test(`interrupted pruning at ${step} resumes safely`, async (t) => {
    const home = fixture(t), old = runtime(home, "0.19.6");
    recordRuntimeActivation(home, "0.19.15", "0.19.14");
    const result = await pruneRuntimes(home, { inventory: () => "", checkpoint: (at) => {
      if (at === step) throw new Error("crash");
    } });
    assert.equal(result.skipped, "crash");
    assert.equal(existsSync(join(home, "runtime/.prune-transaction.json")), true);
    const recovered = await pruneRuntimes(home, { inventory: () => "" });
    assert.equal(recovered.skipped, undefined);
    assert.equal(existsSync(old.tree), false);
    assert.equal(existsSync(join(home, "runtime/.prune-transaction.json")), false);
  });
}

test("pruning notices an old updater without a lease and a process starting between inventories", async (t) => {
  const home = fixture(t), old = runtime(home, "0.19.6");
  recordRuntimeActivation(home, "0.19.15", "0.19.14");
  assert.match((await pruneRuntimes(home, { inventory: () => `123456 ${old.tree}/node_modules/@tetsuo-ai/runtime/bin/agenc update` })).skipped, /older updater/);
  let scans = 0;
  assert.match((await pruneRuntimes(home, { inventory: () => ++scans === 1 ? "" : old.source })).skipped, /busy/);
  assert.ok(existsSync(old.source));
});

test("a process racing quarantine gets its original runtime path restored", async (t) => {
  const home = fixture(t), old = runtime(home, "0.19.6");
  recordRuntimeActivation(home, "0.19.15", "0.19.14");
  let scans = 0;
  const result = await pruneRuntimes(home, { inventory: () => ++scans < 3 ? "" : old.source });
  assert.match(result.skipped, /busy during/);
  assert.ok(existsSync(old.source));
  assert.equal(existsSync(join(home, "runtime/.prune-transaction.json")), false);
});
