/**
 * AgenC multi-line composer.
 *
 * Responsibilities owned by this component:
 *   1. Own the composer buffer state (via `useComposerState`).
 *   2. Bridge the stdin-level `PasteStore` singleton into the reducer:
 *      `paste-start` → PASTE_START, `paste-complete` → drain buffered
 *      bytes with `pushChunk` + dispatch PASTE_COMPLETE. This implements
 *      invariant I-69: Enter presses that arrive while a paste is
 *      streaming are buffered, not submitted.
 *   3. Register chat-level keybindings (`chat:submit`, `chat:cancel`,
 *      `chat:newline`, `history:prev`, `history:next`) and map each
 *      press to the correct reducer action, honoring the paste-in-flight
 *      gate on submit.
 *   4. Scan the live buffer for `@path` mentions (invariant I-71),
 *      validate each one against `session.cwd` + an optional
 *      `config.attachments.allowedRoots` list, surface rejects via
 *      `session.emit?.` or `console.warn`, and render a footer note so
 *      the user sees why an attachment was dropped.
 *
 * The React tree stays intentionally small, but the live buffer now uses
 * the shared wrapped-cursor model (`Cursor` + `useDeclaredCursor`) rather
 * than the original placeholder caret renderer. The contract here covers
 * both keystroke → state plumbing and stable terminal-safe composer
 * rendering for wrapped/multiline drafts.
 */

import React, {
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isAbsolute, relative, resolve } from "node:path";

import { buildDefaultRegistry, getGlobalCommandRegistry } from "../_deps/commands.js";
import { Cursor } from "../_deps/cursor.js";
import { stringWidth } from "../ink/stringWidth.js";
import Box from "../ink/components/Box.js";
import StdinContext from "../ink/components/StdinContext.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import { useDeclaredCursor } from "../ink/hooks/use-declared-cursor.js";
import type { Color } from "../ink/styles.js";
import {
  useActiveKeybindingContext,
  useKeybinding,
} from "../keybindings/KeybindingContext.js";
import { slashCommandOpensPicker } from "../picker-intents.js";
import { useAgenCAppState } from "../state/AppState.js";
import { theme } from "../theme.js";
import {
  getPasteStore,
  type PasteEvent,
  type PasteStore,
} from "./paste-store.js";
import { Palette, fuzzyMatch, type PaletteItem } from "./Palette.js";
import { getSlashCommandItems } from "./palette-sources.js";
import {
  HISTORY_FILE_REL,
  appendHistory,
  readHistory,
  type HistoryEntry,
} from "./history.js";
import {
  useComposerState,
  type ComposerHistorySearchState,
} from "./useComposerState.js";

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

export interface ComposerSession {
  /** Absolute working directory for `@path` resolution. */
  readonly cwd: string;
  /** Optional home directory override (tests supply a tmpdir). */
  readonly home?: string;
  /** Optional observability hook — dropped mentions emit here. */
  readonly emit?: (event: string, payload?: unknown) => void;
}

export interface ComposerAttachmentsConfig {
  readonly allowedRoots?: readonly string[];
}

export interface ComposerProps {
  readonly session: ComposerSession;
  /** Optional attachments config — resolves `config.attachments.allowedRoots`. */
  readonly config?: { readonly attachments?: ComposerAttachmentsConfig };
  /** Fired on a non-paste-gated Enter with the full buffer value. */
  readonly onSubmit: (value: string) => void;
  /** Fired on `chat:cancel` (Escape). */
  readonly onCancel?: () => void;
  /** When true, ignore draft input and hide the declared text cursor. */
  readonly inputLocked?: boolean;
  /** Optional paste-store seam for tests. Defaults to the process singleton. */
  readonly pasteStore?: PasteStore;
}

// ────────────────────────────────────────────────────────────────────────
// Mention validation (exported so unit tests can exercise it directly)
// ────────────────────────────────────────────────────────────────────────

