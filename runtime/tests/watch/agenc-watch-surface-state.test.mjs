import test from "node:test";
import assert from "node:assert/strict";

import { createWatchSurfaceStateController } from "../../src/watch/agenc-watch-surface-state.mjs";

function createSurfaceStateHarness(overrides = {}) {
  return createWatchSurfaceStateController({
    watchState: {
      liveSessionModelRoute: null,
      configuredModelRoute: null,
      sessionAttachedAtMs: 0,
      currentObjective: "",
      runDetail: null,
      latestTool: null,
      latestToolState: null,
      lastUsageSummary: null,
      subagentLiveActivity: new Map(),
      runPhase: "idle",
      runState: "idle",
      expandedEventId: null,
      transcriptScrollOffset: 0,
      plannerDagStatus: "idle",
      plannerDagNote: null,
      sessionId: "session:test",
      lastActivityAt: "idle",
      maintenanceSnapshot: null,
      voiceCompanion: null,
      ...overrides.watchState,
    },
    transportState: { connectionState: "live" },
    events: [],
    queuedOperatorInputs: [],
    pendingAttachments: [],
    subagentPlanSteps: new Map(),
    nowMs: () => 1_000,
    activityPulseIntervalMs: 1_000,
    formatElapsedMs: () => "0m 01s",
    sanitizeInlineText(value) {
      return String(value ?? "").trim();
    },
    planStepDisplayName(step) {
      return step?.stepName ?? "";
    },
    buildSurfaceSummaryCacheKey() {
      return "surface-summary-key";
    },
    buildWatchSurfaceSummary() {
      return {};
    },
    isTranscriptFollowing() {
      return true;
    },
    normalizeModelRouteImpl(input) {
      return input;
    },
    modelRouteToneImpl() {
      return "teal";
    },
    resolveSessionLabel() {
      return null;
    },
    workspaceIndex: null,
  });
}

test("createWatchSurfaceStateController prefers the newest configured model route over a stale live route", () => {
  const controller = createSurfaceStateHarness({
    watchState: {
      liveSessionModelRoute: {
        provider: "grok",
        model: "grok-4.20",
        updatedAt: 100,
      },
      configuredModelRoute: {
        provider: "openai",
        model: "gpt-4.1",
        updatedAt: 200,
      },
    },
  });

  assert.deepEqual(controller.effectiveModelRoute(), {
    provider: "openai",
    model: "gpt-4.1",
    updatedAt: 200,
  });
});

test("createWatchSurfaceStateController keeps the live model route when it is newer than the configured route", () => {
  const controller = createSurfaceStateHarness({
    watchState: {
      liveSessionModelRoute: {
        provider: "openai",
        model: "gpt-4.1",
        updatedAt: 300,
      },
      configuredModelRoute: {
        provider: "grok",
        model: "grok-4.20",
        updatedAt: 200,
      },
    },
  });

  assert.deepEqual(controller.effectiveModelRoute(), {
    provider: "openai",
    model: "gpt-4.1",
    updatedAt: 300,
  });
});
