import test from "node:test";
import assert from "node:assert/strict";

import { buildWatchFooterSummary } from "../../src/watch/agenc-watch-surface-summary.mjs";
import {
  createDisplayLine,
  createWatchFrameHarness,
} from "./fixtures/agenc-watch-frame-harness.mjs";

async function withStubbedSetTimeout(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  const queued = [];
  globalThis.setTimeout = (callback) => {
    queued.push(callback);
    return 1;
  };
  try {
    return await fn({ queued });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("frame controller computes slash-mode layout through the extracted boundary", () => {
  const harness = createWatchFrameHarness({
    inputValue: "/st",
    suggestions: [{ usage: "/status", description: "Show runtime status", aliases: [] }],
    width: 140,
    height: 40,
  });

  const layout = harness.controller.currentTranscriptLayout();

  assert.equal(layout.width, 140);
  assert.equal(layout.height, 40);
  // Header now ends with a trailing breathing-room spacer row, so the
  // body has one fewer line than the pre-redesign layout (was 28).
  assert.equal(layout.bodyHeight, 27);
  assert.equal(harness.layoutCalls.length, 1);
  assert.equal(harness.layoutCalls[0].slashMode, true);
  assert.equal(harness.layoutCalls[0].detailOpen, false);
  assert.ok(harness.layoutCalls[0].popupRows > 0);

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const paletteRow = snapshot.lines.findIndex((line) => String(line).includes("Show runtime status"));
  assert.notEqual(paletteRow, -1);
  assert.ok(paletteRow + 1 > snapshot.composer.absoluteRow);
});

test("frame controller toggles detail mode using the newest expandable event", async () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "agent",
        title: "Agent Reply",
        body: "hello",
        timestamp: "12:00:00",
      },
    ],
    isMarkdownRenderableEvent() {
      return true;
    },
    wrapEventDisplayLines() {
      return [
        createDisplayLine("headline"),
        createDisplayLine("line 2"),
        createDisplayLine("line 3"),
        createDisplayLine("line 4"),
      ];
    },
    previewLines: 2,
  });

  await withStubbedSetTimeout(() => {
    harness.controller.toggleExpandedEvent();
    assert.equal(harness.watchState.expandedEventId, "evt-1");
    assert.ok(harness.statusCalls.includes("detail open: Agent Reply"));

    harness.controller.toggleExpandedEvent();
    assert.equal(harness.watchState.expandedEventId, null);
    assert.ok(harness.statusCalls.includes("detail closed"));
  });
});

test("frame controller prefers the newest truncated event when opening detail mode", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "you",
        title: "Prompt",
        body: "first line\nsecond line",
        bodyTruncated: true,
        timestamp: "12:00:00",
      },
      {
        id: "evt-2",
        kind: "agent",
        title: "Agent Reply",
        body: "short",
        timestamp: "12:00:01",
      },
    ],
  });

  harness.controller.toggleExpandedEvent();

  assert.equal(harness.watchState.expandedEventId, "evt-1");
  assert.ok(harness.statusCalls.includes("detail open: Prompt"));
});

test("frame controller treats market events with detailBody as expandable", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "market",
        title: "Marketplace Tasks",
        body: "1. Task 1",
        detailBody: "1. Task 1\n2. Task 2\n3. Task 3",
        timestamp: "12:00:00",
      },
    ],
  });

  harness.controller.toggleExpandedEvent();

  assert.equal(harness.watchState.expandedEventId, "evt-1");
  assert.ok(harness.statusCalls.includes("detail open: Marketplace Tasks"));
});

