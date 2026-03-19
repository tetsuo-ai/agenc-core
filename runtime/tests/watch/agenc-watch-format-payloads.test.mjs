import test from "node:test";
import assert from "node:assert/strict";

import {
  formatStatusPayload,
  statusFeedFingerprint,
} from "../../src/watch/agenc-watch-format-payloads.mjs";

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
