import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
async function run(command: string) { return runInput(input(command)); }
async function runInput(invocation: ReturnType<typeof input>, signal?: AbortSignal) {
  const child = await sandbox.spawn(invocation, () => {}, signal);
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
    expect(child!.exitCode).toBe(143);
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
    expect((await run("python3 -c 'import resource; resource.prlimit(1, resource.RLIMIT_NOFILE)' ")).code).toBe(0);
    expect((await run("python3 -c 'import resource,subprocess; p=subprocess.Popen([\"sleep\",\"30\"]); resource.prlimit(p.pid, resource.RLIMIT_NOFILE, (32,32)); p.terminate(); p.wait()'")).code).toBe(0);
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
    expect((await terminateProcessTreeAndReport(child!)).commandOutcome?.kind).toBe("reported");
    expect((await run("echo fresh")).out).toBe("fresh\n");
  });
  it("rebuilds for network changes and still denies network when changed back", async () => {
    const command = "python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)'";
    const disabled = await run(command);
    const enabledInput = input(command);
    const index = enabledInput.args.indexOf("--permission-profile") + 1;
    const policy = JSON.parse(enabledInput.args[index]!); policy.network = "enabled";
    enabledInput.args[index] = JSON.stringify(policy);
    const enabled = await runInput(enabledInput);
    expect(enabled.code).toBe(0); expect(enabled.pid).not.toBe(disabled.pid);
    const denied = await run(command);
    expect(denied.code).not.toBe(0); expect(denied.pid).not.toBe(enabled.pid);
  });
  it("rebuilds when writable roots or permission mode change", async () => {
    const first = await run("echo original > allowed");
    const readonly = input("echo forbidden > forbidden");
    const index = readonly.args.indexOf("--permission-profile") + 1;
    const policy = JSON.parse(readonly.args[index]!);
    policy.fileSystem.entries[1].access = "read";
    readonly.args[index] = JSON.stringify(policy);
    const second = await runInput(readonly);
    expect(second.pid).not.toBe(first.pid); expect(second.code).not.toBe(0);
    expect(fs.existsSync(path.join(root, "work/forbidden"))).toBe(false);
    expect((await run("echo restored > restored")).code).toBe(0);
  });
  it("rebuilds for a cwd outside the original workspace without granting writes there", async () => {
    const first = await run("true");
    const elsewhere = path.join(root, "elsewhere"); fs.mkdirSync(elsewhere);
    const invocation = input("pwd; echo denied > forbidden"); invocation.cwd = elsewhere;
    invocation.args[invocation.args.indexOf("--command-cwd") + 1] = elsewhere;
    const result = await runInput(invocation);
    expect(result.pid).not.toBe(first.pid); expect(result.out.trim()).toBe(elsewhere);
    expect(result.code).not.toBe(0); expect(fs.existsSync(path.join(elsewhere, "forbidden"))).toBe(false);
  });
  it("revalidates lexical policy aliases when their targets change", async () => {
    const link = path.join(root, "link"), one = path.join(root, "one"), two = path.join(root, "two");
    for (const dir of [one, two]) {
      fs.mkdirSync(dir);
      for (const name of [".git", ".agents", ".agenc"]) fs.mkdirSync(path.join(dir, name));
    }
    fs.symlinkSync(one, link);
    const make = (command: string) => {
      const invocation = input(command), index = invocation.args.indexOf("--permission-profile") + 1;
      const policy = JSON.parse(invocation.args[index]!);
      policy.fileSystem.entries.push({ path: { kind: "path", path: link }, access: "write" });
      invocation.args[index] = JSON.stringify(policy); return invocation;
    };
    const first = await runInput(make(`echo one > '${one}/first'`)); expect(first.code).toBe(0);
    fs.unlinkSync(link); fs.symlinkSync(two, link);
    const second = await runInput(make(`echo two > '${two}/second'; echo forbidden > '${one}/forbidden'`));
    expect(second.pid).not.toBe(first.pid); expect(second.code).not.toBe(0);
    expect(fs.readFileSync(path.join(two, "second"), "utf8")).toBe("two\n");
    expect(fs.existsSync(path.join(one, "forbidden"))).toBe(false);
  });
  it("does not leak a previous command environment or umask", async () => {
    const original = await run("umask");
    const changed = await runInput(input("export NEW=poison; umask 077; echo $ONLY_THIS", { ONLY_THIS: "value" }));
    expect(changed.out).toBe("value\n");
    const clean = await run("printf '%s:%s\n' \"${NEW-clean}\" \"${ONLY_THIS-clean}\"; umask");
    expect(clean.out).toBe("clean:clean\n" + original.out);
  });
  it("closes an idle namespace on Stop and creates a fresh one for a later turn", async () => {
    const controller = new AbortController();
    const first = await runInput(input("true"), controller.signal);
    controller.abort();
    await vi.waitFor(() => expect(() => process.kill(first.pid!, 0)).toThrow());
    const next = await run("echo next"); expect(next.pid).not.toBe(first.pid); expect(next.out).toBe("next\n");
  });
  it("waits for a SIGTERM handler before closing the namespace", async () => {
    const child = await sandbox.spawn(input("trap 'echo handled; exit 42' TERM; echo ready; while :; do sleep 1; done"), () => {});
    expect(child).toBeDefined();
    let output = ""; child!.stdout.on("data", data => { output += data; });
    await vi.waitFor(() => expect(output).toContain("ready"));
    await sandbox.close();
    expect(output).toContain("handled"); expect(child!.exitCode).toBe(42);
    expect(() => process.kill(child!.pid!, 0)).toThrow();
  });
  it("recreates after executor failure without replaying an effect", async () => {
    const child = await sandbox.spawn(input("echo effect >> effects; echo ready; sleep 30"), () => {});
    expect(child).toBeDefined();
    let ready = false; child!.stdout.on("data", () => { ready = true; });
    await vi.waitFor(() => expect(ready).toBe(true));
    const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
    const descendants = (pid: number): number[] => {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
      return children.flatMap(child => [child, ...descendants(child)]);
    };
    const keeper = descendants(child!.pid!).find(pid => {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      return /^NSpid:.*\s1$/m.test(status);
    });
    expect(keeper).toBeDefined();
    process.kill(keeper!, "SIGKILL"); await closed;
    expect((await terminateProcessTreeAndReport(child!)).commandOutcome?.kind).toBe("unavailable");
    const result = await run("cat effects");
    expect(result.out).toBe("effect\n"); expect(result.pid).not.toBe(child!.pid);
  });
  it("keeps metadata fences and has no per-command descriptor growth", async () => {
    const descriptors = fs.readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 16; i++) expect((await run("true")).code).toBe(0);
    expect((await run("echo denied > .git/forbidden")).code).not.toBe(0);
    expect((await run("echo denied > .agents/forbidden")).code).not.toBe(0);
    await sandbox.close();
    expect(fs.readdirSync("/proc/self/fd").length).toBeLessThanOrEqual(descriptors);
  });
  it("kills the namespace and its detached children when the daemon exits abruptly", async () => {
    const invocation = input("setsid sh -c 'sleep 1; echo leaked > daemon-leak' >/dev/null 2>&1 & echo ready; sleep 30");
    const module = path.join(runtime, "src/sandbox/linux-launcher/session-sandbox.ts");
    const script = `import {SessionSandbox} from ${JSON.stringify(module)};
      const pool = new SessionSandbox();
      const child = await pool.spawn(${JSON.stringify(invocation)}, () => {});
      if (!child) process.exit(2);
      child.stdout.once('data', () => console.log(child.pid));
      setInterval(() => {}, 1000);`;
    const daemon = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: runtime, env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errors = "";
    daemon.stdout.on("data", data => { output += data; }); daemon.stderr.on("data", data => { errors += data; });
    try {
      await vi.waitFor(() => expect(output.trim(), errors).toMatch(/^\d+$/), { timeout: 5000 });
      const pid = Number(output.trim());
      daemon.kill("SIGKILL");
      await vi.waitFor(() => {
        try { expect(fs.readFileSync(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      });
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(fs.existsSync(path.join(root, "work/daemon-leak"))).toBe(false);
    } finally { daemon.kill("SIGKILL"); }
  });

  it("does not interpret command stdout as a control message", async () => {
    const result = await run("printf 'D\\000\\000\\000\\005\\000\\000\\000\\000\\000'; exit 9");
    expect(result.code).toBe(9); expect(result.out.length).toBe(10);
    expect((await run("echo after")).out).toBe("after\n");
  });

});