test("frame controller renders the marketplace task browser inline below the composer", () => {
  const harness = createWatchFrameHarness({
    watchState: {
      marketTaskBrowser: {
        open: true,
        title: "Marketplace Tasks",
        statuses: ["open", "claimed"],
        loading: false,
        selectedIndex: 1,
        expandedTaskKey: "task-2",
        items: [
          {
            key: "task-1",
            taskId: "task-1",
            taskPda: "task-pda-1",
            status: "open",
            description: "Task 1",
            rewardDisplay: "1 SOL",
            currentWorkers: 1,
            maxWorkers: 2,
          },
          {
            key: "task-2",
            taskId: "task-2",
            taskPda: "task-pda-2",
            status: "claimed",
            description: "Task 2",
            rewardDisplay: "2 SOL",
            rewardLamports: "2000000000",
            creator: "creator-2",
            currentWorkers: 2,
            maxWorkers: 4,
            deadlineLabel: "2026-04-10 12:00:00Z",
            createdAtLabel: "2026-04-09 12:00:00Z",
          },
        ],
      },
    },
    inputValue: "",
    width: 120,
    height: 38,
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const titleRow = snapshot.lines.findIndex((line) => String(line).includes("Marketplace Tasks"));
  const taskRow = snapshot.lines.findIndex((line) => String(line).includes("Task 2") && String(line).includes("2 SOL"));
  const detailRow = snapshot.lines.findIndex((line) => String(line).includes("identity: task-2 · task-pda-2"));

  assert.notEqual(titleRow, -1);
  assert.notEqual(taskRow, -1);
  assert.notEqual(detailRow, -1);
  assert.ok(titleRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(taskRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(detailRow + 1 > snapshot.composer.absoluteRow);
  assert.equal(harness.layoutCalls.at(-1)?.slashMode, true);
});

test("frame controller renders the marketplace skill browser inline below the composer", () => {
  const harness = createWatchFrameHarness({
    watchState: {
      marketTaskBrowser: {
        open: true,
        kind: "skills",
        title: "Marketplace Skills",
        query: "browser",
        activeOnly: true,
        loading: false,
        selectedIndex: 1,
        expandedTaskKey: "skill-2",
        items: [
          {
            key: "skill-1",
            skillId: "skill-1",
            skillPda: "skill-pda-1",
            name: "Skill 1",
            isActive: true,
            priceDisplay: "1 SOL",
            rating: 4.1,
            downloads: 11,
          },
          {
            key: "skill-2",
            skillId: "skill-2",
            skillPda: "skill-pda-2",
            name: "Browser Skill",
            author: "author-2",
            tags: ["browser", "automation"],
            isActive: true,
            priceDisplay: "2 SOL",
            priceLamports: "2000000000",
            rating: 4.8,
            ratingCount: 12,
            downloads: 42,
            version: 3,
            createdAtLabel: "2026-04-09 12:00:00Z",
            updatedAtLabel: "2026-04-10 08:00:00Z",
          },
        ],
      },
    },
    inputValue: "",
    width: 120,
    height: 38,
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const titleRow = snapshot.lines.findIndex((line) => String(line).includes("Marketplace Skills"));
  const skillRow = snapshot.lines.findIndex((line) => String(line).includes("Browser Skill") && String(line).includes("by author-2"));
  const detailRow = snapshot.lines.findIndex((line) => String(line).includes("identity: skill-2 · skill-pda-2"));

  assert.notEqual(titleRow, -1);
  assert.notEqual(skillRow, -1);
  assert.notEqual(detailRow, -1);
  assert.ok(titleRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(skillRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(detailRow + 1 > snapshot.composer.absoluteRow);
  assert.equal(harness.layoutCalls.at(-1)?.slashMode, true);
});


test("frame controller renders the governance browser inline below the composer", () => {
  const harness = createWatchFrameHarness({
    watchState: {
      marketTaskBrowser: {
        open: true,
        kind: "governance",
        title: "Governance Proposals",
        statuses: ["active"],
        loading: false,
        selectedIndex: 1,
        expandedTaskKey: "proposal-2",
        items: [
          {
            key: "proposal-1",
            proposalPda: "proposal-pda-1",
            status: "open",
            proposalType: "budget",
            payloadPreview: "Treasury top-up",
          },
          {
            key: "proposal-2",
            proposalPda: "proposal-pda-2",
            proposer: "agent-2",
            status: "active",
            proposalType: "upgrade",
            payloadPreview: "Upgrade validator set",
            votesFor: "12",
            votesAgainst: "3",
            totalVoters: 15,
            createdAtLabel: "2026-04-09 12:00:00Z",
            votingDeadlineLabel: "2026-04-10 12:00:00Z",
          },
        ],
      },
    },
    inputValue: "",
    width: 120,
    height: 38,
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const titleRow = snapshot.lines.findIndex((line) => String(line).includes("Governance Proposals"));
  const proposalRow = snapshot.lines.findIndex(
    (line) =>
      String(line).includes("Upgrade validator set") &&
      String(line).includes("by agent-2") &&
      String(line).includes("for 12") &&
      String(line).includes("against 3"),
  );
  const detailRow = snapshot.lines.findIndex((line) =>
    String(line).includes("identity: proposal-pda-2 · upgrade"),
  );

  assert.notEqual(titleRow, -1);
  assert.notEqual(proposalRow, -1);
  assert.notEqual(detailRow, -1);
  assert.ok(titleRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(proposalRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(detailRow + 1 > snapshot.composer.absoluteRow);
  assert.equal(harness.layoutCalls.at(-1)?.slashMode, true);
});

test("frame controller renders the disputes browser inline below the composer", () => {
  const harness = createWatchFrameHarness({
    watchState: {
      marketTaskBrowser: {
        open: true,
        kind: "disputes",
        title: "Marketplace Disputes",
        statuses: ["pending"],
        loading: false,
        selectedIndex: 0,
        expandedTaskKey: "dispute-1",
        items: [
          {
            key: "dispute-1",
            disputePda: "dispute-pda-1",
            taskPda: "task-pda-9",
            initiator: "creator-1",
            defendant: "worker-1",
            status: "pending",
            resolutionType: "refund",
            votesFor: "2",
            votesAgainst: "1",
            totalVoters: 3,
            createdAtLabel: "2026-04-09 12:00:00Z",
          },
        ],
      },
    },
    inputValue: "",
    width: 120,
    height: 38,
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const titleRow = snapshot.lines.findIndex((line) => String(line).includes("Marketplace Disputes"));
  const disputeRow = snapshot.lines.findIndex(
    (line) =>
      String(line).includes("refund") &&
      String(line).includes("dispute-pda-1") &&
      String(line).includes("for 2"),
  );
  const detailRow = snapshot.lines.findIndex((line) =>
    String(line).includes("identity: dispute-pda-1 · task-pda-9"),
  );

  assert.notEqual(titleRow, -1);
  assert.notEqual(disputeRow, -1);
  assert.notEqual(detailRow, -1);
  assert.ok(titleRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(disputeRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(detailRow + 1 > snapshot.composer.absoluteRow);
  assert.equal(harness.layoutCalls.at(-1)?.slashMode, true);
});

test("frame controller renders the reputation browser inline below the composer", () => {
  const harness = createWatchFrameHarness({
    watchState: {
      marketTaskBrowser: {
        open: true,
        kind: "reputation",
        title: "Reputation Summary",
        loading: false,
        selectedIndex: 0,
        expandedTaskKey: "rep-1",
        items: [
          {
            key: "rep-1",
            authority: "agent-authority-1",
            agentPda: "agent-pda-1",
            registered: true,
            effectiveReputation: 98,
            tasksCompleted: "14",
            totalEarnedSol: "4.2",
          },
        ],
      },
    },
    inputValue: "",
    width: 120,
    height: 38,
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const titleRow = snapshot.lines.findIndex((line) => String(line).includes("Reputation Summary"));
  const reputationRow = snapshot.lines.findIndex(
    (line) =>
      String(line).includes("agent-authority-1") &&
      String(line).includes("effective 98") &&
      String(line).includes("4.2 SOL"),
  );
  const detailRow = snapshot.lines.findIndex((line) =>
    String(line).includes("activity: 14 tasks · 4.2 SOL earned"),
  );

  assert.notEqual(titleRow, -1);
  assert.notEqual(reputationRow, -1);
  assert.notEqual(detailRow, -1);
  assert.ok(titleRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(reputationRow + 1 > snapshot.composer.absoluteRow);
  assert.ok(detailRow + 1 > snapshot.composer.absoluteRow);
  assert.equal(harness.layoutCalls.at(-1)?.slashMode, true);
});

test("frame controller exports transcript view through the extracted seam", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "agent",
        title: "Agent Reply",
        body: "hello world",
        timestamp: "12:00:00",
      },
    ],
  });

  const exportPath = harness.controller.exportCurrentView({ announce: true });

  assert.ok(exportPath);
  assert.equal(harness.fileWrites.length, 1);
  assert.match(harness.fileWrites[0].filePath, /agenc-watch-transcript-\d+\.txt$/);
  assert.equal(
    harness.fileWrites[0].text,
    "[12:00:00] Agent Reply\nhello world\n",
  );
  assert.deepEqual(harness.pushedEvents[0], {
    kind: "operator",
    title: "Transcript Export",
    body: `Transcript exported to ${exportPath}.`,
    tone: "teal",
  });
});

test("frame controller exports the rendered detail view instead of raw event body", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "tool result",
        title: "Patch Preview",
        body: "raw-body",
        timestamp: "12:00:00",
      },
    ],
    wrapEventDisplayLines() {
      return [
        createDisplayLine("diff --git a/file.ts b/file.ts", "diff-header"),
        createDisplayLine("+const value = 1;", "diff-added"),
      ];
    },
  });
  harness.watchState.expandedEventId = "evt-1";

  const exportPath = harness.controller.exportCurrentView({ announce: true });

  assert.ok(exportPath);
  assert.equal(harness.fileWrites.length, 1);
  assert.equal(
    harness.fileWrites[0].text,
    "[12:00:00] Patch Preview\n\ndiff --git a/file.ts b/file.ts\n+const value = 1;\n",
  );
});

test("frame controller exports detailBody when an expanded event provides richer detail text", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "market",
        title: "Marketplace Tasks",
        body: "1. Task 1",
        detailBody: "1. Task 1\n2. Task 2\n3. Task 3",
        timestamp: "12:00:00",
      },
    ],
  });
  harness.watchState.expandedEventId = "evt-1";

  const exportPath = harness.controller.exportCurrentView({ announce: true });

  assert.ok(exportPath);
  assert.equal(harness.fileWrites.length, 1);
  assert.equal(
    harness.fileWrites[0].text,
    "[12:00:00] Marketplace Tasks\n\n1. Task 1\n2. Task 2\n3. Task 3\n",
  );
});

test("frame controller can print the current view into the normal terminal for native selection", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "agent",
        title: "Agent Reply",
        body: "hello world",
        timestamp: "12:00:00",
      },
    ],
  });

  const enteredSelectionMode = harness.controller.toggleTerminalSelectionMode();

  assert.equal(enteredSelectionMode, true);
  assert.equal(harness.controller.isTerminalSelectionModeActive(), true);
  assert.match(harness.stdoutWrites.join(""), /terminal selection mode/);
  assert.match(harness.stdoutWrites.join(""), /hello world/);
});

