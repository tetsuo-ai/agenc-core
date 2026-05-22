import React from "react";

import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { Box, Text } from "../../ink.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { nextGraphemeOffset, selectionBounds } from "./editing.js";
import type { BufferVisibleLine, WorkbenchBufferSnapshot } from "./BufferStore.js";

export function BufferLine({
  line,
  snapshot,
  width,
  focused,
}: {
  readonly line: BufferVisibleLine;
  readonly snapshot: WorkbenchBufferSnapshot;
  readonly width: number;
  readonly focused: boolean;
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
        />
      </Text>
    </Box>
  );
}

function BufferText({
  line,
  displayText,
  displayTo,
  snapshot,
  focused,
}: {
  readonly line: BufferVisibleLine;
  readonly displayText: string;
  readonly displayTo: number;
  readonly snapshot: WorkbenchBufferSnapshot;
  readonly focused: boolean;
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
    return <>{displayText}</>;
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

function truncateByWidth(text: string, maxWidth: number): string {
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
