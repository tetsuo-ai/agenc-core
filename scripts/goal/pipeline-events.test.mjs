import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPLETION_PIPELINE_GATE_IDS,
  createCompletionPipelineEvent,
  emitCompletionPipelineEvent,
  resolveCompletionPipelineEventLogPath,
  startCompletionPipelineGate,
} from "./pipeline-events.mjs";

test("resolves default and env-overridden pipeline event paths", () => {
  assert.equal(
    resolveCompletionPipelineEventLogPath({ cwd: "/repo", env: {} }),
    path.resolve("/repo/.tmp/agenc-tui-completion-pipeline/events.jsonl"),
  );
  assert.equal(
    resolveCompletionPipelineEventLogPath({
      cwd: "/repo",
      env: { AGENC_TUI_COMPLETION_PIPELINE_LOG: "state/events.jsonl" },
    }),
    path.resolve("/repo/state/events.jsonl"),
  );
});

test("creates bounded events with locked gate ordinal", () => {
  const event = createCompletionPipelineEvent({
    pipelineId: "audit",
    gateId: "typecheck",
    status: "started",
    sequence: 42,
    timestamp: "2026-05-12T00:00:00.000Z",
  });

  assert.equal(event.gateIndex, COMPLETION_PIPELINE_GATE_IDS.indexOf("typecheck"));
  assert.equal(event.sequence, 42);
});

test("emits started and succeeded gate events to JSONL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agenc-pipeline-"));
  const eventLogPath = path.join(dir, "events.jsonl");
  try {
    const gate = startCompletionPipelineGate("prep", {
      pipelineId: "audit",
      eventLogPath,
      throwOnWrite: true,
    });
    gate.succeeded("ready");

    const events = readFileSync(eventLogPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].status, "started");
    assert.equal(events[1].status, "succeeded");
    assert.equal(events[1].detail, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct event emit can fail closed for tests", () => {
  assert.throws(() =>
    emitCompletionPipelineEvent(
      createCompletionPipelineEvent({
        pipelineId: "audit",
        gateId: "prep",
        status: "started",
      }),
      { eventLogPath: "/dev/null/events.jsonl", throwOnWrite: true },
    ),
  );
});