test("frame controller scrolls transcript and detail view independently", async () => {
  const harness = createWatchFrameHarness();

  await withStubbedSetTimeout(() => {
    harness.controller.scrollCurrentViewBy(3);
    assert.equal(harness.watchState.transcriptScrollOffset, 3);
    assert.equal(harness.watchState.transcriptFollowMode, false);

    harness.watchState.expandedEventId = "evt-1";
    harness.controller.scrollCurrentViewBy(2);
    assert.equal(harness.watchState.detailScrollOffset, 2);
  });
});

test("frame controller routes slash palette rows through ansi-aware fitting", () => {
  const fitCalls = [];
  const harness = createWatchFrameHarness({
    inputValue: "/",
    suggestions: [{
      usage: "/export",
      description: "Write the current detail view or transcript to a temp file.",
      aliases: ["/copy"],
    }],
    width: 40,
    height: 18,
    dependencies: {
      color: {
        reset: "<reset>",
        bold: "<bold>",
        border: "",
        borderStrong: "",
        softInk: "<soft>",
        fog: "<fog>",
        magenta: "<magenta>",
        teal: "",
        cyan: "",
        red: "",
        green: "",
        yellow: "",
        panelBg: "",
        panelAltBg: "",
        panelHiBg: "",
        ink: "",
      },
      fitAnsi(text, width) {
        fitCalls.push({ text: String(text ?? ""), width });
        return String(text ?? "");
      },
      truncate(value, maxChars = 220) {
        const text = String(value ?? "");
        assert.equal(
          /<(?:reset|soft|fog|magenta)>/.test(text),
          false,
          `plain truncate received colorized text: ${text}`,
        );
        return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
      },
    },
  });

  harness.controller.buildVisibleFrameSnapshot();

  assert.ok(
    fitCalls.some((call) =>
      call.width === 40 &&
      call.text.includes("/export") &&
      call.text.includes("Write the current detail view or transcript to a temp file."),
    ),
  );
});

