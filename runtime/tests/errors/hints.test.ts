import { describe, expect, test } from "vitest";
import {
  _resetAgenCCodeHintStore,
  _test,
  clearPendingHint,
  extractAgenCCodeHints,
  getPendingHintSnapshot,
  hasShownHintThisSession,
  markShownThisSession,
  setPendingHint,
} from "./hints.js";

describe("AgenC code hints", () => {
  test("extracts supported hint tags and strips hint lines", () => {
    const output = [
      "before",
      '<agenc-code-hint v="1" type="plugin" value="lint@official" />',
      "after",
    ].join("\n");

    const extracted = extractAgenCCodeHints(output, "npm run lint");

    expect(extracted.hints).toEqual([
      {
        v: 1,
        type: "plugin",
        value: "lint@official",
        sourceCommand: "npm",
      },
    ]);
    expect(extracted.stripped).toBe("before\n\nafter");
  });

  test("ignores unsupported versions, types, empty values, and inline tags", () => {
    const output = [
      '<agenc-code-hint v="2" type="plugin" value="future@official" />',
      '<agenc-code-hint v="1" type="docs" value="x" />',
      '<agenc-code-hint v="1" type="plugin" value="" />',
      'prefix <agenc-code-hint v="1" type="plugin" value="kept@official" />',
    ].join("\n");

    const extracted = extractAgenCCodeHints(output, "tool");

    expect(extracted.hints).toEqual([]);
    expect(extracted.stripped).toContain("prefix <agenc-code-hint");
  });

  test("extracts multiple supported hints while dropping unsupported whole-line tags", () => {
    const output = [
      "start",
      '<agenc-code-hint v="1" type="plugin" value="lint@official" />',
      '<agenc-code-hint v="1" type="docs" value="ignored" />',
      '<agenc-code-hint v="1" type="plugin" value="test@official" />',
      "end",
    ].join("\n");

    const extracted = extractAgenCCodeHints(output, "npm test");

    expect(extracted.hints).toEqual([
      {
        v: 1,
        type: "plugin",
        value: "lint@official",
        sourceCommand: "npm",
      },
      {
        v: 1,
        type: "plugin",
        value: "test@official",
        sourceCommand: "npm",
      },
    ]);
    expect(extracted.stripped).toBe("start\n\nend");
  });

  test("strips many long unicode hint lines without leaking tag fragments", () => {
    const hintLines = Array.from(
      { length: 50 },
      (_, index) =>
        `<agenc-code-hint v="1" type="plugin" value="plugin-${index}-λ@official" />`,
    );
    const output = ["start", ...hintLines, "end"].join("\n");

    const extracted = extractAgenCCodeHints(output, "node tool.js");

    expect(extracted.hints).toHaveLength(50);
    expect(extracted.hints[49]).toEqual({
      v: 1,
      type: "plugin",
      value: "plugin-49-λ@official",
      sourceCommand: "node",
    });
    expect(extracted.stripped).toBe("start\n\nend");
    expect(extracted.stripped).not.toContain("<agenc-code-hint");
  });

  test("leaves partial hint tags untouched so truncation cannot invent hints", () => {
    const partial =
      'prefix\n<agenc-code-hint v="1" type="plugin" value="partial@official"';

    const extracted = extractAgenCCodeHints(partial, "npm run build");

    expect(extracted.hints).toEqual([]);
    expect(extracted.stripped).toBe(partial);
  });

  test("does not turn malformed attributes into hints", () => {
    const malformed = [
      'before <agenc-code-hint v="1" type="plugin" value="bad',
      '<agenc-code-hint v="1" type="plugin" value />',
      "after",
    ].join("\n");

    const extracted = extractAgenCCodeHints(malformed, "tool");

    expect(extracted.hints).toEqual([]);
    expect(extracted.stripped).toContain(
      'before <agenc-code-hint v="1" type="plugin" value="bad',
    );
    expect(extracted.stripped).not.toContain(
      '<agenc-code-hint v="1" type="plugin" value />',
    );
  });

  test("parses unquoted attributes and first command token", () => {
    expect(_test.parseAttrs('<agenc-code-hint v=1 type=plugin value=a@b />')).toEqual({
      v: "1",
      type: "plugin",
      value: "a@b",
    });
    expect(_test.firstCommandToken("  python3 -m tool")).toBe("python3");
  });

  test("stores and clears a single pending hint", () => {
    _resetAgenCCodeHintStore();
    setPendingHint({
      v: 1,
      type: "plugin",
      value: "lint@official",
      sourceCommand: "npm",
    });
    expect(getPendingHintSnapshot()?.value).toBe("lint@official");

    clearPendingHint();
    expect(getPendingHintSnapshot()).toBeNull();

    markShownThisSession();
    expect(hasShownHintThisSession()).toBe(true);
    setPendingHint({
      v: 1,
      type: "plugin",
      value: "ignored@official",
      sourceCommand: "npm",
    });
    expect(getPendingHintSnapshot()).toBeNull();
  });
});
