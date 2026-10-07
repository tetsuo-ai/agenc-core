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
      verification: { retrySafe: true, costUsd: 0.01, escalate: true, check }, runAttempt });
    expect(r.stopReason).toBe("completed"); expect(r.attempts).toHaveLength(2); expect(r.accountedCostUsd).toBeCloseTo(0.32);
    expect(r.attempts.map(attempt => attempt.verdict)).toEqual(["fail", "pass"]);
    expect(runAttempt.mock.calls[1]![0].remainingCostUsd).toBeCloseTo(0.39);
    const one = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2,
      verification: { retrySafe: true, costUsd: 0, escalate: true, check: async () => "pass" }, runAttempt });
    expect(one.attempts).toHaveLength(1);
  });
  it("stops on missing verification, unknown accounting, cancellation, and unsafe tool effects", async () => {
    for (const mode of ["missing", "throws", "unknown", "tools", "cancelled"] as const) {
      const controller = new AbortController();
      const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.5, signal: controller.signal,
        verification: { retrySafe: false, costUsd: 0, escalate: true, check: async () => {
          if (mode === "throws") throw Error("unavailable"); if (mode === "cancelled") controller.abort();
          return mode === "missing" ? "unavailable" : "fail";
        } }, runAttempt: async () => mode === "unknown" ? { ...result(), costUsd: undefined } : result(first, mode === "tools" ? 1 : 0) });
      expect(r.attempts).toHaveLength(1);
      expect(r.stopReason).toBe(({missing:"verification_unavailable",throws:"verification_unavailable",unknown:"usage_unknown",tools:"tools_already_run",cancelled:"cancelled"})[mode]);
    }
  });
  it("never admits the second attempt when verifier or first-call spend exhausted the cap", async () => {
    const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.31,
      verification: { retrySafe: true, costUsd: 0.01, escalate: true, check: async () => "fail" }, runAttempt: async () => result() });
    expect(r.attempts).toHaveLength(1); expect(r.stopReason).toBe("cost_budget_exhausted");
  });
  it("checks an attempt whose usage is unknown or held when no cap needs the number", async () => {
    for (const usage of [{ costUsd: undefined }, { costUsd: undefined, heldUnknownCostUsd: 0.04 }]) {
      const check = vi.fn(async () => "pass" as const);
      const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2,
        verification: { retrySafe: true, costUsd: 0, escalate: true, check }, runAttempt: async () => ({ ...result(), ...usage }) });
      expect(check).toHaveBeenCalledOnce();
      expect(r).toMatchObject({ stopReason: "completed", attempts: [{ verdict: "pass" }] });
    }
    // A failed check is reported as failed; unknown spend still blocks a further paid attempt.
    const failed = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2,
      verification: { retrySafe: true, costUsd: 0, escalate: true, check: async () => "fail" },
      runAttempt: async () => ({ ...result(), costUsd: undefined }) });
    expect(failed).toMatchObject({ stopReason: "usage_unknown", attempts: [{ verdict: "fail" }] });
    // Held usage is a known upper bound, so a cap can still admit the check.
    const held = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.5,
      verification: { retrySafe: true, costUsd: 0, escalate: true, check: async () => "pass" },
      runAttempt: async () => ({ ...result(), costUsd: undefined, heldUnknownCostUsd: 0.04 }) });
    expect(held).toMatchObject({ stopReason: "completed", attempts: [{ verdict: "pass" }], accountedCostUsd: 0.04 });
  });
  it("retries a provider failure but not a failed check outside a planned cascade", async () => {
    const other = { ...second, provider: "openai", model: "other" };
    const check = vi.fn(async () => "fail" as const);
    const failedCheck = await runChildRoutingFallback({ candidates: [first, other], maxModelCalls: 4,
      verification: { retrySafe: true, costUsd: 0, escalate: false, check }, runAttempt: async ({ candidate }) => result(candidate) });
    expect(failedCheck).toMatchObject({ stopReason: "verification_failed", attempts: [{ verdict: "fail" }] });
    const runAttempt = vi.fn(async ({ candidate }: { candidate: typeof first }) => candidate === first
      ? { ...result(first), terminal: { ...result(first).terminal, reason: "rate_limited" as const, retryable: true } }
      : result(candidate));
    const pass = vi.fn(async () => "pass" as const);
    const fellBack = await runChildRoutingFallback({ candidates: [first, other], maxModelCalls: 4,
      verification: { retrySafe: true, costUsd: 0, escalate: false, check: pass }, runAttempt });
    expect(fellBack.stopReason).toBe("completed");
    expect(fellBack.attempts.map(attempt => [attempt.candidate.provider, attempt.verdict])).toEqual([["deepseek", undefined], ["openai", "pass"]]);
    expect(pass).toHaveBeenCalledOnce();
  });
  it("observes a started first attempt even when its check could not fit, and runs no check", async () => {
    const check = vi.fn(async () => "pass" as const);
    const runAttempt = vi.fn(async ({ candidate }: { candidate: typeof first }) => result(candidate));
    // 0.1 for the attempt plus 0.05 for its check does not fit 0.12.
    const r = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.12,
      firstAttemptStarted: true, verification: { retrySafe: true, costUsd: 0.05, escalate: true, check }, runAttempt });
    expect(runAttempt).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
    expect(r.stopReason).toBe("verification_over_budget");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.verdict).toBeUndefined();
    // Without the started flag the runner would not have run it at all.
    const refused = await runChildRoutingFallback({ candidates: [first, second], maxModelCalls: 2, maxCostUsd: 0.12,
      verification: { retrySafe: true, costUsd: 0.05, escalate: true, check }, runAttempt: vi.fn() });
    expect(refused).toMatchObject({ stopReason: "cost_budget_exhausted", attempts: [] });
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
