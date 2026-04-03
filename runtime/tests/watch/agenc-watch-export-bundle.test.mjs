import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchExportBundle,
  writeWatchExportBundle,
} from "../../src/watch/agenc-watch-export-bundle.mjs";

test("buildWatchExportBundle captures watch state, summary, and frame snapshot", () => {
  const bundle = buildWatchExportBundle({
    projectRoot: "/workspace/agenc-core",
    exportedAtMs: 1_710_000_000_000,
    surfaceSummary: {
      overview: {
        phaseLabel: "running",
      },
    },
    frameSnapshot: {
      lines: ["one", "two"],
    },
    watchState: {
      sessionId: "session-1",
      sessionLabels: new Map([["session-1", "Roadmap branch"]]),
      currentObjective: "Ship it",
      runState: "working",
      runPhase: "queued",
      activeRunStartedAtMs: 123,
      sessionAttachedAtMs: 456,
      lastUsageSummary: "1.2K total",
      lastActivityAt: "15:30:00",
      configuredModelRoute: { provider: "grok", model: "grok-4.20" },
      liveSessionModelRoute: null,
      activeCheckpointId: "cp-2",
      pendingAttachments: [{ id: "att-1", filename: "diagram.png" }],
      checkpoints: [{ id: "cp-2", label: "Checkpoint 2" }],
      queuedOperatorInputs: ["later"],
      events: [{ id: "evt-1", title: "Prompt" }],
      plannerDagStatus: "running",
      plannerDagNote: "waiting on validation",
      plannerDagUpdatedAt: 789,
      plannerDagPipelineId: "pipe-1",
      plannerDagNodes: new Map([["node-1", { key: "node-1" }]]),
      plannerDagEdges: [{ from: "node-1", to: "node-2" }],
      subagentPlanSteps: new Map([["step-1", { id: "step-1" }]]),
      subagentLiveActivity: new Map([["sub-1", "editing README.md"]]),
      lastStatus: { state: "live" },
    },
  });

  assert.equal(bundle.workspaceRoot, "/workspace/agenc-core");
  assert.equal(bundle.session.sessionId, "session-1");
  assert.equal(bundle.session.sessionLabel, "Roadmap branch");
  assert.equal(bundle.sessionLabels["session-1"], "Roadmap branch");
  assert.equal(bundle.summary.overview.phaseLabel, "running");
  assert.equal(bundle.pendingAttachments.length, 1);
  assert.equal(bundle.checkpoints.length, 1);
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.planner.nodes.length, 1);
  assert.equal(bundle.subagents.liveActivity.length, 1);
});

test("writeWatchExportBundle writes a stable json artifact path", () => {
  const writes = [];
  const fs = {
    writeFileSync(target, contents) {
      writes.push([target, contents]);
    },
  };

  const exportPath = writeWatchExportBundle({
    fs,
    bundle: { schemaVersion: 1 },
    outputDir: "/tmp",
    nowMs: () => 4242,
    pathModule: {
      join: (...parts) => parts.join("/"),
    },
  });

  assert.equal(exportPath, "/tmp/agenc-watch-bundle-4242.json");
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /"schemaVersion": 1/);
});
