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
 * The React tree stays intentionally small, but the live buffer now follows
 * the AgenC text-input contract: the wrapped-cursor model renders
 * styled text through the ANSI parser while `useDeclaredCursor` tells Ink
 * where to park the physical cursor for IME/accessibility. The contract
 * here covers both keystroke → state plumbing and stable terminal-safe
 * composer rendering for wrapped/multiline drafts.
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
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import type { Color } from "../ink/styles.js";
import {
  useActiveKeybindingContext,
  useKeybinding,
} from "../keybindings/KeybindingContext.js";
import {
  getDisplayForCommand,
} from "../keybindings/shortcutFormat.js";
import { slashCommandOpensPicker } from "../picker-intents.js";
import { useAgenCAppState } from "../state/AppState.js";
import { modeValueColor, theme } from "../theme.js";
import type { PermissionMode } from "../../permissions/types.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../tools/system/ask-user-question.js";
import {
  getPasteStore,
  type PasteEvent,
  type PasteStore,
} from "./paste-store.js";
import { Palette, fuzzyMatch, type PaletteItem } from "./Palette.js";
import {
  getAppMentionItems,
  getMentionItems,
  getSkillMentionItems,
  getSlashCommandItems,
  type AppMentionServiceLike,
  type SkillMentionServiceLike,
} from "./palette-sources.js";
import {
  HISTORY_FILE_REL,
  appendHistory,
  readHistory,
  type HistoryEntry,
} from "./history.js";
import { normalizePastedImageSource } from "./inputPaste.js";
import {
  expandPendingPastes,
  useComposerState,
} from "./useComposerState.js";
import { ComposerBuffer } from "./ComposerBuffer.js";
import {
  hasSlashMultilineConflict,
  isPrintableInputEvent,
  isSingleAsciiPrintable,
  readMentionDraft,
  readSkillMentionDraft,
  readSlashDraft,
} from "./drafts.js";
import { buildHistorySearchStatusLine } from "./status-line.js";
import { isVimModeEnabled } from "./promptInput-utils.js";
import PromptInputFooter from "./PromptInputFooter.js";
import { getModeFromInput, type PromptInputMode } from "./inputModes.js";
import type { EditorMode } from "../../config/schema.js";
import type { LLMContentPart, LLMMessage } from "../../llm/types.js";
import type { SessionLike as StatusLineSessionLike } from "../cockpit/StatusLineConfig.js";

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
  /** Optional live skills service for AgenC-style `$skill` mentions. */
  readonly skillsManager?: SkillMentionServiceLike;
  /**
   * Optional app/connector registry. When present, app entries are merged
   * into the same `$` palette as skills with a `kind: "app"` tag so the
   * insertion handler can route them to the correct runtime resolver.
   */
  readonly appsManager?: AppMentionServiceLike;
  /** Optional upstream-style one-shot voice input provider. */
  readonly voiceInput?: () => Promise<string | null | undefined>;
  /** Optional runtime mailbox used to attach multimodal content to a submit. */
  enqueueIdleInput?(input: LLMMessage): number;
}

export interface ComposerAttachmentsConfig {
  readonly allowedRoots?: readonly string[];
}

export interface ComposerConfig {
  readonly attachments?: ComposerAttachmentsConfig;
  readonly editorMode?: EditorMode;
  readonly statusLine?: {
    readonly items: readonly string[];
    readonly session: StatusLineSessionLike;
    readonly cwd?: string;
  };
}

