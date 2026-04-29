/**
 * Composer footer container.
 *
 * Renders, in order:
 *   - inline suggestion list (when the composer has a non-empty
 *     suggestion array — e.g. slash-command picker)
 *   - left-hand status (mode hint / pasting / vim INSERT)
 *
 * AgenC ships none of upstream's right-hand pills (bridge state,
 * MCP server count, IDE selection, auto-updater banner) so the right
 * column is a single empty `Box` slot kept for layout symmetry. When
 * tranche 5B introduces those features they can hang off this slot.
 */

import * as React from "react";
import { memo, type ReactNode, useMemo } from "react";

import { Box } from "../ink-public.js";
import { useSetPromptOverlay } from "../state/PromptOverlayContext.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import {
  PromptInputFooterLeftSide,
  type VimMode,
} from "./PromptInputFooterLeftSide.js";
import type { PromptInputMode } from "./inputModes.js";

/**
 * Suggestion item exposed by the footer overlay. Mirrors the shape of
 * `PromptOverlayContext`'s `SuggestionItem` so future ports can swap
 * either side without converting the array.
 */
export interface SuggestionItem {
  readonly value: string;
  readonly displayValue?: string;
  readonly description?: string;
}

type Props = {
  readonly debug?: boolean;
  readonly exitMessage: { readonly show: boolean; readonly key?: string };
  readonly vimMode?: VimMode;
  readonly mode: PromptInputMode;
  readonly verbose?: boolean;
  readonly suggestions: readonly SuggestionItem[];
  readonly selectedSuggestion: number;
  readonly maxColumnWidth?: number;
  readonly helpOpen: boolean;
  readonly suppressHint: boolean;
  readonly isLoading: boolean;
  readonly isPasting?: boolean;
  readonly isInputWrapped?: boolean;
  readonly isSearching: boolean;
};

function PromptInputFooter({
  exitMessage,
  vimMode,
  mode,
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  helpOpen,
  suppressHint,
  isLoading,
  isPasting,
  isSearching,
}: Props): ReactNode {
  const { columns } = useTerminalSize();
  const isNarrow = columns < 80;

  // Forward suggestion data to the floating overlay so a fullscreen
  // shell can render it above the composer instead of inline. AgenC's
  // OverlayProvider rewires the slot when it owns the screen; in the
  // common embedded case the hook is a no-op and we render inline.
  const overlayData = useMemo(
    () =>
      suggestions.length > 0
        ? { suggestions, selectedSuggestion, maxColumnWidth }
        : null,
    [suggestions, selectedSuggestion, maxColumnWidth],
  );
  useSetPromptOverlay(overlayData);

  if (helpOpen) {
    // Help menu is owned by `Composer.tsx`'s shortcut overlay today;
    // tranche 5B will add a dedicated `PromptInputHelpMenu`. Falling
    // through to the default footer keeps the dimensions stable so
    // the composer above doesn't reflow when help toggles.
    return null;
  }

  return (
    <Box
      flexDirection={isNarrow ? "column" : "row"}
      justifyContent={isNarrow ? "flex-start" : "space-between"}
      paddingX={2}
      gap={isNarrow ? 0 : 1}
    >
      <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
        <PromptInputFooterLeftSide
          exitMessage={exitMessage}
          vimMode={vimMode}
          mode={mode}
          suppressHint={suppressHint}
          isLoading={isLoading}
          isPasting={isPasting}
          isSearching={isSearching}
        />
      </Box>
      {/* Right-hand slot reserved for tranche 5B (notifications, MCP
          status, etc.). Kept as an empty Box so layout dimensions stay
          stable when those widgets land. */}
      <Box flexShrink={1} gap={1} />
    </Box>
  );
}

export default memo(PromptInputFooter);
