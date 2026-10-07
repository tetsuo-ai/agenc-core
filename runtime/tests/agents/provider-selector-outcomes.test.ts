import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChildRoutingOutcomeStore } from "../../src/agents/provider-selector-outcomes.js";
import type { ChildRoutingOutcome } from "../../src/agents/provider-selector-outcomes.js";
import { IRT_REVISION, abilityPrior } from "../../src/agents/provider-selector-irt.js";

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

  it("drops only a stale or damaged ability and keeps a funds block, receipts and aggregates", async () => {
    const { path, store } = await fixture();
    await store.record({ ...sample, terminalReason: "insufficient_funds", success: false });
    await store.recordVerification({ receiptId: "verified-1", provider: "openai", model: "gpt-6-luna",
      features: { skill: "coding", difficulty: -1, discrimination: 1 }, passed: true, atMs: 10_500 });
    const current = store.snapshot().abilities![0]!;
    expect(current.revision).toBe(IRT_REVISION);
    const disk = JSON.parse(await readFile(path, "utf8")) as { abilities: unknown[] };
    // An earlier IRT revision, and a row nobody could have written, beside the current one.
    disk.abilities = [{ ...abilityPrior("deepseek", "deepseek-flash", "reasoning"), revision: "child-irt-v2-2026-09-29",
      observations: 4 }, null, { ...current, mean: Number.NaN }, current];
    await writeFile(path, JSON.stringify(disk));
    const restored = await ChildRoutingOutcomeStore.open(path);
    expect(restored.loadWarning).toBeUndefined();
    expect(restored.snapshot().health[0]).toMatchObject({ provider: "deepseek", blockedReason: "insufficient_funds" });
    expect(restored.snapshot().aggregates[0]).toMatchObject({ attempts: 1, infrastructureFailures: 1 });
    expect(restored.snapshot().abilities).toEqual([current]);
    // The next write keeps the block and both receipts, and leaves the stale row behind.
    expect(await restored.record({ ...sample, receiptId: "receipt-2", provider: "openai", model: "gpt-6-luna", atMs: 11_000 })).toBe(true);
    expect(await restored.record(sample)).toBe(false);
    const rewritten = JSON.parse(await readFile(path, "utf8")) as { health: unknown[]; receipts: { id: string }[]; abilities: unknown[] };
    expect(rewritten.health).toContainEqual(expect.objectContaining({ provider: "deepseek", blockedReason: "insufficient_funds" }));
    expect(rewritten.receipts.map(item => item.id).sort()).toEqual(["receipt-1", "receipt-2", "verified:verified-1"]);
    expect(rewritten.abilities).toEqual([current]);
  });

  it("merges outcomes from two processes that share one home instead of overwriting", async () => {
    const { path } = await fixture();
    // The TUI and the daemon each hold their own store for the same file.
    const daemon = await ChildRoutingOutcomeStore.open(path);
    const tui = await ChildRoutingOutcomeStore.open(path);
    expect(await daemon.record({ ...sample, receiptId: "daemon-child" })).toBe(true);
    expect(await tui.record({ ...sample, receiptId: "tui-child", atMs: 11_000 })).toBe(true);
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? daemon : tui).record({ ...sample, receiptId: `parallel-${index}`, atMs: 12_000 + index })));
    const restored = await ChildRoutingOutcomeStore.open(path);
    expect(restored.snapshot().aggregates[0]?.attempts).toBe(12);
    // A receipt the other process already recorded is not counted twice.
    expect(await daemon.record({ ...sample, receiptId: "tui-child", atMs: 11_000 })).toBe(false);
    await daemon.refresh();
    expect(daemon.snapshot().aggregates[0]?.attempts).toBe(12);
  });

  it("removes a temporary that a crash left between write and rename", async () => {
    const { path, store } = await fixture();
    const stray = `${path}.123e4567-e89b-42d3-a456-426614174000.tmp`;
    const unrelated = `${path}.notes.tmp`;
    await writeFile(stray, "{");
    await writeFile(unrelated, "kept");
    expect(await store.record(sample)).toBe(true);
    const names = await readdir(join(path, ".."));
    expect(names).not.toContain("history.json.123e4567-e89b-42d3-a456-426614174000.tmp");
    expect(names).toContain("history.json.notes.tmp");
    expect(JSON.parse(await readFile(path, "utf8")).receipts).toHaveLength(1);
  });

  it("writes nothing to clear a provider that has no recorded failure", async () => {
    const { path, store } = await fixture();
    await store.clearProviderFailure("deepseek", 15_000);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await store.record({ ...sample, terminalReason: "rate_limited", success: false });
    await store.clearProviderFailure("deepseek", 15_000);
    expect(store.snapshot().health[0]).toMatchObject({ provider: "deepseek", cooldownUntilMs: 0, consecutiveFailures: 0 });
  });

  it("does not cool down a provider for a timeout that was not a provider failure", async () => {
    const { store } = await fixture();
    await store.record({ ...sample, terminalReason: "timeout", success: false, retryable: false });
    expect(store.snapshot().health).toEqual([]);
    expect(store.snapshot().aggregates[0]).toMatchObject({ attempts: 1, infrastructureFailures: 1 });
  });

  it("refuses invalid observations and can record a later valid one", async () => {
    const { store } = await fixture();
    await expect(store.record({ ...sample, costUsd: Number.NaN })).rejects.toThrow("Invalid child routing outcome");
    expect(await store.record(sample)).toBe(true);
  });
});
