import { stringWidth } from "../ink/stringWidth.js";
import { wrapAnsi } from "../ink/wrapAnsi.js";
import {
  firstGrapheme,
  getGraphemeSegmenter,
} from "../ink/vendored/intl.js";

type WrappedText = string[];

export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

class WrappedLine {
  constructor(
    readonly text: string,
    readonly startOffset: number,
    readonly isPrecededByNewline: boolean,
    readonly endsWithNewline = false,
  ) {}
}

class MeasuredText {
  readonly text: string;
  readonly columns: number;
  private wrappedLinesCache: WrappedLine[] | null = null;
  private graphemeBoundariesCache: number[] | null = null;

  constructor(text: string, columns: number) {
    this.text = String(text ?? "").normalize("NFC");
    this.columns = Math.max(1, Math.floor(columns));
  }

  private get wrappedLines(): WrappedLine[] {
    this.wrappedLinesCache ??= this.measureWrappedText();
    return this.wrappedLinesCache;
  }

  private getGraphemeBoundaries(): number[] {
    if (this.graphemeBoundariesCache !== null) {
      return this.graphemeBoundariesCache;
    }
    const boundaries: number[] = [];
    for (const { index } of getGraphemeSegmenter().segment(this.text)) {
      boundaries.push(index);
    }
    boundaries.push(this.text.length);
    this.graphemeBoundariesCache = boundaries;
    return boundaries;
  }

  nextOffset(offset: number): number {
    const safeOffset = Math.max(0, Math.min(this.text.length, offset));
    for (const boundary of this.getGraphemeBoundaries()) {
      if (boundary > safeOffset) return boundary;
    }
    return this.text.length;
  }

  prevOffset(offset: number): number {
    const safeOffset = Math.max(0, Math.min(this.text.length, offset));
    let previous = 0;
    for (const boundary of this.getGraphemeBoundaries()) {
      if (boundary >= safeOffset) return previous;
      previous = boundary;
    }
    return previous;
  }

  stringIndexToDisplayWidth(text: string, index: number): number {
    if (index <= 0) return 0;
    if (index >= text.length) return stringWidth(text);
    return stringWidth(text.slice(0, index));
  }

