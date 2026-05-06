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
