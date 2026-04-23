/**
 * Local stub for openclaude `utils/Cursor.ts`.
 *
 * The full upstream class wraps text in a grapheme-aware viewport
 * (`MeasuredText`) so the composer can render a real wrapped buffer with
 * a live cursor and image-chip awareness. That implementation is several
 * hundred lines and pulls in grapheme segmentation utilities that live
 * in the openclaude tree.
 *
 * This shim provides a degraded but typesafe surrogate that keeps the
 * composer compiling and produces a usable single-line view. UI fidelity
 * for multi-line wrapped editing is not preserved.
 */

export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

export class Cursor {
  readonly offset: number;

  constructor(
    readonly text: string,
    readonly columns: number,
    offset = 0,
    readonly selection = 0,
  ) {
    const safeText = String(text ?? "");
    this.text = safeText;
    this.offset = Math.max(0, Math.min(safeText.length, offset));
  }

  static fromText(
    text: string,
    columns: number,
    offset = 0,
    selection = 0,
  ): Cursor {
    return new Cursor(String(text ?? ""), Math.max(1, columns), offset, selection);
  }

  getPosition(): CursorPosition {
    const before = this.text.slice(0, this.offset);
    const lines = before.split("\n");
    return {
      line: lines.length - 1,
      column: lines[lines.length - 1]?.length ?? 0,
    };
  }

  getViewportStartLine(_maxVisibleLines?: number): number {
    return 0;
  }

  getViewportCharOffset(_maxVisibleLines?: number): number {
    return 0;
  }

  getViewportCharEnd(_maxVisibleLines?: number): number {
    return this.text.length;
  }

  isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }

  render(
    cursorChar: string,
    mask: string,
    invert: (text: string) => string,
    _ghostText?: { text: string; dim: (text: string) => string },
    _maxVisibleLines?: number,
  ): string {
    const display = mask
      ? mask.repeat(this.text.length)
      : this.text;
    const sourceLines = display.split("\n");
    const { line, column } = this.getPosition();
    const renderedCursor = cursorChar ? invert(cursorChar) : "";

    // Reserve one column at the right edge for the inline cursor cell so
    // the caret never lands past the visible viewport.
    const wrapWidth = Math.max(1, this.columns - 1);

    const wrappedSegments: string[] = [];
    for (let i = 0; i < sourceLines.length; i += 1) {
      const sourceLine = sourceLines[i] ?? "";
      const lineWithCursor =
        i === line
          ? sourceLine.slice(0, column) +
            renderedCursor +
            sourceLine.slice(column)
          : sourceLine;
      wrappedSegments.push(hardWrap(lineWithCursor, wrapWidth));
    }
    return wrappedSegments.join("\n");
  }

  left(): Cursor {
    return new Cursor(this.text, this.columns, Math.max(0, this.offset - 1));
  }

  right(): Cursor {
    return new Cursor(
      this.text,
      this.columns,
      Math.min(this.text.length, this.offset + 1),
    );
  }
}

/**
 * Hard-wrap `line` into chunks of at most `width` characters. Empty
 * lines pass through unchanged so the rendered transcript keeps blank
 * lines intact. This is intentionally character-based (no word boundary
 * smartness) — the openclaude `MeasuredText` viewport that the upstream
 * Cursor class wraps does grapheme-aware wrapping, but for the TUI tests
 * a simple fixed-width split is enough to produce a stable wrapped
 * frame.
 */
function hardWrap(line: string, width: number): string {
  if (line.length <= width) return line;
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    out.push(line.slice(i, i + width));
  }
  return out.join("\n");
}
