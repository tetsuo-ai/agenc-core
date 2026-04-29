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
      cockpit: {
        repo: { branch: "feature/test", changedFiles: ["/workspace/agenc-core/src/index.ts"] },
        approvals: { count: 1, entries: [{ requestId: "req-1", toolName: "system.applyPatch" }] },
      },
      plannerDagStatus: "running",
      plannerDagNote: "waiting on validation",
      plannerDagUpdatedAt: 789,
      plannerDagPipelineId: "pipe-1",
      plannerDagNodes: new Map([["node-1", { key: "node-1" }]]),
      plannerDagEdges: [{ from: "node-1", to: "node-2" }],
      subagentPlanSteps: new Map([["step-1", { id: "step-1" }]]),
      subagentLiveActivity: new Map([["sub-1", "editing README.md"]]),
      lastStatus: { state: "live" },
      noPhoneHome: true,
      featureFlags: { remoteTools: false },
      unsupportedExternalSurfaces: [
        { name: "Browser", reason: "unsupported by watch console" },
      ],
    },
  });

  assert.equal(bundle.workspaceRoot, "/workspace/agenc-core");
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.session.sessionId, "session-1");
  assert.equal(bundle.session.sessionLabel, "Roadmap branch");
  assert.equal(bundle.sessionLabels["session-1"], "Roadmap branch");
  assert.equal(bundle.summary.overview.phaseLabel, "running");
  assert.equal(bundle.pendingAttachments.length, 1);
  assert.equal(bundle.checkpoints.length, 1);
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.cockpit.repo.changedFiles[0], "src/index.ts");
  assert.equal(bundle.planner.nodes.length, 1);
  assert.equal(bundle.subagents.liveActivity.length, 1);
  assert.equal(bundle.metadata.application, "AgenC watch");
  assert.equal(bundle.metadata.renderer.branding, "AgenC");
  assert.equal(bundle.metadata.search.visibleTextOnly, true);
  assert.ok(bundle.metadata.search.indexedToolInputFields.includes("command"));
  assert.equal(bundle.metadata.dump.eventLimit, 200);
  assert.equal(bundle.metadata.externalSurfaces.noPhoneHome, true);
  assert.deepEqual(
    bundle.metadata.externalSurfaces.unsupported[0],
    { name: "Browser", reason: "unsupported by watch console" },
  );
  assert.ok(
    bundle.metadata.externalSurfaces.disabled.some(
      (entry) => entry.name === "WebSearch" && entry.reason === "no-phone-home mode",
    ),
  );
  assert.ok(
    bundle.metadata.externalSurfaces.disabled.some(
      (entry) => entry.name === "Remote tools" && entry.reason === "feature flag disabled",
    ),
  );
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
    bundle: { schemaVersion: 2 },
    outputDir: "/tmp",
    nowMs: () => 4242,
    pathModule: {
      join: (...parts) => parts.join("/"),
    },
  });

  assert.equal(exportPath, "/tmp/agenc-watch-bundle-4242.json");
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /"schemaVersion": 2/);
});
