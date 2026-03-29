import test from "node:test";
import assert from "node:assert/strict";

import {
  captureWatchCheckpoint,
  clearSubagentToolArgs,
  createWatchState,
  createWatchStateBindings,
  listWatchCheckpointSummaries,
  loadPersistedWatchState,
  persistWatchState,
  readSubagentToolArgs,
  rememberSubagentToolArgs,
  resetDelegatedWatchState,
  rewindWatchToCheckpoint,
} from "../../src/watch/agenc-watch-state.mjs";

test("loadPersistedWatchState returns sanitized values for the active client key", () => {
  const fs = {
    readFileSync: () =>
      JSON.stringify({
        clientKey: "watch-key",
        ownerToken: " owner-1 ",
        sessionId: " session-1 ",
        sessionLabels: {
          "session-1": "Primary fix",
        },
        uiPreferences: {
          inputModeProfile: "vim",
          keybindingProfile: "vim",
          themeName: "aurora",
        },
        pendingAttachments: [{
          id: "att-1",
          path: "/tmp/diagram.png",
          displayPath: "diagram.png",
          filename: "diagram.png",
          mimeType: "image/png",
          type: "image",
          sizeBytes: 1024,
        }],
        attachmentSequence: 1,
        checkpoints: [
          {
            id: "cp-1",
            label: "Before change",
            reason: "manual",
            createdAtMs: 123,
            sessionId: "session-1",
            objective: "Ship it",
            runState: "working",
            eventCount: 2,
          },
        ],
        checkpointSnapshots: {
          "cp-1": {
            primitives: {
              sessionId: "session-1",
              runState: "working",
              currentObjective: "Ship it",
            },
            queuedOperatorInputs: [],
            events: [],
          },
        },
        checkpointSequence: 1,
        activeCheckpointId: "cp-1",
      }),
  };

  const restored = loadPersistedWatchState({
    fs,
    path: {},
    watchStateFile: "/tmp/watch-state.json",
    clientKey: "watch-key",
  });

  assert.equal(restored.ownerToken, "owner-1");
  assert.equal(restored.sessionId, "session-1");
  assert.equal(restored.sessionLabels instanceof Map, true);
  assert.equal(restored.sessionLabels.get("session-1"), "Primary fix");
  assert.equal(restored.uiPreferences.inputModeProfile, "vim");
  assert.equal(restored.uiPreferences.themeName, "aurora");
  assert.equal(restored.pendingAttachments.length, 1);
  assert.equal(restored.pendingAttachments[0].filename, "diagram.png");
  assert.equal(restored.attachmentSequence, 1);
  assert.equal(restored.checkpoints.length, 1);
  assert.equal(restored.checkpoints[0].id, "cp-1");
  assert.equal(restored.checkpointSnapshots instanceof Map, true);
  assert.equal(restored.checkpointSnapshots.has("cp-1"), true);
  assert.equal(restored.activeCheckpointId, "cp-1");
});

test("persistWatchState stores sanitized values and creates the parent directory", () => {
  const calls = [];
  const fs = {
    mkdirSync: (value, options) => calls.push(["mkdirSync", value, options]),
    writeFileSync: (value, data) => calls.push(["writeFileSync", value, data]),
  };
  const path = {
    dirname: (value) => `${value}.dir`,
  };

  persistWatchState({
    fs,
    path,
    watchStateFile: "/tmp/watch-state.json",
    clientKey: "watch-key",
    ownerToken: " owner-2 ",
    sessionId: " session-2 ",
    sessionLabels: new Map([
      ["session-2", "Release branch"],
    ]),
    uiPreferences: {
      inputModeProfile: "vim",
      keybindingProfile: "vim",
      themeName: "ember",
    },
    pendingAttachments: [{
      id: "att-2",
      path: "/tmp/screenshot.png",
      displayPath: "screenshot.png",
      filename: "screenshot.png",
      mimeType: "image/png",
      type: "image",
      sizeBytes: 2048,
    }],
    attachmentSequence: 2,
    checkpoints: [{
      id: "cp-2",
      label: "Checkpoint 2",
      reason: "manual",
      createdAtMs: 456,
      sessionId: "session-2",
      objective: "review",
      runState: "idle",
      eventCount: 1,
    }],
    checkpointSnapshots: new Map([
      ["cp-2", {
        primitives: { sessionId: "session-2", currentObjective: "review" },
        queuedOperatorInputs: ["queued"],
        events: [{ id: "evt-1", body: "hello" }],
      }],
    ]),
    checkpointSequence: 2,
    activeCheckpointId: "cp-2",
  });

  assert.deepEqual(calls[0], [
    "mkdirSync",
    "/tmp/watch-state.json.dir",
    { recursive: true },
  ]);
  assert.equal(calls[1][0], "writeFileSync");
  assert.equal(calls[1][1], "/tmp/watch-state.json");
  assert.match(calls[1][2], /"ownerToken": "owner-2"/);
  assert.match(calls[1][2], /"sessionId": "session-2"/);
  assert.match(calls[1][2], /"sessionLabels"/);
  assert.match(calls[1][2], /"Release branch"/);
  assert.match(calls[1][2], /"uiPreferences"/);
  assert.match(calls[1][2], /"themeName": "ember"/);
  assert.match(calls[1][2], /"pendingAttachments"/);
  assert.match(calls[1][2], /"attachmentSequence": 2/);
  assert.match(calls[1][2], /"checkpointSequence": 2/);
  assert.match(calls[1][2], /"activeCheckpointId": "cp-2"/);
  assert.match(calls[1][2], /"Checkpoint 2"/);
});

