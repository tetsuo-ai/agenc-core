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
  };
  const calls = [];
  const controller = createWatchInputController({
    watchState,
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
    navigateComposer(direction) {
      calls.push({ type: "navigate", direction });
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

  controller.handleTerminalInput("\t\r\x0f\x19\x0c");

  assert.ok(calls.some((entry) => entry.type === "autocomplete"));
  assert.ok(calls.some((entry) => entry.type === "submit" && entry.value === "show status"));
  assert.ok(calls.some((entry) => entry.type === "recordHistory" && entry.value === "show status"));
  assert.ok(calls.some((entry) => entry.type === "resetComposer"));
  assert.ok(calls.some((entry) => entry.type === "toggleExpandedEvent"));
  assert.ok(calls.some((entry) => entry.type === "copy"));
  assert.ok(calls.some((entry) => entry.type === "clear"));
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
