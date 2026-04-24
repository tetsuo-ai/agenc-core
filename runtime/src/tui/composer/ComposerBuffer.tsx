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
        // Match openclaude/src/hooks/renderPlaceholder.ts: invert the FIRST
        // CHARACTER of the placeholder rather than prepending an extra
        // inverted-space cell. Prepending a separate cell shifts the
        // placeholder one column right of where the declared cursor lands,
        // which the user sees as two adjacent highlighted blocks. Inverting
        // the first char keeps the cursor cell co-located with that char so
        // the in-band glyph and the native cursor overlap at column 0.
        const head = placeholder[0] ?? CURSOR_CELL;
        const tail = placeholder.slice(1);
        return tail.length > 0
          ? renderCursorCell(head) + dim(tail)
          : renderCursorCell(head);
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
