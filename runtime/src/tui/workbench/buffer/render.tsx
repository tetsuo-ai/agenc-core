import React from "react";

import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { Ansi, Box, Text } from "../../ink.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { nextGraphemeOffset, selectionBounds } from "./editing.js";
import type { BufferVisibleLine, WorkbenchBufferSnapshot } from "./BufferStore.js";
import type { NeovimRenderSnapshot } from "./neovim/NeovimGrid.js";

export function BufferLine({
  line,
  snapshot,
  width,
  focused,
  highlightedText,
}: {
  readonly line: BufferVisibleLine;
  readonly snapshot: WorkbenchBufferSnapshot;
  readonly width: number;
  readonly focused: boolean;
  readonly highlightedText?: string;
}): React.ReactElement {
  const numberWidth = Math.max(3, String(Math.max(1, snapshot.lineCount)).length);
  const prefix = `${String(line.number).padStart(numberWidth, " ")} `;
  const textWidth = Math.max(1, width - stringWidth(prefix) - 1);
  const text = truncateByWidth(line.text, textWidth);
  const displayTo = line.from + text.length;

  return (
    <Box height={1}>
      <Text dimColor>{prefix}</Text>
      <Text wrap="truncate-end">
        <BufferText
          line={line}
          displayText={text}
          displayTo={displayTo}
          snapshot={snapshot}
          focused={focused}
          highlightedText={highlightedText}
        />
      </Text>
    </Box>
  );
}

export function NeovimGridView({
  terminal,
  focused,
  width,
}: {
  readonly terminal: NeovimRenderSnapshot;
  readonly focused: boolean;
  readonly width: number;
}): React.ReactElement {
  const maxWidth = Math.max(1, width);
  return (
    <>
      {terminal.lines.map((line, row) => (
        <Box key={row} height={1}>
          <Text wrap="truncate-end">
            {renderTerminalLine(line, row, terminal.cursor.row, terminal.cursor.column, focused, maxWidth)}
          </Text>
        </Box>
      ))}
      {terminal.messages.map((message, index) => (
        <Box key={`message-${index}`} height={1}>
          <Text color="warning" wrap="truncate-end">{truncateByWidth(message, maxWidth)}</Text>
        </Box>
      ))}
      {terminal.popupMenu ? (
        <Box height={1}>
          <Text color="suggestion" wrap="truncate-end">
            {truncateByWidth(terminal.popupMenu.items.join("  "), maxWidth)}
          </Text>
        </Box>
      ) : null}
    </>
  );
}

function BufferText({
  line,
  displayText,
  displayTo,
  snapshot,
  focused,
  highlightedText,
}: {
  readonly line: BufferVisibleLine;
  readonly displayText: string;
  readonly displayTo: number;
  readonly snapshot: WorkbenchBufferSnapshot;
  readonly focused: boolean;
  readonly highlightedText?: string;
}): React.ReactElement {
  const { from, to } = selectionBounds(snapshot.selection);
  const selected = from !== to;
  if (selected) {
    return (
      <>
        {renderSelectedText(displayText, line.from, displayTo, from, to)}
      </>
    );
  }
  if (!focused || snapshot.position.line !== line.number) {
    return highlightedText ? <Ansi>{highlightedText}</Ansi> : <>{displayText}</>;
  }
  return <>{renderCursorText(displayText, line.from, snapshot.position.offset)}</>;
}

function renderSelectedText(
  text: string,
  displayFrom: number,
  displayTo: number,
  selectedFrom: number,
  selectedTo: number,
): React.ReactNode {
  const localFrom = Math.max(0, Math.min(text.length, selectedFrom - displayFrom));
  const localTo = Math.max(0, Math.min(text.length, selectedTo - displayFrom));
  if (selectedTo <= displayFrom || selectedFrom >= displayTo || localFrom === localTo) {
    return text;
  }
  return (
    <>
      {text.slice(0, localFrom)}
      <Text inverse>{text.slice(localFrom, localTo)}</Text>
      {text.slice(localTo)}
    </>
  );
}

function renderCursorText(text: string, displayFrom: number, cursorOffset: number): React.ReactNode {
  const local = cursorOffset - displayFrom;
  if (local < 0 || local > text.length) return text;
  if (local === text.length) {
    return (
      <>
        {text}
        <Text inverse> </Text>
      </>
    );
  }
  const next = nextGraphemeOffset(text, local);
  return (
    <>
      {text.slice(0, local)}
      <Text inverse>{text.slice(local, next)}</Text>
      {text.slice(next)}
    </>
  );
}

function renderTerminalLine(
  line: string,
  row: number,
  cursorRow: number,
  cursorColumn: number,
  focused: boolean,
  width: number,
): React.ReactNode {
  const text = truncateByWidth(line, width);
  if (!focused || row !== cursorRow) return text;
  const column = Math.max(0, Math.min(cursorColumn, text.length));
  return (
    <>
      {text.slice(0, column)}
      <Text inverse>{text[column] ?? " "}</Text>
      {text.slice(column + 1)}
    </>
  );
}

export function truncateByWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  let output = "";
  for (const segment of getGraphemeSegmenter().segment(text)) {
    const nextWidth = width + stringWidth(segment.segment);
    if (nextWidth > maxWidth) break;
    width = nextWidth;
    output += segment.segment;
  }
  return output;
}
