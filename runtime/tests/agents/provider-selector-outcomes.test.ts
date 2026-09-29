import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChildRoutingOutcomeStore } from "../../src/agents/provider-selector-outcomes.js";
import type { ChildRoutingOutcome } from "../../src/agents/provider-selector-outcomes.js";

const folders: string[] = [];
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "agenc-routing-outcomes-"));
  folders.push(folder);
  const path = join(folder, "history.json");
  return { path, store: await ChildRoutingOutcomeStore.open(path) };
}
const sample: ChildRoutingOutcome = { receiptId: "receipt-1", provider: "deepseek", model: "deepseek-v4-flash",
  taskKind: "review", complexity: "simple", terminalReason: "completed", success: true,
  latencyMs: 100, costUsd: 0.001, atMs: 10_000 };
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe("local child routing outcomes", () => {
  it("persists sanitized aggregates and deduplicates receipts across restart", async () => {
    const { path, store } = await fixture();
    expect(await store.record({ ...sample, prompt: "private task", credential: "secret" } as ChildRoutingOutcome)).toBe(true);
    const restored = await ChildRoutingOutcomeStore.open(path);
    expect(await restored.record(sample)).toBe(false);
    expect(restored.snapshot().aggregates[0]).toMatchObject({ attempts: 1, successes: 1, qualityObservations: 0,
      costTotalUsd: 0.001, latencyTotalMs: 100 });
    expect(await readFile(path, "utf8")).not.toMatch(/private task|secret|prompt|credential/u);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("learns task quality only from an independent verification signal", async () => {
    const { store } = await fixture();
    await store.record(sample);
    await store.record({ ...sample, receiptId: "verified-pass", verifiedSuccess: true });
    await store.record({ ...sample, receiptId: "verified-fail", verifiedSuccess: false });
    expect(store.snapshot().aggregates[0]).toMatchObject({ attempts: 3, successes: 3,
      qualityObservations: 2, qualitySuccesses: 1 });
  });

  it("serializes concurrent children without losing outcomes", async () => {
    const { store } = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.record({ ...sample, receiptId: `receipt-${index}` })));
    expect(results.every(Boolean)).toBe(true);
    expect(store.snapshot().aggregates[0]?.attempts).toBe(20);
  });

  it("records infrastructure failure separately from model quality and respects Retry-After", async () => {
    const { store } = await fixture();
    await store.record({ ...sample, terminalReason: "rate_limited", success: false, retryAfterMs: 120_000 });
    expect(store.snapshot().aggregates[0]).toMatchObject({ attempts: 1, qualityObservations: 0 });
    expect(store.snapshot().health[0]).toMatchObject({ cooldownUntilMs: 130_000 });
    await store.record({ ...sample, receiptId: "timeout", terminalReason: "timeout", success: false, atMs: 20_000 });
    expect(store.snapshot().health[0]?.cooldownUntilMs).toBe(130_000);
    expect(store.snapshot().aggregates[0]?.qualityObservations).toBe(0);
  });

  it("keeps a funds failure blocked until explicit clearing or a later successful request", async () => {
    const { store, path } = await fixture();
    await store.record({ ...sample, terminalReason: "insufficient_funds", success: false });
    const restored = await ChildRoutingOutcomeStore.open(path);
    expect(restored.snapshot().health[0]?.blockedReason).toBe("insufficient_funds");
    await restored.record({ ...sample, receiptId: "late-old-success", atMs: 5_000 });
    expect(restored.snapshot().health[0]?.blockedReason).toBe("insufficient_funds");
    await restored.clearProviderFailure("deepseek", 15_000);
    expect(restored.snapshot().health[0]?.blockedReason).toBeUndefined();
    await restored.record({ ...sample, receiptId: "funds-again", terminalReason: "insufficient_funds", success: false, atMs: 20_000 });
    await restored.record({ ...sample, receiptId: "success-after-funding", atMs: 30_000 });
    expect(restored.snapshot().health[0]?.blockedReason).toBeUndefined();
    await restored.record({ ...sample, receiptId: "older-funds-arrived-late", terminalReason: "insufficient_funds", success: false, atMs: 25_000 });
    expect(restored.snapshot().health[0]?.blockedReason).toBeUndefined();
  });

  it("does not mutate the store when a caller edits its snapshot", async () => {
    const { store } = await fixture();
    await store.record(sample);
    const copied = store.snapshot();
    (copied.aggregates[0] as { attempts: number }).attempts = 999;
    expect(store.snapshot().aggregates[0]?.attempts).toBe(1);
  });

  it("recovers conservatively from corrupt and overlarge local state", async () => {
    const { path } = await fixture();
    for (const text of ["{", JSON.stringify({ version: 1, aggregates: [{ attempts: -1 }], health: [], receipts: [], receiptFloorMs: 0 }),
      "x".repeat(2_000_001)]) {
      await writeFile(path, text);
      const store = await ChildRoutingOutcomeStore.open(path);
      expect(store.loadWarning).toBe("invalid_local_routing_history");
      expect(store.snapshot()).toEqual({ aggregates: [], health: [] });
    }
  });

  it("refuses invalid observations and can record a later valid one", async () => {
    const { store } = await fixture();
    await expect(store.record({ ...sample, costUsd: Number.NaN })).rejects.toThrow("Invalid child routing outcome");
    expect(await store.record(sample)).toBe(true);
  });
});
