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
 * The React tree is intentionally tiny — a `<Box>` wrapping a single
 * `<Text>` for the live buffer and an optional warning footer. Actual
 * visual polish (prompt glyph, multiline padding, wrapped-line counter)
 * is layered by later waves; the contract here is limited to keystroke
 * → state plumbing + validation.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isAbsolute, relative, resolve } from "node:path";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";
import { theme } from "../theme.js";
import {
  getPasteStore,
  type PasteEvent,
  type PasteStore,
} from "./paste-store.js";
import {
  HISTORY_FILE_REL,
  appendHistory,
  readHistory,
  type HistoryEntry,
} from "./history.js";
import { useComposerState } from "./useComposerState.js";

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

/**
 * Render the buffer with a visual caret. When `cursor === value.length`
 * the caret is appended as a trailing `▌` glyph; otherwise the
 * character at `cursor` is rendered in inverse to simulate a terminal
 * caret highlight.
 */
function RenderedBuffer({
  value,
  cursor,
}: {
  readonly value: string;
  readonly cursor: number;
}): React.ReactElement {
  if (value.length === 0) {
    return <Text>{"\u258C"}</Text>;
  }
  if (cursor >= value.length) {
    return (
      <Text>
        {value}
        {"\u258C"}
      </Text>
    );
  }
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────

export const Composer: React.FC<ComposerProps> = ({
  session,
  config,
  onSubmit,
  onCancel,
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

  // ── keybindings ────────────────────────────────────────────────────
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  const home = session.home ?? process.env.HOME ?? "";

  const handleSubmit = useCallback((): void => {
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
  }, [dispatch, home, session.cwd, store]);

  const handleCancel = useCallback((): void => {
    dispatch({ type: "CLEAR" });
    if (onCancel) onCancel();
  }, [dispatch, onCancel]);

  const handleNewline = useCallback((): void => {
    dispatch({ type: "NEWLINE" });
  }, [dispatch]);

  const handleHistoryPrev = useCallback((): void => {
    dispatch({ type: "HISTORY_PREV" });
  }, [dispatch]);

  const handleHistoryNext = useCallback((): void => {
    dispatch({ type: "HISTORY_NEXT" });
  }, [dispatch]);

  useKeybinding("chat:submit", handleSubmit, "chat");
  useKeybinding("chat:cancel", handleCancel, "chat");
  useKeybinding("chat:newline", handleNewline, "chat");
  useKeybinding("history:prev", handleHistoryPrev, "chat");
  useKeybinding("history:next", handleHistoryNext, "chat");

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

  // ── render ─────────────────────────────────────────────────────────
  const { colors } = theme;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.primary}>{"> "}</Text>
        <RenderedBuffer value={state.value} cursor={state.cursor} />
      </Box>
      {rejected.map((m) => (
        <Box key={m.raw}>
          <Text color={colors.warning}>{"\u26A0 outside workspace: "}</Text>
          <Text color={colors.error}>{m.raw}</Text>
        </Box>
      ))}
    </Box>
  );
};

// Re-export a couple of helpers so callers can import everything from
// this module instead of reaching into `./history.js` and friends.
export { HISTORY_FILE_REL };
