import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createLinuxSandboxCommandArgsForPermissionProfile } from "../../../src/sandbox/engine/landlock.js";
import { execSandboxDenialNotice } from "../../../src/tools/system/exec-sandbox-denial.js";

const runtime = fileURLToPath(new URL("../../../", import.meta.url));

test("Python http.server gets an actionable default denial and works with local binding", { timeout: 15_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-python-binding-"));
  fs.writeFileSync(path.join(root, "index.html"), "python-local-ok");
  const profile = { fileSystem: { kind: "restricted" as const, includePlatformDefaults: true, entries: [
    { path: { kind: "special" as const, value: { kind: "root" as const } }, access: "read" as const },
    { path: { kind: "path" as const, path: root }, access: "write" as const },
  ] }, network: "disabled" as const };
  const run = (command: string[], allow = false) => spawnSync(process.execPath, [
    path.join(runtime, "bin/agenc-linux-sandbox"),
    ...createLinuxSandboxCommandArgsForPermissionProfile(command, root, profile, root, false, root, false, undefined, allow),
  ], { cwd: root, encoding: "utf8", timeout: 6000, env: { PATH: process.env.PATH, HOME: root, AGENC_HOME: root } });
  try {
    const denied = run(["/usr/bin/python3", "-m", "http.server", "8123", "--bind", "127.0.0.1"]);
    expect(denied.status, denied.stderr).toBe(1);
    expect(execSandboxDenialNotice({
      output: denied.stderr, exitCode: denied.status, sandboxApplied: true, escalationAvailable: false,
    })?.notice).toContain("sandbox.network.allowLocalBinding = true");
    const allowed = run(["/bin/bash", "-c", `
      python3 -m http.server 8123 --bind 127.0.0.1 >server.log 2>&1 & pid=$!
      trap 'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null' EXIT
      for i in {1..40}; do
        curl --noproxy '*' -fs --max-time 1 http://127.0.0.1:8123/ && exit 0
        kill -0 "$pid" 2>/dev/null || { cat server.log >&2; exit 1; }
        sleep 0.05
      done
      exit 1
    `], true);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe("python-local-ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(["127.0.0.1", "::1"])("local binding on %s stays inside the sandbox network namespace", { timeout: 20_000 }, async (host) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-local-binding-"));
  const unixPath = path.join(root, "host.sock");
  const hostServer = net.createServer((socket) => socket.end("host"));
  const unixServer = net.createServer((socket) => socket.end("host Unix"));
  await new Promise<void>((resolve) => hostServer.listen(0, host, resolve));
  await new Promise<void>((resolve) => unixServer.listen(unixPath, resolve));
  const hostPort = (hostServer.address() as net.AddressInfo).port;
  const script = `
    const net = require('node:net'), http = require('node:http'), cp = require('node:child_process');
    const host = ${JSON.stringify(host)};
    const server = http.createServer((req, res) => res.end('sandbox-local-ok'));
    server.on('error', err => { console.error(err); process.exit(1); });
    const refused = options => new Promise((resolve, reject) => {
      const socket = net.connect(options);
      socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('connection timed out')); });
      socket.on('connect', () => { socket.destroy(); reject(new Error('escaped namespace')); });
      socket.on('error', err => resolve(err.code));
    });
    server.listen(0, host, async () => {
      try {
        const port = server.address().port;
        const url = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
        const body = await require('node:util').promisify(cp.execFile)('curl', ['--noproxy', '*', '--fail', '--max-time', '3', '-s', url], {encoding:'utf8'}).then(result => result.stdout);
        if (body !== 'sandbox-local-ok') throw new Error(body);
        if (cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("child-stdio-ok")'], {encoding:'utf8'}) !== 'child-stdio-ok') throw new Error('stdio failed');
        console.log(JSON.stringify({ port, body, hostBlocked: await refused({host, port:${hostPort}}), unixBlocked: await refused(${JSON.stringify(unixPath)}) }));
        process.stdin.once('data', () => { server.close(); process.stdin.destroy(); });
      } catch (err) { console.error(err); process.exit(1); }
    });`;
  const profile = { fileSystem: { kind: "restricted" as const, includePlatformDefaults: true, entries: [
    { path: { kind: "special" as const, value: { kind: "root" as const } }, access: "read" as const },
    { path: { kind: "path" as const, path: root }, access: "write" as const },
  ] }, network: "disabled" as const };
  const args = createLinuxSandboxCommandArgsForPermissionProfile(
    [process.execPath, "-e", script], root, profile, root, false, root, false, undefined, true,
  );
  const child = spawn(process.execPath, [path.join(runtime, "bin/agenc-linux-sandbox"), ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, AGENC_HOME: root }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const report = await new Promise<{ port: number; body: string; hostBlocked: string; unixBlocked: string }>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) { try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } }
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`launcher exited before report: ${stdout} ${stderr}`)));
    });
    expect(report.body).toBe("sandbox-local-ok");
    expect(report.hostBlocked).toBe("ECONNREFUSED");
    expect(report.unixBlocked).toBe("EPERM");
    await expect(new Promise((resolve, reject) => {
      const outside = net.connect({ host, port: report.port });
      outside.on("connect", () => { outside.destroy(); resolve("outside reached listener"); });
      outside.on("error", reject);
    })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${report.port}`;
    const separateArgs = createLinuxSandboxCommandArgsForPermissionProfile(
      ["curl", "--noproxy", "*", "--silent", "--max-time", "2", url], root, profile, root, false, root, false, undefined, true,
    );
    const separate = spawnSync(process.execPath, [path.join(runtime, "bin/agenc-linux-sandbox"), ...separateArgs], {
      cwd: root, encoding: "utf8", timeout: 5000,
    });
    expect(separate.status, separate.stderr).toBe(7);
    child.stdin.end("done\n");
    expect(await exited, stderr).toBe(0);
    // Check the socketpair reconnect escape at the syscall layer too.
    const pairProbe = "import socket\ntry:\n socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);raise RuntimeError('datagram pair allowed')\nexcept PermissionError: print('datagram-pair-blocked')";
    const probeArgs = createLinuxSandboxCommandArgsForPermissionProfile(
      ["/usr/bin/python3", "-c", pairProbe], root, profile, root, false, root, false, undefined, true,
    );
    expect(execFileSync(process.execPath, [path.join(runtime, "bin/agenc-linux-sandbox"), ...probeArgs], { cwd: root, encoding: "utf8", timeout: 5000 })).toContain("datagram-pair-blocked");
  } finally {
    child.kill("SIGKILL");
    hostServer.close(); unixServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
