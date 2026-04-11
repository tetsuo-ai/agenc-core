import test from "node:test";
import assert from "node:assert/strict";

import { createWatchInputController } from "../../src/watch/agenc-watch-input.mjs";
import {
  deleteComposerBackward as deleteComposerBackwardState,
  deleteComposerForward as deleteComposerForwardState,
  deleteComposerToLineEnd as deleteComposerToLineEndState,
  insertComposerText,
  moveComposerCursorByCharacter as moveComposerCursorByCharacterState,
} from "../../src/watch/agenc-watch-composer.mjs";

function createInputHarness(overrides = {}) {
  const watchState = {
    composerInput: "",
    composerCursor: 0,
    composerHistoryIndex: -1,
    expandedEventId: null,
    detailScrollOffset: 0,
    introDismissed: false,
    composerPastedRanges: [],
    composerPasteSequence: 0,
    secretPrompt: overrides.secretPrompt ?? null,
    inputPreferences: overrides.inputPreferences ?? {
      inputModeProfile: "default",
      keybindingProfile: "default",
      themeName: "default",
    },
    composerMode: overrides.composerMode ?? "insert",
  };
  const calls = [];
  const controller = createWatchInputController({
    watchState,
    currentInputPreferences: overrides.currentInputPreferences ?? (() => watchState.inputPreferences),
    shuttingDown: overrides.shuttingDown ?? (() => false),
    parseMouseWheelSequence: overrides.parseMouseWheelSequence ?? (() => null),
    scrollCurrentViewBy(delta) {
      calls.push({ type: "scroll", delta });
    },
    shutdownWatch(code) {
      calls.push({ type: "shutdown", code });
    },
    toggleExpandedEvent() {
      calls.push({ type: "toggleExpandedEvent" });
    },
    toggleTerminalSelectionMode() {
      calls.push({ type: "toggleSelectionMode" });
    },
    currentDiffNavigationState() {
      return overrides.currentDiffNavigationState ?? { enabled: false };
    },
    jumpCurrentDiffHunk(direction) {
      calls.push({ type: "jumpDiffHunk", direction });
      return true;
    },
    copyCurrentView() {
      calls.push({ type: "copy" });
    },
    isTerminalSelectionModeActive: overrides.isTerminalSelectionModeActive ?? (() => false),
    clearLiveTranscriptView() {
      calls.push({ type: "clear" });
    },
    deleteComposerTail() {
      deleteComposerToLineEndState(watchState);
      calls.push({ type: "deleteTail" });
    },
    deleteComposerBackward() {
      deleteComposerBackwardState(watchState);
      calls.push({ type: "deleteBackward" });
    },
    deleteComposerForward() {
      deleteComposerForwardState(watchState);
      calls.push({ type: "deleteForward" });
    },
    autocompleteComposerInput() {
      calls.push({ type: "autocomplete" });
    },
    acceptComposerPaletteSelection: overrides.acceptComposerPaletteSelection ?? (() => false),
    navigateComposer(direction) {
      calls.push({ type: "navigate", direction });
    },
    hasActiveMarketTaskBrowser: overrides.hasActiveMarketTaskBrowser ?? (() => false),
    navigateMarketTaskBrowser(direction) {
      calls.push({ type: "navigateMarketTaskBrowser", direction });
      return true;
    },
    toggleMarketTaskBrowserExpansion() {
      calls.push({ type: "toggleMarketTaskBrowserExpansion" });
      return true;
    },
    dismissMarketTaskBrowser() {
      calls.push({ type: "dismissMarketTaskBrowser" });
      return true;
    },
    hasActiveComposerPalette: overrides.hasActiveComposerPalette ?? (() => false),
    navigateComposerPalette(direction) {
      calls.push({ type: "navigatePalette", direction });
      return true;
    },
    moveComposerCursorByCharacter(direction) {
      moveComposerCursorByCharacterState(watchState, direction);
      calls.push({ type: "moveCharacter", direction });
    },
    moveComposerCursorByWord(direction) {
      calls.push({ type: "moveWord", direction });
    },
    setTransientStatus(status) {
      calls.push({ type: "status", status });
    },
    dismissIntro() {
      watchState.introDismissed = true;
      calls.push({ type: "dismissIntro" });
    },
    insertComposerTextValue(char, options = {}) {
      insertComposerText(watchState, char, options);
      calls.push({ type: "insert", char, options });
    },
    resetComposer() {
      watchState.composerInput = "";
      watchState.composerCursor = 0;
      watchState.composerHistoryIndex = -1;
      calls.push({ type: "resetComposer" });
    },
    recordComposerHistory(value) {
      calls.push({ type: "recordHistory", value });
    },
    operatorInputBatcher: {
      push(value) {
        calls.push({ type: "submit", value });
      },
    },
    cancelActiveChat() {
      calls.push({ type: "cancelActiveChat" });
      return true;
    },
    scheduleRender() {
      calls.push({ type: "render" });
    },
  });
  return { controller, watchState, calls };
}

