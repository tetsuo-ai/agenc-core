import React from "react";

import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { Ansi, Box, RawAnsi, Text } from "../../ink.js";
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
  const terminalLines = terminalAnsiLines(terminal, focused, maxWidth);
  return (
    <>
      <RawAnsi lines={terminalLines} width={maxWidth} />
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

export function terminalAnsiLines(
  terminal: NeovimRenderSnapshot,
  focused: boolean,
  width: number,
): string[] {
  const maxWidth = Math.max(1, width);
  // Build the highlight lookup once per snapshot, not once per rendered row
  // (a Neovim redraw renders every row, so this was O(rows × highlights)).
  const highlightMap = new Map(terminal.highlights.map((highlight) => [highlight.id, highlight]));
  return terminal.lines.map((_line, row) =>
    renderTerminalCellsToAnsi(
      terminalLineCells(terminal, row),
      highlightMap,
      row,
      terminal.cursor.row,
      terminal.cursor.column,
      focused,
      maxWidth,
    ),
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

function renderTerminalCellsToAnsi(
  cells: readonly NeovimCell[],
  highlightMap: ReadonlyMap<number, NeovimHighlight>,
  row: number,
  cursorRow: number,
  cursorColumn: number,
  focused: boolean,
  width: number,
): string {
  let output = "";
  let renderedWidth = 0;
  let activeStyleKey = "";
  for (let column = 0; column < cells.length && renderedWidth < width; column += 1) {
    const cell = cells[column]!;
    if (cell.width === 0) continue;
    if (renderedWidth + cell.width > width) break;
    const cursor = focused && row === cursorRow && column === cursorColumn;
    const text = cell.text.length > 0 ? cell.text : " ";
    const style = terminalTextStyle(highlightMap.get(cell.highlightId), cursor);
    const nextStyleKey = terminalTextStyleKey(style);
    if (nextStyleKey !== activeStyleKey) {
      if (activeStyleKey.length > 0) output += "\x1b[0m";
      const nextAnsi = terminalTextStyleAnsi(style);
      if (nextAnsi.length > 0) output += nextAnsi;
      activeStyleKey = nextStyleKey;
    }
    output += text;
    renderedWidth += cell.width;
  }
  if (focused && row === cursorRow && cursorColumn >= cells.length && renderedWidth < width) {
    if (activeStyleKey !== "inverse") {
      if (activeStyleKey.length > 0) output += "\x1b[0m";
      output += "\x1b[7m";
      activeStyleKey = "inverse";
    }
    output += " ";
  }
  if (activeStyleKey.length > 0) output += "\x1b[0m";
  return output;
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

function rgbNumberToHex(value: NeovimHighlight["attributes"][string]): Color | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rgb = Math.max(0, Math.min(0xFFFFFF, Math.floor(value)));
  const red = (rgb >> 16) & 0xFF;
  const green = (rgb >> 8) & 0xFF;
  const blue = rgb & 0xFF;
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}` as Color;
}

function rgbNumberToSgr(value: Color | undefined, mode: 38 | 48): string | null {
  if (!value?.startsWith("#") || value.length !== 7) return null;
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  if (![red, green, blue].every(Number.isFinite)) return null;
  return `${mode};2;${red};${green};${blue}`;
}

function terminalTextStyleAnsi(style: TerminalTextStyle): string {
  const codes: string[] = [];
  const foreground = rgbNumberToSgr(style.color, 38);
  const background = rgbNumberToSgr(style.backgroundColor, 48);
  if (foreground) codes.push(foreground);
  if (background) codes.push(background);
  if (style.bold === true) codes.push("1");
  if (style.italic === true) codes.push("3");
  if (style.underline === true) codes.push("4");
  if (style.strikethrough === true) codes.push("9");
  if (style.inverse === true) codes.push("7");
  return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

function terminalTextStyleKey(style: TerminalTextStyle): string {
  const hasStyle = style.color !== undefined ||
    style.backgroundColor !== undefined ||
    style.bold === true ||
    style.italic === true ||
    style.underline === true ||
    style.strikethrough === true ||
    style.inverse === true;
  if (!hasStyle) return "";
  return [
    style.color ?? "",
    style.backgroundColor ?? "",
    style.bold === true ? "b" : "",
    style.italic === true ? "i" : "",
    style.underline === true ? "u" : "",
    style.strikethrough === true ? "s" : "",
    style.inverse === true ? "inverse" : "",
  ].join("|");
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
