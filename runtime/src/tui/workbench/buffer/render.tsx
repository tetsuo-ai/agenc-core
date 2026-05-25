import React from "react";

import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { Ansi, Box, Text } from "../../ink.js";
import type { Color } from "../../ink/styles.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { nextGraphemeOffset, selectionBounds } from "./editing.js";
import type { BufferVisibleLine, WorkbenchBufferSnapshot } from "./BufferStore.js";
import type { NeovimCell, NeovimHighlight, NeovimRenderSnapshot } from "./neovim/NeovimGrid.js";

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
            {renderTerminalCells(terminalLineCells(terminal, row), terminal.highlights, row, terminal.cursor.row, terminal.cursor.column, focused, maxWidth)}
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

function renderTerminalCells(
  cells: readonly NeovimCell[],
  highlights: readonly NeovimHighlight[],
  row: number,
  cursorRow: number,
  cursorColumn: number,
  focused: boolean,
  width: number,
): React.ReactNode {
  const highlightMap = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  const parts: React.ReactNode[] = [];
  let renderedWidth = 0;
  for (let column = 0; column < cells.length && renderedWidth < width; column += 1) {
    const cell = cells[column]!;
    if (cell.width === 0) continue;
    if (renderedWidth + cell.width > width) break;
    const cursor = focused && row === cursorRow && column === cursorColumn;
    const text = cell.text.length > 0 ? cell.text : " ";
    const style = terminalTextStyle(highlightMap.get(cell.highlightId), cursor);
    parts.push(renderTerminalCellText(text, style, `${column}:${cell.highlightId}:${cursor ? "cursor" : "text"}`));
    renderedWidth += cell.width;
  }
  if (focused && row === cursorRow && cursorColumn >= cells.length && renderedWidth < width) {
    parts.push(<Text key="cursor-end" inverse> </Text>);
  }
  return <>{parts}</>;
}

type TerminalTextStyle = {
  readonly color?: Color;
  readonly backgroundColor?: Color;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly inverse?: boolean;
};

function renderTerminalCellText(
  text: string,
  style: TerminalTextStyle,
  key: string,
): React.ReactNode {
  if (!hasTerminalTextStyle(style)) return <React.Fragment key={key}>{text}</React.Fragment>;
  return (
    <Text
      key={key}
      color={style.color}
      backgroundColor={style.backgroundColor}
      bold={style.bold}
      italic={style.italic}
      underline={style.underline}
      strikethrough={style.strikethrough}
      inverse={style.inverse}
    >
      {text}
    </Text>
  );
}

function terminalTextStyle(
  highlight: NeovimHighlight | undefined,
  cursor: boolean,
): TerminalTextStyle {
  const attributes = highlight?.attributes ?? {};
  const style: TerminalTextStyle = {
    color: rgbNumberToHex(attributes.foreground),
    backgroundColor: rgbNumberToHex(attributes.background),
    bold: attributes.bold === true ? true : undefined,
    italic: attributes.italic === true ? true : undefined,
    underline: attributes.underline === true || attributes.undercurl === true ? true : undefined,
    strikethrough: attributes.strikethrough === true ? true : undefined,
    inverse: cursor || attributes.reverse === true ? true : undefined,
  };
  return style;
}

function hasTerminalTextStyle(style: TerminalTextStyle): boolean {
  return style.color !== undefined ||
    style.backgroundColor !== undefined ||
    style.bold === true ||
    style.italic === true ||
    style.underline === true ||
    style.strikethrough === true ||
    style.inverse === true;
}

function rgbNumberToHex(value: NeovimHighlight["attributes"][string]): Color | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rgb = Math.max(0, Math.min(0xFFFFFF, Math.floor(value)));
  const red = (rgb >> 16) & 0xFF;
  const green = (rgb >> 8) & 0xFF;
  const blue = rgb & 0xFF;
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}` as Color;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function terminalLineCells(terminal: NeovimRenderSnapshot, row: number): readonly NeovimCell[] {
  const cells = terminal.cells[row] ?? [];
  const line = terminal.lines[row] ?? "";
  if (cellsHaveVisibleText(cells) || line.trimEnd().length === 0) return cells;
  return lineToCells(line);
}

function cellsHaveVisibleText(cells: readonly NeovimCell[]): boolean {
  return cells.some((cell) => cell.text.trim().length > 0);
}

function lineToCells(line: string): readonly NeovimCell[] {
  return [...line].map((text) => ({
    text,
    width: Math.max(1, stringWidth(text)),
    highlightId: 0,
  }));
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
