import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type ChangeSpec,
} from "@codemirror/state";

import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { stringWidth } from "../../ink/stringWidth.js";

export type BufferSelection = {
  readonly anchor: number;
  readonly head: number;
};

export type BufferHistoryEntry = {
  readonly undo: ChangeSet;
  readonly redo: ChangeSet;
  readonly before: BufferSelection;
  readonly after: BufferSelection;
};

export type BufferDocument = {
  readonly state: EditorState;
  readonly undoStack: readonly BufferHistoryEntry[];
  readonly redoStack: readonly BufferHistoryEntry[];
  readonly preferredColumn: number | null;
};

export type BufferMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "lineStart"
  | "lineEnd"
  | "top"
  | "bottom";

export function createBufferDocument(content: string, line = 1): BufferDocument {
  const state = EditorState.create({ doc: content });
  const targetLine = state.doc.line(Math.min(Math.max(1, line), state.doc.lines));
  const selection = EditorSelection.single(targetLine.from);
  return {
    state: state.update({ selection }).state,
    undoStack: [],
    redoStack: [],
    preferredColumn: null,
  };
}

export function bufferText(document: BufferDocument): string {
  return document.state.doc.toString();
}

export function currentSelection(document: BufferDocument): BufferSelection {
  const selection = document.state.selection.main;
  return { anchor: selection.anchor, head: selection.head };
}

export function selectionBounds(selection: BufferSelection): { readonly from: number; readonly to: number } {
  return {
    from: Math.min(selection.anchor, selection.head),
    to: Math.max(selection.anchor, selection.head),
  };
}

export function hasSelection(document: BufferDocument): boolean {
  const selection = currentSelection(document);
  return selection.anchor !== selection.head;
}

export function lineDisplayColumn(document: BufferDocument, offset = currentSelection(document).head): number {
  const line = document.state.doc.lineAt(offset);
  return stringWidth(line.text.slice(0, offset - line.from));
}

export function documentPosition(document: BufferDocument): {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
} {
  const offset = currentSelection(document).head;
  const line = document.state.doc.lineAt(offset);
  return {
    line: line.number,
    column: lineDisplayColumn(document, offset),
    offset,
  };
}

function setSelection(
  document: BufferDocument,
  selection: BufferSelection,
  preferredColumn = document.preferredColumn,
): BufferDocument {
  const next = document.state.update({
    selection: EditorSelection.single(selection.anchor, selection.head),
  }).state;
  return { ...document, state: next, preferredColumn };
}

function applyChange(
  document: BufferDocument,
  changes: ChangeSpec,
  selection: BufferSelection,
): BufferDocument {
  const before = currentSelection(document);
  const transaction = document.state.update({
    changes,
    selection: EditorSelection.single(selection.anchor, selection.head),
  });
  const after = {
    anchor: transaction.state.selection.main.anchor,
    head: transaction.state.selection.main.head,
  };
  const historyEntry: BufferHistoryEntry | null = transaction.changes.empty
    ? null
    : {
        undo: transaction.changes.invert(document.state.doc),
        redo: transaction.changes,
        before,
        after,
      };
  return {
    state: transaction.state,
    undoStack: historyEntry ? [...document.undoStack, historyEntry] : document.undoStack,
    redoStack: historyEntry ? [] : document.redoStack,
    preferredColumn: null,
  };
}

export function insertBufferText(document: BufferDocument, text: string): BufferDocument {
  if (text.length === 0) return document;
  const selection = currentSelection(document);
  const { from, to } = selectionBounds(selection);
  const insert = text.normalize("NFC");
  return applyChange(
    document,
    { from, to, insert },
    { anchor: from + insert.length, head: from + insert.length },
  );
}

export function deleteBackward(document: BufferDocument): BufferDocument {
  const selection = currentSelection(document);
  const { from, to } = selectionBounds(selection);
  if (from !== to) return applyChange(document, { from, to, insert: "" }, { anchor: from, head: from });
  if (from === 0) return document;
  const prev = previousGraphemeOffset(bufferText(document), from);
  return applyChange(document, { from: prev, to: from, insert: "" }, { anchor: prev, head: prev });
}

