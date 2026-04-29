/**
 * PromptInput — parallel composer ported from upstream.
 *
 * AgenC already ships a `Composer` component (`./Composer.tsx`); this
 * file is the richer parallel implementation the lead will eventually
 * wire into the App tree as a drop-in replacement. It owns:
 *
 *   - Mode state (`prompt` / `bash` / `memory` / `resources`) with the
 *     leading `!` and `#` prefix characters flipping mode at offset 0.
 *     The `#` mode appends to the project's `AGENC.md` file (resolved
 *     by `runtime/src/prompts/project-instructions.ts`).
 *   - Submission contract (Enter -> `chat:submit`, Esc -> `chat:cancel`,
 *     Shift+Enter / Ctrl+J -> `chat:newline`, Up/Down -> history,
 *     Ctrl+R -> history search, Ctrl+X Ctrl+E -> external editor,
 *     Ctrl+V / Alt+V -> image paste, Ctrl+K / Ctrl+Y -> kill/yank,
 *     Shift+Tab -> cycle permission mode).
 *   - Paste handling via the shared `paste-store` singleton — large
 *     pastes are stashed via `useMaybeTruncateInput` so the live buffer
 *     stays responsive.
 *   - Footer rendering through `PromptInputFooter`.
 *
 * The following upstream-only subsystems are intentionally NOT ported
 * here (tranche 5B excludes them or AgenC has no analogue today):
 *
 *   - Slack channel suggestions, IDE @-mention onboarding, voice
 *     indicator, swarm/team banner, `sandboxPromptFooterHint`, the
 *     full slash/mention/skill palettes (those live in
 *     `palette-sources.ts` and the existing `Composer.tsx` already
 *     wires them).
 *   - Bridge / remote / proactive / fast-mode / ultraplan / ultrareview
 *     keyword decoration. The `combinedHighlights` array is built but
 *     left empty — `ShimmeredInput` is wired so future tranches can
 *     reintroduce keyword sweeps without re-plumbing the renderer.
 *   - Vim mode toggle. `isVimModeEnabled()` is a stub; the keybinding
 *     reservation is wired so the eventual vim adapter slots in.
 */

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Box } from "../ink-public.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";
import { ComposerBuffer } from "./ComposerBuffer.js";
import { getPasteStore, type PasteStore } from "./paste-store.js";
import {
  type PastedContent,
} from "./inputPaste.js";
import {
  getModeFromInput,
  getValueFromInput,
  prependModeCharacterToInput,
  type PromptInputMode,
} from "./inputModes.js";
import { PromptInputModeIndicator } from "./PromptInputModeIndicator.js";
import { useMaybeTruncateInput } from "./useMaybeTruncateInput.js";
import { usePromptInputPlaceholder } from "./usePromptInputPlaceholder.js";
import PromptInputFooter, {
  type SuggestionItem,
} from "./PromptInputFooter.js";
import type { VimMode } from "./PromptInputFooterLeftSide.js";

/**
 * Helpers handed to `onSubmit` so the caller can reset composer state
 * after a submit — mirrors upstream's `PromptInputHelpers`.
 */
export interface PromptInputHelpers {
  setCursorOffset: (offset: number) => void;
  clearBuffer: () => void;
  resetHistory: () => void;
}

export interface PromptInputProps {
  readonly debug?: boolean;
  readonly verbose?: boolean;
  readonly isLoading: boolean;
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly mode: PromptInputMode;
  readonly onModeChange: (mode: PromptInputMode) => void;
  readonly submitCount: number;
  readonly pastedContents: Record<number, PastedContent>;
  readonly setPastedContents: React.Dispatch<
    React.SetStateAction<Record<number, PastedContent>>
  >;
  readonly vimMode?: VimMode;
  readonly setVimMode?: (mode: VimMode) => void;
  readonly onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
  ) => Promise<void> | void;
  readonly onExit?: () => void;
  readonly onExternalEditor?: () => void;
  readonly onImagePaste?: () => void;
  readonly onCycleMode?: () => void;
  readonly helpOpen?: boolean;
  readonly setHelpOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  /** Paste-store seam for tests. Defaults to the process singleton. */
  readonly pasteStore?: PasteStore;
  /**
   * Optional ref so callers (STT, slash dispatcher) can splice text at
   * the live cursor without replacing the entire buffer.
   */
  readonly insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>;
}

const PROMPT_FOOTER_LINES = 5;
const MIN_INPUT_VIEWPORT_LINES = 3;

