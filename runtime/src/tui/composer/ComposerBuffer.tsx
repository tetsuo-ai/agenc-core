import React, { useContext, useMemo } from "react";

import { Cursor } from "../_deps/cursor.js";
import { Ansi } from "../ink/Ansi.js";
import Box from "../ink/components/Box.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import { useDeclaredCursor } from "../ink/hooks/use-declared-cursor.js";
import { useTerminalFocus } from "../ink/hooks/use-terminal-focus.js";
import { stringWidth } from "../ink/stringWidth.js";

const COMPOSER_FRAME_CHROME_COLUMNS = 4;
const MIN_BUFFER_COLUMNS = 4;
const CURSOR_CELL = " ";

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

function renderCursorCell(text: string): string {
  return `\x1b[7m${text || CURSOR_CELL}\x1b[27m`;
}

export function ComposerBuffer({
  value,
  cursor,
  promptPrefix,
  cursorActive,
  placeholder,
  argumentHint,
}: {
  readonly value: string;
  readonly cursor: number;
  readonly promptPrefix: string;
  readonly cursorActive: boolean;
  readonly placeholder?: string;
  readonly argumentHint?: string;
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
  const cursorPosition = cursorModel.getPosition();
  const terminalFocused = useTerminalFocus();
  const cursorRef = useDeclaredCursor({
    line: cursorPosition.line,
    column: cursorPosition.column,
    active: cursorActive && terminalFocused,
  });
  const ghostHint = useMemo(
    () =>
      argumentHint && argumentHint.length > 0
        ? { text: argumentHint, dim }
        : undefined,
    [argumentHint],
  );
  const renderedValue = useMemo(
    () => {
      if (!cursorActive) {
        return cursorModel.render("", "", (text) => text);
      }
      if (
        value.length === 0 &&
        placeholder !== undefined &&
        placeholder.length > 0
      ) {
        // Render only the dim placeholder — no in-band SGR-7 inverted cell.
        // The native terminal cursor (declared above via useDeclaredCursor)
        // already sits at column 0 on top of the placeholder's first char,
        // so a second in-band glyph is redundant. More importantly, an
        // inverted cell here gets stranded when the user types: the diff
        // path between this frame and the next (cursorModel.render output)
        // does not reliably clear column 0's inverted style in AgenC's Ink
        // renderer, leaving a "ghost cursor" block at the start of the row.
        // Dropping the in-band inversion eliminates that vector entirely.
        return dim(placeholder);
      }
      return cursorModel.render(CURSOR_CELL, "", renderCursorCell, ghostHint);
    },
    [cursorActive, cursorModel, ghostHint, placeholder, value.length],
  );

  // Single <Text wrap="truncate-end"> blob, mirroring
  // openclaude/src/components/BaseTextInput.tsx — the per-row split tried
  // earlier did not eliminate the cursor artifact and broke the
  // empty-placeholder layout. The artifact root cause was the placeholder
  // rendering offsetting the in-band glyph by one column from the declared
  // cursor; with that fixed above, a single Text matches upstream and
  // diffs cleanly across frames.
  return (
    <Box ref={cursorRef}>
      <Text wrap="truncate-end">
        <Ansi>{renderedValue}</Ansi>
      </Text>
    </Box>
  );
}
