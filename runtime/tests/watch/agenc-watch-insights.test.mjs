import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchInsightsReport,
  buildWatchMaintenanceReport,
} from "../../src/watch/agenc-watch-insights.mjs";

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
        syncState: "ready",
        syncLabel: "1 owned session · active attached",
        memoryState: "ready",
        memoryLabel: "2 sessions · 12 msgs",
        workspaceIndexState: "ready",
        workspaceIndexLabel: "24 files indexed",
        voiceState: "delegating",
      },
      attention: {
        approvalAlertCount: 1,
        errorAlertCount: 2,
      },
    },
    maintenanceStatus: {
      generatedAt: 1_730_000_000_000,
      sync: {
        ownerSessionCount: 1,
        activeSessionId: "session-1",
        activeSessionOwned: true,
      },
      memory: {
        backendConfigured: true,
        sessionCount: 2,
        totalMessages: 12,
        lastActiveAt: 1_730_000_010_000,
        recentSessions: [{ id: "session-1", messageCount: 7, lastActiveAt: 1_730_000_010_000 }],
      },
    },
    workspaceIndex: {
      ready: true,
      error: null,
      files: new Array(24).fill({ path: "runtime/src/index.ts" }),
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
      voiceCompanion: {
        active: true,
        companionState: "delegating",
        connectionState: "connected",
        voice: "Ara",
        mode: "vad",
        sessionId: "voice:session-1",
        managedSessionId: "session-1",
        delegationStatus: "started",
        currentTask: "Open the release dashboard",
        lastUserTranscript: "Open the release dashboard",
        lastAssistantTranscript: "Working on it.",
        lastError: null,
      },
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
  assert.match(report, /Voice Companion/);
  assert.match(report, /State: delegating/);
  assert.match(report, /Persona: Ara/);
  assert.match(report, /Current task: Open the release dashboard/);
  assert.match(report, /Planner: running/);
  assert.match(report, /Approvals: 1/);
  assert.match(report, /Errors: 2/);
  assert.match(report, /Maintenance/);
  assert.match(report, /Sync: ready/);
  assert.match(report, /Memory sessions\/messages: 2 \/ 12/);
  assert.match(report, /Index: ready/);
});

test("buildWatchMaintenanceReport renders sync, memory, and index details", () => {
  const report = buildWatchMaintenanceReport({
    projectRoot: "/workspace/agenc-core",
    surfaceSummary: {
      overview: {
        syncState: "limited",
        syncLabel: "2 owned sessions · no active session",
        durableRunsState: "disabled",
        durableRunsLabel: "durable background runs disabled",
        memoryState: "disabled",
        memoryLabel: "memory backend not configured",
        workspaceIndexState: "ready",
        workspaceIndexLabel: "42 files indexed",
      },
    },
    maintenanceStatus: {
      generatedAt: 1_730_000_000_000,
      sync: {
        ownerSessionCount: 2,
        activeSessionOwned: false,
      },
      memory: {
        backendConfigured: false,
        sessionCount: 0,
        totalMessages: 0,
        lastActiveAt: 0,
        recentSessions: [],
      },
    },
    workspaceIndex: {
      ready: true,
      error: null,
      files: new Array(42).fill({ path: "runtime/src/index.ts" }),
    },
    watchState: {
      sessionId: "session-2",
      sessionLabels: new Map([["session-2", "Infra"]]),
    },
  });

  assert.match(report, /Watch Maintenance/);
  assert.match(report, /Session label: Infra/);
  assert.match(report, /Sync: limited/);
  assert.match(report, /Durable: disabled/);
  assert.match(report, /Memory: disabled/);
  assert.match(report, /Index files: 42/);
});
