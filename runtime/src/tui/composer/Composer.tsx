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
 * the shared wrapped-cursor model and renders the caret in-band. Native
 * terminal cursor parking is deliberately avoided here because it can drift
 * over footer text when the renderer is recovering from scroll/resize frames.
 * The contract here covers both keystroke → state plumbing and stable
 * terminal-safe composer rendering for wrapped/multiline drafts.
 */

import React, {
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { buildDefaultRegistry, getGlobalCommandRegistry } from "../_deps/commands.js";
import {
  scanMentions,
  validateMentionPath,
  type DetectedMention,
  type MentionValidationResult,
} from "../../prompts/file-mentions.js";
import Box from "../ink/components/Box.js";
import StdinContext from "../ink/components/StdinContext.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import type { Color } from "../ink/styles.js";
import {
  useActiveKeybindingContext,
  useKeybinding,
} from "../keybindings/KeybindingContext.js";
import {
  getDisplayForCommand,
  getDisplaysForCommand,
} from "../keybindings/shortcutFormat.js";
import { slashCommandOpensPicker } from "../picker-intents.js";
import { useAgenCAppState } from "../state/AppState.js";
import { theme } from "../theme.js";
import {
  getPasteStore,
  type PasteEvent,
  type PasteStore,
} from "./paste-store.js";
import { Palette, fuzzyMatch, type PaletteItem } from "./Palette.js";
import { getMentionItems, getSlashCommandItems } from "./palette-sources.js";
import {
  HISTORY_FILE_REL,
  appendHistory,
  readHistory,
  type HistoryEntry,
} from "./history.js";
import { useComposerState } from "./useComposerState.js";
import { ComposerBuffer } from "./ComposerBuffer.js";
import {
  hasSlashMultilineConflict,
  isPrintableInputEvent,
  isSingleAsciiPrintable,
  readMentionDraft,
  readSlashDraft,
} from "./drafts.js";
import { buildHistorySearchStatusLine } from "./status-line.js";

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
  /** Optional text captured before Ink mounted; pre-fills without submitting. */
  readonly initialValue?: string;
  /** When true, ignore draft input and hide the declared text cursor. */
  readonly inputLocked?: boolean;
  /** Optional paste-store seam for tests. Defaults to the process singleton. */
  readonly pasteStore?: PasteStore;
}

// ────────────────────────────────────────────────────────────────────────
// Visual cursor rendering
// ────────────────────────────────────────────────────────────────────────

const PASTE_BURST_CHAR_INTERVAL_MS =
  process.platform === "win32" ? 30 : 8;
// Match openclaude's fallback threshold: regular typing can occasionally
// arrive in small multi-char chunks, so only treat very large unbracketed
// chunks as paste when the parser did not mark them as bracketed paste.
const PASTE_THRESHOLD = 800;

function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function useActiveTurnElapsedMs(active: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      setStartedAt(null);
      setNow(Date.now());
      return;
    }
    const current = Date.now();
    setStartedAt((previous) => previous ?? current);
    setNow(current);
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

function getSlashPaletteItems(): readonly PaletteItem[] {
  const registry = getGlobalCommandRegistry();
  if (registry) {
    return getSlashCommandItems(registry);
  }
  return getSlashCommandItems(buildDefaultRegistry());
}

// ────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────