test("input controller inserts visible characters and dismisses the intro", () => {
  const { controller, watchState, calls } = createInputHarness();

  controller.handleTerminalInput("ab");

  assert.equal(watchState.composerInput, "ab");
  assert.equal(watchState.composerCursor, 2);
  assert.ok(calls.some((entry) => entry.type === "dismissIntro"));
  assert.ok(calls.some((entry) => entry.type === "render"));
});

test("input controller handles enter, tab, and ctrl shortcuts", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.composerInput = "show status";
  watchState.composerCursor = watchState.composerInput.length;

  controller.handleTerminalInput("\t\r\x0f\x19\x11\x0c");

  assert.ok(calls.some((entry) => entry.type === "autocomplete"));
  assert.ok(calls.some((entry) => entry.type === "submit" && entry.value === "show status"));
  assert.ok(calls.some((entry) => entry.type === "recordHistory" && entry.value === "show status"));
  assert.ok(calls.some((entry) => entry.type === "resetComposer"));
  assert.ok(calls.some((entry) => entry.type === "toggleExpandedEvent"));
  assert.ok(calls.some((entry) => entry.type === "copy"));
  assert.ok(calls.some((entry) => entry.type === "toggleSelectionMode"));
  assert.ok(calls.some((entry) => entry.type === "clear"));
});

test("input controller limits input while terminal selection mode is active", () => {
  const { controller, watchState, calls } = createInputHarness({
    isTerminalSelectionModeActive: () => true,
  });
  watchState.composerInput = "keep me";
  watchState.composerCursor = watchState.composerInput.length;

  controller.handleTerminalInput("abc\x11");

  assert.equal(watchState.composerInput, "keep me");
  assert.ok(calls.some((entry) => entry.type === "toggleSelectionMode"));
  assert.equal(calls.some((entry) => entry.type === "insert"), false);
});

test("input controller applies the active palette selection before submitting on enter", () => {
  const { controller, watchState, calls } = createInputHarness({
    hasActiveComposerPalette: () => true,
    acceptComposerPaletteSelection() {
      watchState.composerInput = "/model grok-4-1-fast-reasoning";
      watchState.composerCursor = watchState.composerInput.length;
      calls.push({ type: "acceptPaletteSelection" });
      return true;
    },
  });
  watchState.composerInput = "/model gro";
  watchState.composerCursor = watchState.composerInput.length;

  controller.handleTerminalInput("\r");

  assert.ok(calls.some((entry) => entry.type === "acceptPaletteSelection"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "submit" &&
        entry.value === "/model grok-4-1-fast-reasoning",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "recordHistory" &&
        entry.value === "/model grok-4-1-fast-reasoning",
    ),
  );
});

test("input controller routes mouse-wheel packets to viewport scrolling", () => {
  const { controller, calls } = createInputHarness({
    parseMouseWheelSequence(input, index) {
      if (index === 0) {
        return { isWheel: true, delta: 3, length: input.length };
      }
      return null;
    },
  });

  controller.handleTerminalInput("wheel");

  assert.ok(calls.some((entry) => entry.type === "scroll" && entry.delta === 3));
});

test("input controller closes expanded detail on plain escape", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.expandedEventId = "evt-1";
  watchState.detailScrollOffset = 8;

  controller.handleTerminalEscapeSequence("\x1b", 0);

  assert.equal(watchState.expandedEventId, null);
  assert.equal(watchState.detailScrollOffset, 0);
  assert.ok(calls.some((entry) => entry.type === "status" && entry.status === "detail closed"));
});

