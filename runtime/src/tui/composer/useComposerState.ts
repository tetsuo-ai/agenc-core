/**
 * Composer state reducer + React hook.
 *
 * Owns the full mutable state of the multi-line composer buffer:
 *   - `value` / `cursor` — the text buffer and caret position.
 *   - `history` / `historyIdx` / `draftBeforeHistory` — submitted-message
 *     navigation with draft stash.
 *   - `pasteInFlight` / `pendingEnters` — paste-aware Enter buffering
 *     (invariant I-69). While a paste is in flight, Enter keypresses are
 *     counted but do NOT submit; once the paste completes, every
 *     buffered Enter fires in order.
 *
 * Keeping this as a pure reducer (rather than useState spaghetti inside
 * `Composer.tsx`) means the full keyboard → state mapping is unit
 * testable without an Ink render. The hook is a thin wrapper that
 * supplies initial history + returns the dispatcher.
 */

import { useMemo, useReducer, type Dispatch } from "react";

export type HistorySearchStatus = "idle" | "match" | "no-match";

export interface ComposerHistorySearchState {
  originalValue: string;
  originalCursor: number;
  query: string;
  matches: string[];
  matchIndex: number | null;
  status: HistorySearchStatus;
}

export interface ComposerState {
  value: string;
  cursor: number;
  history: string[];
  historyIdx: number | null;
  draftBeforeHistory: string | null;
  historySearch: ComposerHistorySearchState | null;
  pasteInFlight: boolean;
  pendingEnters: number;
}

export type ComposerAction =
  | { type: "INSERT"; text: string }
  | { type: "REPLACE_RANGE"; start: number; end: number; text: string }
  | { type: "DELETE_BACKWARD" }
  | { type: "DELETE_FORWARD" }
  | { type: "MOVE_CURSOR"; delta: number }
  | { type: "MOVE_CURSOR_HOME" }
  | { type: "MOVE_CURSOR_END" }
  | { type: "SUBMIT" }
  | { type: "HISTORY_PREV" }
  | { type: "HISTORY_NEXT" }
  | { type: "NEWLINE" }
  | { type: "PASTE_START" }
  | { type: "PASTE_COMPLETE" }
  | { type: "CLEAR" }
  | { type: "HISTORY_SEARCH_START" }
  | { type: "HISTORY_SEARCH_APPEND"; text: string }
  | { type: "HISTORY_SEARCH_BACKSPACE" }
  | { type: "HISTORY_SEARCH_CLEAR_QUERY" }
  | { type: "HISTORY_SEARCH_OLDER" }
  | { type: "HISTORY_SEARCH_NEWER" }
  | { type: "HISTORY_SEARCH_ACCEPT" }
  | { type: "HISTORY_SEARCH_CANCEL" }
  | { type: "LOAD_HISTORY"; history: readonly string[] };

/**
 * Clamp a cursor position to `[0, value.length]` so every reducer
 * branch produces a renderable state even when callers fire adjacent
 * INSERT/DELETE actions.
 */
function clampCursor(cursor: number, valueLength: number): number {
  if (cursor < 0) return 0;
  if (cursor > valueLength) return valueLength;
  return cursor;
}

/**
 * Find the start of the line containing `cursor`. Returns the index of
 * the character immediately after the previous `\n`, or `0` if the
 * cursor is on the first line.
 */
function lineStart(value: string, cursor: number): number {
  const prev = value.lastIndexOf("\n", Math.max(0, cursor - 1));
  return prev === -1 ? 0 : prev + 1;
}

/**
 * Find the end of the line containing `cursor`. Returns the index of
 * the next `\n`, or `value.length` if the cursor is on the last line.
 */
function lineEnd(value: string, cursor: number): number {
  const next = value.indexOf("\n", cursor);
  return next === -1 ? value.length : next;
}

function createHistorySearchState(
  state: ComposerState,
): ComposerHistorySearchState {
  return {
    originalValue: state.value,
    originalCursor: state.cursor,
    query: "",
    matches: [],
    matchIndex: null,
    status: "idle",
  };
}

