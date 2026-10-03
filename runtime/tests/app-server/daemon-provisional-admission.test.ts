import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agenCProvisionalAdmissionMessage,
  createAgenCProvisionalAdmissionReceiver,
  observeAgenCSpawnedChildExit,
  type AgenCProvisionalChannel,
} from "../../src/app-server/daemon-provisional-admission.js";

const TOKEN = "a".repeat(64);
class Channel implements AgenCProvisionalChannel {
  connected = true;
  messages = new Set<(message: unknown) => void>();
  closes = new Set<() => void>();
  isConnected(): boolean { return this.connected; }
  addMessageListener(fn: (message: unknown) => void): void { this.messages.add(fn); }
  removeMessageListener(fn: (message: unknown) => void): void { this.messages.delete(fn); }
  addCloseListener(fn: () => void): void { this.closes.add(fn); }
  removeCloseListener(fn: () => void): void { this.closes.delete(fn); }
  async send(message: unknown): Promise<void> { for (const fn of this.messages) fn(message); }
  close(): void { this.connected = false; for (const fn of this.closes) fn(); }
  unref(): void {}
}

describe("disabled provisional admission protocol", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["admit", "abort"] as const)("latches first authenticated %s decision", async (action) => {
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 1_000);
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, action));
    const result = await receiver.decision;
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, action === "admit" ? "abort" : "admit"));
    channel.close();
    expect(receiver.current()).toBe(result);
    expect(result.kind).toBe(action === "admit" ? "admitted" : "aborted");
    expect(Object.isFrozen(result)).toBe(true);
    expect(channel.messages.size).toBe(0);
    expect(channel.closes.size).toBe(0);
  });

  it.each([
    null, [], {},
    { ...agenCProvisionalAdmissionMessage(TOKEN, "admit"), version: 2 },
    { ...agenCProvisionalAdmissionMessage(TOKEN, "admit"), token: "b".repeat(64) },
    { ...agenCProvisionalAdmissionMessage(TOKEN, "admit"), action: "ready" },
    { type: "agenc.daemon.startup.ready", token: TOKEN },
  ])("ignores malformed, unrelated or wrong-token input %j", async (message) => {
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 1_000);
    await channel.send(message);
    expect(receiver.current()).toBeNull();
    receiver.close();
    expect(await receiver.decision).toEqual({ kind: "aborted", reason: "closed" });
  });

  it("canonical cancellation aborts admission without closing the cleanup acknowledgement channel", async () => {
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 1_000);
    receiver.abort();
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, "admit"));
    expect(await receiver.decision).toEqual({ kind: "aborted", reason: "parent-abort" });
    expect(channel.connected).toBe(true);
    expect(channel.messages.size).toBe(0);
    receiver.close();
  });

  it("detects a disconnect that predates receiver installation", async () => {
    const channel = new Channel(); channel.close();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 1_000);
    expect(await receiver.decision).toEqual({ kind: "aborted", reason: "disconnected" });
    expect(channel.messages.size).toBe(0);
    expect(channel.closes.size).toBe(0);
  });

  it("does not admit through a queued message on a disconnected channel", async () => {
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 1_000);
    channel.connected = false;
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, "admit"));
    expect(await receiver.decision).toEqual({ kind: "aborted", reason: "disconnected" });
  });

  it("aborts when the event-loop lease expires and cannot be resurrected", async () => {
    vi.useFakeTimers();
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await receiver.decision).toEqual({ kind: "aborted", reason: "lease-expired" });
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, "admit"));
    expect(receiver.current()?.kind).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the lease after admission without closing the normal startup guard channel", async () => {
    vi.useFakeTimers();
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 100);
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, "admit"));
    await vi.advanceTimersByTimeAsync(200);
    expect(await receiver.decision).toEqual({ kind: "admitted" });
    expect(channel.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects admission at the monotonic deadline before its timer callback runs", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const channel = new Channel();
    const receiver = createAgenCProvisionalAdmissionReceiver(TOKEN, channel, 20);
    clock.mockReturnValue(120);
    await channel.send(agenCProvisionalAdmissionMessage(TOKEN, "admit"));
    expect(await receiver.decision).toEqual({ kind: "aborted", reason: "lease-expired" });
    expect(channel.messages.size).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])("rejects invalid lease %s before installing listeners", (lease) => {
    const channel = new Channel();
    expect(() => createAgenCProvisionalAdmissionReceiver(TOKEN, channel, lease)).toThrow(/timeout/u);
    expect(channel.messages.size).toBe(0);
  });

  it("uses the canonical capability bounds", () => {
    expect(() => createAgenCProvisionalAdmissionReceiver("short", new Channel(), 1_000)).toThrow(/capability/u);
    expect(() => agenCProvisionalAdmissionMessage("a".repeat(1_025), "admit")).toThrow(/capability/u);
    expect(Object.isFrozen(agenCProvisionalAdmissionMessage(TOKEN, "admit"))).toBe(true);
  });
});

