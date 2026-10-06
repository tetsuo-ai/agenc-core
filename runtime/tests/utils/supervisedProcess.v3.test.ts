import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(), execFileSync: vi.fn(),
}));
vi.mock("../../src/utils/direct-bwrap-handoff.js", () => ({ consumeDirectBwrapPlan: vi.fn() }));
const { consumeDirectBwrapPlan } = await import("../../src/utils/direct-bwrap-handoff.js");
const { spawnContainedProcess, terminateProcessTreeAndReport, containedProcessCommandOutcome,
  runSupervisedProcess } = await import("../../src/utils/supervisedProcess.js");
const actualCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "v3-consumer-")); scratch.push(cwd);
  const stdio = Array.from({ length: 5 }, () => new PassThrough());
  const nativeKill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: 0, signalCode: null,
    stdin: stdio[0], stdout: stdio[1], stderr: stdio[2], stdio, kill: nativeKill });
  vi.mocked(cp.spawn).mockReturnValue(child as never);
  const handoff = { payload: Buffer.from("AGB3"), sourceFd: undefined,
    namespaceInitArtifact: "", isCurrent: vi.fn(() => true), dispose: vi.fn() };
  vi.mocked(cp.execFileSync).mockImplementation(((broker: string, args: string[], options: unknown) => {
    if (args[0] !== "--describe-protocol-v3") return Reflect.apply(actualCp.execFileSync, actualCp, [broker, args, options]);
    expect(args).toEqual(["--describe-protocol-v3"]);
    handoff.namespaceInitArtifact = join(dirname(broker), "agenc-namespace-init-entry");
    return "AGB3 owner-pid sealed-static-init-ro-artifact-v1\n";
  }) as typeof cp.execFileSync);
  vi.mocked(consumeDirectBwrapPlan).mockReturnValue(handoff);
  const controller = new AbortController();
  const directBwrap = { protocol: "v3" as const, signal: controller.signal, validateAdmission: vi.fn(),
    prepare: vi.fn(() => ({} as Parameters<typeof consumeDirectBwrapPlan>[0])) };
  const start = () => spawnContainedProcess("/bin/true", [], { cwd, env: {}, linuxContainment: "subreaper", directBwrap });
  const finish = (frame: Buffer, eof = true) => {
    stdio[3]!.emit("data", frame);
    stdio[3]!.emit(eof ? "end" : "close"); child.emit("close", 125, null);
  };
  return { cwd, child, stdio, nativeKill, handoff, directBwrap, controller, start, finish };
}
function proof(state = 0, residual = 0, kind = 0, code = 0) {
  return Buffer.from([83, 65, 71, 67, 51, state, residual, kind, code, 0, 0, 0, 0]);
}

describe.runIf(process.platform === "linux")("V3 supervisor outcome and cleanup consumers", () => {
  it.each([0, 1, 2])("waits for EOF and process close, preserving outcome state %s independently of cleanup", async state => {
    const s = fixture(); const child = s.start();
    expect(vi.mocked(cp.spawn).mock.calls[0]![1]).toEqual(["--bootstrap-v3"]);
    s.stdio[3]!.emit("data", state === 0 ? proof(0, 1) : proof(state, 2, 2));
    expect(containedProcessCommandOutcome(child)).toBeUndefined();
    s.stdio[3]!.emit("end"); expect(containedProcessCommandOutcome(child)).toBeUndefined();
    s.child.emit("close", 125, null);
    const outcome = await terminateProcessTreeAndReport(child);
    expect(outcome.commandOutcome?.kind).toBe(["reported", "aborted", "unavailable"][state]);
    expect(outcome.residualProcessesTerminated).toBe(false);
    expect(outcome.residualProcessesObserved).toBe(state === 0 ? true : undefined);
  });

  it.each(["truncated", "extra", "no-eof", "read-error"])("keeps %s transport failure separate from proven unknown outcomes", async failure => {
    const s = fixture(); const child = s.start();
    if (failure === "read-error") s.stdio[3]!.emit("error", new Error("status read failed"));
    s.finish(failure === "truncated" ? proof().subarray(0, 8) : failure === "extra" ? Buffer.concat([proof(), Buffer.from([0])]) : proof(), failure !== "no-eof");
    expect(containedProcessCommandOutcome(child)).toBeUndefined();
    await expect(terminateProcessTreeAndReport(child)).rejects.toThrow(/cleanup could not be verified/);
  });

  it("queues cancellation until authenticated readiness and never retries after dispatch", () => {
    const s = fixture(); s.start(); s.controller.abort();
    expect(s.nativeKill).not.toHaveBeenCalled();
    s.stdio[3]!.emit("data", Buffer.from("S"));
    expect(s.nativeKill).toHaveBeenCalledWith("SIGTERM");
    s.stdio[3]!.emit("data", proof(1, 2, 2).subarray(1)); s.stdio[3]!.emit("end"); s.child.emit("close");
    expect(cp.spawn).toHaveBeenCalledTimes(1);
  });

  it("uses only pre-dispatch legacy fallback for an unsupported broker", () => {
    const s = fixture(); vi.mocked(cp.execFileSync).mockReturnValue("unsupported\n"); s.start();
    expect(s.directBwrap.prepare).not.toHaveBeenCalled();
    expect(vi.mocked(cp.spawn).mock.calls[0]![1]).toEqual([]);
    s.stdio[3]!.emit("data", Buffer.from("SC")); s.stdio[3]!.emit("end"); s.child.emit("close");
  });

  it("rejects a prepared artifact from a different installed runtime before dispatch", () => {
    const s = fixture(); s.directBwrap.prepare.mockImplementation(() => {
      s.handoff.namespaceInitArtifact = "/other/dist/agenc-namespace-init-entry";
      return {} as Parameters<typeof consumeDirectBwrapPlan>[0];
    }); s.start();
    expect(vi.mocked(cp.spawn).mock.calls[0]![1]).toEqual([]);
    expect(s.handoff.dispose).toHaveBeenCalledTimes(1);
    s.stdio[3]!.emit("data", Buffer.from("SC")); s.stdio[3]!.emit("end"); s.child.emit("close");
  });

  it.each([0, 1, 2])("runSupervisedProcess retains cleanup authority for state %s without inventing success", async state => {
    const s = fixture();
    const result = runSupervisedProcess({ program: "/bin/true", args: [], cwd: s.cwd, env: {} },
      { maxOutputBytes: 1024, linuxContainment: "subreaper", directBwrap: s.directBwrap });
    s.child.emit("spawn");
    s.finish(state === 0 ? proof(0, 0, 0, 125) : proof(state, 2, 2));
    const output = await result;
    expect(output.processTreeCleanupProven).toBe(true);
    expect(output.processStarted).toBe(true);
    expect(output.exitCode).toBe(state === 0 ? 125 : null);
    expect(output.commandOutcome?.kind).toBe(["reported", "aborted", "unavailable"][state]);
    if (state === 2) expect(output.error?.message).toContain("outcome unavailable after dispatch");
    else expect(output.error).toBeUndefined();
    if (state === 1) expect(output.stopReason).toBe("aborted");
  });
});
