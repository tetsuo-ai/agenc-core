import { describe, expect, it, vi } from "vitest";
import { runChildRoutingFallback, type ChildRoutingAttemptContext, type ChildRoutingAttemptResult } from "../../src/agents/child-routing-fallback.js";
import type { ChildTerminalReason } from "../../src/agents/child-terminal.js";
import type { RankedChildCandidate } from "../../src/agents/provider-selector-types.js";

function candidate(provider: string, model = "model", estimatedCostUsd: number | undefined = 0.1): RankedChildCandidate {
  return { provider, model, ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    estimatedLatencyMs: 100, quality: 0.9, score: 1, reason: `${provider} fits the task.` };
}

function outcome(context: ChildRoutingAttemptContext<string>, reason: ChildTerminalReason,
  extra: Partial<ChildRoutingAttemptResult<string>> = {}): ChildRoutingAttemptResult<string> {
  return { value: context.candidate.provider, terminal: {
    provider: context.candidate.provider, model: context.candidate.model, reason,
    retryable: reason === "provider_unavailable" || reason === "rate_limited" || reason === "timeout",
    dispatch: "sent", completedWork: "", unfinishedWork: reason === "completed" ? "" : "task",
  }, modelCalls: 1, toolCalls: 0, costUsd: 0.01, ...extra };
}