function restoreHistorySearchOriginal(
  state: ComposerState,
  search: ComposerHistorySearchState,
): ComposerState {
  return {
    ...state,
    value: search.originalValue,
    cursor: clampCursor(search.originalCursor, search.originalValue.length),
    historySearch: search,
  };
}

function findHistorySearchMatches(
  history: readonly string[],
  query: string,
): string[] {
  const foldedQuery = query.toLocaleLowerCase();
  if (foldedQuery.length === 0) return [];

  const seen = new Set<string>();
  const matches: string[] = [];
  for (const entry of history) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (!entry.toLocaleLowerCase().includes(foldedQuery)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    matches.push(entry);
  }
  return matches;
}

function mergeHistory(
  current: readonly string[],
  loaded: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of [...current, ...loaded]) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  return out;
}

function applyHistorySearchQuery(
  state: ComposerState,
  search: ComposerHistorySearchState,
  query: string,
): ComposerState {
  if (query.length === 0) {
    return restoreHistorySearchOriginal(state, {
      ...search,
      query,
      matches: [],
      matchIndex: null,
      status: "idle",
    });
  }

  const matches = findHistorySearchMatches(state.history, query);
  if (matches.length === 0) {
    return restoreHistorySearchOriginal(state, {
      ...search,
      query,
      matches: [],
      matchIndex: null,
      status: "no-match",
    });
  }

  const match = matches[0]!;
  return {
    ...state,
    value: match,
    cursor: match.length,
    historySearch: {
      ...search,
      query,
      matches,
      matchIndex: 0,
      status: "match",
    },
  };
}

function stepHistorySearch(
  state: ComposerState,
  delta: number,
): ComposerState {
  const search = state.historySearch;
  if (
    search === null ||
    search.query.length === 0 ||
    search.matches.length === 0 ||
    search.matchIndex === null
  ) {
    return state;
  }

  const nextIndex = Math.max(
    0,
    Math.min(search.matches.length - 1, search.matchIndex + delta),
  );
  const match = search.matches[nextIndex];
  if (match === undefined) return state;

  return {
    ...state,
    value: match,
    cursor: match.length,
    historySearch: {
      ...search,
      matchIndex: nextIndex,
      status: "match",
    },
  };
}

function commitToHistory(state: ComposerState): ComposerState {
  const value = state.value;
  if (value.length === 0) {
    // Empty submit clears draft stash/history pointers but does not
    // append a blank entry to history (matches typical shell behavior).
    return {
      ...state,
      value: "",
      cursor: 0,
      historyIdx: null,
      draftBeforeHistory: null,
      historySearch: null,
    };
  }
  // De-dupe consecutive identical submissions — same policy as bash's
  // HISTCONTROL=ignoredups. Avoids spamming the history file when a
  // user re-runs the same prompt.
  const newest = state.history[0];
  const history =
    typeof newest === "string" && newest === value
      ? state.history
      : [value, ...state.history];
  return {
    ...state,
    value: "",
    cursor: 0,
    history,
    historyIdx: null,
    draftBeforeHistory: null,
    historySearch: null,
  };
}

