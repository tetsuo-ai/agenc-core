import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSandbox } from "../../../src/sandbox/linux-launcher/session-sandbox.js";
import { terminateProcessTreeAndReport } from "../../../src/utils/supervisedProcess.js";
const runtime = fileURLToPath(new URL("../../../", import.meta.url));
let root: string, sandbox: SessionSandbox;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-sandbox-test-"));
  for (const p of ["work", "temp", "work/.git", "work/.agents", "work/.agenc"]) fs.mkdirSync(path.join(root, p));
  sandbox = new SessionSandbox();
});
afterEach(async () => { await sandbox.close(); fs.rmSync(root, { recursive: true, force: true }); });
function input(command: string, env: Record<string, string> = {}) {
  const cwd = path.join(root, "work");
  const profile = { fileSystem: { kind: "restricted", entries: [
    { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    { path: { kind: "path", path: cwd }, access: "write" },
  ], includePlatformDefaults: true }, network: "disabled" };
  return { program: process.execPath, cwd, env: { PATH: "/usr/bin:/bin", ...env },
    args: [path.join(runtime, "bin/agenc-linux-sandbox"), "--sandbox-policy-cwd", cwd,
      "--command-cwd", cwd, "--permission-profile", JSON.stringify(profile),
      "--session-temp-root", path.join(root, "temp"), "--", "/bin/bash", "-c", command] };
}
async function run(command: string) {
  const child = await sandbox.spawn(input(command), () => {});
  expect(child, "persistent sandbox must be admitted on the Linux gate").toBeDefined();
  let out = "", err = "";
  child!.stdout.on("data", data => { out += data; }); child!.stderr.on("data", data => { err += data; });
  child!.stdin.end();
  await new Promise<void>(resolve => child!.once("close", () => resolve()));
  return { out, err, pid: child!.pid, code: child!.exitCode,
    outcome: await terminateProcessTreeAndReport(child!) };
}
describe.runIf(process.platform === "linux")("session sandbox", () => {
  it("reuses the namespace while resetting command cwd and environment", async () => {
    const a = await run("export POISON=bad; cd /; printf first");
    const b = await run('printf "%s:%s" "$PWD" "${POISON-clean}"');
    expect(a.out).toBe("first"); expect(b.out).toBe(path.join(root, "work") + ":clean");
    expect(b.pid).toBe(a.pid); expect(b.code).toBe(0);
  });
  it("keeps stdout, stderr and exit status distinct", async () => {
    const result = await run("echo out; echo err >&2; exit 7");
    expect(result.out).toBe("out\n"); expect(result.err).toBe("err\n"); expect(result.code).toBe(7);
  });
  it("rejects writes outside writable roots", async () => {
    const result = await run(`echo denied > '${root}/outside'`);
    expect(result.code).not.toBe(0); expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
    expect((await run("echo allowed > allowed; cat allowed")).out).toBe("allowed\n");
  });
  it("kills detached residual descendants before the next command", async () => {
    const result = await run("setsid sh -c 'sleep 1; echo leaked > leaked' >/dev/null 2>&1 & echo done");
    expect(result.out).toBe("done\n"); expect(result.outcome.residualProcessesTerminated).toBe(true);
    expect((await run("sleep 1.1; test ! -e leaked")).code).toBe(0);
  });
  it("cancels a running tree and remains reusable", async () => {
    const child = await sandbox.spawn(input("sleep 30 & wait"), () => {});
    expect(child).toBeDefined();
    await terminateProcessTreeAndReport(child!);
    expect(child!.exitCode).toBe(137);
    expect((await run("echo after")).out).toBe("after\n");
  });
  it("keeps networking disabled and hides keeper descriptors", async () => {
    const network = await run("python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)'");
    expect(network.code).not.toBe(0);
    const privateFd = await run("cat /proc/1/fd/0");
    expect(privateFd.code).not.toBe(0);
  });
  it("prevents a command from lowering the executor resource limits", async () => {
    const result = await run("python3 -c 'import resource; resource.prlimit(1, resource.RLIMIT_NOFILE, (3,3))'");
    expect(result.code).not.toBe(0);
    expect((await run("echo intact")).out).toBe("intact\n");
  });
  it("rebuilds after replacement of a mounted root", async () => {
    const first = await run("echo old > marker");
    fs.renameSync(path.join(root, "work"), path.join(root, "old"));
    fs.mkdirSync(path.join(root, "work"));
    for (const name of [".git", ".agents", ".agenc"]) fs.mkdirSync(path.join(root, "work", name));
    const second = await run("test ! -f marker; echo new");
    expect(second.pid).not.toBe(first.pid); expect(second.out).toBe("new\n");
  });
  it("falls back while busy and closes the active namespace", async () => {
    const child = await sandbox.spawn(input("sleep 30"), () => {});
    expect(child).toBeDefined();
    expect(await sandbox.spawn(input("echo concurrent"), () => {})).toBeUndefined();
    await sandbox.close();
    expect((await terminateProcessTreeAndReport(child!)).commandOutcome?.kind).toBe("unavailable");
    expect((await run("echo fresh")).out).toBe("fresh\n");
  });
});
