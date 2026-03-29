import test from "node:test";
import assert from "node:assert/strict";

import { buildWatchInsightsReport } from "../../src/watch/agenc-watch-insights.mjs";

test("buildWatchInsightsReport summarizes local watch state and alert pressure", () => {
  const report = buildWatchInsightsReport({
    projectRoot: "/workspace/agenc-core",
    surfaceSummary: {
      overview: {
        connectionState: "live",
        modelLabel: "grok-4.20",
        providerLabel: "grok",
        usage: "1.8K total",
        lastActivityAt: "15:47:00",
        transcriptMode: "follow",
        activeAgentCount: 2,
        planCount: 4,
      },
      attention: {
        approvalAlertCount: 1,
        errorAlertCount: 2,
      },
    },
    watchState: {
      sessionId: "session-1",
      sessionLabels: new Map([["session-1", "Roadmap branch"]]),
      currentObjective: "Ship it",
      runState: "working",
      runPhase: "queued",
      runDetail: {
        availability: {
          controlAvailable: true,
        },
        checkpointAvailable: true,
      },
      lastUsageSummary: "1.8K total",
      lastActivityAt: "15:47:00",
      queuedOperatorInputs: ["later"],
      pendingAttachments: [{ id: "att-1" }],
      checkpoints: [{ id: "cp-1" }, { id: "cp-2" }],
      activeCheckpointId: "cp-2",
      events: [{ id: "evt-1" }, { id: "evt-2" }],
      plannerDagStatus: "running",
      plannerDagNote: "waiting on validation",
    },
  });

  assert.match(report, /Workspace: \/workspace\/agenc-core/);
  assert.match(report, /Session: session-1/);
  assert.match(report, /Session label: Roadmap branch/);
  assert.match(report, /Pending attachments: 1/);
  assert.match(report, /Checkpoints: 2 \(active cp-2\)/);
  assert.match(report, /Run controls: available/);
  assert.match(report, /Checkpoint retry: available/);
  assert.match(report, /Planner: running/);
  assert.match(report, /Approvals: 1/);
  assert.match(report, /Errors: 2/);
});
