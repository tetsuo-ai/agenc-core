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
  assert.match(frameText, /~\/(?:agenc-core(?:\/runtime)?)?\n>/);
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

  const assistantRow = lines.findIndex((line, index) =>
    index > firstUserRow && line.includes("respuesta corta")
  );
  assert.notEqual(assistantRow, -1);
  assert.equal(
    lines.slice(firstUserRow + 2, assistantRow).some((line) => /^─+$/.test(line)),
    false,
  );
});