test("frame controller routes file tag palette rows through ansi-aware fitting", () => {
  const fitCalls = [];
  const harness = createWatchFrameHarness({
    inputValue: "@runtime/src/channels/webchat/ty",
    fileTagPalette: {
      activeTag: {
        query: "runtime/src/channels/webchat/ty",
      },
      suggestions: [{
        label: "types.ts",
        directory: "runtime/src/channels/webchat",
      }],
      summary: {
        title: "Files",
        suggestionHint: "types.ts",
        mode: "active",
        empty: false,
      },
    },
    width: 40,
    height: 18,
    dependencies: {
      color: {
        reset: "<reset>",
        bold: "<bold>",
        border: "",
        borderStrong: "",
        softInk: "<soft>",
        fog: "<fog>",
        magenta: "<magenta>",
        teal: "",
        cyan: "",
        red: "",
        green: "",
        yellow: "",
        panelBg: "",
        panelAltBg: "",
        panelHiBg: "",
        ink: "",
      },
      fitAnsi(text, width) {
        fitCalls.push({ text: String(text ?? ""), width });
        return String(text ?? "");
      },
      truncate(value, maxChars = 220) {
        const text = String(value ?? "");
        assert.equal(
          /<(?:reset|soft|fog|magenta)>/.test(text),
          false,
          `plain truncate received colorized text: ${text}`,
        );
        return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
      },
    },
  });

  harness.controller.buildVisibleFrameSnapshot();

  assert.ok(
    fitCalls.some((call) => call.width === 40 && call.text.includes("types.ts")),
  );
  assert.ok(
    fitCalls.some((call) => call.width === 40 && call.text.includes("runtime/src/channels/webchat")),
  );
});