export const Composer: React.FC<ComposerProps> = ({
  session,
  config,
  onSubmit,
  onCancel,
  initialValue,
  inputLocked = false,
  pasteStore,
}) => {
  const store = pasteStore ?? getPasteStore();
  const terminalSize = useContext(TerminalSizeContext);
  const chromeWidth =
    terminalSize !== null && terminalSize.columns > 0
      ? terminalSize.columns
      : "100%";

  const { state, dispatch } = useComposerState({
    initialHistory: [],
    initialValue,
  });

  // Seed history asynchronously. The reducer owns merging so prompts
  // submitted before the disk read resolves remain newer than loaded
  // entries, matching upstream reverse-history behavior.
  useEffect(() => {
    const home = session.home ?? process.env.HOME ?? "";
    if (home.length === 0) return;
    let alive = true;
    void readHistory(home).then((entries) => {
      if (alive) dispatch({ type: "LOAD_HISTORY", history: entries });
    });
    return () => {
      alive = false;
    };
  }, [dispatch, session.home]);
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
  const activeTurnElapsedMs = useActiveTurnElapsedMs(hasPendingTurn);

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
  const showSlashPalette =
    Boolean(slashDraft?.cursorInsideToken) &&
    slashTokenKey !== dismissedSlashToken &&
    state.historySearch === null;
  const slashConflict = hasSlashMultilineConflict(state.value);
  useEffect(() => {
    if (slashTokenKey === null && dismissedSlashToken !== null) {
      setDismissedSlashToken(null);
    }
  }, [dismissedSlashToken, slashTokenKey]);

  const [dismissedMentionToken, setDismissedMentionToken] = useState<
    string | null
  >(null);
  const [mentionItems, setMentionItems] = useState<readonly PaletteItem[]>([]);
  const mentionDraft = useMemo(
    () => readMentionDraft(state.value, state.cursor),
    [state.value, state.cursor],
  );
  const mentionTokenKey = mentionDraft
    ? `${mentionDraft.replaceStart}:${mentionDraft.replaceEnd}:${mentionDraft.query}`
    : null;
  const mentionMatches = useMemo(
    () => (mentionDraft ? fuzzyMatch(mentionItems, mentionDraft.query) : []),
    [mentionDraft, mentionItems],
  );
  const mentionPreviewItem = mentionMatches[0] ?? null;
  const showMentionPalette =
    Boolean(mentionDraft?.cursorInsideToken) &&
    mentionTokenKey !== dismissedMentionToken &&
    state.historySearch === null &&
    !showSlashPalette;
  useEffect(() => {
    if (mentionTokenKey === null && dismissedMentionToken !== null) {
      setDismissedMentionToken(null);
    }
  }, [dismissedMentionToken, mentionTokenKey]);
  const mentionRequestSeqRef = useRef(0);
  useEffect(() => {
    if (!mentionDraft?.cursorInsideToken) {
      mentionRequestSeqRef.current += 1;
      setMentionItems([]);
      return undefined;
    }
    const seq = mentionRequestSeqRef.current + 1;
    mentionRequestSeqRef.current = seq;
    const timeout = setTimeout(() => {
      void getMentionItems(session.cwd, mentionDraft.query).then((items) => {
        if (mentionRequestSeqRef.current === seq) setMentionItems(items);
      });
    }, 80);
    return () => {
      clearTimeout(timeout);
    };
  }, [mentionDraft?.cursorInsideToken, mentionDraft?.query, session.cwd]);

  // Hold the latest `state.value` in a ref so imperative callbacks
  // (paste-complete → appendHistory) can read the freshest buffer
  // without being recreated on every render.
  const valueRef = useRef(state.value);
  useEffect(() => {
    valueRef.current = state.value;
  }, [state.value]);

  const pendingPlainCharRef = useRef<{
    readonly text: string;
    readonly deadline: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const flushPendingPlainChar = useCallback((): string => {
    const pending = pendingPlainCharRef.current;
    if (pending === null) return "";
    clearTimeout(pending.timer);
    pendingPlainCharRef.current = null;
    const cursor = Math.max(0, Math.min(state.cursor, state.value.length));
    valueRef.current =
      state.value.slice(0, cursor) +
      pending.text +
      state.value.slice(cursor);
    dispatch({ type: "INSERT", text: pending.text });
    return pending.text;
  }, [dispatch, state.cursor, state.value]);

  const valueAfterFlushingPendingPlainChar = useCallback((): string => {
    flushPendingPlainChar();
    return valueRef.current;
  }, [flushPendingPlainChar]);

  const clearPendingPlainChar = useCallback((): void => {
    const pending = pendingPlainCharRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingPlainCharRef.current = null;
  }, []);

  const beginPasteBurst = useCallback(
    (currentText: string): void => {
      const pending = pendingPlainCharRef.current;
      if (pending !== null) {
        clearTimeout(pending.timer);
        pendingPlainCharRef.current = null;
        store.pushChunk(pending.text);
      }
      if (currentText.length > 0) {
        store.pushChunk(currentText);
      }
    },
    [store],
  );

  useEffect(
    () => () => {
      clearPendingPlainChar();
    },
    [clearPendingPlainChar],
  );

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
        if (!isPrintableInputEvent(event)) {
          flushPendingPlainChar();
        }
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
        beginPasteBurst(event.input);
        return;
      }

      if (isPrintableInputEvent(event) && isSingleAsciiPrintable(event.input)) {
        const now = Date.now();
        const pending = pendingPlainCharRef.current;
        if (pending !== null && now <= pending.deadline) {
          beginPasteBurst(event.input);
          return;
        }

        if (pending !== null) {
          flushPendingPlainChar();
        }

        const timer = setTimeout(() => {
          if (pendingPlainCharRef.current?.timer !== timer) return;
          pendingPlainCharRef.current = null;
          dispatch({ type: "INSERT", text: event.input });
        }, PASTE_BURST_CHAR_INTERVAL_MS + 1);
        pendingPlainCharRef.current = {
          text: event.input,
          deadline: now + PASTE_BURST_CHAR_INTERVAL_MS,
          timer,
        };
        return;
      }

      flushPendingPlainChar();

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
    beginPasteBurst,
    dispatch,
    flushPendingPlainChar,
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
    const effectiveValue = valueAfterFlushingPendingPlainChar();
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_ACCEPT" });
      return;
    }
    if (showSlashPalette || showMentionPalette || hasPendingTurn) return;
    if (store.isInFlight() || effectiveValue.length === 0) {
      // While a paste is mid-stream, forward the press to the reducer
      // which will buffer it (I-69). Empty submits are quietly dropped.
      dispatch({ type: "SUBMIT" });
      return;
    }
    const snapshot = effectiveValue;
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
    showMentionPalette,
    showSlashPalette,
    state.historySearch,
    store,
    valueAfterFlushingPendingPlainChar,
  ]);

  const handleCancel = useCallback((): void => {
    if (inputLocked) return;
    const effectiveValue = valueAfterFlushingPendingPlainChar();
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_CANCEL" });
      return;
    }
    if (showSlashPalette || showMentionPalette) return;
    if (effectiveValue.length > 0) {
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
    showMentionPalette,
    showSlashPalette,
    state.historySearch,
    valueAfterFlushingPendingPlainChar,
  ]);

  const handleNewline = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (state.historySearch !== null) return;
    dispatch({ type: "NEWLINE" });
  }, [dispatch, flushPendingPlainChar, inputLocked, state.historySearch]);

  const handleHistoryPrev = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (showSlashPalette || showMentionPalette) return;
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_OLDER" });
      return;
    }
    dispatch({ type: "HISTORY_PREV" });
  }, [
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    showMentionPalette,
    showSlashPalette,
    state.historySearch,
  ]);

  const handleHistoryNext = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (showSlashPalette || showMentionPalette) return;
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_NEWER" });
      return;
    }
    dispatch({ type: "HISTORY_NEXT" });
  }, [
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    showMentionPalette,
    showSlashPalette,
    state.historySearch,
  ]);

  const handleHistorySearch = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (activeKeybindingContext !== "chat") return;
    if (showSlashPalette || showMentionPalette) return;
    dispatch({ type: "HISTORY_SEARCH_START" });
  }, [
    activeKeybindingContext,
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    showMentionPalette,
    showSlashPalette,
  ]);

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
  const submitKey = getDisplayForCommand("chat:submit", "chat") ?? "Enter";
  const acceptSuggestionKey =
    getDisplayForCommand("chat:acceptSuggestion", "chat") ?? "Tab";
  const newlineKeys = getDisplaysForCommand("chat:newline", "chat");
  const formattedNewlineKeys =
    newlineKeys.length > 0 ? newlineKeys.join(" or ") : "Shift+Enter or Ctrl+J";
  const approvalDecisionKeys = [
    getDisplayForCommand("modal:yes", "modal") ?? "Y",
    getDisplayForCommand("modal:no", "modal") ?? "N",
    getDisplayForCommand("modal:allowSession", "modal") ?? "A",
    getDisplayForCommand("modal:deny", "modal") ?? "D",
  ].join("/");
  const cancelKey = getDisplayForCommand("chat:cancel", "chat") ?? "Esc";
  const handleSlashSelect = useCallback(
    (item: PaletteItem): void => {
      if (!slashDraft) return;
      const activeToken = state.value.slice(
        slashDraft.replaceStart,
        slashDraft.replaceEnd,
      );
      if (activeToken === item.value) {
        if (slashTokenKey !== null) {
          setDismissedSlashToken(slashTokenKey);
        }
        return;
      }
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
    [dispatch, slashDraft, slashTokenKey, state.value],
  );
  const handleMentionSelect = useCallback(
    (item: PaletteItem): void => {
      if (!mentionDraft) return;
      const activeToken = state.value.slice(
        mentionDraft.replaceStart,
        mentionDraft.replaceEnd,
      );
      if (activeToken === item.value) {
        if (mentionTokenKey !== null) {
          setDismissedMentionToken(mentionTokenKey);
        }
        return;
      }
      setDismissedMentionToken(null);
      const trailing = state.value.slice(mentionDraft.replaceEnd);
      const needsTrailingSpace =
        trailing.length === 0 || !/^\s/.test(trailing);
      dispatch({
        type: "REPLACE_RANGE",
        start: mentionDraft.replaceStart,
        end: mentionDraft.replaceEnd,
        text: `${item.value}${needsTrailingSpace ? " " : ""}`,
      });
    },
    [dispatch, mentionDraft, mentionTokenKey, state.value],
  );

  const activityLine = useMemo(() => {
    if (pendingRequestCount > 0) {
      return {
        color: colors.warning,
        text: `Approval pending (${approvalDecisionKeys})`,
      };
    }
    if (isStreaming) {
      return {
        color: colors.muted,
        text: `Working (${formatElapsedDuration(activeTurnElapsedMs)} · ${cancelKey.toLowerCase()} to interrupt)`,
      };
    }
    return null;
  }, [
    activeTurnElapsedMs,
    approvalDecisionKeys,
    cancelKey,
    colors.muted,
    colors.warning,
    isStreaming,
    pendingRequestCount,
  ]);

  const statusLine = useMemo(() => {
    const historySearchLine = buildHistorySearchStatusLine(state.historySearch, {
      accept: submitKey,
      cancel: cancelKey,
    });
    if (historySearchLine) {
      return historySearchLine;
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
        text: `Browse commands with Up/Down. ${acceptSuggestionKey} or ${submitKey} inserts the selected command.`,
      };
    }
    if (slashDraft && slashPreviewItem) {
      return {
        color: colors.primary,
        text:
          slashPreviewItem.description ??
          (slashCommandOpensPicker(slashPreviewItem.value)
            ? `${slashPreviewItem.label} opens a picker after you accept it.`
            : `${slashPreviewItem.label} is available.`),
      };
    }
    if (mentionDraft && mentionDraft.query.length === 0) {
      return {
        color: colors.primary,
        text: `Browse files with Up/Down. ${acceptSuggestionKey} or ${submitKey} inserts the selected @file.`,
      };
    }
    if (mentionDraft && mentionPreviewItem) {
      return {
        color: colors.primary,
        text: `Attach ${mentionPreviewItem.label} to the next prompt.`,
      };
    }
    return {
      color: colors.dim,
      text: `Type prompt. / commands. @ files. ${formattedNewlineKeys} newline.`,
    };
  }, [
    acceptSuggestionKey,
    cancelKey,
    formattedNewlineKeys,
    mentionDraft,
    mentionPreviewItem,
    slashConflict,
    slashDraft,
    slashPreviewItem,
    state.pasteInFlight,
    state.pendingEnters,
    state.historySearch,
    submitKey,
  ]);
  const showInstructionLine =
    state.historySearch !== null ||
    state.pasteInFlight ||
    slashConflict ||
    slashDraft !== null ||
    mentionDraft !== null;
  const placeholderText =
    state.value.length === 0 && !showInstructionLine
      ? `Type prompt. / commands. @ files. ${formattedNewlineKeys} newline.`
      : "";

  // ── render ─────────────────────────────────────────────────────────
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width={chromeWidth}
    >
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
      {showMentionPalette ? (
        <Palette
          trigger="@"
          query={mentionDraft?.query ?? ""}
          items={mentionItems}
          placement="above"
          onSelect={handleMentionSelect}
          onClose={() => {
            if (mentionTokenKey !== null) {
              setDismissedMentionToken(mentionTokenKey);
            }
          }}
        />
      ) : null}
      <Box
        flexDirection="column"
        flexShrink={0}
        overflowX="hidden"
        width={chromeWidth}
      >
        {activityLine !== null ? (
          <Box
            flexDirection="row"
            overflowX="hidden"
            width={chromeWidth}
            backgroundColor={colors.surface as Color}
          >
            <Text>{"  "}</Text>
            <Text color={activityLine.color as Color} bold>
              {"• "}
            </Text>
            <Text color={activityLine.color as Color} wrap="truncate">
              {activityLine.text}
            </Text>
          </Box>
        ) : null}
        <Box
          flexDirection="row"
          alignItems="flex-start"
          justifyContent="flex-start"
          overflowX="hidden"
          width={chromeWidth}
          backgroundColor={colors.surfaceAlt as Color}
        >
          <Text>{"  "}</Text>
          <Text color={accentColor}>
            {promptPrefix}
          </Text>
          <Box flexDirection="row" flexGrow={1} flexShrink={1} overflowX="hidden">
            <ComposerBuffer
              value={state.value}
              cursor={state.cursor}
              promptPrefix={promptPrefix}
              cursorActive={!inputLocked}
            />
            {placeholderText.length > 0 ? (
              <Text color={colors.dim as Color} wrap="truncate">
                {placeholderText}
              </Text>
            ) : null}
          </Box>
        </Box>
        {showInstructionLine ? (
          <Box
            flexDirection="row"
            overflowX="hidden"
            width={chromeWidth}
            backgroundColor={colors.surface as Color}
          >
            <Text>{"  "}</Text>
            <Text color={statusLine.color as Color} wrap="truncate">
              {statusLine.text}
            </Text>
          </Box>
        ) : null}
        {rejected.map((m) => (
          <Box
            key={m.raw}
            overflowX="hidden"
            width={chromeWidth}
            backgroundColor={colors.surface as Color}
          >
            <Text>{"  "}</Text>
            <Text color={colors.warning}>{"\u26A0 outside workspace: "}</Text>
            <Text color={colors.error}>{m.raw}</Text>
          </Box>
        ))}
        {state.value.length > 0 && hasPendingTurn ? (
          <Box
            overflowX="hidden"
            width={chromeWidth}
            backgroundColor={colors.surface as Color}
          >
            <Text>{"  "}</Text>
            <Text color={colors.dim}>
              {`${cancelKey} clears the draft first. Press ${cancelKey} again on an empty composer to interrupt the turn.`}
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
export { validateMentionPath };
export type { DetectedMention, MentionValidationResult };
