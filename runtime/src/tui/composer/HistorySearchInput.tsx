/**
 * Composer history search prompt — the inline view shown when the
 * user activates Ctrl+R-style history search.
 *
 * Ported from upstream. Upstream renders a managed `<TextInput>` to
 * own keystroke handling; AgenC has no `TextInput` widget yet, so
 * this component is a display-only renderer. Caller wires keystrokes
 * to its own state and feeds the current `value` (and the
 * `historyFailedMatch` flag) into the props.
 *
 * Pairs with `tui/composer/history.ts`, which loads
 * `~/.agenc/history.jsonl` for the actual lookup.
 */
import * as React from "react";

import { Box, Text } from "../ink-public.js";
import { stringWidth } from "../ink/stringWidth.js";

interface Props {
  readonly value: string;
  readonly historyFailedMatch: boolean;
}

const CURSOR_GLYPH = "▌";

export function HistorySearchInput({
  value,
  historyFailedMatch,
}: Props): React.ReactElement {
  const label = historyFailedMatch ? "no matching prompt:" : "search prompts:";
  // `stringWidth` is used to right-size the trailing space so the
  // cursor caret doesn't visually collide with the label on tight
  // terminals.
  const valueWidth = stringWidth(value);
  return (
    <Box gap={1}>
      <Text dimColor>{label}</Text>
      <Text>{value}</Text>
      {valueWidth >= 0 && <Text dimColor>{CURSOR_GLYPH}</Text>}
    </Box>
  );
}

export default HistorySearchInput;
