/**
 * CompactBoundaryMessage — visual marker drawn between conversation
 * chunks when the runtime context has been compacted.
 *
 * Ported from upstream `components/messages/CompactBoundaryMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream rendered a single dim line with a sparkle glyph and
 *     resolved the `app:toggleTranscript` shortcut via
 *     `useShortcutDisplay()`. AgenC owns `getShortcutDisplay()` in
 *     `keybindings/shortcutFormat.ts`, so we read the shortcut text
 *     from there. The visual is the design-system `Divider` so the
 *     boundary aligns with the rest of the AgenC chrome.
 *   - The keybinding action label `app:toggleTranscript` already
 *     matches AgenC's gut binding command name, so no remap is
 *     required.
 *   - The React Compiler `_c()` cache slots are dropped per the port
 *     pattern guide.
 *
 * @module
 */

import React from "react";

import { Box } from "../../ink-public.js";
import { Divider } from "../../design-system/Divider.js";
import { getShortcutDisplay } from "../../keybindings/shortcutFormat.js";

export interface CompactBoundaryMessageProps {
  /**
   * Optional summary text to surface alongside the boundary glyph.
   * When omitted the divider title falls back to the
   * "Conversation compacted" copy with a hint to expand history.
   */
  readonly summary?: string;
}

export function CompactBoundaryMessage({
  summary,
}: CompactBoundaryMessageProps = {}): React.ReactElement {
  const historyShortcut = getShortcutDisplay(
    "app:toggleTranscript",
    "Global",
    "Ctrl+O",
  );
  const trimmed = typeof summary === "string" ? summary.trim() : "";
  const title =
    trimmed.length > 0
      ? `✻ Conversation compacted — ${trimmed} (${historyShortcut} for history)`
      : `✻ Conversation compacted (${historyShortcut} for history)`;
  return (
    <Box flexDirection="column" marginY={1}>
      <Divider title={title} />
    </Box>
  );
}

export default CompactBoundaryMessage;
