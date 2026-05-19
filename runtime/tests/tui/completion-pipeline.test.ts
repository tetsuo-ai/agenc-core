import { describe, expect, test } from "vitest";

import {
  completionPipelineOwnsPrompt,
  formatCompletionPipelineRows,
  readCompletionPipelineEvents,
  reduceCompletionPipelineEvents,
  safeGateLabel,
  type CompletionPipelineEvent,
} from "./completion-pipeline.js";

function event(
  sequence: number,
  gateId: string,
  status: CompletionPipelineEvent["status"],
  detail?: string,
): CompletionPipelineEvent {
  const gateIndex =
    [
      "prep",
      "branch_shape",
      "branding",
      "shape_evidence",
      "item_specific",
      "typecheck",
      "tui_validate",
      "review",
      "local_merge",
    ].indexOf(gateId);
  return {
    pipelineId: "audit",
    sequence,
    gateId,
    gateIndex,
    status,
    ...(detail ? { detail } : {}),
    timestamp: new Date(sequence * 1000).toISOString(),
  };
}

describe("completion pipeline event reduction", () => {
  test("missing or malformed persisted events render nothing", () => {
    expect(readCompletionPipelineEvents({ readFile: () => "" })).toEqual([]);
    expect(
      readCompletionPipelineEvents({
        readFile: () => '{"bad":true}\nnot json\n',
      }),
    ).toEqual([]);
    expect(reduceCompletionPipelineEvents([]).pipelineId).toBeNull();
  });

  test("prep start renders the first gate as active and owns prompt input", () => {
    const state = reduceCompletionPipelineEvents([event(1, "prep", "started")]);

    expect(state.activeGate?.gateId).toBe("prep");
    expect(completionPipelineOwnsPrompt(state)).toBe(true);
    expect(formatCompletionPipelineRows(state)).toContain(
      "Completion 1/9: Prepare goal running",
    );
  });

  test("success before start waits until the matching start exists", () => {
    const state = reduceCompletionPipelineEvents([
      event(2, "branding", "succeeded"),
      event(1, "branding", "started"),
    ]);

    expect(state.gates[0]?.status).toBe("succeeded");
    expect(state.activeGate).toBeNull();
    expect(completionPipelineOwnsPrompt(state)).toBe(false);
  });

  test("duplicate sequence events are deduped by pipeline and sequence", () => {
    const state = reduceCompletionPipelineEvents([
      event(1, "prep", "started"),
      event(1, "prep", "started"),
      event(2, "prep", "succeeded"),
    ]);

    expect(state.gates).toHaveLength(1);
    expect(state.gates[0]?.status).toBe("succeeded");
  });

  test("failure and cancellation clear prompt ownership and preserve detail", () => {
    const failed = reduceCompletionPipelineEvents([
      event(1, "typecheck", "started"),
      event(2, "typecheck", "failed", "2 errors"),
    ]);
    expect(completionPipelineOwnsPrompt(failed)).toBe(false);
    expect(formatCompletionPipelineRows(failed).join("\n")).toContain(
      "Completion pipeline failed at Typecheck: 2 errors",
    );

    const cancelled = reduceCompletionPipelineEvents([
      event(3, "review", "started"),
      event(4, "review", "cancelled"),
    ]);
    expect(completionPipelineOwnsPrompt(cancelled)).toBe(false);
    expect(formatCompletionPipelineRows(cancelled).join("\n")).toContain(
      "Completion pipeline cancelled",
    );
  });

  test("completed terminal state keeps audit summary but releases input", () => {
    const state = reduceCompletionPipelineEvents([
      event(1, "prep", "started"),
      event(2, "prep", "succeeded"),
      event(99, "local_merge", "completed", "merged locally"),
    ]);

    expect(completionPipelineOwnsPrompt(state)).toBe(false);
    expect(formatCompletionPipelineRows(state).at(-1)).toBe(
      "Completion pipeline complete: merged locally",
    );
  });

  test("safe labels handle unrecognized gate ids", () => {
    expect(safeGateLabel("custom_gate")).toBe("custom gate");
  });
});
