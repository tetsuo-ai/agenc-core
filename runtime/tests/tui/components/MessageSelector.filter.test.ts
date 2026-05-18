import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../utils/messages.js", () => ({
  isSyntheticMessage: () => false,
}));

import { selectableUserMessagesFilter } from "./message-selector-filter.js";

function userMessage(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    message: { content },
    ...extra,
  };
}

describe("selectableUserMessagesFilter", () => {
  it("matches the session selector by rejecting empty visible user text", () => {
    expect(selectableUserMessagesFilter(userMessage("") as never)).toBe(false);
    expect(
      selectableUserMessagesFilter(
        userMessage([{ type: "text", text: "   " }]) as never,
      ),
    ).toBe(false);
    expect(
      selectableUserMessagesFilter(userMessage("restore from here") as never),
    ).toBe(true);
  });

  it("rejects compact boundary and summary replacement messages", () => {
    expect(
      selectableUserMessagesFilter(
        userMessage("<compact>Conversation compacted</compact>", {
          isMeta: true,
        }) as never,
      ),
    ).toBe(false);
    expect(
      selectableUserMessagesFilter(
        userMessage(
          "This session is being continued from a previous conversation that ran out of context. Summary.",
          { isCompactSummary: true },
        ) as never,
      ),
    ).toBe(false);
  });

  it("keeps summarize-up-to reachable in the live selector options", () => {
    const source = readFileSync(new URL("./MessageSelector.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/value:\s*'summarize_up_to'[\s\S]*label:\s*'Summarize up to here'/);
    expect(source).not.toContain(`if ("external" === 'ant')`);
  });
});
