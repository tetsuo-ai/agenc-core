import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSurfaceSummaryCacheKey,
  latestSessionSummary,
  resolveWatchMouseTrackingEnabled,
} from "../../src/watch/agenc-watch-app.mjs";
import {
  FakeWebSocket,
  createWatchLiveReplayHarness,
} from "./fixtures/agenc-watch-live-replay-harness.mjs";

test("createWatchApp starts and disposes terminal lifecycle cleanly", async () => {
  const harness = await createWatchLiveReplayHarness();
  await harness.start();

  assert.deepEqual(harness.stdin.rawModes, [true]);
  assert.equal(harness.stdin.resumeCalls, 1);
  assert.equal(harness.stdin.listenerCount("data"), 1);
  assert.equal(harness.stdout.listenerCount("resize"), 1);
  assert.equal(FakeWebSocket.instances.length, 1);

  const exitCode = harness.dispose(3);
  const closedCode = await harness.app.closed;

  assert.equal(exitCode, 3);
  assert.equal(closedCode, 3);
  assert.deepEqual(harness.stdin.rawModes, [true, false]);
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdout.listenerCount("resize"), 0);
});

test("createWatchApp unwinds raw mode and listeners on startup failure", async () => {
  const harness = await createWatchLiveReplayHarness({ stdoutThrows: true });

  await assert.rejects(() => harness.start(), /resize listener failed/);

  assert.deepEqual(harness.stdin.rawModes, [true, false]);
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdout.listenerCount("resize"), 0);
  assert.equal(await harness.app.closed, 1);
});

test("buildSurfaceSummaryCacheKey invalidates richer status chrome inputs", () => {
  const base = {
    connectionState: "live",
    phaseLabel: "running",
    route: { provider: "grok", model: "grok-4", usedFallback: false },
    backgroundRunStatus: {
      enabled: true,
      operatorAvailable: true,
      activeTotal: 0,
      queuedSignalsTotal: 0,
    },
    runtimeStatus: { state: "live" },
    objective: "Ship status chrome",
    lastUsageSummary: "1.2K total",
    latestTool: "system.bash",
    latestToolState: "ok",
    queuedInputCount: 0,
    pendingAttachmentCount: 0,
    eventsLength: 3,
    lastEventId: "evt-3",
    planCount: 2,
    activeAgentCount: 1,
    activeAgentLabel: "child-a",
    activeAgentActivity: "editing runtime/src/index.ts",
    plannerStatus: "running",
    plannerNote: "waiting on validation",
    sessionId: "session:1234",
    sessionLabel: "Roadmap branch",
    following: true,
    detailOpen: false,
    transcriptScrollOffset: 0,
    lastActivityAt: "15:47:00",
    maintenanceStatus: {
      generatedAt: 1_730_000_000_000,
      sync: {
        ownerSessionCount: 1,
        activeSessionId: "session:1234",
        activeSessionOwned: true,
        durableRunsEnabled: true,
        operatorAvailable: true,
      },
      memory: {
        backendConfigured: true,
        sessionCount: 2,
        totalMessages: 11,
        lastActiveAt: 1_730_000_010_000,
        recentSessions: [{ id: "session:1234", messageCount: 11, lastActiveAt: 1_730_000_010_000 }],
      },
    },
    workspaceIndex: {
      ready: true,
      error: null,
      files: [{ path: "runtime/src/index.ts" }, { path: "runtime/src/watch/agenc-watch-app.mjs" }],
    },
    voiceCompanion: {
      active: true,
      connectionState: "connected",
      companionState: "listening",
      voice: "Ara",
      mode: "vad",
      sessionId: "voice:1234",
      managedSessionId: "session:1234",
      currentTask: null,
      delegationStatus: "completed",
      lastUserTranscript: "Ship status chrome",
      lastAssistantTranscript: "Done.",
      lastError: null,
    },
  };

  const firstKey = buildSurfaceSummaryCacheKey(base);
  const fallbackKey = buildSurfaceSummaryCacheKey({
    ...base,
    route: { ...base.route, usedFallback: true },
  });
  const runtimeKey = buildSurfaceSummaryCacheKey({
    ...base,
    backgroundRunStatus: { ...base.backgroundRunStatus, queuedSignalsTotal: 4 },
  });
  const agentKey = buildSurfaceSummaryCacheKey({
    ...base,
    activeAgentActivity: "running acceptance probe",
  });
  const attachmentKey = buildSurfaceSummaryCacheKey({
    ...base,
    pendingAttachmentCount: 2,
  });
  const sessionLabelKey = buildSurfaceSummaryCacheKey({
    ...base,
    sessionLabel: "Release prep",
  });
  const maintenanceKey = buildSurfaceSummaryCacheKey({
    ...base,
    maintenanceStatus: {
      ...base.maintenanceStatus,
      memory: {
        ...base.maintenanceStatus.memory,
        totalMessages: 12,
      },
    },
  });
  const workspaceIndexKey = buildSurfaceSummaryCacheKey({
    ...base,
    workspaceIndex: {
      ...base.workspaceIndex,
      ready: false,
      error: "index unavailable",
      files: [],
    },
  });
  const voiceKey = buildSurfaceSummaryCacheKey({
    ...base,
    voiceCompanion: {
      ...base.voiceCompanion,
      companionState: "delegating",
      currentTask: "Run release validation",
    },
  });

  assert.notEqual(firstKey, fallbackKey);
  assert.notEqual(firstKey, runtimeKey);
  assert.notEqual(firstKey, agentKey);
  assert.notEqual(firstKey, attachmentKey);
  assert.notEqual(firstKey, sessionLabelKey);
  assert.notEqual(firstKey, maintenanceKey);
  assert.notEqual(firstKey, workspaceIndexKey);
  assert.notEqual(firstKey, voiceKey);
});

test("latestSessionSummary prefers sessions from the current workspace root", () => {
  const payload = [
    {
      sessionId: "session-other",
      workspaceRoot: "/tmp/other-project",
      messageCount: 10,
      lastActiveAt: 200,
    },
    {
      sessionId: "session-same",
      workspaceRoot: "/home/tetsuo/git/AgenC",
      messageCount: 2,
      lastActiveAt: 100,
    },
  ];

  const selected = latestSessionSummary(
    payload,
    null,
    "/home/tetsuo/git/AgenC",
  );

  assert.equal(selected?.sessionId, "session-same");
});

test("resolveWatchMouseTrackingEnabled defaults on so the wheel scrolls the in-app transcript", () => {
  // Default ON: empty env, missing var, and explicit truthy values all
  // enable mouse tracking. Without it, wheel events fall through to the
  // terminal and scroll the alt-screen viewport above the header.
  assert.equal(resolveWatchMouseTrackingEnabled({}), true);
  assert.equal(
    resolveWatchMouseTrackingEnabled({ AGENC_WATCH_ENABLE_MOUSE: "1" }),
    true,
  );
  assert.equal(
    resolveWatchMouseTrackingEnabled({ AGENC_WATCH_ENABLE_MOUSE: "true" }),
    true,
  );
  // Opt-out: only explicit falsey values disable mouse tracking, so users
  // who prefer terminal-native click-to-select can still bypass it.
  assert.equal(
    resolveWatchMouseTrackingEnabled({ AGENC_WATCH_ENABLE_MOUSE: "off" }),
    false,
  );
  assert.equal(
    resolveWatchMouseTrackingEnabled({ AGENC_WATCH_ENABLE_MOUSE: "0" }),
    false,
  );
  assert.equal(
    resolveWatchMouseTrackingEnabled({ AGENC_WATCH_ENABLE_MOUSE: "false" }),
    false,
  );
});