test("frame controller overlays child tool name when a subagent progress entry is active", () => {
  const harness = createWatchFrameHarness({
    width: 140,
    height: 40,
    watchState: {
      activeSubagentProgressByParentToolCallId: new Map([
        [
          "parent-call-xyz",
          {
            subagentSessionId: "subagent:child-1",
            toolUseCount: 4,
            tokenCount: 12345,
            lastToolName: "system.bash",
            lastActivity: { toolName: "system.bash", isError: false, ts: 1 },
            recentActivities: [{ toolName: "system.bash", ts: 1 }],
            elapsedMs: 1200,
            lastUpdatedAt: Date.now(),
          },
        ],
      ]),
      parentToolCallIdBySubagentSession: new Map([
        ["subagent:child-1", "parent-call-xyz"],
      ]),
    },
    dependencies: {
      currentSurfaceSummary() {
        return {
          overview: {
            connectionState: "live",
            sessionToken: "12345678",
            phaseLabel: "thinking",
            queuedInputCount: 0,
            // Parent session's latestTool is the execute_with_agent
            // delegation call. Without the overlay the header would
            // show only "execute_with_agent" (uninformative once the
            // child is working).
            latestTool: "execute_with_agent",
            latestToolState: "running",
            usage: "",
            lastActivityAt: "",
            activeAgentCount: 1,
            planCount: 0,
            transcriptMode: "follow",
            fallbackState: "standby",
            runtimeState: "healthy",
            runtimeLabel: "live",
            activeLine: "",
            durableActiveTotal: 0,
            durableQueuedSignalsTotal: 0,
            durableRunsState: "ready",
          },
          routeLabel: "grok-4",
          providerLabel: "grok",
          objective: "",
          routeState: "primary",
          routeTone: "teal",
          recentTools: [],
          attention: {
            approvalAlertCount: 0,
            errorAlertCount: 0,
            queuedInputCount: 0,
            items: [],
          },
        };
      },
    },
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  const hasOverlay = snapshot.lines.some((line) =>
    String(line).includes("execute_with_agent › system.bash"),
  );
  assert.equal(hasOverlay, true);
});

test("frame controller keeps the full usage summary visible in the header", () => {
  const usage = "80k in · 12k out · 3 cached · 41% window";
  const harness = createWatchFrameHarness({
    width: 140,
    height: 40,
    dependencies: {
      currentSurfaceSummary() {
        return {
          overview: {
            connectionState: "live",
            sessionToken: "12345678",
            phaseLabel: "running",
            queuedInputCount: 0,
            latestTool: "system.exec",
            latestToolState: "running",
            usage,
            lastActivityAt: "00:00:00",
            activeAgentCount: 1,
            planCount: 1,
            transcriptMode: "follow",
            fallbackState: "standby",
            runtimeState: "healthy",
            runtimeLabel: "live · durable ready",
            activeLine: "Awaiting operator prompt",
            durableActiveTotal: 0,
            durableQueuedSignalsTotal: 0,
            durableRunsState: "ready",
          },
          routeLabel: "grok-4 via grok",
          providerLabel: "grok",
          objective: "No active objective",
          routeState: "primary",
          routeTone: "teal",
          recentTools: [],
          attention: {
            approvalAlertCount: 0,
            errorAlertCount: 0,
            queuedInputCount: 0,
            items: [],
          },
        };
      },
    },
  });

  const snapshot = harness.controller.buildVisibleFrameSnapshot();
  assert.ok(snapshot.lines.some((line) => String(line).includes(usage)));
  assert.ok(snapshot.lines.some((line) => String(line).includes("│")));
});

test("frame controller hides transcript timestamps in the visible watch ui", () => {
  const harness = createWatchFrameHarness({
    width: 100,
    height: 22,
    watchState: {
      expandedEventId: "evt-1",
    },
    events: [
      {
        id: "evt-1",
        kind: "tool result",
        title: "Edited runtime/src/index.ts",
        body: "done",
        timestamp: "15:15:01",
      },
    ],
  });

  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));
  assert.equal(lines.some((line) => line.includes("15:15:01")), false);
});

