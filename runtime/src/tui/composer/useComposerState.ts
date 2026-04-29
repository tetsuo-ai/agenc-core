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

import type { HistoryEntry, PersistedMention } from "./history.js";

export type HistorySearchStatus = "idle" | "match" | "no-match";
export const LARGE_PASTE_CHAR_THRESHOLD = 1000;

export interface PendingPaste {
  readonly placeholder: string;
  readonly text: string;
}

export interface ComposerImageAttachment {
  readonly placeholder: string;
  readonly source: string;
  readonly content: string;
  readonly kind: "local" | "remote";
  readonly mediaType?: string;
  readonly sourcePath?: string;
}

export interface ComposerHistorySearchState {
  originalValue: string;
  originalCursor: number;
  query: string;
  matches: HistoryEntry[];
  matchIndex: number | null;
  status: HistorySearchStatus;
}

export interface ComposerState {
  value: string;
  cursor: number;
  // Newest-first list of fully-persisted history entries. Was previously
  // `string[]`; widened to `HistoryEntry[]` so up-arrow recall preserves
  // the persisted mention spans without re-scanning the workspace.
  history: HistoryEntry[];
  historyIdx: number | null;
  draftBeforeHistory: string | null;
  historySearch: ComposerHistorySearchState | null;
  pendingPastes: PendingPaste[];
  largePasteCounters: Readonly<Record<string, number>>;
  localImages: ComposerImageAttachment[];
  remoteImages: ComposerImageAttachment[];
  selectedRemoteImageIndex: number | null;
  pasteInFlight: boolean;
  pendingEnters: number;
  // Single-entry kill buffer (Emacs Ctrl-K / Ctrl-Y). Survives CLEAR and
  // SUBMIT so a yank in the next prompt restores the previous kill. `null`
  // when nothing has been killed yet.
  killBuffer: string | null;
}

export type ComposerAction =
  | { type: "INSERT"; text: string }
  | { type: "INSERT_PASTE"; text: string }
  | {
      type: "ATTACH_IMAGE";
      kind: "local" | "remote";
      source: string;
      content?: string;
      mediaType?: string;
      sourcePath?: string;
    }
  | { type: "MOVE_REMOTE_IMAGE_SELECTION"; delta: number }
  | { type: "DELETE_SELECTED_REMOTE_IMAGE" }
  | { type: "CLEAR_REMOTE_IMAGE_SELECTION" }
  | { type: "REPLACE_RANGE"; start: number; end: number; text: string }
  | { type: "DELETE_BACKWARD" }
  | { type: "DELETE_FORWARD" }
  | { type: "MOVE_CURSOR"; delta: number }
  | { type: "MOVE_CURSOR_HOME" }
  | { type: "MOVE_CURSOR_END" }
  | {
      type: "SUBMIT";
      historyValue?: string;
      historyMentions?: readonly PersistedMention[];
    }
  | { type: "HISTORY_PREV" }
  | { type: "HISTORY_NEXT" }
  | { type: "NEWLINE" }
  | { type: "PASTE_START" }
  | { type: "PASTE_COMPLETE" }
  | { type: "CLEAR" }
  | { type: "KILL_TO_END_OF_LINE" }
  | { type: "YANK" }
  | { type: "HISTORY_SEARCH_START" }
  | { type: "HISTORY_SEARCH_APPEND"; text: string }
  | { type: "HISTORY_SEARCH_BACKSPACE" }
  | { type: "HISTORY_SEARCH_CLEAR_QUERY" }
  | { type: "HISTORY_SEARCH_OLDER" }
  | { type: "HISTORY_SEARCH_NEWER" }
  | { type: "HISTORY_SEARCH_ACCEPT" }
  | { type: "HISTORY_SEARCH_CANCEL" }
  | { type: "LOAD_HISTORY"; history: readonly HistoryEntry[] };

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
  history: readonly HistoryEntry[],
  query: string,
): HistoryEntry[] {
  const foldedQuery = query.toLocaleLowerCase();
  if (foldedQuery.length === 0) return [];

  const seen = new Set<string>();
  const matches: HistoryEntry[] = [];
  for (const entry of history) {
    const value = entry?.value;
    if (typeof value !== "string" || value.length === 0) continue;
    if (!value.toLocaleLowerCase().includes(foldedQuery)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    matches.push(entry);
  }
  return matches;
}

function mergeHistory(
  current: readonly HistoryEntry[],
  loaded: readonly HistoryEntry[],
): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];

  for (const entry of [...current, ...loaded]) {
    const value = entry?.value;
    if (typeof value !== "string" || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
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
    value: match.value,
    cursor: match.value.length,
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
    value: match.value,
    cursor: match.value.length,
    historySearch: {
      ...search,
      matchIndex: nextIndex,
      status: "match",
    },
  };
}

