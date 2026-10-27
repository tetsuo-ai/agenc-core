import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { inspectLinuxBroker } from "./linux-broker-elf.mjs";

// Offline native test. Mount production dist read-only and overlay only the
// rebuilt broker, with the same UID and executable mode as the original.
export async function checkBullseyeBroker(dist, originalBroker) {
  assert.equal(execFileSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" }).trim(), "glibc 2.31");
  const original = spawnSync(originalBroker, ["--describe-protocol-v3"], { encoding: "utf8" });
  assert.notEqual(original.status, 0, "Expected the modern-libc control artifact to fail on bullseye");
  assert.match(original.stderr, /GLIBC_/);
  const broker = join(dist, "agenc-process-broker");
  assert.equal(statSync(broker).uid, process.getuid());
  assert.equal(statSync(broker).mode & 0o777, 0o755);
  const elf = inspectLinuxBroker(broker, "2.31");
  assert.match(execFileSync(broker, ["--describe-protocol-v3"], { encoding: "utf8" }), /AGB3 owner-pid sealed-static-init-ro-artifact-v1/);
  const chunk = readdirSync(dist).filter(name => name.startsWith("chunk-") && name.endsWith(".js"))
    .find(name => /export\s*\{[^}]*\brunSupervisedProcess\b[^}]*\}/.test(readFileSync(join(dist, name), "utf8")));
  assert.ok(chunk, "Production supervisor chunk is missing");
  const supervisor = await import(pathToFileURL(join(dist, chunk)).href);
  assert.equal(typeof supervisor.init_supervisedProcess, "function");
  supervisor.init_supervisedProcess();
  const invoke = (program, args) => supervisor.runSupervisedProcess({ program, args, cwd: "/tmp", env: {} },
    { maxOutputBytes: 4096, linuxContainment: "subreaper" });
  const echo = await invoke("/bin/echo", ["bullseye broker works"]);
  assert.equal(echo.error, undefined);
  assert.equal(echo.exitCode, 0);
  assert.equal(echo.stdout.toString(), "bullseye broker works\n");
  const script = "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()";
  const orphan = await invoke(process.execPath, ["-e", script]);
  assert.equal(orphan.error, undefined);
  const pid = Number(orphan.stdout.toString().trim());
  assert.ok(pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(orphan.processTreeCleanupProven, true);
  return { passed: true, runtimeGlibc: "2.31", ...elf, uid: process.getuid(), brokerUid: statSync(broker).uid,
    originalRejected: true, protocolV3: true, echoExit: echo.exitCode, orphanCleanupProven: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkBullseyeBroker(resolve(process.argv[2]), resolve(process.argv[3]))));
}
