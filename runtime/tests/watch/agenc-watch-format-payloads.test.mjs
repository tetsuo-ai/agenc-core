import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSessionSummaries,
  formatStatusPayload,
  summarizeUsage,
  summarizeRunDetail,
  statusFeedFingerprint,
} from "../../src/watch/agenc-watch-format-payloads.mjs";
import { createWatchSessionLabelMap } from "../../src/watch/agenc-watch-session-indexing.mjs";

test("statusFeedFingerprint changes when connector lifecycle status changes", () => {
  const base = {
    state: "running",
    agentName: "alpha",
    pid: 4242,
    activeSessions: 1,
    backgroundRuns: {
      activeTotal: 0,
      queuedSignalsTotal: 0,
      enabled: true,
      operatorAvailable: true,
    },
    channelStatuses: [
      {
        name: "telegram",
        configured: true,
        enabled: true,
        active: false,
        health: "unknown",
        mode: "polling",
        pendingRestart: false,
      },
    ],
  };

  const pending = {
    ...base,
    channelStatuses: [
      {
        ...base.channelStatuses[0],
        pendingRestart: true,
      },
    ],
  };

  assert.notEqual(statusFeedFingerprint(base), statusFeedFingerprint(pending));
});

test("formatStatusPayload includes connector lifecycle summary lines", () => {
  const text = formatStatusPayload({
    state: "running",
    uptimeMs: 1500,
    activeSessions: 1,
    controlPlanePort: 4100,
    pid: 4242,
    memoryUsage: {
      heapUsedMB: 10.5,
      rssMB: 33.25,
    },
    llmProvider: "grok",
    llmModel: "grok-4",
    agentName: "alpha",
    channels: ["webchat", "telegram"],
    channelStatuses: [
      {
        name: "telegram",
        configured: true,
        enabled: true,
        active: false,
        health: "unknown",
        mode: "polling",
        pendingRestart: true,
      },
    ],
  });

  assert.match(text, /connectors: telegram:configured\/polling,restart/);
});

test("formatSessionSummaries includes active marker and local session labels", () => {
  const text = formatSessionSummaries(
    [
      {
        sessionId: "session:alpha",
        label: "Server label",
        workspaceRoot: "/tmp/agenc-core",
        model: "grok-4.20",
        provider: "grok",
        messageCount: 4,
        lastActiveAt: Date.UTC(2026, 2, 29, 12, 0, 0),
      },
    ],
    {
      sessionLabels: createWatchSessionLabelMap({
        alpha: "Roadmap branch",
      }),
      activeSessionId: "alpha",
    },
  );

  assert.match(text, /session: session:alpha \[active\]/);
  assert.match(text, /local label: Roadmap branch/);
  assert.match(text, /workspace: \/tmp\/agenc-core/);
  assert.match(text, /model: grok-4\.20 via grok/);
});

test("summarizeRunDetail exposes durable run control and checkpoint retry availability", () => {
  const lines = summarizeRunDetail(
    {
      objective: "Ship it",
      state: "working",
      currentPhase: "verifying",
      explanation: "Waiting on verifier output.",
      availability: {
        controlAvailable: false,
      },
      checkpointAvailable: true,
      pendingSignals: 2,
      watchCount: 1,
    },
    {
      currentObjective: null,
      runPhase: null,
      runState: null,
    },
  );

  assert.ok(lines.some((line) => line === "run controls: unavailable"));
  assert.ok(lines.some((line) => line === "checkpoint retry: available"));
});

test("summarizeUsage renders current-view usage against the effective window", () => {
  assert.equal(
    summarizeUsage({
      promptTokens: 12_345,
      contextWindowTokens: 2_000_000,
      effectiveContextWindowTokens: 1_980_000,
      contextPercentUsed: 0.6,
      maxOutputTokens: 131_072,
    }),
    "12K current / 2M effective / 0.6% used / 131K max out",
  );
});
