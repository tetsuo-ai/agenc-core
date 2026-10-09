import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumePreparedProcProbe, prepareLinuxSandboxProbeHint } from "../../../src/sandbox/linux-launcher/probe-cache.js";
import { bubblewrapCapabilityContext } from "../../../src/sandbox/linux-launcher/capability-hint.js";
import * as launcher from "../../../src/sandbox/linux-launcher/launcher.js";
import * as proc from "../../../src/sandbox/linux-launcher/proc-probe.js";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consume-proc-probe-"));
  const profile = { fileSystem: { kind: "restricted", entries: [
    { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    { path: { kind: "path", path: dir }, access: "write" },
  ], includePlatformDefaults: true }, network: "disabled" };
  const args = ["/trusted/agenc-linux-sandbox", "--sandbox-policy-cwd", dir,
    "--command-cwd", dir, "--permission-profile", JSON.stringify(profile),
    "--session-temp-root", dir, "--", "/bin/echo", "once"];
  const env = { PATH: "/usr/bin:/bin" };
  vi.spyOn(launcher, "findSystemBubblewrapInPath").mockReturnValue(process.execPath);
  vi.spyOn(launcher, "probeBubblewrapCapabilities").mockReturnValue({ supportsArgv0: true, supportsBindFd: true });
  vi.spyOn(proc, "runProcMountProbe").mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof proc.runProcMountProbe>);
  return { dir, args, env };
}

describe("consumePreparedProcProbe", () => {
  it("accepts one-use identity-bound evidence and refuses a second consume", () => {
    const s = setup();
    try {
      const prepared = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      const context = bubblewrapCapabilityContext(process.execPath, s.dir, s.env)!;
      expect(prepared).toBeDefined();
      expect(context).toMatch(/^[a-f0-9]{64}$/);
      expect(consumePreparedProcProbe(prepared.args, context)).toBe(true);
      expect(consumePreparedProcProbe(prepared.args, context)).toBe(false);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  it("burns evidence on a wrong context and never accepts a copied argv", () => {
    const s = setup();
    try {
      const prepared = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      const context = bubblewrapCapabilityContext(process.execPath, s.dir, s.env)!;
      expect(consumePreparedProcProbe(prepared.args, "0".repeat(64))).toBe(false);
      expect(consumePreparedProcProbe(prepared.args, context)).toBe(false);
      const again = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      expect(consumePreparedProcProbe([...again.args], context)).toBe(false);
      expect(consumePreparedProcProbe(again.args, context)).toBe(true);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  it("rejects mutated hinted argv, original launcher argv, and invalidated evidence", () => {
    const s = setup();
    try {
      const mutated = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      const context = bubblewrapCapabilityContext(process.execPath, s.dir, s.env)!;
      (mutated.args as string[])[0] = "/other/agenc-linux-sandbox";
      expect(consumePreparedProcProbe(mutated.args, context)).toBe(false);
      const original = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      expect(consumePreparedProcProbe(s.args, context)).toBe(false);
      expect(consumePreparedProcProbe(original.args, context)).toBe(true);
      const cancelled = prepareLinuxSandboxProbeHint(s.args, s.dir, s.env)!;
      cancelled.invalidate();
      expect(consumePreparedProcProbe(cancelled.args, context)).toBe(false);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
});