test("createWatchState seeds persisted identity and collection state", () => {
  const state = createWatchState({
    persistedWatchState: {
      ownerToken: "owner-3",
      sessionId: "session-3",
      sessionLabels: new Map([
        ["session-3", "Watch Roadmap"],
      ]),
      uiPreferences: {
        inputModeProfile: "vim",
        keybindingProfile: "vim",
        themeName: "aurora",
      },
      pendingAttachments: [{
        id: "att-1",
        path: "/tmp/notes.md",
        displayPath: "notes.md",
        filename: "notes.md",
        mimeType: "text/markdown",
        type: "file",
        sizeBytes: 12,
      }],
      attachmentSequence: 1,
      checkpoints: [{
        id: "cp-1",
        label: "Boot",
        reason: "manual",
        createdAtMs: 10,
        sessionId: "session-3",
        objective: null,
        runState: "idle",
        eventCount: 0,
      }],
      checkpointSnapshots: new Map([
        ["cp-1", { primitives: { sessionId: "session-3" }, queuedOperatorInputs: [], events: [] }],
      ]),
      checkpointSequence: 1,
      activeCheckpointId: "cp-1",
    },
    launchedAtMs: 123,
  });

  assert.equal(state.ownerToken, "owner-3");
  assert.equal(state.sessionId, "session-3");
  assert.equal(state.sessionLabels instanceof Map, true);
  assert.equal(state.sessionLabels.get("session-3"), "Watch Roadmap");
  assert.equal(state.inputPreferences.inputModeProfile, "vim");
  assert.equal(state.inputPreferences.themeName, "aurora");
  assert.equal(state.composerMode, "insert");
  assert.equal(state.pendingAttachments.length, 1);
  assert.equal(state.attachmentSequence, 1);
  assert.equal(state.sessionAttachedAtMs, 123);
  assert.equal(state.transientStatus, "Booting watch client…");
  assert.ok(Array.isArray(state.events));
  assert.ok(state.subagentPlanSteps instanceof Map);
  assert.ok(state.subagentToolArgs instanceof Map);
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.checkpointSnapshots instanceof Map, true);
  assert.equal(state.activeCheckpointId, "cp-1");
});

test("createWatchStateBindings exposes mutable bridge bindings", () => {
  const state = createWatchState();
  const bindings = createWatchStateBindings({
    state,
    bindState: (get, set) => ({ get, set }),
  });

  bindings.sessionId.set("session-4");
  bindings.latestTool.set("system.bash");

  assert.equal(bindings.sessionId.get(), "session-4");
  assert.equal(bindings.latestTool.get(), "system.bash");
  assert.equal(state.sessionId, "session-4");
  assert.equal(state.latestTool, "system.bash");
});

test("subagent tool arg helpers cache, read, clear, and reset cleanly", () => {
  const state = createWatchState();
  state.subagentPlanSteps.set("step-1", { id: 1 });
  state.subagentSessionPlanKeys.set("session-1", "step-1");
  state.subagentLiveActivity.set("session-1", "editing file");
  state.recentSubagentLifecycleFingerprints.set("fingerprint", Date.now());
  state.plannerDagNodes.set("node-1", { key: "node-1" });
  state.plannerDagEdges.push({ from: "a", to: "b" });
  state.plannerDagStatus = "running";
  state.plannerDagNote = "note";
  state.plannerDagUpdatedAt = 456;
  state.plannerDagHydratedSessionId = "session-1";

  rememberSubagentToolArgs(state, "session-1", "system.bash", {
    command: "pwd",
  });
  rememberSubagentToolArgs(state, "session-1", "system.readFile", {
    path: "README.md",
  });

  assert.deepEqual(
    readSubagentToolArgs(state, "session-1", "system.bash"),
    { command: "pwd" },
  );

  clearSubagentToolArgs(state, "session-1", "system.bash");
  assert.equal(
    readSubagentToolArgs(state, "session-1", "system.bash"),
    undefined,
  );
  assert.deepEqual(
    readSubagentToolArgs(state, "session-1", "system.readFile"),
    { path: "README.md" },
  );

  resetDelegatedWatchState(state);

  assert.equal(state.subagentPlanSteps.size, 0);
  assert.equal(state.subagentSessionPlanKeys.size, 0);
  assert.equal(state.subagentLiveActivity.size, 0);
  assert.equal(state.recentSubagentLifecycleFingerprints.size, 0);
  assert.equal(state.subagentToolArgs.size, 0);
  assert.equal(state.plannerDagNodes.size, 0);
  assert.deepEqual(state.plannerDagEdges, []);
  assert.equal(state.plannerDagStatus, "idle");
  assert.equal(state.plannerDagNote, null);
  assert.equal(state.plannerDagUpdatedAt, 0);
  assert.equal(state.plannerDagHydratedSessionId, null);
});

