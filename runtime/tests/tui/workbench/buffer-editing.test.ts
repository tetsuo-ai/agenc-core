import { describe, expect, it } from "vitest";

import {
  bufferText,
  createBufferDocument,
  deleteBackward,
  documentPosition,
  insertBufferText,
  moveBufferCursor,
  redoBufferChange,
  undoBufferChange,
} from "../../../src/tui/workbench/buffer/editing.js";

describe("buffer editing model", () => {
  it("inserts, deletes, undoes, and redoes multiline text", () => {
    let document = createBufferDocument("alpha\nomega");
    document = insertBufferText(document, "A\n");

    expect(bufferText(document)).toBe("A\nalpha\nomega");
    document = undoBufferChange(document);
    expect(bufferText(document)).toBe("alpha\nomega");
    document = redoBufferChange(document);
    expect(bufferText(document)).toBe("A\nalpha\nomega");
    document = deleteBackward(document);
    expect(bufferText(document)).toBe("Aalpha\nomega");
  });

  it("replaces selected text with a single undo step", () => {
    let document = createBufferDocument("abc");
    document = moveBufferCursor(document, "right");
    document = moveBufferCursor(document, "right", { extend: true });
    document = insertBufferText(document, "X");

    expect(bufferText(document)).toBe("aXc");
    document = undoBufferChange(document);
    expect(bufferText(document)).toBe("abc");
  });

  it("moves and deletes by grapheme without splitting emoji", () => {
    let document = createBufferDocument("a🙂b");
    document = moveBufferCursor(document, "right");
    document = moveBufferCursor(document, "right");
    document = deleteBackward(document);

    expect(bufferText(document)).toBe("ab");
  });

  it("preserves display column while moving across wide characters", () => {
    let document = createBufferDocument("ab\n語\nabcd");
    document = moveBufferCursor(document, "lineEnd");
    document = moveBufferCursor(document, "down");

    expect(documentPosition(document)).toMatchObject({ line: 2, column: 2 });
    document = moveBufferCursor(document, "down");
    expect(documentPosition(document)).toMatchObject({ line: 3, column: 2 });
  });

  it("resets stale preferred column after collapsing a vertical selection", () => {
    let document = createBufferDocument("abcd\nx\nabcdef");
    document = moveBufferCursor(document, "lineEnd");
    document = moveBufferCursor(document, "down", { extend: true });

    document = moveBufferCursor(document, "right");
    expect(documentPosition(document)).toMatchObject({ line: 2, column: 1 });

    document = moveBufferCursor(document, "down");
    expect(documentPosition(document)).toMatchObject({ line: 3, column: 1 });
  });

  it("honors explicit line and document moves while collapsing selections", () => {
    let document = createBufferDocument("alpha\nbeta\ngamma");
    document = moveBufferCursor(document, "right");
    document = moveBufferCursor(document, "right", { extend: true });

    document = moveBufferCursor(document, "lineEnd");
    expect(documentPosition(document)).toMatchObject({ line: 1, column: 5 });

    document = moveBufferCursor(document, "left", { extend: true });
    document = moveBufferCursor(document, "bottom");
    expect(documentPosition(document)).toMatchObject({ line: 3, column: 5 });
  });
});
