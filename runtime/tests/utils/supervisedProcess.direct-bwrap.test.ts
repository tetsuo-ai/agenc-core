import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn), execFileSync: vi.fn(original.execFileSync) };
});
vi.mock("../../src/utils/direct-bwrap-handoff.js", () => ({ consumeDirectBwrapPlan: vi.fn() }));
const { consumeDirectBwrapPlan } = await import("../../src/utils/direct-bwrap-handoff.js");
const { spawnContainedProcess } = await import("../../src/utils/supervisedProcess.js");

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(cp.spawn).mockReset();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "direct-handoff-")); scratch.push(cwd);
  const streams = Array.from({ length: 5 }, () => new PassThrough());
  const nativeKill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdio: streams,
    stdin: streams[0], stdout: streams[1], stderr: streams[2], kill: nativeKill, ref() {}, unref() {} });
  const spawn = vi.mocked(cp.spawn).mockReturnValue(child as never);
  const end = vi.spyOn(streams[4]!, "end");
  const controller = new AbortController();
  const handoff = { payload: Buffer.from("owned frame"), sourceFd: undefined as number | undefined,
    isCurrent: vi.fn(() => true), dispose: vi.fn() };
  vi.mocked(consumeDirectBwrapPlan).mockReturnValue(handoff);
  const prepare = vi.fn(() => ({} as Parameters<typeof consumeDirectBwrapPlan>[0]));
  const validateAdmission = vi.fn();
  const run = () => spawnContainedProcess("/bin/echo", ["legacy"], {
    cwd, env: {}, linuxContainment: "subreaper",
    directBwrap: { prepare, validateAdmission, signal: controller.signal },
  });
  return { run, child, spawn, end, streams, nativeKill, controller, handoff, prepare, validateAdmission };
}

describe.runIf(process.platform === "linux")("direct broker ownership at the publication boundary", () => {
  it("duplicates only the owned descriptor and releases its source before publication", () => {
    const s = setup(); s.handoff.sourceFd = 37;
    expect(s.run()).toBe(s.child);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.spawn.mock.calls[0]![1]).toEqual(["--bootstrap-v2"]);
    expect(s.spawn.mock.calls[0]![2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", 37] });
    expect(s.handoff.dispose).toHaveBeenCalledTimes(1);
    expect(s.handoff.dispose.mock.invocationCallOrder[0]).toBeLessThan(s.end.mock.invocationCallOrder[0]!);
    expect(s.validateAdmission).toHaveBeenCalledTimes(2);
    s.child.emit("close");
  });

  it("refuses pre-dispatch revocation without spawning and disposes the prepared fd", () => {
    const s = setup(); s.validateAdmission.mockImplementation(() => { throw new Error("revoked"); });
    expect(s.run).toThrow("revoked"); expect(s.spawn).not.toHaveBeenCalled();
    expect(s.handoff.dispose).toHaveBeenCalledTimes(1);
  });

  it("withholds every byte and uses native SIGKILL if admission changes after spawn", () => {
    const s = setup(); s.validateAdmission.mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("revoked"); });
    expect(s.run()).toBe(s.child);
    expect(s.end).not.toHaveBeenCalled();
    expect(s.nativeKill).toHaveBeenCalledWith("SIGKILL");
    expect(s.streams[4]!.destroyed).toBe(true);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.child.emit("close");
  });

  it("withholds the frame for an abort during spawn, without waiting for S", () => {
    const s = setup();
    s.spawn.mockImplementation(() => { s.controller.abort(); return s.child as never; });
    expect(s.run()).toBe(s.child);
    expect(s.end).not.toHaveBeenCalled(); expect(s.nativeKill).toHaveBeenCalledWith("SIGKILL");
    s.child.emit("close");
  });

  it("marks publication committed before calling end, and queues cancellation until S", async () => {
    const s = setup();
    s.end.mockImplementation(() => { s.controller.abort(); return s.streams[4]!; });
    expect(s.run()).toBe(s.child);
    expect(s.end).toHaveBeenCalledWith(s.handoff.payload);
    expect(s.nativeKill).not.toHaveBeenCalled();
    s.streams[3]!.write("S"); await Promise.resolve();
    expect(s.nativeKill).toHaveBeenCalledWith("SIGTERM");
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.child.emit("close");
  });

  it("retains the child after a partial/synchronous publication failure and never retries", async () => {
    const s = setup(); s.end.mockImplementation(() => { throw new Error("partial frame write"); });
    expect(s.run()).toBe(s.child);
    expect(s.nativeKill).not.toHaveBeenCalled(); expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.child.listenerCount("close")).toBeGreaterThan(0);
    expect(s.streams[3]!.listenerCount("close")).toBeGreaterThan(0);
    expect(s.streams[4]!.destroyed).toBe(true);
    s.child.emit("close"); await new Promise(resolve => setImmediate(resolve));
  });

  it("allows only a pre-spawn stale-plan miss to select the original AGB1 path", () => {
    const s = setup(); s.handoff.isCurrent.mockReturnValue(false);
    s.run();
    expect(s.spawn).toHaveBeenCalledTimes(1); expect(s.spawn.mock.calls[0]![1]).toEqual([]);
    expect((s.end.mock.calls[0]![0] as Buffer).subarray(0, 4).toString()).toBe("AGB1");
    expect(s.handoff.dispose).toHaveBeenCalledTimes(1);
    s.child.emit("close");
  });

  it("withholds every byte if the executable identity changes after spawn", () => {
    const s = setup(); s.handoff.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    expect(s.run()).toBe(s.child);
    expect(s.end).not.toHaveBeenCalled(); expect(s.nativeKill).toHaveBeenCalledWith("SIGKILL");
    expect(s.spawn).toHaveBeenCalledTimes(1); expect(s.handoff.dispose).toHaveBeenCalledTimes(1);
    s.child.emit("close");
  });

  it("keeps unsupported native protocols on AGB1 without preparing a descriptor", () => {
    const s = setup();
    const actual = cp.execFileSync;
    const probe = vi.mocked(cp.execFileSync);
    const implementation = probe.getMockImplementation()!;
    probe.mockImplementation(((program: string, args: string[], options: unknown) => {
      if (args?.[0] === "--describe-protocol") return "unsupported\n";
      return Reflect.apply(implementation, cp, [program, args, options]);
    }) as typeof actual);
    try {
      s.run(); expect(s.prepare).not.toHaveBeenCalled();
      expect(s.spawn.mock.calls[0]![1]).toEqual([]);
      expect((s.end.mock.calls[0]![0] as Buffer).subarray(0, 4).toString()).toBe("AGB1");
    } finally { probe.mockImplementation(implementation); s.child.emit("close"); }
  });

  it("does not retry a native spawn exception", () => {
    const s = setup(); s.spawn.mockImplementation(() => { throw new Error("spawn refused"); });
    expect(s.run).toThrow("spawn refused");
    expect(s.spawn).toHaveBeenCalledTimes(1); expect(s.handoff.dispose).toHaveBeenCalledTimes(1);
  });
});