export interface ComposerProps {
  readonly session: ComposerSession;
  /** Optional attachments config — resolves `config.attachments.allowedRoots`. */
  readonly config?: ComposerConfig;
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
// Composer timing constants
// ────────────────────────────────────────────────────────────────────────

const PASTE_BURST_CHAR_INTERVAL_MS =
  process.platform === "win32" ? 30 : 8;
// Match AgenC's fallback threshold: regular typing can occasionally
// arrive in small multi-char chunks, so only treat very large unbracketed
// chunks as paste when the parser did not mark them as bracketed paste.
const PASTE_THRESHOLD = 800;
function buildSubmittedText(
  value: string,
  state: {
    readonly pendingPastes: Parameters<typeof expandPendingPastes>[1];
    readonly remoteImages: readonly {
      readonly placeholder: string;
      readonly source: string;
    }[];
    readonly localImages: readonly {
      readonly placeholder: string;
      readonly source: string;
    }[];
  },
): string {
  const expanded = expandPendingPastes(value, state.pendingPastes);
  const attachmentLines = [...state.remoteImages, ...state.localImages].map(
    (image) => `${image.placeholder}: ${image.source}`,
  );
  return attachmentLines.length === 0
    ? expanded
    : `${attachmentLines.join("\n")}\n\n${expanded}`;
}

function imageAttachmentsToContentParts(state: {
  readonly remoteImages: readonly {
    readonly content?: string;
  }[];
  readonly localImages: readonly {
    readonly content?: string;
  }[];
}): LLMContentPart[] {
  return [...state.remoteImages, ...state.localImages]
    .map((image) => image.content)
    .filter((content): content is string => typeof content === "string" && content.length > 0)
    .map((url) => ({ type: "image_url", image_url: { url } }));
}

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

  const { state, dispatch } = useComposerState({
    initialHistory: [],
    initialValue,
  });
  const vimEnabled = isVimModeEnabled(
    config?.editorMode !== undefined ? { editorMode: config.editorMode } : null,
  );
  const [vimMode, setVimMode] = useState<"INSERT" | "NORMAL">("INSERT");
  const [helpOpen, setHelpOpen] = useState(false);

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
  const hasPendingAskUserQuestion =
    appState?.pendingRequests.some(
      (request) => request.toolName === ASK_USER_QUESTION_TOOL_NAME,
    ) ?? false;
  const genericPendingRequestCount = hasPendingAskUserQuestion
    ? 0
    : pendingRequestCount;
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
  // Inline ghost hint for slash commands. Only shown when there is exactly
  // one matching command — otherwise the user is still narrowing down which
  // command they want and a hint would be misleading. Cursor.render gates
  // the actual rendering on `isAtEnd()`, so this naturally stays hidden
  // when the caret is mid-buffer.
  const argumentHint = useMemo<string | undefined>(() => {
    if (slashDraft === null) return undefined;
    if (slashMatches.length !== 1) return undefined;
    const description = slashMatches[0]?.description;
    if (typeof description !== "string" || description.length === 0)
      return undefined;
    return ` — ${description}`;
  }, [slashDraft, slashMatches]);
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