const CHILD = String.raw`
const [url, mode, token] = process.argv.slice(1);
const { createAgenCProvisionalAdmissionReceiver, agenCProvisionalAdmissionMessage } = await import(url);
if (mode === "late-install") {
  process.stdout.write("BEFORE\n");
  await new Promise(resolve => setTimeout(resolve, 150));
}
const channel = {
  isConnected: () => process.connected === true,
  addMessageListener: fn => process.on("message", fn),
  removeMessageListener: fn => process.off("message", fn),
  addCloseListener: fn => process.on("disconnect", fn),
  removeCloseListener: fn => process.off("disconnect", fn),
  send: message => new Promise((resolve,reject) => process.send(message,error => error ? reject(error) : resolve())),
  close: () => { if (process.connected) process.disconnect(); },
  unref: () => process.channel?.unref(),
};
const receiver = createAgenCProvisionalAdmissionReceiver(token, channel, mode === "overdue-admit" ? 20 : mode === "lease" || mode === "blocked" ? 100 : 5000);
process.stdout.write("READY\n");
if (mode === "overdue-admit") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  // Deliberately deliver a callback before the overdue timer. This pins event
  // ordering without claiming a particular OS IPC scheduling order.
  process.emit("message", agenCProvisionalAdmissionMessage(token, "admit"));
}
if (mode === "blocked") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
const result = await receiver.decision;
process.stdout.write(JSON.stringify(result)+"\n");
if (mode === "hold-exit") {
  process.stdout.write("ACK\n");
  await new Promise(resolve => process.on("message", message => { if (message.type === "test-release") resolve(); }));
}
process.exit(0);
`;

describe("native provisional process controls (not production activation proof)", () => {
  let root: string, bundle: string;
  const children = new Set<ChildProcess>();
  const outputs = new Map<ChildProcess, { stdout: string; stderr: string }>();
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agenc-provisional-prototype-"));
    bundle = join(root, "admission.mjs");
    buildSync({ entryPoints: [fileURLToPath(new URL("../../src/app-server/daemon-provisional-admission.ts", import.meta.url))], outfile: bundle, bundle: true, platform: "node", format: "esm" });
  });
  afterEach(async () => {
    await Promise.all([...children].map(async child => {
      const observer = observeAgenCSpawnedChildExit(child);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await observer.waitForExit(5_000);
    }));
    children.clear(); outputs.clear();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function start(mode: string): ChildProcess {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", CHILD, pathToFileURL(bundle).href, mode, TOKEN], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.add(child);
    const output = { stdout: "", stderr: "" }; outputs.set(child, output);
    child.stdout!.on("data", part => { output.stdout += String(part); });
    child.stderr!.on("data", part => { output.stderr += String(part); });
    return child;
  }
  async function line(child: ChildProcess, value: string): Promise<void> {
    if (outputs.get(child)!.stdout.includes(value)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); child.stdout!.off("data", inspect); child.off("exit", failed); };
      const inspect = (): void => { if (outputs.get(child)!.stdout.includes(value)) { cleanup(); resolve(); } };
      const failed = (): void => { cleanup(); reject(new Error(JSON.stringify(outputs.get(child)))); };
      const timer = setTimeout(failed, 5_000);
      child.stdout!.on("data", inspect); child.on("exit", failed); inspect();
    });
  }
  async function send(child: ChildProcess, value: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => child.send!(value as never, error => error ? reject(error) : resolve()));
  }

  it("admits a live exact child only via the authenticated decision", async () => {
    const child = start("admit"), observer = observeAgenCSpawnedChildExit(child);
    await line(child, "READY\n");
    await send(child, agenCProvisionalAdmissionMessage(TOKEN, "admit"));
    expect((await observer.waitForExit(5_000)).code).toBe(0);
    expect(outputs.get(child)!.stdout).toContain('"kind":"admitted"');
  });

  it("detects IPC loss before receiver installation in a real child", async () => {
    const child = start("late-install"), observer = observeAgenCSpawnedChildExit(child);
    await line(child, "BEFORE\n"); child.disconnect();
    expect((await observer.waitForExit(5_000)).code).toBe(0);
    expect(outputs.get(child)!.stdout).toContain('"reason":"disconnected"');
  });

  it("exits on an expired lease when its event loop is available", async () => {
    const child = start("lease"), observer = observeAgenCSpawnedChildExit(child);
    expect((await observer.waitForExit(5_000)).code).toBe(0);
    expect(outputs.get(child)!.stdout).toContain('"reason":"lease-expired"');
  });

  it("does not mistake cleanup acknowledgement for child exit", async () => {
    const child = start("hold-exit"), observer = observeAgenCSpawnedChildExit(child);
    await line(child, "READY\n");
    const cleanup = async (): Promise<void> => { await send(child, agenCProvisionalAdmissionMessage(TOKEN, "abort")); await line(child, "ACK\n"); };
    await expect(observer.cancelAndWaitForExit(cleanup, 100)).rejects.toThrow(/not verified/u);
    expect(child.exitCode).toBeNull();
    await send(child, { type: "test-release" });
    expect((await observer.waitForExit(5_000)).code).toBe(0);
  });

  it("reports the blocked-event-loop gap rather than claiming lease cleanup succeeded", async () => {
    const child = start("blocked"), observer = observeAgenCSpawnedChildExit(child);
    await line(child, "READY\n"); child.disconnect();
    await expect(observer.waitForExit(100)).rejects.toThrow(/not verified/u);
    expect(child.exitCode).toBeNull();
    expect((await observer.waitForExit(5_000)).code).toBe(0);
    expect(outputs.get(child)!.stdout).toContain('"kind":"aborted"');
  });

  it("refuses an overdue native admission callback before the queued timer", async () => {
    const child = start("overdue-admit"), observer = observeAgenCSpawnedChildExit(child);
    expect((await observer.waitForExit(5_000)).code).toBe(0);
    expect(outputs.get(child)!.stdout).toContain('"reason":"lease-expired"');
    expect(outputs.get(child)!.stdout).not.toContain('"kind":"admitted"');
  });

  it("accepts already-observed exit but not a failing cleanup acknowledgement", async () => {
    const child = start("lease"); await once(child, "exit");
    const observer = observeAgenCSpawnedChildExit(child);
    expect((await observer.waitForExit(1_000)).code).toBe(0);
    await expect(observer.cancelAndWaitForExit(async () => { throw new Error("cleanup failed"); }, 1_000)).rejects.toThrow("cleanup failed");
  });
});
