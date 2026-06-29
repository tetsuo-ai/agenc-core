import { describe, expect, it } from "vitest";

import { formatMessage } from "../../src/i18n/messages.js";

describe("i18n message catalog", () => {
  it("formats English-default CLI messages", () => {
    expect(formatMessage("cli.outputFormat.requiresValue")).toBe(
      "agenc --output-format requires a value (usage: agenc -p --output-format <text|json|stream-json>)",
    );
  });
});