function commitToHistory(
  state: ComposerState,
  explicitHistoryValue?: string,
  historyMentions?: readonly PersistedMention[],
): ComposerState {
  const value = state.value;
  const historyValue = expandPendingPastes(
    explicitHistoryValue ?? value,
    state.pendingPastes,
  );
  if (value.length === 0 && historyValue.length === 0) {
    // Empty submit clears draft stash/history pointers but does not
    // append a blank entry to history (matches typical shell behavior).
    return {
      ...state,
      value: "",
      cursor: 0,
      historyIdx: null,
      draftBeforeHistory: null,
      historySearch: null,
      pendingPastes: [],
      largePasteCounters: {},
      localImages: [],
      remoteImages: [],
      selectedRemoteImageIndex: null,
    };
  }
  // De-dupe consecutive identical submissions — same policy as bash's
  // HISTCONTROL=ignoredups. Avoids spamming the history file when a
  // user re-runs the same prompt.
  const newest = state.history[0];
  const newEntry: HistoryEntry = {
    timestamp: Date.now(),
    value: historyValue,
    ...(historyMentions && historyMentions.length > 0
      ? { mentions: historyMentions }
      : {}),
  };
  const history =
    newest && newest.value === historyValue
      ? state.history
      : [newEntry, ...state.history];
  return {
    ...state,
    value: "",
    cursor: 0,
    history,
    historyIdx: null,
    draftBeforeHistory: null,
    historySearch: null,
    pendingPastes: [],
    largePasteCounters: {},
    localImages: [],
    remoteImages: [],
    selectedRemoteImageIndex: null,
  };
}

function nextLargePastePlaceholder(
  state: ComposerState,
  charCount: number,
): {
  readonly placeholder: string;
  readonly counters: Readonly<Record<string, number>>;
} {
  const key = String(charCount);
  const nextCount = (state.largePasteCounters[key] ?? 0) + 1;
  const base = `[Pasted Content ${charCount} chars]`;
  return {
    placeholder: nextCount === 1 ? base : `${base} #${nextCount}`,
    counters: {
      ...state.largePasteCounters,
      [key]: nextCount,
    },
  };
}

export function expandPendingPastes(
  value: string,
  pendingPastes: readonly PendingPaste[],
): string {
  let out = value;
  for (const paste of pendingPastes) {
    if (out.includes(paste.placeholder)) {
      out = out.split(paste.placeholder).join(paste.text);
    }
  }
  return out;
}

function imagePlaceholder(index: number): string {
  return `[Image #${index}]`;
}

interface RelabeledImages {
  readonly value: string;
  readonly remoteImages: ComposerImageAttachment[];
  readonly localImages: ComposerImageAttachment[];
  readonly placeholderShift: number;
}

function relabelImages(
  value: string,
  remoteImages: readonly ComposerImageAttachment[],
  localImages: readonly ComposerImageAttachment[],
): RelabeledImages {
  const nextRemoteImages = remoteImages.map((image, index) => ({
    ...image,
    placeholder: imagePlaceholder(index + 1),
  }));
  let nextValue = value;
  const nextLocalImages = localImages.map((image, index) => {
    const nextPlaceholder = imagePlaceholder(
      nextRemoteImages.length + index + 1,
    );
    if (image.placeholder !== nextPlaceholder) {
      nextValue = nextValue.split(image.placeholder).join(nextPlaceholder);
    }
    return {
      ...image,
      placeholder: nextPlaceholder,
    };
  });
  return {
    value: nextValue,
    remoteImages: nextRemoteImages,
    localImages: nextLocalImages,
    placeholderShift: nextValue.length - value.length,
  };
}

