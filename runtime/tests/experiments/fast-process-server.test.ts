import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OneShotProcessServer } from "../../src/unified-exec/one-shot-process-server.js";
import { sessionProcessBoundaries } from "../../src/utils/session-process-boundary.js";
import * as supervised from "../../src/utils/supervisedProcess.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
const servers: OneShotProcessServer[] = [];
const managers: UnifiedExecProcessManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all([...servers.splice(0).map(s => s.close()), ...managers.splice(0).map(m => m.closeAll())]);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function server() { const s = new OneShotProcessServer(); servers.push(s); return s; }
function root() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fast-server-")); dirs.push(d); return d; }
async function start(s: OneShotProcessServer, cmd: string, cwd = "/tmp", env = { PATH: "/usr/bin:/bin" }) {
  const child = await s.spawn({ program: "/bin/bash", args: ["-c", cmd], argv0: "test-shell", cwd, env }, () => {});
  expect(child).toBeDefined();
  let out = "", err = "";
  child!.stdout.on("data", chunk => { out += chunk.toString(); });
  child!.stderr.on("data", chunk => { err += chunk.toString(); });
  const result = new Promise<{out:string;err:string;code:number|null}>(resolve => child!.on("close", () => resolve({out,err,code:child!.exitCode})));
  child!.stdin.end();
  return { child: child!, result };
}
describe.runIf(process.platform === "linux")("bypass reusable command boundary", () => {
  test("prepares an empty broker and admits the later command with fresh state", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess"), s = server(), dir = root();
    const validate = vi.fn();
    expect(await s.prepare(dir, validate)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![1]).toEqual(["--one-shot-server-v1"]);
    const child = launch.mock.results[0]!.value;
    const send = vi.spyOn(child.stdin, "write");
    await expect(s.spawn({ program: "/bin/sh", args: ["-c", "echo bad > effects"], cwd: dir, env: {} },
      () => { throw new Error("new denial"); })).rejects.toThrow("new denial");
    expect(send).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect((await (await start(s, "printf '%s' \"$FRESH\"", dir, { FRESH: "after-model" })).result).out).toBe("after-model");
    expect(launch).toHaveBeenCalledTimes(1);
  });
  test("preparation respects fast scope and closes idle brokers with the owner", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const manager = new UnifiedExecProcessManager({ cwd: root() }); managers.push(manager);
    const owner = manager.createOwnerLifetime("prepared"), binding = owner.bind();
    await manager.prepareOneShotCommandBoundary("prepared", binding);
    expect(launch).not.toHaveBeenCalled();
    await withOneShotFastMode(() => manager.prepareOneShotCommandBoundary("prepared", binding));
    expect(launch).toHaveBeenCalledTimes(1);
    const pid = launch.mock.results[0]!.value.pid;
    await owner.prepareForDurableClose();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(withOneShotFastMode(() => manager.prepareOneShotCommandBoundary("prepared", binding))).rejects.toThrow();
    expect(launch).toHaveBeenCalledTimes(1);
  });
  test("an aborted preparation never publishes a command", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess"), s = server();
    const controller = new AbortController();
    await s.prepare("/tmp", () => {}, controller.signal);
    const child = launch.mock.results[0]!.value;
    const send = vi.spyOn(child.stdin, "write");
    controller.abort();
    await s.close();
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(send).not.toHaveBeenCalled();
    await expect(s.prepare("/tmp", () => {}, controller.signal)).rejects.toThrow();
    expect(launch).toHaveBeenCalledTimes(1);
  });
  test("reuses one broker while cwd, argv0, environment, shell state, and status stay fresh", async () => {
    const spy = vi.spyOn(supervised, "spawnContainedProcess"), s = server(), dir = root();
    const a = await start(s, 'printf "%s:%s:%s" "$0" "$PWD" "$X"; printf err >&2; export LEAK=yes; cd /; exit 7', dir, { PATH: "/usr/bin:/bin", X: "first" });
    expect(await a.result).toEqual({ out: `test-shell:${dir}:first`, err: "err", code: 7 });
    const b = await start(s, 'printf "%s:%s:%s:%s" "$0" "$PWD" "$X" "${LEAK-unset}"', "/tmp", { PATH: "/usr/bin:/bin", X: "next" });
    expect(await b.result).toEqual({ out: "test-shell:/tmp:next:unset", err: "", code: 0 });
    expect(a.child.pid).toBe(b.child.pid); expect(spy).toHaveBeenCalledTimes(1);
  });
  test("cleans escaped descendants before publishing completion and serving the next command", async () => {
    const s = server(), dir = root();
    const a = await start(s, "setsid /bin/sh -c 'echo $$ > child; exec sleep 30' & while [ ! -s child ]; do :; done", dir);
    expect((await a.result).code).toBe(0);
    const pid = Number(fs.readFileSync(path.join(dir, "child"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(sessionProcessBoundaries.get(a.child)!.outcome()).toMatchObject({kind:"reported",residual:"observed"});
    expect((await (await start(s, "printf next")).result).out).toBe("next");
  });
  test("termination escalates for TERM-resistant commands and permits safe reuse", async () => {
    const s = server(); const a = await start(s, "trap '' TERM; printf ready; while :; do sleep 1; done");
    await new Promise<void>(resolve => a.child.stdout.once("data", () => resolve()));
    await sessionProcessBoundaries.get(a.child)!.terminate();
    expect((await a.result).code).not.toBe(0);
    expect((await (await start(s, "echo alive")).result).out).toBe("alive\n");
  });
  test("server death reports unknown outcome without replay and outer broker cleans descendants", async () => {
    const s = server(), dir = root();
    const a = await start(s, "echo once >> effects; echo $$ > target; kill -KILL $PPID; sleep 30", dir);
    await a.result;
    expect(fs.readFileSync(path.join(dir, "effects"), "utf8")).toBe("once\n");
    expect(sessionProcessBoundaries.get(a.child)!.outcome()).toEqual({kind:"unavailable",residual:"unknown"});
    expect(() => process.kill(Number(fs.readFileSync(path.join(dir,"target"),"utf8")), 0)).toThrow();
  });
  test("does not expose the server control descriptors to commands", async () => {
    const s = server();
    const a = await start(s, "for n in 3 4 5 6; do if test -e /proc/$$/fd/$n; then echo leaked:$n; fi; done");
    expect((await a.result).out).toBe("");
  });
  test("busy server declines before publication and invalidated authority never executes", async () => {
    const s = server(), dir = root();
    const a = await start(s, "sleep 30");
    expect(await s.spawn({program:"/bin/sh",args:["-c","echo bad > effects"],cwd:dir,env:{}},()=>{})).toBeUndefined();
    await sessionProcessBoundaries.get(a.child)!.terminate(); await a.result;
    await expect(s.spawn({program:"/bin/sh",args:["-c","echo bad > effects"],cwd:dir,env:{}},()=>{throw new Error("denied");})).rejects.toThrow("denied");
    expect(fs.existsSync(path.join(dir,"effects"))).toBe(false);
  });
  test("a cancellation crossing the final frame does not cancel the next command", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess"), s = server();
    expect((await (await start(s, "echo first")).result).out).toBe("first\n");
    // Queue the stale cancel after D, immediately followed by the next R.
    launch.mock.results[0]!.value.stdin.write(Buffer.from([75,0,0,0,0]));
    expect((await (await start(s, "echo next")).result).out).toBe("next\n");
    expect(launch).toHaveBeenCalledTimes(1);
  });
  test("startup failure falls back before executing anything and is remembered", async () => {
    const s = server(), dir = root();
    const launch = vi.spyOn(supervised, "spawnContainedProcess").mockImplementationOnce(() => { throw new Error("unavailable"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 2; i++)
      expect(await s.spawn({program:"/bin/sh",args:["-c","echo bad > effects"],cwd:dir,env:{}},()=>{})).toBeUndefined();
    expect(launch).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir,"effects"))).toBe(false);
  });
  test("native framing rejects malformed commands without executing a payload", async () => {
    const child = supervised.spawnContainedProcess(supervised.resolveLinuxSubreaperBroker(), ["--one-shot-server-v1"],
      {cwd:"/tmp",env:{PATH:"/usr/bin:/bin"},linuxContainment:"subreaper"});
    child.stderr.resume();
    const ready = await new Promise<Buffer>(resolve => child.stdout.once("data", resolve));
    expect([...ready]).toEqual([80,0,0,0,0]);
    const closed = new Promise(resolve => child.once("close", resolve));
    // A declared request body with no argc/envc is invalid, never a shell script.
    child.stdin.write(Buffer.from([82,0,0,0,1,0]));
    await closed;
    expect(child.exitCode).toBe(125);
    await supervised.terminateProcessTreeAndReport(child);
  });
  test("large multichunk stdout and stderr fully drain before the final status", async () => {
    const s = server();
    const a = await start(s, "printf '%0100000d' 0; printf '%0100000d' 1 >&2; exit 3");
    const result = await a.result;
    expect(result.out).toBe("0".repeat(100000));
    expect(result.err).toBe("0".repeat(99999)+"1"); expect(result.code).toBe(3);
  });
  test("a declined async startup cannot fall back after its owner closes", async () => {
    const manager = new UnifiedExecProcessManager({cwd:root()}); managers.push(manager);
    let decline!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered=resolve; });
    vi.spyOn(OneShotProcessServer.prototype, "spawn").mockImplementationOnce(async () => {
      entered(); await new Promise<void>(resolve => { decline=resolve; }); return undefined;
    });
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    await withOneShotFastMode(async () => {
      const owner = manager.createOwnerLifetime("closing");
      const pending = manager.execCommand({cmd:"echo must-not-run",login:false,ownerId:"closing",ownerBinding:owner.bind()});
      const rejected = expect(pending).rejects.toThrow();
      await waiting; await owner.prepareForDurableClose(); decline(); await rejected;
      expect(launch).not.toHaveBeenCalled();
    });
  });
  test("the command cannot write a forged terminal frame through the server's proc descriptors", async () => {
    const s = server();
    const a = await start(s, "printf forged > /proc/$PPID/fd/1");
    const result = await a.result;
    expect(result.code).not.toBe(0); expect(result.out).toBe("");
    expect((await (await start(s,"echo intact")).result).out).toBe("intact\n");
  });
  test("manager drains reusable brokers on owner close and resumes with a fresh lifetime", async () => {
    const manager = new UnifiedExecProcessManager(); managers.push(manager);
    const spy = vi.spyOn(supervised, "spawnContainedProcess");
    await withOneShotFastMode(async () => {
      const owner = manager.createOwnerLifetime("fast");
      const opts = {ownerId:"fast",ownerBinding:owner.bind(),login:false};
      expect((await manager.execCommand({cmd:"echo first",...opts})).stdout).toBe("first\n");
      expect((await manager.execCommand({cmd:"echo second",...opts})).stdout).toBe("second\n");
      expect(spy).toHaveBeenCalledTimes(1);
      const pid = spy.mock.results[0]!.value.pid;
      await owner.prepareForDurableClose(); expect(() => process.kill(pid, 0)).toThrow();
      const next = manager.createOwnerLifetime("fast");
      expect((await manager.execCommand({cmd:"echo third",ownerId:"fast",ownerBinding:next.bind(),login:false})).stdout).toBe("third\n");
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
