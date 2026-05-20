import { describe, expect, test } from "vitest";

import {
  COMPLETION_PIPELINE_EVENT_LOG_ENV,
  formatCompletionPipelineRows,
  gateIndexFor,
  normalizeCompletionPipelineEvent,
  readCompletionPipelineState,
  reduceCompletionPipelineEvents,
  type CompletionPipelineEvent,
} from "./completion-pipeline.js";

function pipelineEvent(
  sequence: number,
  gateId: string,
  status: CompletionPipelineEvent["status"],
  pipelineId = "current",
): CompletionPipelineEvent {
  return {
    pipelineId,
    sequence,
    gateId,
    gateIndex: gateIndexFor(gateId),
    status,
    timestamp: new Date(sequence * 1000).toISOString(),
  };
}

describe("completion pipeline wave 055 coverage", () => {
  test("normalizes persisted events and reduces only the latest pipeline", () => {
    expect(gateIndexFor("custom_gate", 42)).toBe(42);
    expect(gateIndexFor("custom_gate")).toBe(9);
    expect(normalizeCompletionPipelineEvent(null)).toBeNull();
    expect(
      normalizeCompletionPipelineEvent({
        pipelineId: " ",
        gateId: "prep",
        sequence: 1,
        status: "started",
      }),
    ).toBeNull();
    expect(
      normalizeCompletionPipelineEvent({
        pipelineId: "current",
        gateId: " ",
        sequence: 1,
        status: "started",
      }),
    ).toBeNull();
    expect(
      normalizeCompletionPipelineEvent({
        pipelineId: "current",
        gateId: "prep",
        sequence: 1.5,
        status: "started",
      }),
    ).toBeNull();
    expect(
      normalizeCompletionPipelineEvent({
        pipelineId: "current",
        gateId: "prep",
        sequence: 1,
        status: "unknown",
      }),
    ).toBeNull();

    const normalized = normalizeCompletionPipelineEvent({
      pipelineId: "current",
      sequence: 2,
      gateId: "custom_gate",
      gateIndex: 42,
      status: "failed",
      message: "  stalled\nwhile waiting  ",
      detail: ` ${"x".repeat(260)} `,
      timestamp: "not a date",
    });

    expect(normalized).toMatchObject({
      pipelineId: "current",
      sequence: 2,
      gateId: "custom_gate",
      gateIndex: 42,
      status: "failed",
      message: "stalled while waiting",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    expect(normalized?.detail).toHaveLength(240);
    expect(normalized?.detail?.endsWith("\u2026")).toBe(true);

    const env = {
      [COMPLETION_PIPELINE_EVENT_LOG_ENV]: "logs/events.jsonl",
    };
    const readPaths: string[] = [];
    const state = readCompletionPipelineState({
      env,
      cwd: "/tmp/agenc",
      readFile: (path) => {
        readPaths.push(path);
        return [
          JSON.stringify(pipelineEvent(1, "prep", "started", "stale")),
          JSON.stringify(pipelineEvent(2, "prep", "succeeded", "stale")),
          JSON.stringify(pipelineEvent(3, "prep", "started")),
          JSON.stringify(pipelineEvent(4, "typecheck", "failed")),
          JSON.stringify(pipelineEvent(5, "typecheck", "started")),
          JSON.stringify(pipelineEvent(6, "custom_gate", "succeeded")),
          JSON.stringify(pipelineEvent(7, "custom_gate", "started")),
          JSON.stringify(pipelineEvent(8, "local_merge", "completed")),
        ].join("\n");
      },
    });

    expect(readPaths).toEqual(["/tmp/agenc/logs/events.jsonl"]);
    expect(state.pipelineId).toBe("current");
    expect(state.activeGate).toBeNull();
    expect(state.ownsPrompt).toBe(false);
    expect(state.gates.map((gate) => gate.gateId)).toEqual([
      "prep",
      "typecheck",
      "local_merge",
      "custom_gate",
    ]);
    expect(state.gates.find((gate) => gate.gateId === "typecheck")).toMatchObject({
      status: "failed",
      started: true,
    });
    expect(state.gates.find((gate) => gate.gateId === "custom_gate")).toMatchObject({
      status: "succeeded",
      started: true,
    });
    expect(formatCompletionPipelineRows(state)).toEqual([
      "Completion 1/9: Prepare goal running",
      "Completion 6/9: Typecheck failed",
      "Completion 9/9: Local merge completed",
      "Completion ?/9: custom gate ok",
      "Completion pipeline complete: Completion pipeline finished",
    ]);

    expect(
      reduceCompletionPipelineEvents([
        pipelineEvent(1, "review", "started"),
        pipelineEvent(2, "review", "cancelled"),
        pipelineEvent(3, "review", "started"),
      ]).terminal,
    ).toMatchObject({
      status: "cancelled",
      detail: "Pipeline cancelled",
    });
    expect(readCompletionPipelineState({ readFile: () => { throw new Error("nope"); } })).toMatchObject({
      pipelineId: null,
      gates: [],
    });
  });
});