test("input controller ignores unknown escape sequences without cancelling or leaking text", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.composerInput = "hello";
  watchState.composerCursor = 5;

  controller.handleTerminalInput("\x1b[999~");

  assert.equal(watchState.composerInput, "hello");
  assert.equal(calls.some((entry) => entry.type === "cancelActiveChat"), false);
});

test("input controller routes arrow keys to palette navigation while the composer palette is open", () => {
  const { controller, calls } = createInputHarness({
    hasActiveComposerPalette: () => true,
  });

  controller.handleTerminalInput("\x1b[A\x1b[B");

  assert.deepEqual(
    calls.filter((entry) => entry.type === "navigatePalette"),
    [
      { type: "navigatePalette", direction: -1 },
      { type: "navigatePalette", direction: 1 },
    ],
  );
  assert.equal(calls.some((entry) => entry.type === "navigate"), false);
});

test("input controller routes arrow keys to the market browser before palette navigation", () => {
  const { controller, calls } = createInputHarness({
    hasActiveMarketTaskBrowser: () => true,
    hasActiveComposerPalette: () => true,
  });

  controller.handleTerminalInput("\x1b[A\x1b[B");

  assert.deepEqual(
    calls.filter((entry) => entry.type === "navigateMarketTaskBrowser"),
    [
      { type: "navigateMarketTaskBrowser", direction: -1 },
      { type: "navigateMarketTaskBrowser", direction: 1 },
    ],
  );
  assert.equal(calls.some((entry) => entry.type === "navigatePalette"), false);
  assert.equal(calls.some((entry) => entry.type === "navigate"), false);
});

test("input controller toggles market task details instead of submitting when the browser is active", () => {
  const { controller, watchState, calls } = createInputHarness({
    hasActiveMarketTaskBrowser: () => true,
  });
  watchState.composerInput = "leave me alone";
  watchState.composerCursor = watchState.composerInput.length;

  controller.handleTerminalInput("\r");

  assert.equal(watchState.composerInput, "leave me alone");
  assert.ok(calls.some((entry) => entry.type === "toggleMarketTaskBrowserExpansion"));
  assert.equal(calls.some((entry) => entry.type === "submit"), false);
});

test("input controller dismisses the market task browser before closing detail or cancelling chat", () => {
  const { controller, watchState, calls } = createInputHarness({
    hasActiveMarketTaskBrowser: () => true,
  });
  watchState.expandedEventId = "evt-1";

  controller.handleTerminalEscapeSequence("\x1b", 0);

  assert.ok(calls.some((entry) => entry.type === "dismissMarketTaskBrowser"));
  assert.equal(watchState.expandedEventId, "evt-1");
  assert.equal(calls.some((entry) => entry.type === "cancelActiveChat"), false);
});

test("input controller routes ctrl+p and ctrl+n to diff hunk navigation only in diff detail mode", () => {
  const { controller, calls } = createInputHarness({
    currentDiffNavigationState: { enabled: true, currentHunkIndex: 1, totalHunks: 3 },
  });

  controller.handleTerminalInput("\x10\x0e");

  assert.deepEqual(
    calls.filter((entry) => entry.type === "jumpDiffHunk"),
    [
      { type: "jumpDiffHunk", direction: -1 },
      { type: "jumpDiffHunk", direction: 1 },
    ],
  );
});

test("input controller ignores diff shortcuts outside diff detail mode", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.composerInput = "hello";
  watchState.composerCursor = 5;

  controller.handleTerminalInput("\x10\x0e");

  assert.equal(calls.some((entry) => entry.type === "jumpDiffHunk"), false);
  assert.equal(watchState.composerInput, "hello");
});

test("input controller inserts bracketed paste text without auto-submitting it", () => {
  const { controller, watchState, calls } = createInputHarness();

  controller.handleTerminalInput("\x1b[200~alpha\r\nbeta\x1b[201~");

  assert.equal(watchState.composerInput, "alpha\nbeta");
  assert.equal(
    calls.some((entry) => entry.type === "submit"),
    false,
  );
  assert.ok(
    calls.some((entry) => entry.type === "insert" && entry.options?.markPasted === true),
  );
});