export function composerReducer(
  state: ComposerState,
  action: ComposerAction,
): ComposerState {
  switch (action.type) {
    case "INSERT": {
      const text = action.text;
      if (text.length === 0) return state;
      const cursor = clampCursor(state.cursor, state.value.length);
      const nextValue =
        state.value.slice(0, cursor) + text + state.value.slice(cursor);
      return {
        ...state,
        value: nextValue,
        cursor: cursor + text.length,
      };
    }
    case "REPLACE_RANGE": {
      const start = clampCursor(
        Math.min(action.start, action.end),
        state.value.length,
      );
      const end = clampCursor(
        Math.max(action.start, action.end),
        state.value.length,
      );
      const nextValue =
        state.value.slice(0, start) + action.text + state.value.slice(end);
      return {
        ...state,
        value: nextValue,
        cursor: start + action.text.length,
      };
    }
    case "NEWLINE": {
      // Same machinery as INSERT('\n'); kept separate for readability
      // and so a future renderer can treat explicit newlines distinctly
      // (e.g. highlight vs. pasted newlines).
      const cursor = clampCursor(state.cursor, state.value.length);
      const nextValue =
        state.value.slice(0, cursor) + "\n" + state.value.slice(cursor);
      return {
        ...state,
        value: nextValue,
        cursor: cursor + 1,
      };
    }
    case "DELETE_BACKWARD": {
      const cursor = clampCursor(state.cursor, state.value.length);
      if (cursor === 0) return state;
      const nextValue =
        state.value.slice(0, cursor - 1) + state.value.slice(cursor);
      return {
        ...state,
        value: nextValue,
        cursor: cursor - 1,
      };
    }
    case "DELETE_FORWARD": {
      const cursor = clampCursor(state.cursor, state.value.length);
      if (cursor >= state.value.length) return state;
      const nextValue =
        state.value.slice(0, cursor) + state.value.slice(cursor + 1);
      return {
        ...state,
        value: nextValue,
        cursor,
      };
    }
    case "MOVE_CURSOR": {
      return {
        ...state,
        cursor: clampCursor(state.cursor + action.delta, state.value.length),
      };
    }
    case "MOVE_CURSOR_HOME": {
      return {
        ...state,
        cursor: lineStart(state.value, state.cursor),
      };
    }
    case "MOVE_CURSOR_END": {
      return {
        ...state,
        cursor: lineEnd(state.value, state.cursor),
      };
    }
    case "SUBMIT": {
      if (state.pasteInFlight) {
        // I-69: never submit while a paste is streaming. Every Enter
        // press is counted and replayed once `PASTE_COMPLETE` fires.
        return {
          ...state,
          pendingEnters: state.pendingEnters + 1,
        };
      }
      return commitToHistory(state);
    }
    case "CLEAR": {
      return {
        ...state,
        value: "",
        cursor: 0,
        historyIdx: null,
        draftBeforeHistory: null,
        historySearch: null,
      };
    }
    case "HISTORY_SEARCH_START": {
      if (state.historySearch !== null) {
        return stepHistorySearch(state, +1);
      }
      return {
        ...state,
        historyIdx: null,
        draftBeforeHistory: null,
        historySearch: createHistorySearchState(state),
      };
    }
    case "HISTORY_SEARCH_APPEND": {
      const search = state.historySearch;
      if (search === null || action.text.length === 0) return state;
      return applyHistorySearchQuery(state, search, search.query + action.text);
    }
    case "HISTORY_SEARCH_BACKSPACE": {
      const search = state.historySearch;
      if (search === null) return state;
      return applyHistorySearchQuery(
        state,
        search,
        search.query.slice(0, Math.max(0, search.query.length - 1)),
      );
    }
    case "HISTORY_SEARCH_CLEAR_QUERY": {
      const search = state.historySearch;
      if (search === null) return state;
      return applyHistorySearchQuery(state, search, "");
    }
    case "HISTORY_SEARCH_OLDER": {
      return stepHistorySearch(state, +1);
    }
    case "HISTORY_SEARCH_NEWER": {
      return stepHistorySearch(state, -1);
    }
    case "HISTORY_SEARCH_ACCEPT": {
      const search = state.historySearch;
      if (
        search === null ||
        search.status !== "match" ||
        search.matchIndex === null
      ) {
        return state;
      }
      return {
        ...state,
        cursor: state.value.length,
        historyIdx: null,
        draftBeforeHistory: null,
        historySearch: null,
      };
    }
    case "HISTORY_SEARCH_CANCEL": {
      const search = state.historySearch;
      if (search === null) return state;
      return {
        ...restoreHistorySearchOriginal(state, search),
        historyIdx: null,
        draftBeforeHistory: null,
        historySearch: null,
      };
    }
    case "LOAD_HISTORY": {
      const history = mergeHistory(state.history, action.history);
      const next: ComposerState = {
        ...state,
        history,
        ...(state.historyIdx !== null
          ? { historyIdx: null, draftBeforeHistory: null }
          : {}),
      };

      if (state.historySearch === null) {
        return next;
      }

      return applyHistorySearchQuery(
        next,
        state.historySearch,
        state.historySearch.query,
      );
    }
    case "HISTORY_PREV": {
      if (state.historySearch !== null) {
        return stepHistorySearch(state, +1);
      }
      if (state.history.length === 0) return state;
      if (state.historyIdx === null) {
        // First PREV press: stash whatever the user was drafting and
        // swap to the newest history entry.
        const entry = state.history[0]!;
        return {
          ...state,
          draftBeforeHistory: state.value,
          historyIdx: 0,
          value: entry,
          cursor: entry.length,
        };
      }
      // Clamp at the oldest entry — once the user is at the end of
      // history, further PREV presses stay there.
      const nextIdx = Math.min(
        state.history.length - 1,
        state.historyIdx + 1,
      );
      const entry = state.history[nextIdx]!;
      return {
        ...state,
        historyIdx: nextIdx,
        value: entry,
        cursor: entry.length,
      };
    }
    case "HISTORY_NEXT": {
      if (state.historySearch !== null) {
        return stepHistorySearch(state, -1);
      }
      if (state.historyIdx === null) return state;
      if (state.historyIdx === 0) {
        // Step off the top of history back into the draft stash.
        const draft = state.draftBeforeHistory ?? "";
        return {
          ...state,
          historyIdx: null,
          draftBeforeHistory: null,
          value: draft,
          cursor: draft.length,
        };
      }
      const nextIdx = state.historyIdx - 1;
      const entry = state.history[nextIdx]!;
      return {
        ...state,
        historyIdx: nextIdx,
        value: entry,
        cursor: entry.length,
      };
    }
    case "PASTE_START": {
      return {
        ...state,
        pasteInFlight: true,
      };
    }
    case "PASTE_COMPLETE": {
      // Replay any Enter presses that were buffered while the paste
      // was streaming. Each replayed SUBMIT goes through the same
      // reducer branch so history append + clear semantics match a
      // direct user press.
      let next: ComposerState = {
        ...state,
        pasteInFlight: false,
      };
      const pending = next.pendingEnters;
      next = { ...next, pendingEnters: 0 };
      for (let i = 0; i < pending; i++) {
        next = composerReducer(next, { type: "SUBMIT" });
      }
      return next;
    }
    default: {
      // Exhaustive check: every ComposerAction.type must be handled
      // above. If TypeScript ever reports this as reachable, a new
      // action was added without a reducer branch.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

export interface UseComposerStateOptions {
  readonly initialHistory: string[];
  readonly initialValue?: string;
}

export interface UseComposerStateResult {
  readonly state: ComposerState;
  readonly dispatch: Dispatch<ComposerAction>;
}

export function useComposerState(
  opts: UseComposerStateOptions,
): UseComposerStateResult {
  // `useMemo` rather than capturing the initial history on every
  // render — the reducer should only see a fresh reference when the
  // caller truly rotates history.
  const initialState = useMemo<ComposerState>(
    () => ({
      value: opts.initialValue ?? "",
      cursor: opts.initialValue?.length ?? 0,
      history: [...opts.initialHistory],
      historyIdx: null,
      draftBeforeHistory: null,
      historySearch: null,
      pasteInFlight: false,
      pendingEnters: 0,
    }),
    // We intentionally depend on the array contents via a stable key
    // derived from length + first entry. Full identity comparison isn't
    // worth it here; the caller is expected to pass a fresh array when
    // history actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.initialHistory.length, opts.initialHistory[0], opts.initialValue],
  );
  const [state, dispatch] = useReducer(composerReducer, initialState);
  return { state, dispatch };
}