test("frame controller keeps footer minimal while surfacing run context in the frame", () => {
  const harness = createWatchFrameHarness({
    activeRun: true,
    latestTool: "system.bash",
    surfaceSummary: {
      overview: {
        connectionState: "live",
        sessionToken: "12345678",
        phaseLabel: "running",
        queuedInputCount: 2,
        latestTool: "system.bash",
        latestToolState: "ok",
        usage: "3.4K total",
        lastActivityAt: "15:47:00",
        activeAgentCount: 1,
        planCount: 2,
        transcriptMode: "follow",
        fallbackState: "standby",
        runtimeState: "healthy",
        runtimeLabel: "live · durable ready",
        activeLine: "Shipping statusline controls",
        durableActiveTotal: 1,
        durableQueuedSignalsTotal: 0,
        durableRunsState: "ready",
        providerLabel: "grok",
        modelLabel: "grok-4.20",
      },
    },
    dependencies: {
      buildWatchFooterSummary,
      watchFeatureFlags: { statusline: true, checkpoints: true },
      animatedWorkingGlyph() {
        return "*";
      },
    },
  });
  harness.watchState.activeCheckpointId = "cp-9";
  harness.watchState.checkpoints = [{ id: "cp-1" }, { id: "cp-9" }];

  const snapshot = harness.controller.buildVisibleFrameSnapshot({
    width: 140,
    height: 22,
  });
  const frameText = snapshot.lines.join("\n");

  assert.match(frameText, /Shipping statusline controls/);
  assert.match(frameText, /LATEST:system\.bash/);
  assert.match(frameText, /PLAN:2/);
  assert.match(frameText, /session 12345678/);
  assert.match(frameText, /(?:~\/[^\n]*|\/[^\n]+)\n>/);
  assert.equal(/\nlive\s+idle\n>/.test(frameText), false);
});

test("frame controller renders the header model chip without repeating the provider", () => {
  const harness = createWatchFrameHarness({
    activeRun: true,
    surfaceSummary: {
      modelLabel: "gpt-4.1",
      providerLabel: "openai",
      routeLabel: "gpt-4.1 via openai",
      overview: {
        phaseLabel: "running",
        activeLine: "Testing model header",
        modelLabel: "gpt-4.1",
      },
    },
  });

  const frameText = harness.controller.buildVisibleFrameSnapshot({
    width: 120,
    height: 22,
  }).lines.join("\n");

  // Model lives in the lower header border (Style C — Modern Card),
  // rendered lowercase as "model <name>" instead of the old "MODEL:<name>"
  // chip. The provider must still not be repeated alongside the name.
  assert.match(frameText, /model gpt-4\.1/);
  assert.doesNotMatch(frameText, /model openai\/gpt-4\.1/);
});

test("frame controller renders user transcript rows as shaded blocks without divider rules", () => {
  // The redesigned header is taller (top spacer + bottom spacer rows), so
  // a height of 18 pushes the transcript rows out of the visible viewport.
  // Use 25 to keep the user-prompt block fully visible.
  const harness = createWatchFrameHarness({
    width: 60,
    height: 25,
    events: [
      {
        id: "evt-you",
        kind: "you",
        title: "You",
        body: "hola\notra linea",
        timestamp: "15:15:00",
      },
      {
        id: "evt-agent",
        kind: "agent",
        title: "Agent Reply",
        body: "respuesta corta",
        timestamp: "15:15:01",
      },
    ],
    dependencies: {
      color: {
        reset: "<reset>",
        bold: "",
        border: "",
        borderStrong: "",
        softInk: "<soft>",
        fog: "<fog>",
        magenta: "",
        teal: "",
        cyan: "",
        red: "",
        green: "",
        yellow: "",
        panelBg: "",
        panelAltBg: "<altbg>",
        panelHiBg: "<bg>",
        ink: "",
      },
      paintSurface(text, width, background = "") {
        return `${background}${String(text ?? "").padEnd(width)}`;
      },
      buildEventDisplayLines(event) {
        return String(event.body ?? "")
          .split("\n")
          .map((line) => createDisplayLine(line, "plain"));
      },
      wrapDisplayLines(lines) {
        return lines;
      },
    },
  });

  // The user-prompt rounded pill uses a hardcoded ANSI 238 background
  // (medium gray) instead of `color.panelHiBg`, so the test mock for
  // `<bg>` does not apply. Match the actual escape sequence emitted by
  // the renderer.
  const transcriptUserBg = "\x1b[48;5;238m";
  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));
  const firstUserRow = lines.findIndex((line) =>
    line.includes(transcriptUserBg) && line.includes("><reset> <soft>hola<reset>")
  );
  assert.notEqual(firstUserRow, -1);
  assert.match(
    lines[firstUserRow + 1] ?? "",
    new RegExp(`\\x1b\\[48;5;238m\\s+<soft>otra linea<reset>`),
  );

  const assistantRow = lines.findIndex((line) => line.includes("respuesta corta"));
  assert.notEqual(assistantRow, -1);
  const betweenStart = Math.min(firstUserRow, assistantRow) + 1;
  const betweenEnd = Math.max(firstUserRow, assistantRow);
  assert.equal(
    lines.slice(betweenStart, betweenEnd).some((line) => /^─+$/.test(line)),
    false,
  );
});

