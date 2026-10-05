import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeDirectBwrapPlan, prepareDirectBwrapPlan, type PreparedDirectBwrap } from "../../../src/sandbox/linux-launcher/direct-bwrap.js";
import * as platform from "../../../src/sandbox/linux-launcher/direct-bwrap-platform.js";
import * as legacy from "../../../src/sandbox/linux-launcher/linux-run-main.js";
import * as launcher from "../../../src/sandbox/linux-launcher/launcher.js";
import * as proc from "../../../src/sandbox/linux-launcher/proc-probe.js";
import { createNetworkSeccompProgram } from "../../../src/sandbox/linux-launcher/landlock.js";

const runtime = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-bwrap-plan-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture(network = "disabled") {
  const cwd = path.join(root, "work"), temp = path.join(root, "temp");
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(temp, { recursive: true });
  for (const name of [".git", ".agenc", ".agents"]) fs.mkdirSync(path.join(cwd, name), { recursive: true });
  const profile = { fileSystem: { kind: "restricted", entries: [
    { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    { path: { kind: "path", path: cwd }, access: "write" },
  ], includePlatformDefaults: true }, network };
  const args = [path.join(runtime, "bin/agenc-linux-sandbox"), "--sandbox-policy-cwd", cwd,
    "--command-cwd", cwd, "--permission-profile", JSON.stringify(profile), "--session-temp-root", temp,
    "--", "/bin/bash", "-c", "printf once"];
  vi.spyOn(launcher, "preferredBubblewrapLauncher").mockReturnValue({ program: process.execPath, supportsArgv0: true });
  vi.spyOn(proc, "runProcMountProbe").mockReturnValue({ status: 0 } as ReturnType<typeof proc.runProcMountProbe>);
  return { program: process.execPath, args, cwd, env: { PATH: "/usr/bin:/bin" }, temp };
}

function decode(payload: Buffer) {
  const maps = payload.readUInt32BE(20), argc = payload.readUInt32BE(8), envc = payload.readUInt32BE(12);
  const bpfLength = maps === 1 ? payload.readUInt32BE(40) : 0;
  const strings = payload.subarray(28 + maps * 16, payload.length - 1 - bpfLength).toString().split("\0").slice(0, -1);
  return { program: strings[0], args: strings.slice(2, argc + 1),
    env: Object.fromEntries(strings.slice(argc + 1, argc + 1 + envc).map(item => {
      const separator = item.indexOf("="); return [item.slice(0, separator), item.slice(separator + 1)];
    })), bpf: payload.subarray(payload.length - 1 - bpfLength, -1), owner: payload.readUInt32BE(24) };
}

describe.runIf(process.platform === "linux")("guarded immutable direct bwrap planning", () => {
  it("binds the actual owner and BPF, unlinks its source, and disposes exactly once", () => {
    const f = fixture();
    const plan = prepareDirectBwrapPlan(f);
    expect(plan).toBeDefined();
    const handoff = consumeDirectBwrapPlan(plan!);
    const decoded = decode(handoff.payload);
    expect(decoded.owner).toBe(process.pid);
    expect(decoded.bpf).toEqual(createNetworkSeccompProgram("restricted"));
    expect(fs.readlinkSync(`/proc/self/fd/${handoff.sourceFd}`)).toMatch(/\(deleted\)$/);
    expect(fs.readdirSync(f.temp)).toEqual([]);
    expect(fs.readFileSync(handoff.sourceFd!)).toEqual(decoded.bpf);
    expect(handoff.isCurrent()).toBe(true);
    expect(() => consumeDirectBwrapPlan(plan!)).toThrow(/consumed/);
    expect(() => consumeDirectBwrapPlan({} as PreparedDirectBwrap)).toThrow(/invalid/);
    handoff.dispose();
    const reused = fs.openSync("/dev/null", "r");
    try { handoff.dispose(); expect(() => fs.fstatSync(reused)).not.toThrow(); }
    finally { fs.closeSync(reused); }
  });

  it("uses no descriptor when no seccomp is required and copies caller inputs", () => {
    const f = fixture("enabled");
    const plan = prepareDirectBwrapPlan(f)!;
    f.args[f.args.length - 1] = "changed";
    f.env.PATH = "/changed";
    const handoff = consumeDirectBwrapPlan(plan);
    try {
      expect(handoff.sourceFd).toBeUndefined();
      expect(decode(handoff.payload).args.at(-1)).toBe("printf once");
      expect(decode(handoff.payload).env.PATH).toBe("/usr/bin:/bin");
      expect(handoff.isCurrent()).toBe(true);
    } finally { handoff.dispose(); }
  });

  it("finishes partial BPF writes and closes/unlinks preparation failures", () => {
    const f = fixture();
    const write = fs.writeSync;
    const partial = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Uint8Array,
      offset: number, length: number, position: number) => write(fd, bytes, offset, Math.min(8, length), position)) as typeof fs.writeSync);
    const handoff = consumeDirectBwrapPlan(prepareDirectBwrapPlan(f)!);
    try { expect(fs.readFileSync(handoff.sourceFd!)).toEqual(decode(handoff.payload).bpf); }
    finally { handoff.dispose(); partial.mockRestore(); }
    const count = fs.readdirSync("/proc/self/fd").length;
    const failed = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("fixture write failure"); });
    expect(prepareDirectBwrapPlan(f)).toBeUndefined();
    failed.mockRestore();
    expect(fs.readdirSync(f.temp)).toEqual([]);
    expect(fs.readdirSync("/proc/self/fd")).toHaveLength(count);
  });

  it("rejects custom helpers, runtimes, scripts and unsupported launcher routes", () => {
    const f = fixture();
    const custom = path.join(root, "agenc-linux-sandbox"); fs.copyFileSync(f.args[0]!, custom);
    expect(prepareDirectBwrapPlan({ ...f, args: [custom, ...f.args.slice(1)] })).toBeUndefined();
    expect(prepareDirectBwrapPlan({ ...f, program: "/bin/bash" })).toBeUndefined();
    const script = path.join(root, "script"); fs.writeFileSync(script, "#!/bin/sh\ntrue\n", { mode: 0o755 });
    expect(prepareDirectBwrapPlan({ ...f, args: [...f.args.slice(0, -3), script] })).toBeUndefined();
    for (const flag of ["--allow-network-for-proxy", "--browser-cdp-over-stdio", "--apply-seccomp-then-exec", "--inherited-readonly-command-cwd"]) {
      expect(prepareDirectBwrapPlan({ ...f, args: [f.args[0]!, flag, ...f.args.slice(1)] })).toBeUndefined();
    }
    expect(prepareDirectBwrapPlan({ ...f, env: { ...f.env, NODE_OPTIONS: "--require=/untrusted" } })).toBeUndefined();
    expect(prepareDirectBwrapPlan({ ...f, cwd: root })).toBeUndefined();
    vi.mocked(launcher.preferredBubblewrapLauncher).mockReturnValue(null);
    expect(prepareDirectBwrapPlan(f)).toBeUndefined();
  });

  it("rechecks executable identity after slow probes and again at handoff", () => {
    const f = fixture();
    const shell = path.join(root, "shell"); fs.copyFileSync("/bin/bash", shell);
    const input = { ...f, args: [...f.args.slice(0, -3), shell, "-c", "true"] };
    const handoff = consumeDirectBwrapPlan(prepareDirectBwrapPlan(input)!);
    fs.renameSync(shell, shell + ".old"); fs.copyFileSync("/bin/bash", shell);
    try { expect(handoff.isCurrent()).toBe(false); } finally { handoff.dispose(); }
    vi.mocked(proc.runProcMountProbe).mockImplementation(() => {
      fs.unlinkSync(shell); fs.copyFileSync("/bin/bash", shell);
      return { status: 0 } as ReturnType<typeof proc.runProcMountProbe>;
    });
    expect(prepareDirectBwrapPlan(input)).toBeUndefined();
  });

  it("requires zero protected-create targets across every writable root", () => {
    const f = fixture();
    fs.mkdirSync(path.join(root, ".git"));
    const extra = path.join(root, "other"); fs.mkdirSync(extra);
    const profileIndex = f.args.indexOf("--permission-profile") + 1;
    const profile = JSON.parse(f.args[profileIndex]!);
    profile.fileSystem.entries.push({ path: { kind: "path", path: extra }, access: "write" });
    f.args[profileIndex] = JSON.stringify(profile);
    expect(prepareDirectBwrapPlan(f)).toBeUndefined();
    expect(fs.readdirSync(f.temp)).toEqual([]);
    fs.mkdirSync(path.join(extra, ".git"));
    const accepted = prepareDirectBwrapPlan(f);
    expect(accepted).toBeDefined();
    consumeDirectBwrapPlan(accepted!).dispose();
    fs.rmdirSync(path.join(f.cwd, ".git"));
    expect(prepareDirectBwrapPlan(f)).toBeUndefined();
  });

  it("keeps the bounded platform helpers equivalent to the unchanged launcher", () => {
    fixture();
    const text = path.join(root, "text"); fs.writeFileSync(text, "not ELF");
    for (const file of ["/bin/bash", process.execPath, text, root, "/dev/null", path.join(root, "missing")]) {
      for (const arch of [process.arch, "arm64", "x64"] as const) {
        expect(platform.isNativeElfExecutable(file, arch)).toBe(legacy.isNativeElfExecutable(file, arch));
      }
    }
    for (const value of [undefined, "", "/dev/null:/dev/zero", "/dev/tty*:/dev/null", "/tmp/*:relative:/dev/missing", "/dev/../etc/passwd"]) {
      const env = value === undefined ? {} : { AGENC_SANDBOX_DEVICE_BINDS: value };
      expect(platform.resolveSandboxDeviceBinds(env)).toEqual(legacy.resolveSandboxDeviceBinds(env));
    }
  });

  it.each(["disabled", "enabled"])("matches the unchanged launcher argv and session environment (%s)", async network => {
    const f = fixture(network);
    for (const nodeEnv of [undefined, "production", "development"]) {
      const env = { ...f.env, ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }), AGENC_SANDBOX_DEVICE_BINDS: "/dev/null" };
      const key = Symbol.for("agenc.originalRuntimeEnvironment");
      const prior = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { value: { NODE_ENV: undefined }, configurable: true });
      const handoff = consumeDirectBwrapPlan(prepareDirectBwrapPlan({ ...f, env })!);
      try {
        const actual = decode(handoff.payload);
        // Simulate the separate Node launcher's own incoming-env snapshot.
        Object.defineProperty(globalThis, key, { value: { NODE_ENV: nodeEnv }, configurable: true });
        const spawn = vi.spyOn(launcher, "spawnBubblewrap").mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
          queueMicrotask(() => child.emit("exit", 0, null));
          return { child: child as never, cleanup() {} };
        });
        expect(await legacy.runLinuxSandboxMain(f.args.slice(1), { env,
          selfCommand: [process.execPath, path.join(runtime, "dist/sandbox/linux-launcher/main.js")],
          preferredLauncher: () => ({ program: process.execPath, supportsArgv0: true }),
        })).toBe(0);
        const call = spawn.mock.calls.at(-1)!;
        expect(actual.program).toBe(call[0].program);
        expect(actual.args).toEqual(call[1]);
        expect(actual.env).toEqual(call[2].env);
        expect(actual.args).toContain("--die-with-parent");
        expect(actual.args).toContain("--unshare-pid");
        expect(actual.args).toContain("--proc");
        spawn.mockRestore();
      } finally {
        handoff.dispose();
        if (prior === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, prior);
      }
    }
  });
});
