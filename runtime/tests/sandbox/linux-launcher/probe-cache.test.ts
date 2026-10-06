import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuccessfulProbeCache, prepareLinuxSandboxProbeHint } from "../../../src/sandbox/linux-launcher/probe-cache.js";
import { bubblewrapCapabilityContext, capabilityDigest, parseBubblewrapCapabilityHint } from "../../../src/sandbox/linux-launcher/capability-hint.js";
import { parseLinuxSandboxLauncherArgs } from "../../../src/sandbox/linux-launcher/cli.js";
import * as launcher from "../../../src/sandbox/linux-launcher/launcher.js";
import * as proc from "../../../src/sandbox/linux-launcher/proc-probe.js";

const hint = { context: "a".repeat(64), procArgs: "b".repeat(64), supportsArgv0: true, supportsBindFd: false };
afterEach(() => vi.restoreAllMocks());

describe("successful probe cache", () => {
  it("reuses success only for the same key and re-probes after invalidation", () => {
    const cache = new SuccessfulProbeCache(); const probe = vi.fn(() => hint);
    expect(cache.get("one", probe)).toEqual(hint);
    cache.get("one", probe); expect(probe).toHaveBeenCalledTimes(1);
    cache.get("two", probe); expect(probe).toHaveBeenCalledTimes(2);
    cache.invalidate("one"); cache.get("one", probe); expect(probe).toHaveBeenCalledTimes(3);
  });
  it("never stores failed probes and bounds daemon memory", () => {
    const cache = new SuccessfulProbeCache(); const failed = vi.fn(() => undefined);
    cache.get("failed", failed); cache.get("failed", failed); expect(failed).toHaveBeenCalledTimes(2);
    const ok = vi.fn(() => hint);
    for (let i = 0; i < 65; i++) cache.get(String(i), ok);
    cache.get("0", ok); expect(ok).toHaveBeenCalledTimes(66);
  });
  it("rejects malformed hints without granting a capability", () => {
    for (const value of ["{", "null", "{}", JSON.stringify({ ...hint, supportsBindFd: 1 }), "x".repeat(1025)]) {
      expect(parseBubblewrapCapabilityHint(value)).toBeUndefined();
    }
    expect(parseBubblewrapCapabilityHint(JSON.stringify(hint))).toEqual(hint);
  });
  it("binds identity, cwd, environment and mount state without persisting plaintext", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-identity-"));
    try {
      const file = path.join(dir, "bwrap"); fs.writeFileSync(file, "one");
      const context = bubblewrapCapabilityContext(file, dir, { PATH: "/usr/bin", SECRET: "not-persisted" });
      expect(context).toMatch(/^[a-f0-9]{64}$/);
      expect(bubblewrapCapabilityContext(file, dir, { SECRET: "not-persisted", PATH: "/usr/bin" })).toBe(context);
      expect(bubblewrapCapabilityContext(file, dir, { PATH: "/bin" })).not.toBe(context);
      fs.renameSync(file, file + ".old"); fs.writeFileSync(file, "one");
      expect(bubblewrapCapabilityContext(file, dir, { PATH: "/usr/bin", SECRET: "not-persisted" })).not.toBe(context);
      expect(bubblewrapCapabilityContext(file + ".missing", dir, {})).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("daemon launcher handoff", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-handoff-"));
    const profile = { fileSystem: { kind: "restricted", entries: [
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      { path: { kind: "path", path: dir }, access: "write" },
    ], includePlatformDefaults: true }, network: "disabled" };
    const args = ["/trusted/agenc-linux-sandbox", "--sandbox-policy-cwd", dir,
      "--command-cwd", dir, "--permission-profile", JSON.stringify(profile),
      "--session-temp-root", dir, "--", "/bin/echo", "once"];
    const env = { PATH: "/usr/bin:/bin" };
    vi.spyOn(launcher, "findSystemBubblewrapInPath").mockReturnValue(process.execPath);
    const capabilities = vi.spyOn(launcher, "probeBubblewrapCapabilities").mockReturnValue({ supportsArgv0: true, supportsBindFd: true });
    const run = vi.spyOn(proc, "runProcMountProbe").mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof proc.runProcMountProbe>);
    return { dir, args, env, capabilities, run };
  }
  it("reuses probes for different commands, resolves current policy, preserves command and invalidates failures", () => {
    const s = setup();
    try {
      const first = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      expect(first).toBeDefined();
      const parsed = parseLinuxSandboxLauncherArgs(first.args.slice(1));
      expect(parsed.mountProc).toBe(true); expect(parsed.command).toEqual(["/bin/echo", "once"]);
      expect(parsed.capabilityHint).toBeDefined();
      const second = prepareLinuxSandboxProbeHint([...s.args.slice(0, -1), "twice"], s.dir, s.env)!;
      expect(second).toBeDefined(); expect(s.run).toHaveBeenCalledTimes(1); expect(s.capabilities).toHaveBeenCalledTimes(1);
      first.invalidate(); prepareLinuxSandboxProbeHint(s.args, s.dir, s.env);
      expect(s.run).toHaveBeenCalledTimes(2);
      prepareLinuxSandboxProbeHint(s.args, s.dir, { ...s.env, LANG: "C" });
      expect(s.run).toHaveBeenCalledTimes(3);
      expect(capabilityDigest(["--proc", "/proc"])).not.toBe(capabilityDigest(["--bind", "/proc", "/proc"]));
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
  it("does not cache namespace/proc failures or opt nonstandard launch paths in", () => {
    const s = setup();
    try {
      s.run.mockReturnValue({ status: 1, error: undefined, stderr: "Can't mount proc on /proc" } as ReturnType<typeof proc.runProcMountProbe>);
      expect(prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)).toBeUndefined();
      expect(prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)).toBeUndefined();
      expect(s.run).toHaveBeenCalledTimes(2);
      s.capabilities.mockReturnValue(undefined);
      expect(prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)).toBeUndefined();
      expect(s.run).toHaveBeenCalledTimes(2);
      for (const flag of ["--allow-network-for-proxy", "--no-proc", "--browser-cdp-over-stdio"]) {
        expect(prepareLinuxSandboxProbeHint([s.args[0]!, flag, ...s.args.slice(1)], s.dir, s.env)).toBeUndefined();
      }
      expect(prepareLinuxSandboxProbeHint(["/other/custom-helper", ...s.args.slice(1)], s.dir, s.env)).toBeUndefined();
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
});

describe("launcher enforcement with a successful hint", () => {
  it("keeps namespace/proc/seccomp flags and reports failed real launch without retry", async () => {
    const { runLinuxSandboxMain } = await import("../../../src/sandbox/linux-launcher/linux-run-main.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-enforcement-"));
    try {
      const cwd = path.join(root, "work"), bin = path.join(root, "bin");
      fs.mkdirSync(cwd); fs.mkdirSync(bin);
      const program = path.join(bin, "bwrap"), capture = path.join(root, "argv");
      fs.writeFileSync(program, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE"\nexit 42\n', { mode: 0o755 });
      const env = { PATH: bin + ":/usr/bin:/bin", CAPTURE: capture };
      const fileSystem = { kind: "restricted" as const, entries: [
        { path: { kind: "special" as const, value: { kind: "root" as const } }, access: "read" as const },
        { path: { kind: "path" as const, path: cwd }, access: "write" as const },
      ], includePlatformDefaults: true };
      const procArgs = proc.createProcMountProbeArgs({ fileSystem, sandboxPolicyCwd: cwd,
        commandCwd: cwd, networkMode: "isolated", sessionTempRoot: cwd }).args;
      const h = { context: bubblewrapCapabilityContext(program, cwd, env)!,
        procArgs: capabilityDigest(procArgs), supportsArgv0: false, supportsBindFd: false };
      const args = ["--bwrap-capability-hint", JSON.stringify(h), "--sandbox-policy-cwd", cwd,
        "--command-cwd", cwd, "--permission-profile", JSON.stringify({ fileSystem, network: "disabled" }),
        "--session-temp-root", cwd, "--", "/bin/echo", "once"];
      const code = await runLinuxSandboxMain(args, { env,
        preferredLauncher: options => launcher.preferredBubblewrapLauncher({ ...options, trustedDirectories: [bin] }),
      });
      expect(code).toBe(42);
      const captured = fs.readFileSync(capture, "utf8").trim().split("\n");
      expect(captured.filter(x => x === "--")).toHaveLength(1);
      for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--proc", "--seccomp", "--die-with-parent"]) {
        expect(captured).toContain(flag);
      }
      // Replacing the executable invalidates the child-side identity check.
      fs.renameSync(program, program + ".old"); fs.copyFileSync(program + ".old", program);
      const selected = launcher.preferredBubblewrapLauncher({ cwd, env, requireNamespaces: true,
        trustedDirectories: [bin], capabilityHint: h });
      expect(selected).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