test("input controller captures secret prompt text locally without mutating composer state", () => {
  const { controller, watchState, calls } = createInputHarness({
    secretPrompt: {
      kind: "xai-api-key",
      label: "xai key",
      value: "",
      pending: false,
      onSubmit() {},
      onCancel() {},
    },
  });

  controller.handleTerminalInput("ab");
  controller.handleTerminalInput("\x1b[200~12\r\n34\x1b[201~");
  controller.handleTerminalInput("\x7f");

  assert.equal(watchState.secretPrompt?.value, "ab12\n3");
  assert.equal(watchState.composerInput, "");
  assert.equal(
    calls.some((entry) => entry.type === "insert"),
    false,
  );
  assert.equal(
    calls.some((entry) => entry.type === "submit"),
    false,
  );
});

test("input controller submits and cancels secret prompts locally", () => {
  const submissions = [];
  const { controller, watchState, calls } = createInputHarness();
  watchState.secretPrompt = {
    kind: "xai-api-key",
    label: "xai key",
    value: "",
    pending: false,
    onSubmit(value) {
      submissions.push(value);
      watchState.secretPrompt.pending = true;
    },
    onCancel() {
      calls.push({ type: "cancelSecretPrompt" });
      watchState.secretPrompt = null;
    },
  };

  controller.handleTerminalInput("key\r");
  controller.handleTerminalInput("ignored");

  assert.deepEqual(submissions, ["key"]);
  assert.equal(watchState.secretPrompt?.value, "key");
  assert.equal(watchState.composerInput, "");

  watchState.secretPrompt.pending = false;
  controller.handleTerminalInput("\x1b");

  assert.equal(watchState.secretPrompt, null);
  assert.ok(calls.some((entry) => entry.type === "cancelSecretPrompt"));
});

test("input controller backspace deletes an entire pasted placeholder block", () => {
  const { controller, watchState } = createInputHarness();

  controller.handleTerminalInput("\x1b[200~alpha\r\nbeta\x1b[201~");
  controller.handleTerminalInput("\x7f");

  assert.equal(watchState.composerInput, "");
  assert.equal(watchState.composerCursor, 0);
  assert.deepEqual(watchState.composerPastedRanges, []);
});

test("input controller delete removes an entire pasted placeholder block from its start", () => {
  const { controller, watchState } = createInputHarness();

  controller.handleTerminalInput("x");
  controller.handleTerminalInput("\x1b[200~alpha\r\nbeta\x1b[201~");
  controller.handleTerminalInput("\x1b[D");
  controller.handleTerminalEscapeSequence("\x1b[3~", 0);

  assert.equal(watchState.composerInput, "x");
  assert.equal(watchState.composerCursor, 1);
  assert.deepEqual(watchState.composerPastedRanges, []);
});

test("input controller enters vim normal mode on escape and resumes insert mode on i", () => {
  const { controller, watchState, calls } = createInputHarness({
    inputPreferences: {
      inputModeProfile: "vim",
      keybindingProfile: "vim",
      themeName: "aurora",
    },
  });

  controller.handleTerminalEscapeSequence("\x1b", 0);
  controller.handleTerminalInput("ix");

  assert.equal(watchState.composerMode, "insert");
  assert.equal(watchState.composerInput, "x");
  assert.ok(calls.some((entry) => entry.type === "status" && entry.status === "vim normal"));
  assert.ok(calls.some((entry) => entry.type === "status" && entry.status === "vim insert"));
});

test("input controller uses vim normal-mode motions without inserting text", () => {
  const { controller, watchState, calls } = createInputHarness({
    inputPreferences: {
      inputModeProfile: "vim",
      keybindingProfile: "vim",
      themeName: "ember",
    },
    composerMode: "normal",
  });
  watchState.composerInput = "abcd";
  watchState.composerCursor = 2;

  controller.handleTerminalInput("hxjk");

  assert.equal(watchState.composerInput, "acd");
  assert.equal(watchState.composerCursor, 1);
  assert.ok(calls.some((entry) => entry.type === "scroll" && entry.delta === -1));
  assert.ok(calls.some((entry) => entry.type === "scroll" && entry.delta === 1));
});
