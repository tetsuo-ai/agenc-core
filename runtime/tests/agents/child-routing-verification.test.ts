import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildRoutingOutcomeStore } from "../../src/agents/provider-selector-outcomes.js";
import { runChildRoutingFallback } from "../../src/agents/child-routing-fallback.js";
const first = { provider: "deepseek", model: "cheap", estimatedCostUsd: 0.1, estimatedLatencyMs: 1, quality: 0.8, score: 0.7, reason: "cheap" };
const second = { ...first, model: "parent", estimatedCostUsd: 0.2 };
const result = (candidate = first, toolCalls = 0) => ({ value: candidate.model, modelCalls: 1, toolCalls, costUsd: candidate.estimatedCostUsd,
  terminal: { provider: candidate.provider, model: candidate.model, reason: "completed" as const, dispatch: "sent" as const,
    completedWork: "an answer", unfinishedWork: "", retryable: false } });

describe("trusted verification and fresh attempts", () => {
  it("stops after the first pass and escalates only a failed check, including within a provider", async () => {
    const runAttempt = vi.fn(async ({ candidate }) => result(candidate));
    const check = vi.fn(async (r) => r.candidate.model === "cheap" ? "fail" as const : "pass" as const);
    const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.5,
      verification: { retrySafe: true, costUsd: 0.01, check }, runAttempt });
    expect(r.stopReason).toBe("completed"); expect(r.attempts).toHaveLength(2); expect(r.accountedCostUsd).toBeCloseTo(0.32);
    expect(runAttempt.mock.calls[1]![0].remainingCostUsd).toBeCloseTo(0.39);
    const one = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2,
      verification: { retrySafe: true, costUsd: 0, check: async () => "pass" }, runAttempt });
    expect(one.attempts).toHaveLength(1);
  });
  it("stops on missing verification, unknown accounting, cancellation, and unsafe tool effects", async () => {
    for (const mode of ["missing", "throws", "unknown", "tools", "cancelled"] as const) {
      const controller = new AbortController();
      const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.5, signal: controller.signal,
        verification: { retrySafe: false, costUsd: 0, check: async () => {
          if (mode === "throws") throw Error("unavailable"); if (mode === "cancelled") controller.abort();
          return mode === "missing" ? "unavailable" : "fail";
        } }, runAttempt: async () => mode === "unknown" ? { ...result(), costUsd: undefined } : result(first, mode === "tools" ? 1 : 0) });
      expect(r.attempts).toHaveLength(1);
      expect(r.stopReason).toBe(({missing:"verification_unavailable",throws:"verification_unavailable",unknown:"usage_unknown",tools:"tools_already_run",cancelled:"cancelled"})[mode]);
    }
  });
  it("never admits the second attempt when verifier or first-call spend exhausted the cap", async () => {
    const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.31,
      verification: { retrySafe: true, costUsd: 0.01, check: async () => "fail" }, runAttempt: async () => result() });
    expect(r.attempts).toHaveLength(1); expect(r.stopReason).toBe("cost_budget_exhausted");
  });
});
describe("independent local outcome persistence", () => {
  it("deduplicates delayed verdicts across reopen without counting completion as success or storing task text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selector-v2-outcomes-"));
    try {
      const path = join(dir, "outcomes.json"); const store = await ChildRoutingOutcomeStore.open(path);
      await store.record({ receiptId: "execution", provider: "deepseek", model: "deepseek-flash", taskKind: "coding", complexity: "simple",
        terminalReason: "completed", success: true, latencyMs: 1, atMs: 100 });
      expect(store.snapshot().abilities).toBeUndefined();
      const verdict = { receiptId: "execution", provider: "deepseek", model: "deepseek-flash",
        features: { skill: "coding" as const, difficulty: 0, discrimination: 1 }, passed: false, atMs: 101 };
      expect(await store.recordVerification(verdict)).toBe(true);
      const reopened = await ChildRoutingOutcomeStore.open(path);
      expect(await reopened.recordVerification(verdict)).toBe(false);
      expect(reopened.snapshot().abilities?.[0]?.observations).toBe(1);
      expect(reopened.snapshot().aggregates[0]?.attempts).toBe(1);
      const disk = await readFile(path, "utf8"); expect(disk).not.toContain("prompt"); expect(disk).not.toContain("completedWork");
    } finally { await rm(dir, {recursive:true,force:true}); }
  });
});