describe("bounded fresh child fallback", () => {
  it.each(["rate_limited", "insufficient_funds", "provider_unavailable", "timeout"] as const)(
    "uses a fresh provider after %s with no child tools", async (reason) => {
      const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) =>
        outcome(context, context.attempt === 1 ? reason : "completed"));
      const result = await runChildRoutingFallback({
        candidates: [candidate("deepseek"), candidate("deepseek", "other-model"), candidate("openai")],
        maxModelCalls: 5, maxCostUsd: 1, runAttempt,
      });
      expect(result.stopReason).toBe("completed");
      expect(result.value).toBe("openai");
      expect(result.modelCalls).toBe(2);
      expect(result.accountedCostUsd).toBeCloseTo(0.02);
      expect(runAttempt.mock.calls.map(([context]) => context.candidate.provider)).toEqual(["deepseek", "openai"]);
      expect(runAttempt.mock.calls[1]![0]).toMatchObject({ attempt: 2, remainingModelCalls: 4, remainingCostUsd: 0.99 });
      expect(runAttempt.mock.calls[1]![0].previousAttempts[0]?.terminal.reason).toBe(reason);
    },
  );

  it.each(["completed", "step_limit", "parent_cancelled", "policy_revoked", "consent_denied",
    "consent_unavailable", "auth_required", "effect_outcome_unknown", "context_insufficient",
    "cost_cap_reached", "resume_blocked", "tool_protocol_unreliable", "model_refused"] as const)(
    "does not fall back on %s", async (reason) => {
      const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context, reason));
      const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, runAttempt });
      expect(runAttempt).toHaveBeenCalledOnce();
      expect(result.stopReason).toBe(reason === "completed" ? "completed" : "terminal_outcome");
    },
  );

  it("never replays a child that dispatched even one tool", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context, "timeout", { toolCalls: 1 }));
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, runAttempt });
    expect(result.stopReason).toBe("tools_already_run");
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("counts all used model calls across attempts", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context, "rate_limited", { modelCalls: 2 }));
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b"), candidate("c")], maxModelCalls: 3, runAttempt });
    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(runAttempt.mock.calls[1]![0].remainingModelCalls).toBe(1);
    expect(result.stopReason).toBe("model_call_budget_exhausted");
    expect(result.modelCalls).toBe(4);
  });

  it("subtracts both spend and unknown holds before selecting the next candidate", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context,
      context.attempt === 1 ? "timeout" : "completed", context.attempt === 1
        ? { costUsd: 0.2, heldUnknownCostUsd: 0.5 } : { costUsd: 0.1 }));
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b", "model", 0.5), candidate("c", "model", 0.2)],
      maxModelCalls: 5, maxCostUsd: 1, runAttempt });
    expect(runAttempt.mock.calls[1]![0].candidate.provider).toBe("c");
    expect(runAttempt.mock.calls[1]![0].remainingCostUsd).toBeCloseTo(0.3);
    expect(result.accountedCostUsd).toBeCloseTo(0.8);
  });

  it("stops when no remaining candidate fits the unspent task budget", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context, "timeout", { costUsd: 0.2, heldUnknownCostUsd: 0.7 }));
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b", "model", 0.2)], maxModelCalls: 5, maxCostUsd: 1, runAttempt });
    expect(result.stopReason).toBe("cost_budget_exhausted");
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("refuses unknown prices under a hard task budget before executing", async () => {
    const unpriced = candidate("a");
    const { estimatedCostUsd: _price, ...withoutPrice } = unpriced;
    const runAttempt = vi.fn();
    const result = await runChildRoutingFallback({ candidates: [withoutPrice], maxModelCalls: 5, maxCostUsd: 1, runAttempt });
    expect(result.stopReason).toBe("cost_budget_exhausted");
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it("does not reuse budget when sent usage has no cost or reservation evidence", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context, "timeout", { costUsd: undefined }));
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, runAttempt });
    expect(result.stopReason).toBe("usage_unknown");
    expect(result.accountedCostUsd).toBeUndefined();
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("bounds unpriced pre-dispatch failures to three distinct provider attempts", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => {
      const result = outcome(context, "provider_unavailable", { modelCalls: 0, costUsd: undefined });
      return { ...result, terminal: { ...result.terminal, dispatch: "not_sent" as const } };
    });
    const result = await runChildRoutingFallback({ candidates: ["a", "b", "c", "d"].map((provider) => candidate(provider)), maxModelCalls: 5, runAttempt });
    expect(result.stopReason).toBe("attempt_limit");
    expect(result.modelCalls).toBe(0);
    expect(result.accountedCostUsd).toBe(0);
    expect(runAttempt).toHaveBeenCalledTimes(3);
  });

  it.each(["before", "during"] as const)("does not fall back after cancellation %s the attempt", async (when) => {
    const controller = new AbortController();
    if (when === "before") controller.abort();
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => {
      controller.abort();
      return outcome(context, "timeout");
    });
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, signal: controller.signal, runAttempt });
    expect(result.stopReason).toBe("cancelled");
    expect(runAttempt).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  });

  it("propagates an unattested callback failure without retrying", async () => {
    const runAttempt = vi.fn(async () => { throw new Error("result lost after effects"); });
    await expect(runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, runAttempt }))
      .rejects.toThrow("result lost after effects");
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it.each([
    { modelCalls: -1 }, { modelCalls: 0 }, { modelCalls: NaN }, { toolCalls: -1 },
    { costUsd: -1 }, { costUsd: NaN }, { heldUnknownCostUsd: Infinity },
  ])("refuses invalid attempt accounting %j", async (extra) => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => outcome(context, "timeout", extra));
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, runAttempt });
    expect(result.stopReason).toBe("invalid_usage");
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("refuses accounting for a destination other than the selected candidate", async () => {
    const runAttempt = vi.fn(async (context: ChildRoutingAttemptContext<string>) => {
      const result = outcome(context, "timeout");
      return { ...result, terminal: { ...result.terminal, provider: "unexpected" } };
    });
    const result = await runChildRoutingFallback({ candidates: [candidate("a"), candidate("b")], maxModelCalls: 5, runAttempt });
    expect(result.stopReason).toBe("invalid_usage");
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it.each([{ maxAttempts: 4 }, { maxModelCalls: -1 }, { maxCostUsd: Infinity }])(
    "refuses invalid fallback bounds %j", async (bounds) => {
      const runAttempt = vi.fn();
      await expect(runChildRoutingFallback({ candidates: [candidate("a")], maxModelCalls: 5, ...bounds, runAttempt })).rejects.toThrow(RangeError);
      expect(runAttempt).not.toHaveBeenCalled();
    },
  );
});
