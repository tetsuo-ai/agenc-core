import React, { useContext, useMemo } from "react";

import { Cursor } from "../_deps/cursor.js";
import Box from "../ink/components/Box.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import { useDeclaredCursor } from "../ink/hooks/use-declared-cursor.js";
import { stringWidth } from "../ink/stringWidth.js";

const COMPOSER_FRAME_CHROME_COLUMNS = 4;
const MIN_BUFFER_COLUMNS = 4;

export function ComposerBuffer({
  value,
  cursor,
  promptPrefix,
  cursorActive,
}: {
  readonly value: string;
  readonly cursor: number;
  readonly promptPrefix: string;
  readonly cursorActive: boolean;
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
  const renderedValue = useMemo(
    () => cursorModel.render("", "", (text) => text),
    [cursorModel],
  );
  const cursorPosition = cursorModel.getPosition();
  const viewportStartLine = cursorModel.getViewportStartLine();
  const cursorRef = useDeclaredCursor({
    line: cursorPosition.line - viewportStartLine,
    column: cursorPosition.column,
    active: cursorActive,
  });

  return (
    <Box ref={cursorRef}>
      <Text>{renderedValue}</Text>
    </Box>
  );
}
