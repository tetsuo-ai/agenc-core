import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  COMPLETION_PIPELINE_EVENT_LOG_ENV,
  COMPLETION_PIPELINE_EVENT_LOG_PATH,
  completionPipelineOwnsPrompt,
  formatCompletionPipelineRows,
  gateIndexFor,
  normalizeCompletionPipelineEvent,
  readCompletionPipelineEvents,
  reduceCompletionPipelineEvents,
  resolveCompletionPipelineEventLogPath,
  safeGateLabel,
  type CompletionPipelineEvent,
} from "../completion-pipeline.js";

function event(
  sequence: number,
  gateId: string,
  status: CompletionPipelineEvent["status"],
  overrides: Partial<CompletionPipelineEvent> = {},
): CompletionPipelineEvent {
  return {
    pipelineId: "row-147",
    sequence,
    gateId,
    gateIndex: gateIndexFor(gateId),
    status,
    timestamp: new Date(sequence * 1000).toISOString(),
    ...overrides,
  };
}

describe("completion pipeline coverage swarm row 147", () => {
  test("resolves default log paths and normalizes optional text fields", () => {
    expect(resolveCompletionPipelineEventLogPath({}, "/tmp/agenc")).toBe(
      resolve("/tmp/agenc", COMPLETION_PIPELINE_EVENT_LOG_PATH),
    );
    expect(
      resolveCompletionPipelineEventLogPath(
        { [COMPLETION_PIPELINE_EVENT_LOG_ENV]: "   " },
        "/tmp/agenc",
      ),
    ).toBe(resolve("/tmp/agenc", COMPLETION_PIPELINE_EVENT_LOG_PATH));

    const normalized = normalizeCompletionPipelineEvent({
      pipelineId: "row-147",
      sequence: 4,
      gateId: "branch_shape",
      status: "succeeded",
      message: "  ",
      detail: 42,
      timestamp: "2026-05-20T12:00:00.000Z",
    });

    expect(normalized).toEqual({
      pipelineId: "row-147",
      sequence: 4,
      gateId: "branch_shape",
      gateIndex: 1,
      status: "succeeded",
      timestamp: "2026-05-20T12:00:00.000Z",
    });
  });

  test("returns no events for a missing default log and parses only valid lines", () => {
    expect(
      readCompletionPipelineEvents({
        env: {},
        cwd: "/tmp/agenc-row-147-missing-log-root",
      }),
    ).toEqual([]);

    const valid = event(1, "prep", "started");
    expect(
      readCompletionPipelineEvents({
        readFile: () =>
          [
            "",
            "not json",
            JSON.stringify({ pipelineId: "row-147", gateId: "prep" }),
            JSON.stringify(valid),
          ].join("\r\n"),
      }),
    ).toEqual([valid]);
  });

  test("keeps a later active gate when an earlier gate succeeds", () => {
    const state = reduceCompletionPipelineEvents([
      event(1, "prep", "started"),
      event(2, "typecheck", "started"),
      event(3, "prep", "succeeded"),
    ]);

    expect(state.gates.find((gate) => gate.gateId === "prep")).toMatchObject({
      status: "succeeded",
      started: true,
    });
    expect(state.activeGate).toMatchObject({ gateId: "typecheck" });
    expect(completionPipelineOwnsPrompt(state)).toBe(true);
    expect(formatCompletionPipelineRows(state)).toContain(
      "Completion 6/9: Typecheck running",
    );
  });

  test("flushes multiple held terminal events after their matching start", () => {
    const state = reduceCompletionPipelineEvents([
      event(1, "typecheck", "succeeded"),
      event(2, "typecheck", "failed", { message: "compiler failed" }),
      event(3, "typecheck", "started"),
    ]);

    expect(state.gates).toHaveLength(1);
    expect(state.gates[0]).toMatchObject({
      gateId: "typecheck",
      status: "failed",
      message: "compiler failed",
      started: true,
    });
    expect(state.activeGate).toBeNull();
    expect(formatCompletionPipelineRows(state)).toEqual([
      "Completion 6/9: Typecheck failed",
      "Completion pipeline failed at Typecheck: compiler failed",
    ]);
  });

  test("sorts same-index custom gates by sequence and formats cancellation details", () => {
    const state = reduceCompletionPipelineEvents([
      event(2, "zeta_gate", "started", { gateIndex: 99 }),
      event(1, "alpha-gate", "started", { gateIndex: 99 }),
      event(3, "zeta_gate", "cancelled", {
        gateIndex: 99,
        detail: "operator stopped it",
      }),
    ]);

    expect(safeGateLabel("alpha-gate")).toBe("alpha gate");
    expect(formatCompletionPipelineRows(state)).toEqual([
      "Completion ?/9: alpha gate running",
      "Completion ?/9: zeta gate cancelled: operator stopped it",
      "Completion pipeline cancelled: operator stopped it",
    ]);
    expect(completionPipelineOwnsPrompt(state)).toBe(false);
  });
});