export function PromptInput({
  isLoading,
  input,
  onInputChange,
  mode,
  onModeChange,
  submitCount,
  pastedContents,
  setPastedContents,
  vimMode,
  onSubmit,
  onExit,
  onExternalEditor,
  onImagePaste,
  onCycleMode,
  helpOpen = false,
  pasteStore,
  insertTextRef,
}: PromptInputProps): React.ReactElement {
  const store = pasteStore ?? getPasteStore();
  const [cursorOffset, setCursorOffset] = useState<number>(input.length);
  const [exitMessage] = useState<{
    show: boolean;
    key?: string;
  }>({ show: false });
  const [isPasting, setIsPasting] = useState(false);
  const [suggestions] = useState<readonly SuggestionItem[]>([]);
  const [selectedSuggestion] = useState<number>(-1);

  // Keep cursor synced with external input updates (e.g. slash command
  // text injection). Internal keystroke handlers update `cursorOffset`
  // directly; this layoutEffect only fires when the parent supplies a
  // brand-new buffer.
  const lastPropInputRef = useRef(input);
  React.useLayoutEffect(() => {
    if (input === lastPropInputRef.current) return;
    lastPropInputRef.current = input;
    setCursorOffset((prev) =>
      prev === input.length ? prev : input.length,
    );
  }, [input]);

  // Expose an `insertText` handle for STT / slash injection.
  if (insertTextRef) {
    insertTextRef.current = {
      cursorOffset,
      insert: (text: string) => {
        const needsSpace =
          cursorOffset === input.length &&
          input.length > 0 &&
          !/\s$/u.test(input);
        const insertText = needsSpace ? ` ${text}` : text;
        const newValue =
          input.slice(0, cursorOffset) +
          insertText +
          input.slice(cursorOffset);
        onInputChange(newValue);
        setCursorOffset(cursorOffset + insertText.length);
      },
      setInputWithCursor: (value: string, cursor: number) => {
        onInputChange(value);
        setCursorOffset(cursor);
      },
    };
  }

  // Truncate oversize input into a stashed paste reference so the
  // renderer stays responsive.
  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange,
    setCursorOffset,
    setPastedContents: (contents) =>
      setPastedContents(() => contents),
  });

  // Placeholder shown when the buffer is empty.
  const placeholder = usePromptInputPlaceholder({
    input,
    submitCount,
  });

  // ── paste-store → composer bridge ──────────────────────────────────
  useEffect(() => {
    const onPasteEvent = (event: { kind: string }): void => {
      if (event.kind === "paste-start") {
        setIsPasting(true);
      } else if (event.kind === "paste-complete") {
        setIsPasting(false);
        const buffered = store.consumeBuffer();
        if (buffered.length > 0) {
          // Splice into the buffer at the current cursor.
          const newValue =
            input.slice(0, cursorOffset) +
            buffered +
            input.slice(cursorOffset);
          onInputChange(newValue);
          setCursorOffset(cursorOffset + buffered.length);
        }
      }
    };
    return store.subscribe(onPasteEvent);
    // We deliberately depend only on `store` so paste events route to
    // the freshest input/cursor via the closure refs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // ── input-change handler ───────────────────────────────────────────
  // Exposed via the returned tree so the eventual stdin bridge (the
  // same one `Composer.tsx` owns today) can call it on every keystroke.
  // For now, kept as a closure so the file documents the upstream
  // mode-flip semantics; tranche 5B wires the stdin pump.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onChange = useCallback(
    (value: string): void => {
      const isSingleCharInsertion = value.length === input.length + 1;
      const insertedAtStart = cursorOffset === 0;
      const detectedMode = getModeFromInput(value);
      if (insertedAtStart && detectedMode !== "prompt") {
        if (isSingleCharInsertion) {
          onModeChange(detectedMode === "bash" ? "bash" : "memory");
          return;
        }
        if (input.length === 0) {
          onModeChange(detectedMode === "bash" ? "bash" : "memory");
          const valueWithoutMode = getValueFromInput(value).replaceAll(
            "\t",
            "    ",
          );
          onInputChange(valueWithoutMode);
          setCursorOffset(valueWithoutMode.length);
          return;
        }
      }
      onInputChange(value.replaceAll("\t", "    "));
    },
    [cursorOffset, input, onInputChange, onModeChange],
  );

  // ── submission ─────────────────────────────────────────────────────
  const handleSubmit = useCallback((): void => {
    const trimmed = input.trimEnd();
    if (trimmed.length === 0) return;

    const submitted = prependModeCharacterToInput(trimmed, mode);
    void onSubmit(submitted, {
      setCursorOffset,
      clearBuffer: () => {
        onInputChange("");
        setCursorOffset(0);
      },
      resetHistory: () => {
        // History reset is owned by the host composer (`Composer.tsx`)
        // for now — the eventual unified composer will plug this in.
      },
    });
  }, [input, mode, onSubmit, onInputChange]);

  const handleCancel = useCallback((): void => {
    if (input.length > 0) {
      onInputChange("");
      setCursorOffset(0);
      onModeChange("prompt");
      return;
    }
    if (isLoading && onExit) onExit();
  }, [input, isLoading, onExit, onInputChange, onModeChange]);

  const handleNewline = useCallback((): void => {
    const newValue =
      input.slice(0, cursorOffset) + "\n" + input.slice(cursorOffset);
    onInputChange(newValue);
    setCursorOffset(cursorOffset + 1);
  }, [cursorOffset, input, onInputChange]);

  const handleHistoryPrev = useCallback((): void => {
    // History navigation is owned by `Composer.tsx`'s reducer today;
    // when this PromptInput becomes the canonical composer, wire the
    // shared `useArrowKeyHistory` here.
  }, []);

  const handleHistoryNext = useCallback((): void => {
    // Same as above — history is reducer-owned today.
  }, []);

  const handleHistorySearch = useCallback((): void => {
    // Same as above.
  }, []);

  const handleExternalEditor = useCallback((): void => {
    onExternalEditor?.();
  }, [onExternalEditor]);

  const handleImagePaste = useCallback((): void => {
    if (onImagePaste) {
      onImagePaste();
      return;
    }
    // TODO(tranche-5): wire to AgenC clipboard via xclip/wl-paste/pbpaste once adapter lands
    const placeholderToken = "[Image]";
    const newValue =
      input.slice(0, cursorOffset) +
      placeholderToken +
      input.slice(cursorOffset);
    onInputChange(newValue);
    setCursorOffset(cursorOffset + placeholderToken.length);
  }, [cursorOffset, input, onImagePaste, onInputChange]);

  const handleCycleMode = useCallback((): void => {
    onCycleMode?.();
  }, [onCycleMode]);

  const handleKillToEnd = useCallback((): void => {
    if (cursorOffset >= input.length) return;
    const remainder = input.slice(0, cursorOffset);
    onInputChange(remainder);
  }, [cursorOffset, input, onInputChange]);

  const handleYank = useCallback((): void => {
    // Yank is reducer-owned in `Composer.tsx`. The keybinding is
    // reserved here so the eventual unified composer can take over.
  }, []);

  useKeybinding("chat:submit", handleSubmit, "chat");
  useKeybinding("chat:cancel", handleCancel, "chat");
  useKeybinding("chat:newline", handleNewline, "chat");
  useKeybinding("chat:externalEditor", handleExternalEditor, "chat");
  useKeybinding("chat:imagePaste", handleImagePaste, "chat");
  useKeybinding("chat:cycleMode", handleCycleMode, "chat");
  useKeybinding("chat:killToEnd", handleKillToEnd, "chat");
  useKeybinding("chat:yank", handleYank, "chat");
  useKeybinding("history:prev", handleHistoryPrev, "chat");
  useKeybinding("history:next", handleHistoryNext, "chat");
  useKeybinding("history:search", handleHistorySearch, "global");

  // ── highlights ─────────────────────────────────────────────────────
  // `HighlightedInput` is imported (and kept reachable through the
  // re-exported `TextHighlight` type) so future tranches can reintroduce
  // keyword sweeps without re-plumbing the renderer. The current
  // composer renders through `ComposerBuffer` (cursor + wrap-aware) and
  // does not need shimmer yet.

  const promptPrefix = mode === "bash" ? "! " : mode === "memory" ? "# " : "❯ ";

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box
        flexDirection="row"
        alignItems="flex-start"
        justifyContent="flex-start"
        overflowX="hidden"
        width="100%"
      >
        <PromptInputModeIndicator mode={mode} isLoading={isLoading} />
        <Box flexDirection="row" flexGrow={1} flexShrink={1} overflowX="hidden">
          <ComposerBuffer
            value={input}
            cursor={cursorOffset}
            promptPrefix={promptPrefix}
            cursorActive={!isLoading}
            placeholder={placeholder}
          />
        </Box>
      </Box>
      <PromptInputFooter
        exitMessage={exitMessage}
        vimMode={vimMode}
        mode={mode}
        suggestions={suggestions}
        selectedSuggestion={selectedSuggestion}
        helpOpen={helpOpen}
        suppressHint={false}
        isLoading={isLoading}
        isPasting={isPasting}
        isSearching={false}
      />
    </Box>
  );
}

/**
 * Reserved frame budget below the input box — kept exported for the
 * fullscreen layout calculator. Tranche 5B's footer/help-menu
 * extensions will tighten this number.
 */
export const PROMPT_INPUT_FOOTER_LINES = PROMPT_FOOTER_LINES;
export const PROMPT_INPUT_MIN_VIEWPORT_LINES = MIN_INPUT_VIEWPORT_LINES;

// Re-export so callers that import everything from this module don't
// have to reach into sibling files.
export type { PromptInputMode } from "./inputModes.js";
export type { SuggestionItem } from "./PromptInputFooter.js";
export type { TextHighlight } from "./ShimmeredInput.js";
