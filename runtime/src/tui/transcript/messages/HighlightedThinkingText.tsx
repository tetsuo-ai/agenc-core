/**
 * HighlightedThinkingText — renders a single line of "thinking" or
 * thinking-style user reflection text with optional inline highlighting.
 *
 * Adapted from upstream's `components/messages/HighlightedThinkingText.tsx`.
 *
 * Differences from upstream:
 *   - upstream scanned the text for ultrathink trigger phrases and
 *     rendered them in rainbow colors. AgenC has no ultrathink trigger
 *     surface, so we render the body in plain ink color with the leading
 *     pointer glyph in dim text.
 *   - upstream pulled `figures.pointer` from the npm `figures` package;
 *     AgenC uses its own `glyphs.pointer` from `design-system/glyphs.js`.
 *   - The `briefLayout` branch keeps the upstream UX of a "You" tag plus
 *     timestamp on top of the body. The `briefLabelYou` and `subtle` color
 *     keys in upstream are mapped to AgenC's `accent` and `dim`.
 *
 * @module
 */

import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { glyphs } from "../../design-system/glyphs.js";
import { theme } from "../../theme.js";

export interface HighlightedThinkingTextProps {
  readonly text: string;
  readonly useBriefLayout?: boolean;
  readonly timestamp?: string;
  /** Mark the row as queued (dim everything). */
  readonly isQueued?: boolean;
  /** Mark the row as the active selection (bring up the accent). */
  readonly isSelected?: boolean;
}

function formatBriefTimestamp(input: string): string {
  // Best-effort short timestamp. AgenC has no equivalent of upstream's
  // `formatBriefTimestamp` helper, and timestamps in the transcript are
  // typically already short ("12:34" / "2026-04-27 12:34"). If the input
  // is a parseable date we render `HH:MM`, otherwise pass through.
  try {
    const ms = Date.parse(input);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      const hh = `${d.getHours()}`.padStart(2, "0");
      const mm = `${d.getMinutes()}`.padStart(2, "0");
      return `${hh}:${mm}`;
    }
  } catch {
    /* fall through */
  }
  return input;
}

export function HighlightedThinkingText({
  text,
  useBriefLayout = false,
  timestamp,
  isQueued = false,
  isSelected = false,
}: HighlightedThinkingTextProps): React.ReactElement {
  const pointerColor = isSelected ? theme.colors.accent : theme.colors.dim;

  if (useBriefLayout) {
    const ts = timestamp ? formatBriefTimestamp(timestamp) : "";
    const labelColor = isQueued ? theme.colors.dim : theme.colors.accent;
    const bodyColor = isQueued ? theme.colors.dim : theme.colors.ink;
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text color={labelColor}>You</Text>
          {ts ? <Text color={theme.colors.dim}> {ts}</Text> : null}
        </Box>
        <Text color={bodyColor}>{text}</Text>
      </Box>
    );
  }

  return (
    <Text>
      <Text color={pointerColor}>{glyphs.pointer} </Text>
      <Text color={theme.colors.ink}>{text}</Text>
    </Text>
  );
}

export default HighlightedThinkingText;