function attachImage(
  state: ComposerState,
  kind: "local" | "remote",
  source: string,
  content?: string,
  mediaType?: string,
  sourcePath?: string,
): ComposerState {
  const trimmedSource = source.trim();
  if (trimmedSource.length === 0) return state;
  const imageContent =
    typeof content === "string" && content.length > 0 ? content : trimmedSource;

  if (kind === "remote") {
    const remoteImages = [
      ...state.remoteImages,
      {
        kind,
        source: trimmedSource,
        content: imageContent,
        ...(mediaType !== undefined ? { mediaType } : {}),
        ...(sourcePath !== undefined ? { sourcePath } : {}),
        placeholder: imagePlaceholder(state.remoteImages.length + 1),
      },
    ];
    const relabeled = relabelImages(
      state.value,
      remoteImages,
      state.localImages,
    );
    const cursor = clampCursor(
      state.cursor + relabeled.placeholderShift,
      relabeled.value.length,
    );
    return {
      ...state,
      value: relabeled.value,
      cursor,
      remoteImages: relabeled.remoteImages,
      localImages: relabeled.localImages,
      selectedRemoteImageIndex: remoteImages.length - 1,
    };
  }

  const placeholder = imagePlaceholder(
    state.remoteImages.length + state.localImages.length + 1,
  );
  const cursor = clampCursor(state.cursor, state.value.length);
  const nextValue =
    state.value.slice(0, cursor) + placeholder + state.value.slice(cursor);
  return {
    ...state,
    value: nextValue,
    cursor: cursor + placeholder.length,
    localImages: [
      ...state.localImages,
      {
        kind,
        source: trimmedSource,
        content: imageContent,
        ...(mediaType !== undefined ? { mediaType } : {}),
        ...(sourcePath !== undefined ? { sourcePath } : {}),
        placeholder,
      },
    ],
    selectedRemoteImageIndex: null,
  };
}

function moveRemoteSelection(
  state: ComposerState,
  delta: number,
): ComposerState {
  const count = state.remoteImages.length;
  if (count === 0) return { ...state, selectedRemoteImageIndex: null };
  const current =
    state.selectedRemoteImageIndex === null
      ? delta < 0
        ? count
        : -1
      : state.selectedRemoteImageIndex;
  const next = Math.max(0, Math.min(count - 1, current + delta));
  return { ...state, selectedRemoteImageIndex: next };
}

