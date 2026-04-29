import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTranscriptCardSearchText,
  computeTranscriptPreviewMaxLines,
  getTranscriptCardActions,
  resolveTranscriptCardLabel,
  splitTranscriptPreviewForHeadline,
} from "../../src/watch/agenc-watch-transcript-cards.mjs";

test("splitTranscriptPreviewForHeadline consumes the first preview line for agent and user cards", () => {
  const previewLines = [
    { text: "Linked List in C", plainText: "Linked List in C" },
    { text: "Here's a clean example", plainText: "Here's a clean example" },
  ];

  const agentCard = splitTranscriptPreviewForHeadline({ kind: "agent" }, previewLines);
  assert.equal(agentCard.headline, "Linked List in C");
  assert.deepEqual(agentCard.bodyLines.map((line) => line.plainText), ["Here's a clean example"]);

  const toolCard = splitTranscriptPreviewForHeadline({ kind: "tool result" }, previewLines);
  assert.equal(toolCard.headline, "");
  assert.deepEqual(toolCard.bodyLines.map((line) => line.plainText), [
    "Linked List in C",
    "Here's a clean example",
  ]);
});

test("computeTranscriptPreviewMaxLines gives the latest followed agent more room", () => {
  const followedLatest = computeTranscriptPreviewMaxLines({
    eventKind: "agent",
    latestIsCurrent: true,
    following: true,
    viewportLines: 28,
    maxPreviewSourceLines: 160,
  });
  const olderAgent = computeTranscriptPreviewMaxLines({
    eventKind: "agent",
    latestIsCurrent: false,
    following: true,
    viewportLines: 28,
    maxPreviewSourceLines: 160,
  });

  assert.equal(followedLatest, Infinity);
  assert.ok(followedLatest > olderAgent);
});

test("computeTranscriptPreviewMaxLines gives marketplace events enough room for multi-row previews", () => {
  const generic = computeTranscriptPreviewMaxLines({
    eventKind: "history",
    latestIsCurrent: false,
    following: true,
    viewportLines: 28,
    maxPreviewSourceLines: 160,
  });
  const market = computeTranscriptPreviewMaxLines({
    eventKind: "market",
    latestIsCurrent: false,
    following: true,
    viewportLines: 28,
    maxPreviewSourceLines: 160,
  });

  assert.equal(generic, 2);
  assert.equal(market, 6);
  assert.ok(market > generic);
});

test("buildTranscriptCardSearchText indexes visible tool fields only", () => {
  const searchText = buildTranscriptCardSearchText(
    {
      kind: "tool result",
      title: "Search ready",
      body: "<system-reminder>hidden policy</system-reminder>visible body",
      toolName: "Grep",
      toolArgs: {
        pattern: "ready",
        path: "src",
        hiddenPromptState: "do not index",
      },
      toolResult: {
        filenames: ["src/app.ts"],
        internalModelTrace: "do not index",
      },
    },
    [{ plainText: "preview line" }],
  );

  assert.match(searchText, /Search ready/);
  assert.match(searchText, /visible body/);
  assert.match(searchText, /ready/);
  assert.match(searchText, /src\/app\.ts/);
  assert.doesNotMatch(searchText, /hidden policy/);
  assert.doesNotMatch(searchText, /hiddenPromptState|internalModelTrace|do not index/);
});

test("transcript card labels and actions expose supported watch affordances", () => {
  assert.equal(
    resolveTranscriptCardLabel({
      kind: "tool result",
      toolName: "ExitPlanMode",
    }),
    "PLAN",
  );
  assert.equal(
    resolveTranscriptCardLabel({
      kind: "tool result",
      toolName: "VerifyPlanExecution",
    }),
    "VERIFY",
  );
  assert.deepEqual(
    getTranscriptCardActions({
      kind: "approval",
      filePath: ".agenc/plans/demo.md",
      toolName: "ExitPlanMode",
    }),
    ["copy", "detail", "open-file", "review-approval", "open-plan"],
  );
});

test("computeTranscriptPreviewMaxLines gives approvals room for actionable detail", () => {
  assert.equal(
    computeTranscriptPreviewMaxLines({
      eventKind: "approval",
      latestIsCurrent: true,
      viewportLines: 28,
    }),
    6,
  );
});