export type MentionValidationResult =
  | { ok: true; resolved: string }
  | { ok: false; reason: "outside_workspace" | "unreadable" };

/**
 * Decide whether a `@mention` should be accepted as an attachment:
 *   1. Resolve relative to `cwd`.
 *   2. Allow if the resolved path is inside `cwd` (via
 *      `path.relative(cwd, resolved)` — reject iff the result starts
 *      with `..` OR is absolute).
 *   3. Otherwise allow if it lives inside one of `allowedRoots`.
 *   4. Reject with `outside_workspace` in all other cases.
 *
 * Any thrown error (e.g. an invalid path string) maps to `unreadable`.
 */
export function validateMentionPath(
  raw: string,
  cwd: string,
  allowedRoots?: readonly string[],
): MentionValidationResult {
  try {
    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);

    // Normalize cwd too so `/tmp/app/./` and `/tmp/app` compare equal.
    const cwdResolved = resolve(cwd);

    const rel = relative(cwdResolved, resolved);
    const insideCwd =
      rel === "" ||
      (!rel.startsWith("..") && !isAbsolute(rel));
    if (insideCwd) {
      return { ok: true, resolved };
    }

    if (allowedRoots && allowedRoots.length > 0) {
      for (const root of allowedRoots) {
        if (typeof root !== "string" || root.length === 0) continue;
        const rootAbs = resolve(root);
        const rootRel = relative(rootAbs, resolved);
        const insideRoot =
          rootRel === "" ||
          (!rootRel.startsWith("..") && !isAbsolute(rootRel));
        if (insideRoot) {
          return { ok: true, resolved };
        }
      }
    }

    return { ok: false, reason: "outside_workspace" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Mention scanning
// ────────────────────────────────────────────────────────────────────────

interface DetectedMention {
  readonly raw: string;
  readonly validation: MentionValidationResult;
}

const MENTION_REGEX = /@([^\s]+)/g;

function scanMentions(
  value: string,
  cwd: string,
  allowedRoots?: readonly string[],
): DetectedMention[] {
  const out: DetectedMention[] = [];
  // Build a fresh RegExp per call — `g` regexes carry lastIndex state
  // which would leak between renders if we reused the module-level one.
  const rx = new RegExp(MENTION_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = rx.exec(value)) !== null) {
    const raw = match[1];
    if (typeof raw !== "string" || raw.length === 0) continue;
    out.push({ raw, validation: validateMentionPath(raw, cwd, allowedRoots) });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Visual cursor rendering
// ────────────────────────────────────────────────────────────────────────

const COMPOSER_FRAME_CHROME_COLUMNS = 4;
const MIN_BUFFER_COLUMNS = 4;
// Match openclaude's fallback threshold: regular typing can occasionally
// arrive in small multi-char chunks, so only treat very large unbracketed
// chunks as paste when the parser did not mark them as bracketed paste.
const PASTE_THRESHOLD = 800;

function ComposerBuffer({
  value,
  cursor,
  promptPrefix,
  cursorActive,
}: {
  readonly value: string;
  readonly cursor: number;
  readonly promptPrefix: string;
  readonly cursorActive: boolean;
}): React.ReactElement {
  const terminalSize = useContext(TerminalSizeContext);
  const prefixWidth = Math.max(1, stringWidth(promptPrefix));
  const availableColumns = Math.max(
    MIN_BUFFER_COLUMNS,
    (terminalSize?.columns ?? 80) - COMPOSER_FRAME_CHROME_COLUMNS - prefixWidth,
  );
  const cursorModel = useMemo(
    () => Cursor.fromText(value, availableColumns, cursor),
    [availableColumns, cursor, value],
  );
  const renderedValue = useMemo(
    // Let the native declared cursor be the only visible caret. Rendering
    // an inverted-space cursor here fights Ink's real cursor parking and
    // leaves stale blocks/glyphs behind on some terminals.
    () => cursorModel.render("", "", (text) => text),
    [cursorModel],
  );
  const cursorPosition = cursorModel.getPosition();
  const viewportStartLine = cursorModel.getViewportStartLine();
  const cursorRef = useDeclaredCursor({
    line: cursorPosition.line - viewportStartLine,
    column: cursorPosition.column,
    active: cursorActive,
  });

  return (
    <Box ref={cursorRef}>
      <Text>{renderedValue}</Text>
    </Box>
  );
}

let cachedFallbackSlashItems: readonly PaletteItem[] | null = null;

function getSlashPaletteItems(): readonly PaletteItem[] {
  const registry = getGlobalCommandRegistry();
  if (registry) {
    return getSlashCommandItems(registry);
  }
  if (cachedFallbackSlashItems === null) {
    cachedFallbackSlashItems = getSlashCommandItems(buildDefaultRegistry());
  }
  return cachedFallbackSlashItems;
}

interface LineBounds {
  readonly cursor: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

function getLineBounds(value: string, cursor: number): LineBounds {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const prevNewline = value.lastIndexOf("\n", Math.max(0, safeCursor - 1));
  const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
  const nextNewline = value.indexOf("\n", safeCursor);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  return { cursor: safeCursor, lineStart, lineEnd };
}

interface SlashDraft {
  readonly query: string;
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly cursorInsideToken: boolean;
}

function readSlashDraft(value: string, cursor: number): SlashDraft | null {
  const bounds = getLineBounds(value, cursor);
  const line = value.slice(bounds.lineStart, bounds.lineEnd);
  const leadingWhitespace = line.match(/^\s*/)?.[0].length ?? 0;
  if ((line[leadingWhitespace] ?? "") !== "/") return null;

  const replaceStart = bounds.lineStart + leadingWhitespace;
  let replaceEnd = replaceStart;
  while (replaceEnd < value.length) {
    const next = value[replaceEnd];
    if (next === undefined || next === "\n" || /\s/.test(next)) break;
    replaceEnd += 1;
  }

  return {
    query: value.slice(replaceStart + 1, replaceEnd),
    replaceStart,
    replaceEnd,
    cursorInsideToken:
      bounds.cursor >= replaceStart + 1 && bounds.cursor <= replaceEnd,
  };
}

function hasSlashMultilineConflict(value: string): boolean {
  const lines = value.split("\n");
  if (lines.length <= 1) return false;
  const first = lines[0]?.trimStart() ?? "";
  if (!first.startsWith("/")) return false;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim().length > 0) return true;
  }
  return false;
}

function isPrintableInputEvent(event: InputEvent): boolean {
  if (typeof event.input !== "string" || event.input.length === 0) return false;
  if (event.key.return || event.key.escape || event.key.tab) return false;
  if (
    event.key.upArrow ||
    event.key.downArrow ||
    event.key.leftArrow ||
    event.key.rightArrow ||
    event.key.home ||
    event.key.end ||
    event.key.backspace ||
    event.key.delete
  ) {
    return false;
  }
  if (event.key.ctrl || event.key.super) return false;
  return true;
}

function buildHistorySearchStatusLine(
  search: ComposerHistorySearchState | null,
): { readonly color: Color; readonly text: string } | null {
  if (search === null) return null;

  let suffix = "";
  if (search.status === "match") {
    const currentIndex = (search.matchIndex ?? 0) + 1;
    suffix = `  ${currentIndex}/${search.matches.length}  Enter accept  Esc cancel`;
  } else if (search.status === "no-match") {
    suffix = "  no match";
  }

  return {
    color:
      search.status === "no-match"
        ? (theme.colors.warning as Color)
        : (theme.colors.primary as Color),
    text: `reverse-i-search: ${search.query}${suffix}`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────

export const Composer: React.FC<ComposerProps> = ({
  session,
  config,
  onSubmit,
  onCancel,
  inputLocked = false,
  pasteStore,
}) => {
  const store = pasteStore ?? getPasteStore();

  // Seed history asynchronously; until the read completes the reducer
  // runs with an empty list. We hold the seeded history in a
  // `useState` rather than pushing it into the reducer because the
  // reducer's initial state is snapshot on first render.
  const [initialHistory, setInitialHistory] = useState<string[]>([]);
  useEffect(() => {
    const home = session.home ?? process.env.HOME ?? "";
    if (home.length === 0) return;
    let alive = true;
    void readHistory(home).then((entries) => {
      if (alive) setInitialHistory(entries);
    });
    return () => {
      alive = false;
    };
  }, [session.home]);

  const { state, dispatch } = useComposerState({ initialHistory });
  const stdin = useContext(StdinContext);
  const activeKeybindingContext = useActiveKeybindingContext();

  let appState:
    | ReturnType<typeof useAgenCAppState>
    | null = null;
  try {
    appState = useAgenCAppState();
  } catch {
    appState = null;
  }

  const mode = appState?.mode ?? "default";
  const isStreaming = appState?.isStreaming ?? false;
  const pendingRequestCount = appState?.pendingRequests.length ?? 0;
  const hasPendingTurn = isStreaming || pendingRequestCount > 0;

  const slashItems = useMemo(() => getSlashPaletteItems(), []);
  const [dismissedSlashToken, setDismissedSlashToken] = useState<string | null>(
    null,
  );
  const slashDraft = useMemo(
    () => readSlashDraft(state.value, state.cursor),
    [state.value, state.cursor],
  );
  const slashTokenKey = slashDraft
    ? `${slashDraft.replaceStart}:${slashDraft.replaceEnd}:${slashDraft.query}`
    : null;
  const slashMatches = useMemo(
    () => (slashDraft ? fuzzyMatch(slashItems, slashDraft.query) : []),
    [slashDraft, slashItems],
  );
  const slashPreviewItem = slashMatches[0] ?? null;
  const exactSlashSelection = useMemo(() => {
    if (!slashDraft || !slashPreviewItem) return false;
    const activeToken = state.value.slice(
      slashDraft.replaceStart,
      slashDraft.replaceEnd,
    );
    return activeToken === slashPreviewItem.value;
  }, [slashDraft, slashPreviewItem, state.value]);
  const showSlashPalette =
    Boolean(slashDraft?.cursorInsideToken) &&
    slashTokenKey !== dismissedSlashToken &&
    !exactSlashSelection &&
    state.historySearch === null;
  const slashConflict = hasSlashMultilineConflict(state.value);
  useEffect(() => {
    if (slashTokenKey === null && dismissedSlashToken !== null) {
      setDismissedSlashToken(null);
    }
  }, [dismissedSlashToken, slashTokenKey]);

  // Hold the latest `state.value` in a ref so imperative callbacks
  // (paste-complete → appendHistory) can read the freshest buffer
  // without being recreated on every render.
  const valueRef = useRef(state.value);
  useEffect(() => {
    valueRef.current = state.value;
  }, [state.value]);

  // ── paste-store → reducer bridge ───────────────────────────────────
  useEffect(() => {
    const onPasteEvent = (event: PasteEvent): void => {
      if (event.kind === "paste-start") {
        dispatch({ type: "PASTE_START" });
      } else if (event.kind === "paste-complete") {
        // Drain the buffer THROUGH the reducer — the store already
        // emitted `paste-complete` by the time this callback fires in
        // the fallback implementation, but draining here keeps the
        // Composer resilient to alternative paste-store lifetimes.
        const buffered = store.consumeBuffer();
        if (buffered.length > 0) {
          dispatch({ type: "INSERT", text: buffered });
        }
        dispatch({ type: "PASTE_COMPLETE" });
      }
    };
    const unsubscribe = store.subscribe(onPasteEvent);
    return unsubscribe;
  }, [store, dispatch]);

  // ── raw stdin → reducer bridge ─────────────────────────────────────
  useEffect(() => {
    const emitter = stdin.internal_eventEmitter;
    const onInput = (event: InputEvent): void => {
      if (inputLocked) {
        return;
      }
      if (activeKeybindingContext === "modal") {
        return;
      }
      if (state.historySearch !== null) {
        if (event.key.ctrl && event.input.toLowerCase() === "s") {
          dispatch({ type: "HISTORY_SEARCH_NEWER" });
          return;
        }
        if (event.key.backspace) {
          dispatch({ type: "HISTORY_SEARCH_BACKSPACE" });
          return;
        }
        if (event.key.ctrl && event.input.toLowerCase() === "u") {
          dispatch({ type: "HISTORY_SEARCH_CLEAR_QUERY" });
          return;
        }
        if (isPrintableInputEvent(event)) {
          dispatch({ type: "HISTORY_SEARCH_APPEND", text: event.input });
        }
        return;
      }
      const isFromBracketedPaste = event.keypress.isPasted === true;
      const shouldTreatAsPaste =
        isPrintableInputEvent(event) &&
        (isFromBracketedPaste ||
          store.isInFlight() ||
          event.input.length > PASTE_THRESHOLD);
      if (shouldTreatAsPaste) {
        store.pushChunk(event.input);
        return;
      }

      if (event.key.leftArrow || (event.key.ctrl && event.input === "b")) {
        dispatch({ type: "MOVE_CURSOR", delta: -1 });
        return;
      }
      if (event.key.rightArrow || (event.key.ctrl && event.input === "f")) {
        dispatch({ type: "MOVE_CURSOR", delta: 1 });
        return;
      }
      if (event.key.home || (event.key.ctrl && event.input === "a")) {
        dispatch({ type: "MOVE_CURSOR_HOME" });
        return;
      }
      if (event.key.end || (event.key.ctrl && event.input === "e")) {
        dispatch({ type: "MOVE_CURSOR_END" });
        return;
      }
      if (event.key.backspace) {
        dispatch({ type: "DELETE_BACKWARD" });
        return;
      }
      if (event.key.delete) {
        dispatch({ type: "DELETE_FORWARD" });
        return;
      }
      if (!isPrintableInputEvent(event)) return;
      dispatch({ type: "INSERT", text: event.input });
    };

    emitter.on("input", onInput);
    return () => {
      emitter.removeListener("input", onInput);
    };
  }, [
    activeKeybindingContext,
    dispatch,
    inputLocked,
    state.historySearch,
    stdin,
    store,
  ]);

  // ── keybindings ────────────────────────────────────────────────────
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  const home = session.home ?? process.env.HOME ?? "";

  const handleSubmit = useCallback((): void => {
    if (inputLocked) return;
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_ACCEPT" });
      return;
    }
    if (showSlashPalette || hasPendingTurn) return;
    if (store.isInFlight() || valueRef.current.length === 0) {
      // While a paste is mid-stream, forward the press to the reducer
      // which will buffer it (I-69). Empty submits are quietly dropped.
      dispatch({ type: "SUBMIT" });
      return;
    }
    const snapshot = valueRef.current;
    onSubmitRef.current(snapshot);
    dispatch({ type: "SUBMIT" });
    if (home.length > 0) {
      const entry: HistoryEntry = {
        timestamp: Date.now(),
        value: snapshot,
        cwd: session.cwd,
      };
      // Fire-and-forget — appending to ~/.agenc/history.jsonl must
      // never block the UI. Failures are swallowed because the user's
      // draft already made it to the transcript.
      void appendHistory(home, entry).catch(() => {
        // Silent — history is best-effort.
      });
    }
  }, [
    dispatch,
    hasPendingTurn,
    home,
    inputLocked,
    session.cwd,
    showSlashPalette,
    state.historySearch,
    store,
  ]);

  const handleCancel = useCallback((): void => {
    if (inputLocked) return;
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_CANCEL" });
      return;
    }
    if (showSlashPalette) return;
    if (valueRef.current.length > 0) {
      dispatch({ type: "CLEAR" });
      return;
    }
    if (!hasPendingTurn) return;
    dispatch({ type: "CLEAR" });
    if (onCancel) onCancel();
  }, [
    dispatch,
    hasPendingTurn,
    inputLocked,
    onCancel,
    showSlashPalette,
    state.historySearch,
  ]);

  const handleNewline = useCallback((): void => {
    if (inputLocked) return;
    if (state.historySearch !== null) return;
    dispatch({ type: "NEWLINE" });
  }, [dispatch, inputLocked, state.historySearch]);

  const handleHistoryPrev = useCallback((): void => {
    if (inputLocked) return;
    if (showSlashPalette) return;
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_OLDER" });
      return;
    }
    dispatch({ type: "HISTORY_PREV" });
  }, [dispatch, inputLocked, showSlashPalette, state.historySearch]);

  const handleHistoryNext = useCallback((): void => {
    if (inputLocked) return;
    if (showSlashPalette) return;
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_NEWER" });
      return;
    }
    dispatch({ type: "HISTORY_NEXT" });
  }, [dispatch, inputLocked, showSlashPalette, state.historySearch]);

  const handleHistorySearch = useCallback((): void => {
    if (inputLocked) return;
    if (activeKeybindingContext !== "chat") return;
    if (showSlashPalette) return;
    dispatch({ type: "HISTORY_SEARCH_START" });
  }, [activeKeybindingContext, dispatch, inputLocked, showSlashPalette]);

  useKeybinding("chat:submit", handleSubmit, "chat");
  useKeybinding("chat:cancel", handleCancel, "chat");
  useKeybinding("chat:newline", handleNewline, "chat");
  useKeybinding("history:prev", handleHistoryPrev, "chat");
  useKeybinding("history:next", handleHistoryNext, "chat");
  useKeybinding("history:search", handleHistorySearch, "global");

  // ── mention scanning + warning emission ────────────────────────────
  const allowedRoots = config?.attachments?.allowedRoots;
  const mentions = useMemo(
    () => scanMentions(state.value, session.cwd, allowedRoots),
    [state.value, session.cwd, allowedRoots],
  );

  // Emit one warning per unique rejected mention string. A ref set
  // guards against duplicate emissions when the user keeps typing
  // after the first rejection.
  const warnedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const m of mentions) {
      if (m.validation.ok) continue;
      if (warnedRef.current.has(m.raw)) continue;
      warnedRef.current.add(m.raw);
      if (session.emit) {
        session.emit("warning:mention_outside_workspace", {
          path: m.raw,
          reason: m.validation.reason,
        });
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `warning:mention_outside_workspace path=${m.raw} reason=${m.validation.reason}`,
        );
      }
    }
    // Garbage-collect warning records for mentions that the user has
    // since edited out of the buffer.
    const liveSet = new Set(mentions.map((m) => m.raw));
    for (const raw of Array.from(warnedRef.current)) {
      if (!liveSet.has(raw)) warnedRef.current.delete(raw);
    }
  }, [mentions, session]);

  const rejected = mentions.filter((m) => !m.validation.ok);
  const colors = theme.colors;
  const promptGlyph =
    theme.modeIndicatorChar[
      mode as keyof typeof theme.modeIndicatorChar
    ] ?? theme.modeIndicatorChar.default;
  const promptPrefix = `${promptGlyph} `;
  const accentColor = (
    pendingRequestCount > 0
      ? colors.warning
      : isStreaming
        ? colors.accent
        : colors.primary
  ) as Color;
  const handleSlashSelect = useCallback(
    (item: PaletteItem): void => {
      if (!slashDraft) return;
      setDismissedSlashToken(null);
      const trailing = state.value.slice(slashDraft.replaceEnd);
      const needsTrailingSpace =
        trailing.length === 0 || !/^\s/.test(trailing);
      dispatch({
        type: "REPLACE_RANGE",
        start: slashDraft.replaceStart,
        end: slashDraft.replaceEnd,
        text: `${item.value}${needsTrailingSpace ? " " : ""}`,
      });
    },
    [dispatch, slashDraft, state.value],
  );

  const statusLine = useMemo(() => {
    const historySearchLine = buildHistorySearchStatusLine(state.historySearch);
    if (historySearchLine) {
      return historySearchLine;
    }
    if (pendingRequestCount > 0) {
      return {
        color: colors.warning,
        text: "Approval pending. Resolve the modal with Y/N/A/D before sending the next turn.",
      };
    }
    if (isStreaming) {
      return {
        color: colors.accent,
        text: "Turn active. Keep drafting; Enter waits until the current turn is done.",
      };
    }
    if (state.pasteInFlight) {
      const suffix =
        state.pendingEnters > 0
          ? ` Enter queued x${state.pendingEnters}.`
          : "";
      return {
        color: colors.secondary,
        text: `Paste in progress.${suffix}`,
      };
    }
    if (slashConflict) {
      return {
        color: colors.warning,
        text: "Slash commands submit on a single line. Extra lines keep this as plain text.",
      };
    }
    if (slashDraft && slashDraft.query.length === 0) {
      return {
        color: colors.primary,
        text: "Browse commands with Up/Down. Tab or Enter inserts the selected command.",
      };
    }
    if (slashDraft && slashPreviewItem) {
      const opensPicker =
        exactSlashSelection && slashCommandOpensPicker(slashPreviewItem.value);
      return {
        color: colors.primary,
        text: opensPicker
          ? `Enter opens the ${slashPreviewItem.label} picker. Tab inserts it without submitting.`
          : exactSlashSelection
            ? `Enter runs ${slashPreviewItem.label}. Tab inserts it without submitting.`
          : (slashPreviewItem.description ??
            `${slashPreviewItem.label} is available.`),
      };
    }
    return {
      color: colors.dim,
      text: "Type a prompt or / for commands. Shift+Enter or Ctrl+J adds a newline.",
    };
  }, [
    isStreaming,
    pendingRequestCount,
    slashConflict,
    slashDraft,
    slashPreviewItem,
    state.pasteInFlight,
    state.pendingEnters,
    state.historySearch,
    exactSlashSelection,
  ]);

  // ── render ─────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {showSlashPalette ? (
        <Palette
          trigger="/"
          query={slashDraft?.query ?? ""}
          items={slashItems}
          placement="above"
          onSelect={handleSlashSelect}
          onClose={() => {
            if (slashTokenKey !== null) {
              setDismissedSlashToken(slashTokenKey);
            }
          }}
        />
      ) : null}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={accentColor}
        paddingX={1}
        width="100%"
      >
        <Box>
          <Text color={accentColor}>
            {promptPrefix}
          </Text>
          <ComposerBuffer
            value={state.value}
            cursor={state.cursor}
            promptPrefix={promptPrefix}
            cursorActive={!inputLocked}
          />
        </Box>
        <Box>
          <Text color={statusLine.color as Color}>{statusLine.text}</Text>
        </Box>
        {rejected.map((m) => (
          <Box key={m.raw}>
            <Text color={colors.warning}>{"\u26A0 outside workspace: "}</Text>
            <Text color={colors.error}>{m.raw}</Text>
          </Box>
        ))}
        {state.value.length > 0 && hasPendingTurn ? (
          <Box>
            <Text color={colors.dim}>
              {"Esc clears the draft first. Press Esc again on an empty composer to interrupt the turn."}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
};

// Re-export a couple of helpers so callers can import everything from
// this module instead of reaching into `./history.js` and friends.
export { HISTORY_FILE_REL };
