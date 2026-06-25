import { describe, expect, test } from "vitest";
import {
  ToolLatencyStore,
  DEFAULT_TOOL_LATENCY_CONFIG,
  type ToolLatencyConfig,
} from "./tool-latency-store.js";

// Reach the private per-tool stat for the ring/EWMA white-box assertions.
interface StatLike {
  count: number;
  total: number;
  ewmaMean: number;
  ewmaDev: number;
  seeded: boolean;
}
function perToolStat(
  store: ToolLatencyStore,
  name: string,
): StatLike | undefined {
  return (
    store as unknown as { perTool: Map<string, StatLike> }
  ).perTool.get(name);
}
function globalStat(store: ToolLatencyStore): StatLike {
  return (store as unknown as { global: StatLike }).global;
}

function seed(store: ToolLatencyStore, name: string, ms: number, n: number) {
  for (let i = 0; i < n; i += 1) store.record(name, ms);
}

describe("ToolLatencyStore (Goal #4a)", () => {
  // (1) Cold start → null. < K per-tool AND < K global → null.
  // REVERT: removing the `total >= minSamples` gate (return estimate
  // unconditionally) would return a non-null value here → red.
  test("cold start: < K samples per-tool and global → estimateLatencyMs is null", () => {
    const store = new ToolLatencyStore();
    seed(store, "Read", 50, 99); // 99 per-tool, 99 global — both < 100
    expect(store.estimateLatencyMs("Read")).toBeNull();
    expect(store.estimateLatencyMs("Unseen")).toBeNull();
  });

  // (2) K boundary — exact `>= K`. 99 → null, the 100th → non-null.
  // REVERT: `>` instead of `>=` would keep null at 100 → red.
  test("K boundary: 99 → null, 100 → non-null (>= not >)", () => {
    const store = new ToolLatencyStore();
    seed(store, "Read", 50, 99);
    expect(store.estimateLatencyMs("Read")).toBeNull();
    store.record("Read", 50); // 100th
    expect(store.estimateLatencyMs("Read")).not.toBeNull();
  });

  // (3) Per-tool p99 picks the tail, not the mean.
  test("per-tool >= K: estimate ≈ p99 picks the slow tail, not the mean", () => {
    const store = new ToolLatencyStore();
    seed(store, "T", 100, 990); // 990 fast
    seed(store, "T", 5000, 10); // 10 slow → top 1%
    const est = store.estimateLatencyMs("T");
    expect(est).not.toBeNull();
    // p99 over a 512-ring window dominated by recent slow samples sits near the
    // tail, far above the 100ms body and well above the arithmetic mean.
    expect(est!).toBeGreaterThan(1000);
  });

  // (4) Global fallback: a thin tool (< K) uses the pooled global estimate.
  // REVERT: dropping the global tier (return null when per-tool < K) → red.
  test("global fallback: thin per-tool tool uses the pooled global estimate", () => {
    const store = new ToolLatencyStore();
    // 100 pooled samples across OTHER tools → global >= K.
    seed(store, "other", 200, 100);
    // Tool A has only 10 samples (< K), so its own per-tool tier is not eligible.
    seed(store, "A", 250, 10);
    const est = store.estimateLatencyMs("A");
    expect(est).not.toBeNull();
    // The thin tool resolves to the GLOBAL pooled estimate — IDENTICAL to what
    // an entirely unseen name (which can only use the global tier) resolves to.
    const globalEst = store.estimateLatencyMs("definitely-unseen-name");
    expect(globalEst).not.toBeNull();
    expect(est).toBe(globalEst);
  });

  // (5) Ring eviction / memory bound: count never exceeds ringCap; p99 reflects
  // only the recent window after the old huge samples age out.
  test("ring eviction: count bounded by ringCap; p99 tracks the recent window", () => {
    const cfg: Partial<ToolLatencyConfig> = { ringCap: 64, minSamples: 10 };
    const store = new ToolLatencyStore(cfg);
    seed(store, "T", 100_000, 64); // fill the ring with huge old samples
    seed(store, "T", 50, 64 + 200); // overwrite entirely with tiny recent ones
    const stat = perToolStat(store, "T")!;
    expect(stat.count).toBe(64); // never exceeds ringCap
    expect(stat.total).toBeGreaterThan(64); // lifetime total keeps climbing
    const est = store.estimateLatencyMs("T");
    expect(est).not.toBeNull();
    // The old 100_000ms samples have all been evicted; p99 reflects the tiny
    // recent window (EWMA may add headroom but the percentile is small).
    const pctOnly = (
      store as unknown as {
        percentileOf: (s: StatLike, p: number) => number;
      }
    ).percentileOf(stat, 0.99);
    expect(pctOnly).toBeLessThan(1000);
  });

  // (6) EWMA tail dominance via `max`: a variance burst pushes ewma+kσ above
  // p99, so the EWMA term is the chosen estimate.
  // REVERT: replacing `max(pct, ewma)` with percentile-only → red.
  test("EWMA tail dominance: max() selects ewma+kσ over p99 on a variance burst", () => {
    const store = new ToolLatencyStore({ minSamples: 10, ringCap: 512 });
    // Steady body, then ONE recent giant spike. The ring p99 (1/512 ≈ 0.2%
    // of the window) does NOT capture a single outlier at the 99th pct, but
    // the EWMA deviation absorbs the spike and ewma+4σ jumps.
    seed(store, "T", 100, 500);
    store.record("T", 100_000); // single recent spike
    const stat = perToolStat(store, "T")!;
    const pct = (
      store as unknown as {
        percentileOf: (s: StatLike, p: number) => number;
      }
    ).percentileOf(stat, 0.99);
    const ewma = stat.ewmaMean + DEFAULT_TOOL_LATENCY_CONFIG.kSigma * stat.ewmaDev;
    expect(ewma).toBeGreaterThan(pct); // EWMA term wins
    expect(store.estimateLatencyMs("T")).toBe(Math.max(pct, ewma));
  });

  // (7) RFC 6298 EWMA order: deviation measured against the PRE-update mean.
  // REVERT: swapping the two update lines (mean before dev) → red.
  test("RFC 6298 order: ewmaDev uses the pre-update mean", () => {
    const a = DEFAULT_TOOL_LATENCY_CONFIG.ewmaAlpha; // 0.125
    const b = DEFAULT_TOOL_LATENCY_CONFIG.ewmaBeta; // 0.25
    const store = new ToolLatencyStore();
    // First sample seeds: mean = r0, dev = r0/2.
    const r0 = 100;
    const r1 = 300;
    store.record("T", r0);
    store.record("T", r1);
    const stat = perToolStat(store, "T")!;
    // After r0 seed: mean0 = 100, dev0 = 50.
    // r1 update (RFC 6298 ORDER — dev against PRE-update mean):
    //   dev1  = (1-b)*dev0 + b*|r1 - mean0|
    //   mean1 = (1-a)*mean0 + a*r1
    const expectedDev = (1 - b) * (r0 / 2) + b * Math.abs(r1 - r0);
    const expectedMean = (1 - a) * r0 + a * r1;
    expect(stat.ewmaDev).toBeCloseTo(expectedDev, 6);
    expect(stat.ewmaMean).toBeCloseTo(expectedMean, 6);
    // Sanity: if the order were swapped, dev would be computed against mean1,
    // i.e. (1-b)*dev0 + b*|r1-mean1| = 0.75*50 + 0.25*|300-125| = 81.25,
    // distinct from the correct 0.75*50 + 0.25*200 = 87.5.
    const swappedDev = (1 - b) * (r0 / 2) + b * Math.abs(r1 - expectedMean);
    expect(swappedDev).not.toBeCloseTo(expectedDev, 6);
  });

  // Hardening: negative / non-finite samples are ignored (never poison the ring).
  test("invalid samples (NaN / negative / Infinity) are dropped", () => {
    const store = new ToolLatencyStore({ minSamples: 5 });
    store.record("T", Number.NaN);
    store.record("T", -1);
    store.record("T", Number.POSITIVE_INFINITY);
    expect(perToolStat(store, "T")).toBeUndefined(); // never created a stat
    expect(globalStat(store).total).toBe(0);
  });
});