  displayWidthToStringIndex(text: string, targetWidth: number): number {
    if (targetWidth <= 0 || text.length === 0) return 0;
    let currentWidth = 0;
    let currentOffset = 0;
    for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
      const nextWidth = currentWidth + stringWidth(segment);
      if (nextWidth > targetWidth) break;
      currentWidth = nextWidth;
      currentOffset = index + segment.length;
    }
    return currentOffset;
  }

  private measureWrappedText(): WrappedLine[] {
    const wrapped = wrapAnsi(this.text, this.columns, {
      hard: true,
      trim: false,
    });
    const lines = wrapped.split("\n");
    const out: WrappedLine[] = [];
    let searchOffset = 0;
    let lastNewLinePos = -1;

    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] ?? "";
      const isPrecededByNewline = (startOffset: number): boolean =>
        index === 0 || (startOffset > 0 && this.text[startOffset - 1] === "\n");

      if (text.length === 0) {
        lastNewLinePos = this.text.indexOf("\n", lastNewLinePos + 1);
        if (lastNewLinePos !== -1) {
          out.push(
            new WrappedLine(
              text,
              lastNewLinePos,
              isPrecededByNewline(lastNewLinePos),
              true,
            ),
          );
        } else {
          out.push(
            new WrappedLine(
              text,
              this.text.length,
              isPrecededByNewline(this.text.length),
              false,
            ),
          );
        }
        continue;
      }

      const startOffset = this.text.indexOf(text, searchOffset);
      if (startOffset === -1) {
        const fallbackOffset = Math.min(searchOffset, this.text.length);
        out.push(
          new WrappedLine(
            text,
            fallbackOffset,
            isPrecededByNewline(fallbackOffset),
            false,
          ),
        );
        continue;
      }

      searchOffset = startOffset + text.length;
      const potentialNewlinePos = startOffset + text.length;
      const endsWithNewline =
        potentialNewlinePos < this.text.length &&
        this.text[potentialNewlinePos] === "\n";
      if (endsWithNewline) {
        lastNewLinePos = potentialNewlinePos;
      }
      out.push(
        new WrappedLine(
          text,
          startOffset,
          isPrecededByNewline(startOffset),
          endsWithNewline,
        ),
      );
    }

    return out.length > 0 ? out : [new WrappedLine("", 0, true, false)];
  }

  getWrappedText(): WrappedText {
    return this.wrappedLines.map((line) =>
      line.isPrecededByNewline ? line.text : line.text.trimStart(),
    );
  }

  getWrappedLines(): WrappedLine[] {
    return this.wrappedLines;
  }

  private getLine(line: number): WrappedLine {
    const lines = this.wrappedLines;
    return lines[Math.max(0, Math.min(line, lines.length - 1))]!;
  }

  getLineLength(line: number): number {
    return stringWidth(this.getLine(line).text);
  }

  getOffsetFromPosition(position: CursorPosition): number {
    const wrappedLine = this.getLine(position.line);
    if (wrappedLine.text.length === 0 && wrappedLine.endsWithNewline) {
      return wrappedLine.startOffset;
    }

    const leadingWhitespace = wrappedLine.isPrecededByNewline
      ? 0
      : wrappedLine.text.length - wrappedLine.text.trimStart().length;
    const displayColumnWithLeading = position.column + leadingWhitespace;
    const stringIndex = this.displayWidthToStringIndex(
      wrappedLine.text,
      displayColumnWithLeading,
    );
    const offset = wrappedLine.startOffset + stringIndex;
    const lineEnd = wrappedLine.startOffset + wrappedLine.text.length;
    const lineDisplayWidth = stringWidth(wrappedLine.text);
    const maxOffset =
      wrappedLine.endsWithNewline && position.column > lineDisplayWidth
        ? lineEnd + 1
        : lineEnd;
    return Math.min(offset, maxOffset);
  }

  getPositionFromOffset(offset: number): CursorPosition {
    const safeOffset = Math.max(0, Math.min(this.text.length, offset));
    const lines = this.wrappedLines;
    for (let line = 0; line < lines.length; line += 1) {
      const currentLine = lines[line]!;
      const nextLine = lines[line + 1];
      if (
        safeOffset >= currentLine.startOffset &&
        (!nextLine || safeOffset < nextLine.startOffset)
      ) {
        const stringPosInLine = safeOffset - currentLine.startOffset;
        if (currentLine.isPrecededByNewline) {
          return {
            line,
            column: this.stringIndexToDisplayWidth(
              currentLine.text,
              stringPosInLine,
            ),
          };
        }

        const leadingWhitespace =
          currentLine.text.length - currentLine.text.trimStart().length;
        if (stringPosInLine < leadingWhitespace) {
          return { line, column: 0 };
        }
        return {
          line,
          column: this.stringIndexToDisplayWidth(
            currentLine.text.trimStart(),
            stringPosInLine - leadingWhitespace,
          ),
        };
      }
    }

    const line = Math.max(0, lines.length - 1);
    return {
      line,
      column: stringWidth(lines[line]?.text ?? ""),
    };
  }

  get lineCount(): number {
    return this.wrappedLines.length;
  }
}

export class Cursor {
  readonly offset: number;

  constructor(
    readonly measuredText: MeasuredText,
    offset = 0,
    readonly selection = 0,
  ) {
    this.offset = Math.max(0, Math.min(this.text.length, offset));
  }

  static fromText(
    text: string,
    columns: number,
    offset = 0,
    selection = 0,
  ): Cursor {
    return new Cursor(
      new MeasuredText(text, Math.max(1, columns - 1)),
      offset,
      selection,
    );
  }

  get text(): string {
    return this.measuredText.text;
  }

  getPosition(): CursorPosition {
    return this.measuredText.getPositionFromOffset(this.offset);
  }

  getViewportStartLine(maxVisibleLines?: number): number {
    if (maxVisibleLines === undefined || maxVisibleLines <= 0) return 0;
    const { line } = this.getPosition();
    const allLines = this.measuredText.getWrappedText();
    if (allLines.length <= maxVisibleLines) return 0;
    const half = Math.floor(maxVisibleLines / 2);
    let startLine = Math.max(0, line - half);
    const endLine = Math.min(allLines.length, startLine + maxVisibleLines);
    if (endLine - startLine < maxVisibleLines) {
      startLine = Math.max(0, endLine - maxVisibleLines);
    }
    return startLine;
  }

  getViewportCharOffset(maxVisibleLines?: number): number {
    const startLine = this.getViewportStartLine(maxVisibleLines);
    if (startLine === 0) return 0;
    return this.measuredText.getWrappedLines()[startLine]?.startOffset ?? 0;
  }

