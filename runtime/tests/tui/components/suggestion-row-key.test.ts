import { describe, expect, it } from "vitest";
import { suggestionRowKey } from "../../../src/tui/components/PromptInput/PromptInputFooterSuggestions.js";

// core-todo.md PromptInputFooterSuggestions.tsx:351 — folding isSelected into
// the React key unmounted/remounted the selected + previously-selected rows on
// every arrow keypress, defeating the row's memo. The key is now item.id only,
// with isSelected passed as a prop.

describe("suggestionRowKey", () => {
  it("is invariant to selection (no remount when the cursor moves)", () => {
    const item = { id: "cmd-1" };
    expect(suggestionRowKey(item, true)).toBe(suggestionRowKey(item, false));
  });

  it("keys by the item's stable id", () => {
    expect(suggestionRowKey({ id: "cmd-42" }, false)).toBe("cmd-42");
    expect(suggestionRowKey({ id: "cmd-42" }, true)).toBe("cmd-42");
  });
});