export function deleteForward(document: BufferDocument): BufferDocument {
  const selection = currentSelection(document);
  const { from, to } = selectionBounds(selection);
  if (from !== to) return applyChange(document, { from, to, insert: "" }, { anchor: from, head: from });
  if (to >= document.state.doc.length) return document;
  const next = nextGraphemeOffset(bufferText(document), to);
  return applyChange(document, { from: to, to: next, insert: "" }, { anchor: to, head: to });
}

export function moveBufferCursor(
  document: BufferDocument,
  move: BufferMove,
  options: { readonly extend?: boolean; readonly pageSize?: number } = {},
): BufferDocument {
  const selection = currentSelection(document);
  const { from, to } = selectionBounds(selection);
  let target = selection.head;
  let preferredColumn = document.preferredColumn;

  if (!options.extend && from !== to) {
    if (move === "left") target = from;
    else if (move === "right") target = to;
  } else if (move === "left") {
    target = previousGraphemeOffset(bufferText(document), selection.head);
    preferredColumn = null;
  } else if (move === "right") {
    target = nextGraphemeOffset(bufferText(document), selection.head);
    preferredColumn = null;
  } else if (move === "lineStart") {
    target = document.state.doc.lineAt(selection.head).from;
    preferredColumn = null;
  } else if (move === "lineEnd") {
    target = document.state.doc.lineAt(selection.head).to;
    preferredColumn = null;
  } else if (move === "top") {
    target = 0;
    preferredColumn = null;
  } else if (move === "bottom") {
    target = document.state.doc.length;
    preferredColumn = null;
  } else if (move === "up" || move === "down") {
    const currentLine = document.state.doc.lineAt(selection.head);
    const delta = move === "up" ? -(options.pageSize ?? 1) : options.pageSize ?? 1;
    const nextLineNumber = Math.min(Math.max(1, currentLine.number + delta), document.state.doc.lines);
    const nextLine = document.state.doc.line(nextLineNumber);
    const column = preferredColumn ?? lineDisplayColumn(document, selection.head);
    target = nextLine.from + offsetAtDisplayColumn(nextLine.text, column);
    preferredColumn = column;
  }

  const nextSelection = options.extend
    ? { anchor: selection.anchor, head: target }
    : { anchor: target, head: target };
  return setSelection(document, nextSelection, preferredColumn);
}

export function moveBufferCursorToLine(document: BufferDocument, line: number): BufferDocument {
  const targetLine = document.state.doc.line(Math.min(Math.max(1, line), document.state.doc.lines));
  return setSelection(document, { anchor: targetLine.from, head: targetLine.from }, null);
}

export function undoBufferChange(document: BufferDocument): BufferDocument {
  const entry = document.undoStack.at(-1);
  if (!entry) return document;
  const transaction = document.state.update({
    changes: entry.undo,
    selection: EditorSelection.single(entry.before.anchor, entry.before.head),
  });
  return {
    state: transaction.state,
    undoStack: document.undoStack.slice(0, -1),
    redoStack: [...document.redoStack, entry],
    preferredColumn: null,
  };
}

export function redoBufferChange(document: BufferDocument): BufferDocument {
  const entry = document.redoStack.at(-1);
  if (!entry) return document;
  const transaction = document.state.update({
    changes: entry.redo,
    selection: EditorSelection.single(entry.after.anchor, entry.after.head),
  });
  return {
    state: transaction.state,
    undoStack: [...document.undoStack, entry],
    redoStack: document.redoStack.slice(0, -1),
    preferredColumn: null,
  };
}

export function previousGraphemeOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const segment of getGraphemeSegmenter().segment(text)) {
    if (segment.index >= offset) break;
    previous = segment.index;
  }
  return previous;
}

export function nextGraphemeOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  for (const segment of getGraphemeSegmenter().segment(text)) {
    if (segment.index > offset) return segment.index;
    if (segment.index === offset) return Math.min(text.length, segment.index + segment.segment.length);
  }
  return text.length;
}

export function offsetAtDisplayColumn(text: string, targetColumn: number): number {
  if (targetColumn <= 0) return 0;
  let width = 0;
  let offset = 0;
  for (const segment of getGraphemeSegmenter().segment(text)) {
    const nextWidth = width + stringWidth(segment.segment);
    if (nextWidth > targetColumn) break;
    width = nextWidth;
    offset = segment.index + segment.segment.length;
  }
  return offset;
}
