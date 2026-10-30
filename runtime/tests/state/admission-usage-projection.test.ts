import { describe, expect, it } from "vitest";
import {
  AdmissionUsageProjection,
  type UsageReservation,
} from "../../src/state/admission-usage-snapshot.js";

function row(
  overrides: Partial<UsageReservation> & Pick<UsageReservation, "reservation_id">,
): UsageReservation {
  return {
    run_id: "parent",
    kind: "model_turn",
    model: "test",
    provider: "test",
    status: "reconciled",
    actual_input_tokens: 10,
    actual_output_tokens: 5,
    actual_tokens: 15,
    actual_cost_nanos: 250_000_000,
    reserved_cost_nanos: 500_000_000,
    resolution_reason: null,
    ...overrides,
  };
}

function capture(projection: AdmissionUsageProjection, runId = "parent", sequence = 1) {
  return projection.capture(runId, sequence).read();
}

describe("AdmissionUsageProjection", () => {
  it("adjusts only eligible timed model calls and invalidates snapshots when call time changes", () => {
    const projection = new AdmissionUsageProjection();
    const peak = row({ reservation_id: "deepseek", provider: "deepseek", dispatched_at: "2026-10-19T02:00:00Z" });
    projection.update("deepseek", peak);
    const before = projection.capture("parent", 1);
    projection.update("deepseek", { ...peak, dispatched_at: "2026-10-24T02:00:00Z" });
    expect(projection.capture("parent", 2).signature).not.toBe(before.signature);
    expect(before.read().billedEstimateUsd).toBe(0.25);
    expect(capture(projection)).toMatchObject({ billedEstimateUsd: 0.125, hasOffPeakDiscount: true });
    expect(before.read().hasOffPeakDiscount).toBeUndefined();
    for (const [id, fields] of [
      ["qwen", { provider: "qwen", model: "deepseek-v4.1-flash" }],
      ["other-qwen", { provider: "qwen", model: "qwen3.8-max" }],
      ["reported", { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" }],
      ["tool", { kind: "tool_exec", provider: "deepseek" }],
    ] as const) {
      projection.update(id, row({ reservation_id: id, dispatched_at: "2026-10-19T14:00:00Z", ...fields }));
    }
    expect(capture(projection)).toMatchObject({ costUsd: 1.25, billedEstimateUsd: 1 });
    projection.update("fallback", row({ reservation_id: "fallback", provider: "deepseek", resolution_reason: "estimated_model_price" }));
    expect(capture(projection).billedEstimateUsd).toBeUndefined();
  });

  it.each([undefined, null, "invalid"])("withholds the billed estimate for an eligible call with time %s", (dispatched_at) => {
    const projection = new AdmissionUsageProjection();
    projection.update("old", row({ reservation_id: "old", provider: "deepseek", dispatched_at }));
    expect(capture(projection)).toMatchObject({ costUsd: 0.25, hasMissingDispatchTime: true });
    expect(capture(projection).billedEstimateUsd).toBeUndefined();
  });

  it("names unresolved calls, snapshots their reasons, and removes resolved diagnostics", () => {
    const projection = new AdmissionUsageProjection();
    const unresolved = row({ reservation_id: "missing", step_id: "turn-2", status: "held_unknown", actual_cost_nanos: null,
      model: "deepseek-flash", provider: "deepseek", resolution_reason: "cancelled_after_dispatch:interrupted" });
    projection.update("missing", unresolved);
    const before = projection.capture("parent", 1);
    expect(before.read().unpricedCalls).toEqual([{
      reservationId: "missing", runId: "parent", stepId: "turn-2", kind: "model_turn", model: "deepseek-flash", provider: "deepseek",
      reason: "cancelled_after_dispatch:interrupted",
    }]);
    projection.update("missing", { ...unresolved, resolution_reason: "missing_provider_usage" });
    expect(projection.capture("parent", 2).signature).not.toBe(before.signature);
    expect(before.read().unpricedCalls?.[0]?.reason).toBe("cancelled_after_dispatch:interrupted");
    projection.update("missing", { ...unresolved, status: "reconciled", actual_cost_nanos: 25 });
    expect(capture(projection).unpricedCalls).toBeUndefined();
    expect(capture(projection).hasUnknownCost).toBe(false);
  });

  it.each([
    [
      "reserved",
      { status: "reserved" as const },
      { costUsd: 0, heldCostUsd: 0.5, inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, hasUnknownCost: false },
    ],
    [
      "dispatched",
      { status: "dispatched" as const },
      { costUsd: 0, heldCostUsd: 0.5, inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, hasUnknownCost: false },
    ],
    [
      "reconciled",
      { status: "reconciled" as const },
      { costUsd: 0.25, heldCostUsd: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1, hasUnknownCost: false },
    ],
    [
      "held_unknown",
      { status: "held_unknown" as const },
      { costUsd: 0, heldCostUsd: 0.5, inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1, hasUnknownCost: true },
    ],
    [
      "provider_overrun with a reported cost",
      { status: "provider_overrun" as const },
      { costUsd: 0.25, heldCostUsd: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1, hasUnknownCost: false },
    ],
    [
      "provider_overrun with an unknown cost",
      { status: "provider_overrun" as const, actual_cost_nanos: null },
      { costUsd: 0, heldCostUsd: 0.5, inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1, hasUnknownCost: true },
    ],
    [
      "cancelled",
      { status: "cancelled" as const },
      { costUsd: 0, heldCostUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, hasUnknownCost: false },
    ],
  ])("contributes %s rows only through the observation table", (_label, fields, totals) => {
    const projection = new AdmissionUsageProjection();
    projection.update("r1", row({ reservation_id: "r1", ...fields }));

    expect(capture(projection)).toMatchObject(totals);
    expect(capture(projection).costEstimated).toBeUndefined();
  });

  it("does not count a tool reservation as a model call or model row", () => {
    const projection = new AdmissionUsageProjection();
    projection.update("tool", row({
      reservation_id: "tool",
      kind: "tool_exec",
      actual_tokens: 0,
      actual_input_tokens: 0,
      actual_output_tokens: 0,
      actual_cost_nanos: 0,
      reserved_cost_nanos: 0,
    }));

    const observed = capture(projection);
    expect(observed.modelCalls).toBe(0);
    expect(observed.models).toEqual([]);
  });

  it("replaces a live reservation incrementally and forgets voided or deleted rows", () => {
    const projection = new AdmissionUsageProjection();
    projection.update("r1", row({ reservation_id: "r1", status: "dispatched" }));
    expect(capture(projection).heldCostUsd).toBe(0.5);

    projection.update("r1", row({ reservation_id: "r1", status: "reconciled" }));
    expect(capture(projection)).toMatchObject({ costUsd: 0.25, heldCostUsd: 0, modelCalls: 1 });
    expect(projection.size).toBe(1);

    projection.update("r1", row({ reservation_id: "r1", status: "voided" }));
    expect(projection.size).toBe(0);
    expect(capture(projection)).toMatchObject({ costUsd: 0, heldCostUsd: 0, modelCalls: 0 });

    projection.update("r2", row({ reservation_id: "r2" }));
    projection.update("r2", undefined);
    expect(projection.size).toBe(0);
    expect(capture(projection).costUsd).toBe(0);
  });

  it("marks estimated prices without treating them as unknown spend", () => {
    const projection = new AdmissionUsageProjection();
    projection.update("r1", row({ reservation_id: "r1", resolution_reason: "estimated_model_price" }));

    expect(capture(projection)).toMatchObject({
      costUsd: 0.25,
      hasUnknownCost: false,
      costEstimated: true,
    });
  });

  it("groups child agents separately and never leaks them into the parent model-call count as owners", () => {
    const projection = new AdmissionUsageProjection();
    projection.update("parent-turn", row({ reservation_id: "parent-turn" }));
    projection.update("child-turn", row({
      reservation_id: "child-turn",
      run_id: "child",
      actual_cost_nanos: 100_000_000,
      reserved_cost_nanos: 200_000_000,
      actual_input_tokens: 4,
      actual_output_tokens: 2,
      actual_tokens: 6,
    }));

    const observed = capture(projection, "parent");
    expect(observed.costUsd).toBe(0.35);
    expect(observed.modelCalls).toBe(2);
    expect(observed.agents).toEqual([
      expect.objectContaining({ runId: "child", costUsd: 0.1, modelCalls: 1, inputTokens: 4 }),
    ]);
    expect(observed.models).toEqual([
      expect.objectContaining({ model: "test", provider: "test", costUsd: 0.35, modelCalls: 2 }),
    ]);
  });

  it("orders NULL model identities before named ones, matching SQLite BINARY", () => {
    const projection = new AdmissionUsageProjection();
    projection.update("named", row({ reservation_id: "named", model: "zeta" }));
    projection.update("unknown", row({ reservation_id: "unknown", model: null, actual_cost_nanos: 100_000_000 }));

    expect(capture(projection).models.map((model) => model.model)).toEqual(["unknown", "zeta"]);
  });

  it("owns snapshot arrays so later mutations cannot change a published observation", () => {
    const projection = new AdmissionUsageProjection();
    projection.update("r1", row({ reservation_id: "r1" }));
    const snapshot = projection.capture("parent", 3);
    const first = snapshot.read();
    Object.assign(first, { inputTokens: 999 });
    if (first.models[0]) Object.assign(first.models[0], { inputTokens: 999 });

    expect(snapshot.read()).toEqual(capture(projection, "parent", 3));
    expect(snapshot.sequence).toBe(3);
  });

  it("rejects a cost total that leaves the safe nano-USD integer range", () => {
    const projection = new AdmissionUsageProjection();
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    projection.update("a", row({ reservation_id: "a", actual_cost_nanos: half }));
    projection.update("b", row({ reservation_id: "b", actual_cost_nanos: half }));

    expect(() => capture(projection)).toThrow(/safe nano-USD range/);
  });
});