test("frame controller renders full non-code agent replies in transcript view", () => {
  const harness = createWatchFrameHarness({
    width: 60,
    height: 28,
    previewLines: 2,
    events: [
      {
        id: "evt-agent",
        kind: "agent",
        title: "Agent Reply",
        body: "ignored",
        timestamp: "15:15:01",
      },
    ],
    dependencies: {
      isMarkdownRenderableEvent(event) {
        return event?.kind === "agent";
      },
      buildEventDisplayLines() {
        return [
          createDisplayLine("Here are the open tasks", "paragraph"),
          createDisplayLine("1. Task A", "list"),
          createDisplayLine("2. Task B", "list"),
          createDisplayLine("3. Task C", "list"),
        ];
      },
    },
  });

  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));
  const headingRow = lines.findIndex((line) => line.includes("Here are the open tasks"));
  const firstTaskRow = lines.findIndex((line) => line.includes("1. Task A"));

  assert.ok(lines.some((line) => line.includes("Here are the open tasks")));
  assert.ok(lines.some((line) => line.includes("1. Task A")));
  assert.ok(lines.some((line) => line.includes("2. Task B")));
  assert.ok(lines.some((line) => line.includes("3. Task C")));
  assert.ok(firstTaskRow > headingRow + 1);
  assert.equal(String(lines[headingRow + 1] ?? "").trim().length, 0);
});

test("frame controller renders full code-heavy agent replies in transcript view", () => {
  const harness = createWatchFrameHarness({
    width: 60,
    height: 28,
    previewLines: 2,
    events: [
      {
        id: "evt-agent",
        kind: "agent",
        title: "Agent Reply",
        body: "ignored",
        timestamp: "15:15:01",
      },
    ],
    dependencies: {
      isMarkdownRenderableEvent(event) {
        return event?.kind === "agent";
      },
      buildEventDisplayLines() {
        return [
          createDisplayLine("Patch preview", "paragraph"),
          createDisplayLine("code · ts", "code-meta"),
          createDisplayLine("const task = 1;", "code"),
          createDisplayLine("return task;", "code"),
        ];
      },
      wrapEventDisplayLines() {
        return [
          createDisplayLine("Patch preview", "paragraph"),
          createDisplayLine("code · ts", "code-meta"),
          createDisplayLine("const task = 1;", "code"),
          createDisplayLine("return task;", "code"),
        ];
      },
    },
  });

  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));

  assert.ok(lines.some((line) => line.includes("Patch preview")));
  assert.ok(lines.some((line) => line.includes("code · ts")));
  assert.ok(lines.some((line) => line.includes("const task = 1;")));
  assert.ok(lines.some((line) => line.includes("return task;")));
});

test("frame controller renders restored agent detailBody instead of truncated body", () => {
  const harness = createWatchFrameHarness({
    width: 64,
    height: 36,
    previewLines: 2,
    events: [
      {
        id: "evt-agent-old",
        kind: "agent",
        title: "Agent Reply",
        body: "stored preview only…",
        detailBody: "Full restored reply\nline beyond stored cutoff",
        bodyTruncated: true,
        timestamp: "15:15:01",
      },
      {
        id: "evt-you-later",
        kind: "you",
        title: "Prompt",
        body: "next prompt",
        timestamp: "15:15:02",
      },
    ],
    dependencies: {
      isMarkdownRenderableEvent(event) {
        return event?.kind === "agent";
      },
      buildEventDisplayLines(event) {
        return String(event?.body ?? "")
          .split("\n")
          .map((line) => createDisplayLine(line, "paragraph"));
      },
    },
  });

  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));

  assert.ok(lines.some((line) => line.includes("Full restored reply")));
  assert.ok(lines.some((line) => line.includes("line beyond stored cutoff")));
  assert.equal(lines.some((line) => line.includes("stored preview only")), false);
});

