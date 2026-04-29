/**
 * Wave 3-A: composer reducer unit tests.
 *
 * Exercises the pure `composerReducer` without a React render so every
 * state transition can be asserted deterministically.
 */

import { describe, expect, test } from "vitest";
import type { HistoryEntry } from "./history.js";
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  composerReducer,
  expandPendingPastes,
  type ComposerState,
} from "./useComposerState.js";

function entry(value: string, overrides?: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: 0,
    value,
    ...overrides,
  };
}

function entries(...values: string[]): HistoryEntry[] {
  return values.map((v) => entry(v));
}

function freshState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    cursor: 0,
    history: [],
    historyIdx: null,
    draftBeforeHistory: null,
    historySearch: null,
    pendingPastes: [],
    largePasteCounters: {},
    localImages: [],
    remoteImages: [],
    selectedRemoteImageIndex: null,
    pasteInFlight: false,
    pendingEnters: 0,
    killBuffer: null,
    ...overrides,
  };
}

describe("composerReducer", () => {
  test("INSERT at cursor advances cursor by text length", () => {
    const start = freshState({ value: "ab", cursor: 1 });
    const next = composerReducer(start, { type: "INSERT", text: "XY" });
    expect(next.value).toBe("aXYb");
    expect(next.cursor).toBe(3);
  });

  test("DELETE_BACKWARD at position 0 is a no-op", () => {
    const start = freshState({ value: "abc", cursor: 0 });
    const next = composerReducer(start, { type: "DELETE_BACKWARD" });
    expect(next.value).toBe("abc");
    expect(next.cursor).toBe(0);
  });

  test("DELETE_BACKWARD removes the character immediately before cursor", () => {
    const start = freshState({ value: "abc", cursor: 2 });
    const next = composerReducer(start, { type: "DELETE_BACKWARD" });
    expect(next.value).toBe("ac");
    expect(next.cursor).toBe(1);
  });

  test("REPLACE_RANGE swaps only the targeted token and lands the cursor after the replacement", () => {
    const start = freshState({ value: "/he foo", cursor: 3 });
    const next = composerReducer(start, {
      type: "REPLACE_RANGE",
      start: 0,
      end: 3,
      text: "/help",
    });
    expect(next.value).toBe("/help foo");
    expect(next.cursor).toBe(5);
  });

  test("SUBMIT commits value to history and resets the buffer", () => {
    const start = freshState({ value: "hello", cursor: 5 });
    const next = composerReducer(start, { type: "SUBMIT" });
    expect(next.value).toBe("");
    expect(next.cursor).toBe(0);
    expect(next.history.map((e) => e.value)).toEqual(["hello"]);
    expect(next.historyIdx).toBeNull();
  });

  test("SUBMIT with historyMentions persists them on the new entry", () => {
    const start = freshState({ value: "see @x.ts", cursor: 9 });
    const next = composerReducer(start, {
      type: "SUBMIT",
      historyValue: "see @x.ts",
      historyMentions: [
        { start: 4, end: 9, kind: "file", resolved: "/repo/x.ts" },
      ],
    });
    expect(next.history[0]?.value).toBe("see @x.ts");
    expect(next.history[0]?.mentions).toEqual([
      { start: 4, end: 9, kind: "file", resolved: "/repo/x.ts" },
    ]);
  });

  test("large paste inserts a placeholder and expands on submit", () => {
    const pasted = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 5);
    let state = freshState();
    state = composerReducer(state, { type: "INSERT_PASTE", text: pasted });

    expect(state.value).toBe(
      `[Pasted Content ${LARGE_PASTE_CHAR_THRESHOLD + 5} chars]`,
    );
    expect(state.pendingPastes).toEqual([
      { placeholder: state.value, text: pasted },
    ]);
    expect(expandPendingPastes(state.value, state.pendingPastes)).toBe(pasted);

    state = composerReducer(state, {
      type: "SUBMIT",
      historyValue: expandPendingPastes(state.value, state.pendingPastes),
    });
    expect(state.value).toBe("");
    expect(state.history.map((e) => e.value)).toEqual([pasted]);
    expect(state.pendingPastes).toEqual([]);
  });

  test("repeated same-size large pastes get unique placeholders", () => {
    const pasted = "y".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1);
    let state = freshState();
    state = composerReducer(state, { type: "INSERT_PASTE", text: pasted });
    state = composerReducer(state, { type: "INSERT", text: "\n" });
    state = composerReducer(state, { type: "INSERT_PASTE", text: pasted });

    expect(state.pendingPastes.map((paste) => paste.placeholder)).toEqual([
      `[Pasted Content ${LARGE_PASTE_CHAR_THRESHOLD + 1} chars]`,
      `[Pasted Content ${LARGE_PASTE_CHAR_THRESHOLD + 1} chars] #2`,
    ]);
  });

  test("remote image rows relabel existing local placeholders", () => {
    let state = freshState();
    state = composerReducer(state, {
      type: "ATTACH_IMAGE",
      kind: "local",
      source: "/tmp/local.png",
    });
    expect(state.value).toBe("[Image #1]");

    state = composerReducer(state, {
      type: "ATTACH_IMAGE",
      kind: "remote",
      source: "https://example.com/cat.png",
    });
    expect(state.remoteImages.map((image) => image.placeholder)).toEqual([
      "[Image #1]",
    ]);
    expect(state.value).toBe("[Image #2]");
    expect(state.localImages.map((image) => image.placeholder)).toEqual([
      "[Image #2]",
    ]);

    state = composerReducer(state, { type: "DELETE_SELECTED_REMOTE_IMAGE" });
    expect(state.remoteImages).toEqual([]);
    expect(state.value).toBe("[Image #1]");
    expect(state.localImages.map((image) => image.placeholder)).toEqual([
      "[Image #1]",
    ]);
  });

  test("SUBMIT while paste is in flight buffers the Enter press", () => {
    const start = freshState({
      value: "typed",
      cursor: 5,
      pasteInFlight: true,
      pendingEnters: 0,
    });
    const next = composerReducer(start, { type: "SUBMIT" });
    expect(next.pendingEnters).toBe(1);
    expect(next.value).toBe("typed");
    expect(next.cursor).toBe(5);
    expect(next.history).toEqual([]);
  });

  test("PASTE_COMPLETE flushes all pending enters in order", () => {
    let state = freshState({
      value: "one",
      cursor: 3,
      pasteInFlight: true,
    });
    // Three enter presses while paste was streaming.
    state = composerReducer(state, { type: "SUBMIT" });
    state = composerReducer(state, { type: "SUBMIT" });
    state = composerReducer(state, { type: "SUBMIT" });
    expect(state.pendingEnters).toBe(3);

    // The first replayed SUBMIT commits "one"; subsequent replays see
    // an empty value and therefore do not double-append.
    const after = composerReducer(state, { type: "PASTE_COMPLETE" });
    expect(after.pasteInFlight).toBe(false);
    expect(after.pendingEnters).toBe(0);
    expect(after.history.map((e) => e.value)).toEqual(["one"]);
    expect(after.value).toBe("");
  });

  test("HISTORY_PREV stashes the current draft on the first press", () => {
    const start = freshState({
      value: "draft",
      cursor: 5,
      history: entries("older"),
    });
    const next = composerReducer(start, { type: "HISTORY_PREV" });
    expect(next.value).toBe("older");
    expect(next.cursor).toBe(5);
    expect(next.historyIdx).toBe(0);
    expect(next.draftBeforeHistory).toBe("draft");
  });

  test("HISTORY_NEXT from top of history restores the stashed draft", () => {
    let state = freshState({
      value: "draft",
      cursor: 5,
      history: entries("older"),
    });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    expect(state.value).toBe("older");
    state = composerReducer(state, { type: "HISTORY_NEXT" });
    expect(state.value).toBe("draft");
    expect(state.cursor).toBe(5);
    expect(state.historyIdx).toBeNull();
    expect(state.draftBeforeHistory).toBeNull();
  });

  test("HISTORY_PREV clamps at the oldest entry", () => {
    let state = freshState({
      value: "",
      cursor: 0,
      history: entries("newest", "middle", "oldest"),
    });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    // Already at the oldest; one more press must not overshoot.
    state = composerReducer(state, { type: "HISTORY_PREV" });
    expect(state.historyIdx).toBe(2);
    expect(state.value).toBe("oldest");
  });

  test("HISTORY_PREV preserves persisted mention metadata on recall", () => {
    const start = freshState({
      value: "draft",
      cursor: 5,
      history: [
        entry("look at @src/index.ts", {
          mentions: [
            {
              start: 8,
              end: 21,
              kind: "file",
              resolved: "/repo/src/index.ts",
            },
          ],
        }),
      ],
    });
    const next = composerReducer(start, { type: "HISTORY_PREV" });
    expect(next.value).toBe("look at @src/index.ts");
    expect(next.history[0]?.mentions).toEqual([
      { start: 8, end: 21, kind: "file", resolved: "/repo/src/index.ts" },
    ]);
  });

  test("HISTORY_SEARCH_START snapshots the current draft without previewing history yet", () => {
    const start = freshState({
      value: "draft",
      cursor: 3,
      history: entries("second", "first"),
    });
    const next = composerReducer(start, { type: "HISTORY_SEARCH_START" });
    expect(next.value).toBe("draft");
    expect(next.cursor).toBe(3);
    expect(next.historySearch).toMatchObject({
      originalValue: "draft",
      originalCursor: 3,
      query: "",
      status: "idle",
    });
  });

  test("HISTORY_SEARCH_APPEND previews the newest unique match and older/newer walk matches", () => {
    let state = freshState({
      value: "draft",
      cursor: 5,
      history: entries("alpha two", "alpha one", "alpha one", "beta"),
    });
    state = composerReducer(state, { type: "HISTORY_SEARCH_START" });
    state = composerReducer(state, {
      type: "HISTORY_SEARCH_APPEND",
      text: "alpha",
    });
    expect(state.value).toBe("alpha two");
    expect(state.historySearch).toMatchObject({
      query: "alpha",
      matchIndex: 0,
      status: "match",
    });
    expect(state.historySearch?.matches.map((m) => m.value)).toEqual([
      "alpha two",
      "alpha one",
    ]);

    state = composerReducer(state, { type: "HISTORY_SEARCH_OLDER" });
    expect(state.value).toBe("alpha one");
    expect(state.historySearch?.matchIndex).toBe(1);

    state = composerReducer(state, { type: "HISTORY_SEARCH_NEWER" });
    expect(state.value).toBe("alpha two");
    expect(state.historySearch?.matchIndex).toBe(0);
  });

  test("HISTORY_SEARCH_CANCEL restores the original draft", () => {
    let state = freshState({
      value: "draft",
      cursor: 2,
      history: entries("alpha one"),
    });
    state = composerReducer(state, { type: "HISTORY_SEARCH_START" });
    state = composerReducer(state, {
      type: "HISTORY_SEARCH_APPEND",
      text: "alpha",
    });
    expect(state.value).toBe("alpha one");

    state = composerReducer(state, { type: "HISTORY_SEARCH_CANCEL" });
    expect(state.value).toBe("draft");
    expect(state.cursor).toBe(2);
    expect(state.historySearch).toBeNull();
  });

  test("HISTORY_SEARCH_ACCEPT keeps the previewed match as the draft", () => {
    let state = freshState({
      value: "draft",
      cursor: 5,
      history: entries("alpha one"),
    });
    state = composerReducer(state, { type: "HISTORY_SEARCH_START" });
    state = composerReducer(state, {
      type: "HISTORY_SEARCH_APPEND",
      text: "alpha",
    });
    state = composerReducer(state, { type: "HISTORY_SEARCH_ACCEPT" });
    expect(state.value).toBe("alpha one");
    expect(state.cursor).toBe("alpha one".length);
    expect(state.historySearch).toBeNull();
  });

  test("HISTORY_SEARCH with no match restores the draft but stays active for further edits", () => {
    let state = freshState({
      value: "draft",
      cursor: 5,
      history: entries("alpha one"),
    });
    state = composerReducer(state, { type: "HISTORY_SEARCH_START" });
    state = composerReducer(state, {
      type: "HISTORY_SEARCH_APPEND",
      text: "zzz",
    });
    expect(state.value).toBe("draft");
    expect(state.cursor).toBe(5);
    expect(state.historySearch).toMatchObject({
      query: "zzz",
      status: "no-match",
      matchIndex: null,
    });
  });

  test("LOAD_HISTORY merges disk entries behind live in-memory prompts", () => {
    const start = freshState({
      value: "draft",
      cursor: 5,
      history: entries("live prompt", "shared"),
    });
    const next = composerReducer(start, {
      type: "LOAD_HISTORY",
      history: entries("disk newest", "shared", "disk oldest"),
    });
    expect(next.history.map((e) => e.value)).toEqual([
      "live prompt",
      "shared",
      "disk newest",
      "disk oldest",
    ]);
    expect(next.value).toBe("draft");
    expect(next.cursor).toBe(5);
  });

  test("LOAD_HISTORY refreshes active reverse search matches", () => {
    let state = freshState({
      value: "draft",
      cursor: 5,
      history: [],
    });
    state = composerReducer(state, { type: "HISTORY_SEARCH_START" });
    state = composerReducer(state, {
      type: "HISTORY_SEARCH_APPEND",
      text: "alpha",
    });
    expect(state.historySearch?.status).toBe("no-match");

    state = composerReducer(state, {
      type: "LOAD_HISTORY",
      history: entries("alpha from disk"),
    });

    expect(state.value).toBe("alpha from disk");
    expect(state.historySearch).toMatchObject({
      query: "alpha",
      status: "match",
      matchIndex: 0,
    });
  });

  test("MOVE_CURSOR clamps to [0, value.length]", () => {
    const start = freshState({ value: "abc", cursor: 1 });
    const left = composerReducer(start, { type: "MOVE_CURSOR", delta: -10 });
    expect(left.cursor).toBe(0);
    const right = composerReducer(start, { type: "MOVE_CURSOR", delta: +10 });
    expect(right.cursor).toBe(3);
  });

  test("MOVE_CURSOR_HOME jumps to the start of the current line", () => {
    // value = "line one\nline two" — cursor mid-second-line, HOME should
    // land on index 9 (immediately after the \n at position 8).
    const start = freshState({
      value: "line one\nline two",
      cursor: 13,
    });
    const next = composerReducer(start, { type: "MOVE_CURSOR_HOME" });
    expect(next.cursor).toBe(9);
  });

  test("MOVE_CURSOR_END jumps to the end of the current line", () => {
    const start = freshState({
      value: "line one\nline two",
      cursor: 11,
    });
    const next = composerReducer(start, { type: "MOVE_CURSOR_END" });
    // Last line has no trailing newline, so END lands on value.length.
    expect(next.cursor).toBe(17);

    // And on the first line, END lands on the `\n` position.
    const first = freshState({
      value: "line one\nline two",
      cursor: 2,
    });
    const endOfFirst = composerReducer(first, { type: "MOVE_CURSOR_END" });
    expect(endOfFirst.cursor).toBe(8);
  });

  test("KILL_TO_END_OF_LINE captures the rest of the line and survives CLEAR", () => {
    const start = freshState({ value: "hello world", cursor: 5 });
    const killed = composerReducer(start, { type: "KILL_TO_END_OF_LINE" });
    expect(killed.value).toBe("hello");
    expect(killed.cursor).toBe(5);
    expect(killed.killBuffer).toBe(" world");

    // CLEAR resets the buffer/history pointers but the kill buffer is
    // intentionally preserved so a yank in the next prompt restores it.
    const cleared = composerReducer(killed, { type: "CLEAR" });
    expect(cleared.value).toBe("");
    expect(cleared.killBuffer).toBe(" world");

    const yanked = composerReducer(cleared, { type: "YANK" });
    expect(yanked.value).toBe(" world");
    expect(yanked.cursor).toBe(" world".length);
  });

  test("KILL_TO_END_OF_LINE on a newline kills the newline only", () => {
    const start = freshState({ value: "abc\ndef", cursor: 3 });
    const killed = composerReducer(start, { type: "KILL_TO_END_OF_LINE" });
    expect(killed.value).toBe("abcdef");
    expect(killed.cursor).toBe(3);
    expect(killed.killBuffer).toBe("\n");
  });

  test("KILL_TO_END_OF_LINE at end of buffer is a no-op and preserves prior kill", () => {
    const start = freshState({
      value: "ready",
      cursor: 5,
      killBuffer: "saved",
    });
    const next = composerReducer(start, { type: "KILL_TO_END_OF_LINE" });
    expect(next).toBe(start);
    expect(next.killBuffer).toBe("saved");
  });

  test("YANK with empty kill buffer is a no-op", () => {
    const start = freshState({ value: "abc", cursor: 1, killBuffer: null });
    const next = composerReducer(start, { type: "YANK" });
    expect(next).toBe(start);
  });

  test("YANK inserts kill buffer at cursor", () => {
    const start = freshState({
      value: "abc",
      cursor: 1,
      killBuffer: "XYZ",
    });
    const next = composerReducer(start, { type: "YANK" });
    expect(next.value).toBe("aXYZbc");
    expect(next.cursor).toBe(4);
    // killBuffer is preserved across yanks (Emacs semantics — it stays
    // available for repeated yanks until the next kill replaces it).
    expect(next.killBuffer).toBe("XYZ");
  });
});
