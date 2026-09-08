import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PairingStore } from "../../src/gateway/pairing.js";

interface WorkerOperation {
  operation: "approve" | "revoke" | "challenge" | "redeem" | "unexpected-read";
  peer: string;
  code?: string;
  delayMs?: number;
}

const children = new Set<ChildProcess>();
let bundleRoot: string;
let bundlePath: string;
let home: string;

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), "agenc-pairing-worker-"));
  bundlePath = join(bundleRoot, "pairing.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "../../src/gateway/pairing.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    logLevel: "silent",
  });
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agenc-pairing-transaction-"));
  copyFileSync(bundlePath, join(home, "pairing-runtime.mjs"));
  await new PairingStore({ agencHome: home }).approve("tg", "seed");
});

afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  })));
  children.clear();
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));

async function runWorkers(operations: readonly WorkerOperation[]): Promise<unknown[]> {
  const workers = operations.map(operation => {
    const child = fork(join(import.meta.dirname, "fixtures/pairing-worker.mjs"), [JSON.stringify(operation)], {
      cwd: home,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.add(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    const result = new Promise<unknown>((resolve, reject) => {
      let reported = false;
      let value: unknown;
      child.on("message", (message: { ready?: boolean; error?: string; result?: unknown }) => {
        if (message.ready) { markReady(); return; }
        reported = true;
        value = message.result;
        if (message.error) reject(new Error(message.error));
      });
      child.once("error", error => { failReady(error); reject(error); });
      child.once("exit", code => {
        children.delete(child);
        if (code === 0 && reported) { resolve(value); return; }
        const error = new Error(`pairing worker exited ${code}: ${stderr}`);
        failReady(error);
        reject(error);
      });
    });
    return { child, ready, result };
  });
  const results = Promise.all(workers.map(worker => worker.result));
  void results.catch(() => {});
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send("start");
  return results;
}

describe("PairingStore transactions", () => {
  test("the instrumented worker refuses reads outside its pairing state file", async () => {
    await expect(runWorkers([{ operation: "unexpected-read", peer: "unused" }])).rejects.toThrow("pairing fixture read outside its state file");
  });

  test("the worker rejects execution outside its private fixture directory", () => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures/pairing-worker.mjs"), JSON.stringify({ operation: "approve", peer: "outside", home })], {
      cwd: bundleRoot,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pairing worker requires its private fixture directory");
    expect(new PairingStore({ agencHome: home }).isPaired("tg", "outside")).toBe(false);
  });

  test("retains approvals from separate store instances", async () => {
    const peers = Array.from({ length: 20 }, (_, index) => `peer-${index}`);
    await Promise.all(peers.map(peer => new PairingStore({ agencHome: home }).approve("tg", peer)));
    expect(new PairingStore({ agencHome: home }).listPaired("tg").toSorted()).toEqual([...peers, "seed"].toSorted());
  });

  test("retains every synchronized child-process approval", async () => {
    const peers = Array.from({ length: 8 }, (_, index) => `peer-${index}`);
    await runWorkers(peers.map(peer => ({ operation: "approve", peer })));
    expect(new PairingStore({ agencHome: home }).listPaired("tg").toSorted()).toEqual([...peers, "seed"].toSorted());
    expect(statSync(join(home, "gateway/pairing.json")).mode & 0o777).toBe(0o600);
  }, 30_000);

  test("does not resurrect a revoked sender beside an unrelated process approval", async () => {
    await new PairingStore({ agencHome: home }).approve("tg", "revoked");
    await runWorkers([
      { operation: "revoke", peer: "revoked", delayMs: 100 },
      { operation: "approve", peer: "unrelated", delayMs: 300 },
    ]);
    expect(new PairingStore({ agencHome: home }).listPaired("tg").toSorted()).toEqual(["seed", "unrelated"]);
  }, 30_000);

  test("shares one pending challenge across contending processes", async () => {
    const codes = await runWorkers(Array.from({ length: 8 }, (_, index) => ({ operation: "challenge", peer: "alice", code: `CODE${index}` })));
    expect(new Set(codes).size).toBe(1);
    expect(await new PairingStore({ agencHome: home }).listPending()).toEqual([expect.objectContaining({ peerId: "alice", code: codes[0] })]);
  }, 30_000);

  test("redeems a pending code only once across processes", async () => {
    await new PairingStore({ agencHome: home, generateCode: () => "ONCE" }).challenge("tg", { peerId: "alice" });
    const results = await runWorkers(Array.from({ length: 8 }, () => ({ operation: "redeem", peer: "alice", code: "ONCE" })));
    expect(results.filter(result => result === true)).toHaveLength(1);
    expect(new PairingStore({ agencHome: home }).isPaired("tg", "alice")).toBe(true);
  }, 30_000);
});