test("frame controller does not add blank rows between wrapped lines of one paragraph", () => {
  const harness = createWatchFrameHarness({
    width: 36,
    height: 28,
    previewLines: 2,
    events: [
      {
        id: "evt-agent",
        kind: "agent",
        title: "Agent Reply",
        body: "ignored",
        timestamp: "15:15:01",
      },
    ],
    dependencies: {
      isMarkdownRenderableEvent(event) {
        return event?.kind === "agent";
      },
      buildEventDisplayLines() {
        return [
          createDisplayLine(
            "This is a long paragraph that should wrap across multiple transcript rows without extra blank gaps.",
            "paragraph",
          ),
          createDisplayLine("Next paragraph", "paragraph"),
        ];
      },
      wrapDisplayLines(lines, width) {
        const text = String(lines[0]?.plainText ?? lines[0]?.text ?? "");
        const chunkSize = Math.max(8, Number(width) || 8);
        const chunks = [];
        for (let index = 0; index < text.length; index += chunkSize) {
          chunks.push(createDisplayLine(text.slice(index, index + chunkSize), lines[0]?.mode ?? "plain"));
        }
        return chunks;
      },
    },
  });

  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));
  const firstParagraphRow = lines.findIndex((line) => line.includes("This is a long paragraph"));
  const nextParagraphRow = lines.findIndex((line) => line.includes("Next paragraph"));
  const continuationRows = lines.slice(firstParagraphRow + 1, Math.max(firstParagraphRow + 1, nextParagraphRow - 1));

  assert.notEqual(firstParagraphRow, -1);
  assert.notEqual(nextParagraphRow, -1);
  assert.ok(continuationRows.length >= 1);
  assert.equal(continuationRows.some((line) => String(line).trim().length === 0), false);
  assert.equal(String(lines[nextParagraphRow - 1] ?? "").trim().length, 0);
});

test("frame controller keeps agent table rows contiguous and rendered", () => {
  const harness = createWatchFrameHarness({
    width: 90,
    height: 34,
    previewLines: 20,
    events: [
      {
        id: "evt-agent-table",
        kind: "agent",
        title: "Agent Reply",
        body: "ignored",
        timestamp: "15:15:01",
      },
    ],
    dependencies: {
      isMarkdownRenderableEvent(event) {
        return event?.kind === "agent";
      },
      buildEventDisplayLines() {
        return [
          createDisplayLine("┌────────┬────────┬───────┐", "table-divider"),
          createDisplayLine("│ Name   │ Status │ Score │", "table-header"),
          createDisplayLine("├────────┼────────┼───────┤", "table-divider"),
          createDisplayLine("│ Elena  │ Active │ 92.1  │", "table-row"),
          createDisplayLine("└────────┴────────┴───────┘", "table-divider"),
        ];
      },
      wrapDisplayLines(lines) {
        return lines;
      },
      renderEventBodyLine(_event, line) {
        return `<render:${line?.mode}>${line?.text ?? ""}`;
      },
    },
  });

  const lines = harness.controller.buildVisibleFrameSnapshot().lines.map((line) => String(line));
  const topRow = lines.findIndex((line) => line.includes("┌────────"));
  const headerRow = lines.findIndex((line) => line.includes("│ Name"));
  const dividerRow = lines.findIndex((line) => line.includes("├────────"));
  const dataRow = lines.findIndex((line) => line.includes("│ Elena"));
  const bottomRow = lines.findIndex((line) => line.includes("└────────"));
  const tableRows = lines.slice(topRow, bottomRow + 1);

  assert.notEqual(topRow, -1);
  assert.notEqual(headerRow, -1);
  assert.notEqual(dividerRow, -1);
  assert.notEqual(dataRow, -1);
  assert.notEqual(bottomRow, -1);
  assert.deepEqual([headerRow, dividerRow, dataRow, bottomRow], [topRow + 1, topRow + 2, topRow + 3, topRow + 4]);
  assert.equal(tableRows.some((line) => line.trim().length === 0), false);
  assert.ok(lines.some((line) => line.includes("<render:table-divider>┌")));
  assert.ok(lines.some((line) => line.includes("<render:table-header>│ Name")));
});