function deleteSelectedRemoteImage(state: ComposerState): ComposerState {
  const index = state.selectedRemoteImageIndex;
  if (index === null || state.remoteImages[index] === undefined) return state;
  const remoteImages = state.remoteImages.filter((_, i) => i !== index);
  const relabeled = relabelImages(
    state.value,
    remoteImages,
    state.localImages,
  );
  return {
    ...state,
    value: relabeled.value,
    cursor: clampCursor(
      state.cursor + relabeled.placeholderShift,
      relabeled.value.length,
    ),
    remoteImages: relabeled.remoteImages,
    localImages: relabeled.localImages,
    selectedRemoteImageIndex:
      remoteImages.length === 0
        ? null
        : Math.min(index, remoteImages.length - 1),
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
        selectedRemoteImageIndex: null,
      };
    }
    case "INSERT_PASTE": {
      const text = action.text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
      if (text.length === 0) return state;
      const charCount = [...text].length;
      if (charCount <= LARGE_PASTE_CHAR_THRESHOLD) {
        return composerReducer(state, { type: "INSERT", text });
      }
      const { placeholder, counters } = nextLargePastePlaceholder(
        state,
        charCount,
      );
      const cursor = clampCursor(state.cursor, state.value.length);
      const nextValue =
        state.value.slice(0, cursor) + placeholder + state.value.slice(cursor);
      return {
        ...state,
        value: nextValue,
        cursor: cursor + placeholder.length,
        largePasteCounters: counters,
        pendingPastes: [
          ...state.pendingPastes,
          { placeholder, text },
        ],
        selectedRemoteImageIndex: null,
      };
    }
    case "ATTACH_IMAGE": {
      return attachImage(
        state,
        action.kind,
        action.source,
        action.content,
        action.mediaType,
        action.sourcePath,
      );
    }
    case "MOVE_REMOTE_IMAGE_SELECTION": {
      return moveRemoteSelection(state, action.delta);
    }
    case "DELETE_SELECTED_REMOTE_IMAGE": {
      return deleteSelectedRemoteImage(state);
    }
    case "CLEAR_REMOTE_IMAGE_SELECTION": {
      if (state.selectedRemoteImageIndex === null) return state;
      return { ...state, selectedRemoteImageIndex: null };
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
        selectedRemoteImageIndex: null,
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
        selectedRemoteImageIndex: null,
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
        selectedRemoteImageIndex: null,
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
        selectedRemoteImageIndex: null,
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
      return commitToHistory(
        state,
        action.historyValue,
        action.historyMentions,
      );
    }
    case "CLEAR": {
      return {
        ...state,
        value: "",
        cursor: 0,
        historyIdx: null,
        draftBeforeHistory: null,
        historySearch: null,
        pendingPastes: [],
        largePasteCounters: {},
        localImages: [],
        remoteImages: [],
        selectedRemoteImageIndex: null,
      };
    }
    case "KILL_TO_END_OF_LINE": {
      const cursor = clampCursor(state.cursor, state.value.length);
      const newlineAt = state.value.indexOf("\n", cursor);
      let killStart = cursor;
      let killEnd: number;
      if (newlineAt === -1) {
        // No newline ahead — kill to end of buffer.
        killEnd = state.value.length;
      } else if (newlineAt === cursor) {
        // Caret sits on the newline itself — kill the newline only.
        killEnd = cursor + 1;
      } else {
        killEnd = newlineAt;
      }
      const killed = state.value.slice(killStart, killEnd);
      if (killed.length === 0) {
        // Nothing to kill (cursor at end of buffer with no newline).
        // Leave killBuffer untouched so a previous kill survives.
        return state;
      }
      const nextValue =
        state.value.slice(0, killStart) + state.value.slice(killEnd);
      return {
        ...state,
        value: nextValue,
        cursor: killStart,
        killBuffer: killed,
        selectedRemoteImageIndex: null,
      };
    }
    case "YANK": {
      const text = state.killBuffer;
      if (text === null || text.length === 0) return state;
      const cursor = clampCursor(state.cursor, state.value.length);
      const nextValue =
        state.value.slice(0, cursor) + text + state.value.slice(cursor);
      return {
        ...state,
        value: nextValue,
        cursor: cursor + text.length,
        selectedRemoteImageIndex: null,
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
          value: entry.value,
          cursor: entry.value.length,
          pendingPastes: [],
          largePasteCounters: {},
          localImages: [],
          remoteImages: [],
          selectedRemoteImageIndex: null,
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
        value: entry.value,
        cursor: entry.value.length,
        pendingPastes: [],
        largePasteCounters: {},
        localImages: [],
        remoteImages: [],
        selectedRemoteImageIndex: null,
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
          pendingPastes: [],
          largePasteCounters: {},
          localImages: [],
          remoteImages: [],
          selectedRemoteImageIndex: null,
        };
      }
      const nextIdx = state.historyIdx - 1;
      const entry = state.history[nextIdx]!;
      return {
        ...state,
        historyIdx: nextIdx,
        value: entry.value,
        cursor: entry.value.length,
        pendingPastes: [],
        largePasteCounters: {},
        localImages: [],
        remoteImages: [],
        selectedRemoteImageIndex: null,
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
  readonly initialHistory: readonly HistoryEntry[];
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
      pendingPastes: [],
      largePasteCounters: {},
      localImages: [],
      remoteImages: [],
      selectedRemoteImageIndex: null,
      pasteInFlight: false,
      pendingEnters: 0,
      killBuffer: null,
    }),
    // We intentionally depend on the array contents via a stable key
    // derived from length + first entry's value. Full identity comparison
    // isn't worth it here; the caller is expected to pass a fresh array
    // when history actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      opts.initialHistory.length,
      opts.initialHistory[0]?.value,
      opts.initialValue,
    ],
  );
  const [state, dispatch] = useReducer(composerReducer, initialState);
  return { state, dispatch };
}