test("watch checkpoint helpers capture summaries, list newest first, and rewind in place", () => {
  const state = createWatchState({
    persistedWatchState: {
      ownerToken: "owner-4",
      sessionId: "session-4",
    },
    launchedAtMs: 1_000,
  });
  state.currentObjective = "Initial objective";
  state.runState = "working";
  state.events.push({ id: "evt-1", title: "Prompt", body: "ship it" });
  state.queuedOperatorInputs.push("later");
  state.pendingAttachments.push({
    id: "att-1",
    path: "/tmp/diagram.png",
    displayPath: "diagram.png",
    filename: "diagram.png",
    mimeType: "image/png",
    type: "image",
    sizeBytes: 1024,
  });
  state.attachmentSequence = 1;
  state.subagentPlanSteps.set("step-1", { label: "Review" });
  state.plannerDagNodes.set("node-1", { key: "node-1" });
  state.plannerDagEdges.push({ from: "node-1", to: "node-2" });

  const first = captureWatchCheckpoint(state, {
    label: "Before mutate",
    reason: "manual",
    nowMs: () => 2_000,
  });

  state.currentObjective = "Mutated objective";
  state.runState = "blocked";
  state.events.push({ id: "evt-2", title: "Error", body: "bad" });
  state.queuedOperatorInputs.push("queued-2");
  state.pendingAttachments.push({
    id: "att-2",
    path: "/tmp/notes.md",
    displayPath: "notes.md",
    filename: "notes.md",
    mimeType: "text/markdown",
    type: "file",
    sizeBytes: 24,
  });
  state.attachmentSequence = 2;
  state.subagentPlanSteps.set("step-2", { label: "Fix" });
  state.plannerDagNodes.set("node-2", { key: "node-2" });

  const second = captureWatchCheckpoint(state, {
    label: "After mutate",
    reason: "manual",
    nowMs: () => 3_000,
  });

  const listed = listWatchCheckpointSummaries(state);
  assert.deepEqual(
    listed.map((summary) => summary.id),
    [second.id, first.id],
  );
  assert.equal(listed[0].active, true);

  state.currentObjective = "Drift";
  state.runState = "failed";
  state.events.push({ id: "evt-3", title: "More drift", body: "oops" });
  state.queuedOperatorInputs.push("queued-3");
  state.pendingAttachments.push({
    id: "att-3",
    path: "/tmp/log.txt",
    displayPath: "log.txt",
    filename: "log.txt",
    mimeType: "text/plain",
    type: "file",
    sizeBytes: 10,
  });
  state.attachmentSequence = 3;
  state.subagentPlanSteps.set("step-3", { label: "Retry" });
  state.plannerDagNodes.set("node-3", { key: "node-3" });
  state.plannerDagEdges.push({ from: "node-2", to: "node-3" });

  const rewound = rewindWatchToCheckpoint(state, first.id);

  assert.equal(rewound?.id, first.id);
  assert.equal(state.currentObjective, "Initial objective");
  assert.equal(state.runState, "working");
  assert.deepEqual(state.queuedOperatorInputs, ["later"]);
  assert.deepEqual(state.pendingAttachments.map((attachment) => attachment.id), ["att-1"]);
  assert.equal(state.attachmentSequence, 1);
  assert.deepEqual(state.events.map((event) => event.id), ["evt-1"]);
  assert.equal(state.subagentPlanSteps.size, 1);
  assert.equal(state.subagentPlanSteps.has("step-1"), true);
  assert.equal(state.subagentPlanSteps.has("step-3"), false);
  assert.equal(state.plannerDagNodes.size, 1);
  assert.equal(state.plannerDagEdges.length, 1);
  assert.equal(state.activeCheckpointId, first.id);
});
