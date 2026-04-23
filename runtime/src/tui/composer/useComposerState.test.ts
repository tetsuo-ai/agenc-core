/**
 * Wave 3-A: composer reducer unit tests.
 *
 * Exercises the pure `composerReducer` without a React render so every
 * state transition can be asserted deterministically.
 */

import { describe, expect, test } from "vitest";
import {
  composerReducer,
  type ComposerState,
} from "./useComposerState.js";

function freshState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    cursor: 0,
    history: [],
    historyIdx: null,
    draftBeforeHistory: null,
    historySearch: null,
    pasteInFlight: false,
    pendingEnters: 0,
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
    expect(next.history).toEqual(["hello"]);
    expect(next.historyIdx).toBeNull();
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
    expect(after.history).toEqual(["one"]);
    expect(after.value).toBe("");
  });

  test("HISTORY_PREV stashes the current draft on the first press", () => {
    const start = freshState({
      value: "draft",
      cursor: 5,
      history: ["older"],
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
      history: ["older"],
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
      history: ["newest", "middle", "oldest"],
    });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    state = composerReducer(state, { type: "HISTORY_PREV" });
    // Already at the oldest; one more press must not overshoot.
    state = composerReducer(state, { type: "HISTORY_PREV" });
    expect(state.historyIdx).toBe(2);
    expect(state.value).toBe("oldest");
  });

  test("HISTORY_SEARCH_START snapshots the current draft without previewing history yet", () => {
    const start = freshState({
      value: "draft",
      cursor: 3,
      history: ["second", "first"],
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
      history: ["alpha two", "alpha one", "alpha one", "beta"],
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
    expect(state.historySearch?.matches).toEqual(["alpha two", "alpha one"]);

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
      history: ["alpha one"],
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
      history: ["alpha one"],
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
      history: ["alpha one"],
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
});
