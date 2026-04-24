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
}: {
  readonly value: string;
  readonly cursor: number;
  readonly promptPrefix: string;
  readonly cursorActive: boolean;
  readonly placeholder?: string;
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
        return `${renderCursorCell(CURSOR_CELL)}${dim(placeholder)}`;
      }
      return cursorModel.render(CURSOR_CELL, "", renderCursorCell);
    },
    [cursorActive, cursorModel, placeholder, value.length],
  );

  return (
    <Box ref={cursorRef}>
      <Text wrap="truncate-end">
        <Ansi>{renderedValue}</Ansi>
      </Text>
    </Box>
  );
}
