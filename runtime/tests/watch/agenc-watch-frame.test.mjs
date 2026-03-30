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
  assert.equal(layout.bodyHeight, 29);
  assert.equal(harness.layoutCalls.length, 1);
  assert.equal(harness.layoutCalls[0].slashMode, true);
  assert.equal(harness.layoutCalls[0].detailOpen, false);
  assert.ok(harness.layoutCalls[0].popupRows > 0);
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

test("frame controller wraps long slash palette usage lines instead of truncating them", () => {
  const fitCalls = [];
  const wrapCalls = [];
  const harness = createWatchFrameHarness({
    inputValue: "/pe",
    suggestions: [{
      usage: "/permissions [status|simulate <toolName> [jsonArgs]|credentials|requests|approve <requestId>|deny <requestId>]",
      description: "Inspect policy state or simulate approval and policy decisions.",
      aliases: [],
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
      wrapAndLimit(text, width, maxLines = 2) {
        const value = String(text ?? "");
        wrapCalls.push({ text: value, width, maxLines });
        if (value.startsWith("/permissions")) {
          return [
            "/permissions [status|simulate",
            "<toolName> [jsonArgs]|credentials|",
            "requests|approve <requestId>|deny <requestId>]",
          ];
        }
        return [value];
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
    wrapCalls.some((call) => call.width === 36 && call.maxLines === 3 && call.text.startsWith("/permissions")),
  );
  assert.ok(
    fitCalls.some((call) =>
      call.width === 36 &&
      call.text.includes("/permissions [status|simulate"),
    ),
  );
  assert.ok(
    fitCalls.some((call) =>
      call.width === 36 &&
      call.text.includes("<toolName> [jsonArgs]|credentials|"),
    ),
  );
  assert.ok(
    fitCalls.some((call) =>
      call.width === 36 &&
      call.text.includes("requests|approve <requestId>|deny <requestId>]"),
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
    fitCalls.some((call) => call.width === 36 && call.text.includes("types.ts")),
  );
  assert.ok(
    fitCalls.some((call) => call.width === 36 && call.text.includes("runtime/src/channels/webchat")),
  );
});

test("frame controller renders the structured statusline when enabled", () => {
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

  assert.match(frameText, /PROV grok/);
  assert.match(frameText, /MODEL grok-4\.20/);
  assert.match(frameText, /SESS 12345678/);
  assert.match(frameText, /USAGE 3\.4K total/);
  assert.match(frameText, /CKPT cp-9/);
});