  const [dismissedSkillToken, setDismissedSkillToken] = useState<string | null>(
    null,
  );
  const [skillMentionItems, setSkillMentionItems] = useState<
    readonly PaletteItem[]
  >([]);
  const skillDraft = useMemo(
    () => readSkillMentionDraft(state.value, state.cursor),
    [state.value, state.cursor],
  );
  const skillTokenKey = skillDraft
    ? `${skillDraft.replaceStart}:${skillDraft.replaceEnd}:${skillDraft.query}`
    : null;
  const skillMatches = useMemo(
    () => (skillDraft ? fuzzyMatch(skillMentionItems, skillDraft.query) : []),
    [skillDraft, skillMentionItems],
  );
  const skillPreviewItem = skillMatches[0] ?? null;
  const showSkillPalette =
    Boolean(skillDraft?.cursorInsideToken) &&
    skillTokenKey !== dismissedSkillToken &&
    state.historySearch === null &&
    !showSlashPalette &&
    !showMentionPalette &&
    skillMentionItems.length > 0;
  useEffect(() => {
    if (skillTokenKey === null && dismissedSkillToken !== null) {
      setDismissedSkillToken(null);
    }
  }, [dismissedSkillToken, skillTokenKey]);
  useEffect(() => {
    if (!skillDraft?.cursorInsideToken) {
      setSkillMentionItems([]);
      return undefined;
    }
    let alive = true;
    const timeout = setTimeout(() => {
      // Skills and apps share the `$<token>` trigger; they're fetched in
      // parallel and merged into one ranked list. The `kind` tag on each
      // PaletteItem lets the insertion handler route to the right resolver.
      void Promise.all([
        getSkillMentionItems(session.skillsManager),
        getAppMentionItems(session.appsManager),
      ]).then(([skillItems, appItems]) => {
        if (!alive) return;
        if (appItems.length === 0) {
          setSkillMentionItems(skillItems);
          return;
        }
        if (skillItems.length === 0) {
          setSkillMentionItems(appItems);
          return;
        }
        setSkillMentionItems([...skillItems, ...appItems]);
      });
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, [
    session.appsManager,
    session.skillsManager,
    skillDraft?.cursorInsideToken,
    skillDraft?.query,
  ]);

  // Hold the latest `state.value` in a ref so imperative callbacks
  // (paste-complete → appendHistory) can read the freshest buffer
  // without being recreated on every render.
  const stateRef = useRef(state);
  const valueRef = useRef(state.value);
  useEffect(() => {
    stateRef.current = state;
    valueRef.current = state.value;
  }, [state]);

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
    const latestState = stateRef.current;
    const cursor = Math.max(
      0,
      Math.min(latestState.cursor, latestState.value.length),
    );
    valueRef.current =
      latestState.value.slice(0, cursor) +
      pending.text +
      latestState.value.slice(cursor);
    dispatch({ type: "INSERT", text: pending.text });
    return pending.text;
  }, [dispatch]);

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
          const image = normalizePastedImageSource(
            buffered,
            session.cwd,
            session.home,
          );
          if (image) {
            dispatch({
              type: "ATTACH_IMAGE",
              kind: image.kind === "local" ? "local" : "remote",
              source: image.source,
              content: image.content,
              mediaType: image.mediaType,
              sourcePath: image.sourcePath,
            });
          } else {
            dispatch({ type: "INSERT_PASTE", text: buffered });
          }
        }
        dispatch({ type: "PASTE_COMPLETE" });
      }
    };
    const unsubscribe = store.subscribe(onPasteEvent);
    return unsubscribe;
  }, [store, dispatch, session.cwd, session.home]);

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
      if (helpOpen && (event.key.escape || isPrintableInputEvent(event))) {
        setHelpOpen(false);
        if (event.key.escape) return;
      }
      if (vimEnabled && event.key.escape) {
        clearPendingPlainChar();
        setVimMode("NORMAL");
        return;
      }
      if (vimEnabled && vimMode === "NORMAL") {
        if (!isPrintableInputEvent(event)) return;
        switch (event.input) {
          case "i":
            setVimMode("INSERT");
            return;
          case "a":
            dispatch({ type: "MOVE_CURSOR", delta: 1 });
            setVimMode("INSERT");
            return;
          case "A":
            dispatch({ type: "MOVE_CURSOR_END" });
            setVimMode("INSERT");
            return;
          case "I":
            dispatch({ type: "MOVE_CURSOR_HOME" });
            setVimMode("INSERT");
            return;
          case "o":
            dispatch({ type: "MOVE_CURSOR_END" });
            dispatch({ type: "NEWLINE" });
            setVimMode("INSERT");
            return;
          case "h":
            dispatch({ type: "MOVE_CURSOR", delta: -1 });
            return;
          case "l":
            dispatch({ type: "MOVE_CURSOR", delta: 1 });
            return;
          case "0":
            dispatch({ type: "MOVE_CURSOR_HOME" });
            return;
          case "$":
            dispatch({ type: "MOVE_CURSOR_END" });
            return;
          case "x":
            dispatch({ type: "DELETE_FORWARD" });
            return;
          default:
            return;
        }
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
      if (
        state.remoteImages.length > 0 &&
        (event.key.upArrow || event.key.downArrow)
      ) {
        flushPendingPlainChar();
        dispatch({
          type: "MOVE_REMOTE_IMAGE_SELECTION",
          delta: event.key.upArrow ? -1 : 1,
        });
        return;
      }
      if (event.key.delete && state.selectedRemoteImageIndex !== null) {
        flushPendingPlainChar();
        dispatch({ type: "DELETE_SELECTED_REMOTE_IMAGE" });
        return;
      }
      const isFromBracketedPaste = event.keypress.isPasted === true;
      const shouldTreatAsPaste =
        isPrintableInputEvent(event) &&
        (isFromBracketedPaste ||
          store.isInFlight() ||
          event.input.length > PASTE_THRESHOLD);
      if (
        isPrintableInputEvent(event) &&
        event.input === "?" &&
        state.value.length === 0 &&
        state.remoteImages.length === 0 &&
        state.localImages.length === 0
      ) {
        flushPendingPlainChar();
        setHelpOpen(true);
        return;
      }
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
          const latestState = stateRef.current;
          const cursor = Math.max(
            0,
            Math.min(latestState.cursor, latestState.value.length),
          );
          valueRef.current =
            latestState.value.slice(0, cursor) +
            event.input +
            latestState.value.slice(cursor);
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
    clearPendingPlainChar,
    dispatch,
    flushPendingPlainChar,
    helpOpen,
    inputLocked,
    state.historySearch,
    state.localImages.length,
    state.remoteImages.length,
    state.selectedRemoteImageIndex,
    state.value.length,
    stdin,
    store,
    vimEnabled,
    vimMode,
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
    if (
      showSlashPalette ||
      showMentionPalette ||
      showSkillPalette ||
      hasPendingTurn
    ) {
      return;
    }
    const hasImages =
      state.remoteImages.length > 0 || state.localImages.length > 0;
    if (store.isInFlight() || (effectiveValue.length === 0 && !hasImages)) {
      // While a paste is mid-stream, forward the press to the reducer
      // which will buffer it (I-69). Empty submits are quietly dropped.
      dispatch({ type: "SUBMIT" });
      return;
    }
    const snapshot = buildSubmittedText(effectiveValue, state);
    // Re-scan mentions on the post-`expandPendingPastes` snapshot so the
    // persisted offsets line up with the value that lands in history. The
    // live `mentions` memo is computed against the pre-expansion buffer
    // and would carry stale offsets if a placeholder expanded in the
    // middle of the prompt.
    const submittedMentions = scanMentions(
      snapshot,
      session.cwd,
      config?.attachments?.allowedRoots,
    ).map((m) => ({
      start: m.start,
      end: m.end,
      kind: "file" as const,
      ...(m.validation.ok ? { resolved: m.validation.resolved } : {}),
    }));
    const imageParts = imageAttachmentsToContentParts(state);
    if (imageParts.length > 0) {
      session.enqueueIdleInput?.({
        role: "user",
        content: imageParts,
      });
    }
    onSubmitRef.current(snapshot);
    dispatch({
      type: "SUBMIT",
      historyValue: snapshot,
      historyMentions: submittedMentions,
    });
    if (home.length > 0) {
      const entry: HistoryEntry = {
        timestamp: Date.now(),
        value: snapshot,
        cwd: session.cwd,
        ...(submittedMentions.length > 0
          ? { mentions: submittedMentions }
          : {}),
      };
      // Fire-and-forget — appending to ~/.agenc/history.jsonl must
      // never block the UI. Failures are swallowed because the user's
      // draft already made it to the transcript.
      void appendHistory(home, entry).catch(() => {
        // Silent — history is best-effort.
      });
    }
  }, [
    config?.attachments?.allowedRoots,
    dispatch,
    hasPendingTurn,
    home,
    inputLocked,
    session.cwd,
    showMentionPalette,
    showSlashPalette,
    showSkillPalette,
    state.historySearch,
    state.localImages,
    state.pendingPastes,
    state.remoteImages,
    store,
    valueAfterFlushingPendingPlainChar,
  ]);

  const handleCancel = useCallback((): void => {
    if (inputLocked) return;
    if (helpOpen) {
      setHelpOpen(false);
      return;
    }
    if (vimEnabled && vimMode === "INSERT") {
      flushPendingPlainChar();
      setVimMode("NORMAL");
      return;
    }
    const effectiveValue = valueAfterFlushingPendingPlainChar();
    if (state.historySearch !== null) {
      dispatch({ type: "HISTORY_SEARCH_CANCEL" });
      return;
    }
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
    if (
      effectiveValue.length > 0 ||
      state.localImages.length > 0 ||
      state.remoteImages.length > 0
    ) {
      dispatch({ type: "CLEAR" });
      return;
    }
    if (!hasPendingTurn) return;
    dispatch({ type: "CLEAR" });
    if (onCancel) onCancel();
  }, [
    dispatch,
    hasPendingTurn,
    helpOpen,
    inputLocked,
    onCancel,
    showMentionPalette,
    showSlashPalette,
    showSkillPalette,
    state.historySearch,
    state.localImages.length,
    state.remoteImages.length,
    valueAfterFlushingPendingPlainChar,
    vimEnabled,
    vimMode,
    flushPendingPlainChar,
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
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
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
    showSkillPalette,
    state.historySearch,
  ]);

  const handleHistoryNext = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
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
    showSkillPalette,
    state.historySearch,
  ]);

  const handleHistorySearch = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (activeKeybindingContext !== "chat") return;
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
    dispatch({ type: "HISTORY_SEARCH_START" });
  }, [
    activeKeybindingContext,
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    showMentionPalette,
    showSlashPalette,
    showSkillPalette,
  ]);

  // Kill (Ctrl-K) and yank (Ctrl-Y) follow Emacs semantics. The kill buffer
  // survives CLEAR and SUBMIT so a yank in the next prompt can restore the
  // last kill — the reducer keeps `killBuffer` outside the per-submit reset.
  // Both handlers flush the burst-debounced pending char first, matching the
  // submit/cancel ordering above.
  const handleKillToEnd = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (state.historySearch !== null) return;
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
    dispatch({ type: "KILL_TO_END_OF_LINE" });
  }, [
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    showMentionPalette,
    showSlashPalette,
    showSkillPalette,
    state.historySearch,
  ]);

  const handleYank = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (state.historySearch !== null) return;
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
    dispatch({ type: "YANK" });
  }, [
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    showMentionPalette,
    showSlashPalette,
    showSkillPalette,
    state.historySearch,
  ]);

  const handleVoiceInput = useCallback((): void => {
    if (inputLocked) return;
    flushPendingPlainChar();
    if (state.historySearch !== null) return;
    if (showSlashPalette || showMentionPalette || showSkillPalette) return;
    const readVoice = session.voiceInput;
    if (typeof readVoice !== "function") {
      session.emit?.("warning:voice_input_unavailable", {
        reason: "voice input service is not configured",
      });
      return;
    }
    void readVoice()
      .then((transcript) => {
        if (typeof transcript !== "string" || transcript.length === 0) return;
        dispatch({ type: "INSERT", text: transcript });
      })
      .catch((error: unknown) => {
        session.emit?.("warning:voice_input_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }, [
    dispatch,
    flushPendingPlainChar,
    inputLocked,
    session,
    showMentionPalette,
    showSkillPalette,
    showSlashPalette,
    state.historySearch,
  ]);

  useKeybinding("chat:submit", handleSubmit, "chat");
  useKeybinding("chat:cancel", handleCancel, "chat");
  useKeybinding("chat:newline", handleNewline, "chat");
  useKeybinding("chat:killToEnd", handleKillToEnd, "chat");
  useKeybinding("chat:yank", handleYank, "chat");
  useKeybinding("chat:voiceInput", handleVoiceInput, "chat");
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
  // Single source of truth — same helper StatusLineConfig consumes — so
  // the `◆`/`⚠` mode glyph never drifts in color across the UI. Default
  // mode keeps its activity tint (ember while streaming, warning when an
  // approval is pending); non-default modes always show their canonical
  // mode color, with `warning` overriding only when there's a pending
  // approval to draw the eye to.
  const accentColor = modeValueColor(mode as PermissionMode, {
    colors,
    pendingRequestCount: genericPendingRequestCount,
    isStreaming,
  }) as Color;
  const submitKey = getDisplayForCommand("chat:submit", "chat") ?? "Enter";
  const acceptSuggestionKey =
    getDisplayForCommand("chat:acceptSuggestion", "chat") ?? "Tab";
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
  const handleSkillSelect = useCallback(
    (item: PaletteItem): void => {
      if (!skillDraft) return;
      const activeToken = state.value.slice(
        skillDraft.replaceStart,
        skillDraft.replaceEnd,
      );
      if (activeToken === item.value) {
        if (skillTokenKey !== null) {
          setDismissedSkillToken(skillTokenKey);
        }
        return;
      }
      setDismissedSkillToken(null);
      const trailing = state.value.slice(skillDraft.replaceEnd);
      const needsTrailingSpace =
        trailing.length === 0 || !/^\s/.test(trailing);
      dispatch({
        type: "REPLACE_RANGE",
        start: skillDraft.replaceStart,
        end: skillDraft.replaceEnd,
        text: `${item.value}${needsTrailingSpace ? " " : ""}`,
      });
    },
    [dispatch, skillDraft, skillTokenKey, state.value],
  );

  const activityLine = useMemo(() => {
    if (genericPendingRequestCount > 0) {
      return {
        color: colors.warning,
        text: `Approval pending (${approvalDecisionKeys})`,
      };
    }
    if (isStreaming) {
      return {
        color: colors.muted,
        text: `Working (${formatElapsedDuration(activeTurnElapsedMs)})`,
      };
    }
    return null;
  }, [
    activeTurnElapsedMs,
    approvalDecisionKeys,
    cancelKey,
    colors.muted,
    colors.warning,
    genericPendingRequestCount,
    isStreaming,
  ]);

  const statusLine = useMemo(() => {
    const historySearchLine = buildHistorySearchStatusLine(state.historySearch, {
      accept: submitKey,
      cancel: cancelKey,
    });
    if (historySearchLine) {
      return historySearchLine;
    }
    if (state.remoteImages.length > 0) {
      return {
        color: colors.secondary,
        text:
          state.selectedRemoteImageIndex === null
            ? "Remote images attached. Up/Down selects a row; Delete removes it."
            : `Remote image ${state.selectedRemoteImageIndex + 1} selected. Delete removes it.`,
      };
    }
    if (state.localImages.length > 0) {
      return {
        color: colors.secondary,
        text: `${state.localImages.length} local image${state.localImages.length === 1 ? "" : "s"} attached.`,
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
    if (state.pendingPastes.length > 0) {
      return {
        color: colors.secondary,
        text: `${state.pendingPastes.length} large paste${state.pendingPastes.length === 1 ? "" : "s"} staged. ${submitKey} expands on submit.`,
      };
    }
    if (slashConflict) {
      return {
        color: colors.warning,
        text: "Slash commands submit on a single line. Extra lines keep this as plain text.",
      };
    }
    if (vimEnabled && vimMode === "NORMAL") {
      return {
        color: colors.primary,
        text: "VIM NORMAL. i/a/o insert. h/l move. x delete. Enter submits.",
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
    if (skillDraft && skillDraft.query.length === 0) {
      const sourcesLabel =
        session.appsManager !== undefined && session.skillsManager !== undefined
          ? "skills and apps"
          : session.appsManager !== undefined
            ? "apps"
            : "skills";
      const tokenLabel =
        session.appsManager !== undefined && session.skillsManager !== undefined
          ? "$mention"
          : session.appsManager !== undefined
            ? "$app"
            : "$skill";
      return {
        color: colors.primary,
        text: `Browse ${sourcesLabel} with Up/Down. ${acceptSuggestionKey} or ${submitKey} inserts the selected ${tokenLabel}.`,
      };
    }
    if (skillDraft && skillPreviewItem) {
      return {
        color: colors.primary,
        text:
          skillPreviewItem.description ??
          `Invoke ${skillPreviewItem.label} for this prompt.`,
      };
    }
    return null;
  }, [
    acceptSuggestionKey,
    cancelKey,
    mentionDraft,
    mentionPreviewItem,
    session.appsManager,
    session.skillsManager,
    skillDraft,
    skillPreviewItem,
    slashConflict,
    slashDraft,
    slashPreviewItem,
    state.pasteInFlight,
    state.pendingPastes,
    state.pendingEnters,
    state.localImages,
    state.remoteImages,
    state.selectedRemoteImageIndex,
    state.historySearch,
    submitKey,
    vimEnabled,
    vimMode,
  ]);
  const footerStatus = activityLine ?? statusLine;
  const inputMode = getModeFromInput(state.value) as PromptInputMode;
  const placeholderText =
    state.value.length === 0 && !helpOpen
      ? "Ask AgenC to do anything"
      : "";

  // ── render ─────────────────────────────────────────────────────────
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width="100%"
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
      {showSkillPalette ? (
        <Palette
          trigger="$"
          query={skillDraft?.query ?? ""}
          items={skillMentionItems}
          placement="above"
          onSelect={handleSkillSelect}
          onClose={() => {
            if (skillTokenKey !== null) {
              setDismissedSkillToken(skillTokenKey);
            }
          }}
        />
      ) : null}
      <Box
        flexDirection="column"
        flexShrink={0}
        overflowX="hidden"
        width="100%"
      >
        {state.remoteImages.map((image, index) => {
          const selected = state.selectedRemoteImageIndex === index;
          return (
            <Box
              key={`${image.placeholder}:${image.source}`}
              flexDirection="row"
              overflowX="hidden"
              width="100%"
              height={1}
              backgroundColor={
                (selected ? colors.surface : colors.surfaceAlt) as Color
              }
            >
              <Text>{"  "}</Text>
              <Text color={selected ? colors.primary : colors.secondary}>
                {selected ? "> " : "  "}
              </Text>
              <Text color={colors.primary} bold>
                {image.placeholder}
              </Text>
              <Text color={colors.dim}>{" "}</Text>
              <Box flexGrow={1} flexShrink={1} overflowX="hidden">
                <Text color={colors.dim} wrap="truncate">
                  {image.source}
                </Text>
              </Box>
            </Box>
          );
        })}
        <Box
          flexDirection="row"
          alignItems="flex-start"
          justifyContent="flex-start"
          overflowX="hidden"
          width="100%"
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
              placeholder={placeholderText}
              argumentHint={argumentHint}
            />
          </Box>
        </Box>
        {rejected.map((m) => (
          <Box
            key={m.raw}
            overflowX="hidden"
            width="100%"
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
            width="100%"
            height={1}
            backgroundColor={colors.surface as Color}
          >
            <Text>{"  "}</Text>
            <Box flexGrow={1} flexShrink={1} overflowX="hidden">
              <Text color={colors.dim} wrap="truncate">
                {`${cancelKey} clears the draft first. Press ${cancelKey} again on an empty composer to interrupt the turn.`}
              </Text>
            </Box>
          </Box>
        ) : null}
        <PromptInputFooter
          exitMessage={{ show: false }}
          vimMode={vimMode}
          mode={inputMode}
          permissionMode={mode as PermissionMode}
          suggestions={[]}
          selectedSuggestion={0}
          helpOpen={helpOpen}
          suppressHint={state.value.length > 0}
          isLoading={hasPendingTurn}
          isPasting={state.pasteInFlight}
          isSearching={state.historySearch !== null}
          status={footerStatus}
          pendingRequestCount={genericPendingRequestCount}
          statusLineItems={config?.statusLine?.items}
          statusLineSession={config?.statusLine?.session}
          statusLineCwd={config?.statusLine?.cwd}
        />
      </Box>
    </Box>
  );
};

// Re-export a couple of helpers so callers can import everything from
// this module instead of reaching into `./history.js` and friends.
export { HISTORY_FILE_REL };
export { validateMentionPath };
export type { DetectedMention, MentionValidationResult };