  getViewportCharEnd(maxVisibleLines?: number): number {
    const startLine = this.getViewportStartLine(maxVisibleLines);
    const allLines = this.measuredText.getWrappedLines();
    if (maxVisibleLines === undefined || maxVisibleLines <= 0) {
      return this.text.length;
    }
    const endLine = Math.min(allLines.length, startLine + maxVisibleLines);
    if (endLine >= allLines.length) return this.text.length;
    return allLines[endLine]?.startOffset ?? this.text.length;
  }

  isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }

  render(
    cursorChar: string,
    mask: string,
    invert: (text: string) => string,
    ghostText?: { text: string; dim: (text: string) => string },
    maxVisibleLines?: number,
  ): string {
    const { line, column } = this.getPosition();
    const allLines = this.measuredText.getWrappedText();
    const startLine = this.getViewportStartLine(maxVisibleLines);
    const endLine =
      maxVisibleLines !== undefined && maxVisibleLines > 0
        ? Math.min(allLines.length, startLine + maxVisibleLines)
        : allLines.length;

    return allLines
      .slice(startLine, endLine)
      .map((text, index) => {
        const currentLine = index + startLine;
        const displayText = mask ? maskLine(text, mask, currentLine, allLines) : text;
        if (line !== currentLine) return displayText.trimEnd();

        const split = splitAtDisplayColumn(displayText, column);
        const ghost =
          ghostText &&
          currentLine === allLines.length - 1 &&
          this.isAtEnd() &&
          ghostText.text.length > 0
            ? renderGhostCursor(cursorChar, invert, ghostText)
            : null;
        const renderedCursor =
          ghost ??
          (cursorChar ? invert(split.atCursor || cursorChar) : split.atCursor);
        return split.before + renderedCursor + split.after.trimEnd();
      })
      .join("\n");
  }

  left(): Cursor {
    if (this.offset === 0) return this;
    const chip = this.imageRefEndingAt(this.offset);
    if (chip) return new Cursor(this.measuredText, chip.start, 0);
    return new Cursor(
      this.measuredText,
      this.measuredText.prevOffset(this.offset),
      0,
    );
  }

  right(): Cursor {
    if (this.offset >= this.text.length) return this;
    const chip = this.imageRefStartingAt(this.offset);
    if (chip) return new Cursor(this.measuredText, chip.end, 0);
    return new Cursor(
      this.measuredText,
      this.measuredText.nextOffset(this.offset),
      0,
    );
  }

  private imageRefEndingAt(offset: number): { start: number; end: number } | null {
    const match = this.text.slice(0, offset).match(/\[Image #\d+\]$/);
    return match ? { start: offset - match[0].length, end: offset } : null;
  }

  private imageRefStartingAt(
    offset: number,
  ): { start: number; end: number } | null {
    const match = this.text.slice(offset).match(/^\[Image #\d+\]/);
    return match ? { start: offset, end: offset + match[0].length } : null;
  }
}

function maskLine(
  text: string,
  mask: string,
  currentLine: number,
  allLines: readonly string[],
): string {
  const graphemes = Array.from(getGraphemeSegmenter().segment(text));
  if (currentLine !== allLines.length - 1) {
    return mask.repeat(graphemes.length);
  }
  const visibleCount = Math.min(6, graphemes.length);
  const maskCount = graphemes.length - visibleCount;
  const splitOffset =
    graphemes.length > visibleCount ? graphemes[maskCount]?.index ?? 0 : 0;
  return mask.repeat(maskCount) + text.slice(splitOffset);
}

function splitAtDisplayColumn(
  text: string,
  column: number,
): { before: string; atCursor: string; after: string } {
  let before = "";
  let atCursor = "";
  let after = "";
  let currentWidth = 0;
  let cursorFound = false;

  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    if (cursorFound) {
      after += segment;
      continue;
    }
    const nextWidth = currentWidth + stringWidth(segment);
    if (nextWidth > column) {
      atCursor = segment;
      cursorFound = true;
    } else {
      currentWidth = nextWidth;
      before += segment;
    }
  }

  return { before, atCursor, after };
}

function renderGhostCursor(
  cursorChar: string,
  invert: (text: string) => string,
  ghostText: { text: string; dim: (text: string) => string },
): string {
  const first = firstGrapheme(ghostText.text) || (ghostText.text[0] ?? "");
  const rest = ghostText.text.slice(first.length);
  const cursor = cursorChar ? invert(first) : first;
  return rest.length > 0 ? cursor + ghostText.dim(rest) : cursor;
}
