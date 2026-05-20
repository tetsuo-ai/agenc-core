import { describe, expect, test } from "vitest";

import type { Key } from "../ink.js";
import { getKeyName, matchesBinding, matchesKeystroke } from "./match.js";
import type { ParsedBinding, ParsedKeystroke } from "./types.js";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  wheelUp: false,
  wheelDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  fn: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
};

function key(overrides: Partial<Key> = {}): Key {
  return { ...baseKey, ...overrides };
}

function stroke(
  keyName: string,
  overrides: Partial<ParsedKeystroke> = {},
): ParsedKeystroke {
  return {
    key: keyName,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
    ...overrides,
  };
}

describe("keybinding input matching", () => {
  test("normalizes terminal keys and matches only exact modifier combinations", () => {
    const namedKeyCases: Array<[Partial<Key>, string, string | null]> = [
      [{ escape: true }, "", "escape"],
      [{ return: true }, "", "enter"],
      [{ tab: true }, "", "tab"],
      [{ backspace: true }, "", "backspace"],
      [{ delete: true }, "", "delete"],
      [{ upArrow: true }, "", "up"],
      [{ downArrow: true }, "", "down"],
      [{ leftArrow: true }, "", "left"],
      [{ rightArrow: true }, "", "right"],
      [{ pageUp: true }, "", "pageup"],
      [{ pageDown: true }, "", "pagedown"],
      [{ wheelUp: true }, "", "wheelup"],
      [{ wheelDown: true }, "", "wheeldown"],
      [{ home: true }, "", "home"],
      [{ end: true }, "", "end"],
      [{}, "A", "a"],
      [{}, "ab", null],
    ];

    for (const [overrides, input, expected] of namedKeyCases) {
      expect(getKeyName(input, key(overrides))).toBe(expected);
    }

    expect(matchesKeystroke("x", key(), stroke("x"))).toBe(true);
    expect(matchesKeystroke("x", key(), stroke("y"))).toBe(false);

    expect(
      matchesKeystroke("x", key({ ctrl: true }), stroke("x", { ctrl: true })),
    ).toBe(true);
    expect(matchesKeystroke("x", key({ ctrl: true }), stroke("x"))).toBe(false);

    expect(
      matchesKeystroke("x", key({ shift: true }), stroke("x", { shift: true })),
    ).toBe(true);
    expect(matchesKeystroke("x", key({ shift: true }), stroke("x"))).toBe(false);

    expect(
      matchesKeystroke("x", key({ meta: true }), stroke("x", { alt: true })),
    ).toBe(true);
    expect(
      matchesKeystroke("x", key({ meta: true }), stroke("x", { meta: true })),
    ).toBe(true);
    expect(matchesKeystroke("x", key(), stroke("x", { alt: true }))).toBe(false);

    expect(
      matchesKeystroke("x", key({ super: true }), stroke("x", { super: true })),
    ).toBe(true);
    expect(matchesKeystroke("x", key({ super: true }), stroke("x"))).toBe(false);

    expect(
      matchesKeystroke("", key({ escape: true, meta: true }), stroke("escape")),
    ).toBe(true);
    expect(
      matchesKeystroke(
        "",
        key({ escape: true, meta: true }),
        stroke("escape", { meta: true }),
      ),
    ).toBe(false);

    const enterBinding: ParsedBinding = {
      action: "chat:submit",
      chord: [stroke("enter")],
      context: "Chat",
    };

    expect(matchesBinding("", key({ return: true }), enterBinding)).toBe(true);
    expect(
      matchesBinding("", key({ return: true }), {
        ...enterBinding,
        chord: [stroke("enter"), stroke("x")],
      }),
    ).toBe(false);
    expect(
      matchesBinding("", key({ return: true }), {
        ...enterBinding,
        chord: new Array(1) as ParsedKeystroke[],
      }),
    ).toBe(false);
  });
});
