import { describe, expect, test } from "vitest";

import type { Key } from "../ink.js";
import { parseBindings } from "./parser.js";
import {
  getBindingDisplayText,
  resolveKey,
  resolveKeyWithChordState,
} from "./resolver.js";
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

describe("keybinding resolver edge coverage", () => {
  test("keeps direct, shadowed chord, cancellation, and malformed binding outcomes distinct", () => {
    const bindings = parseBindings([
      {
        context: "Global",
        bindings: {
          "ctrl+x": "app:toggleTodos",
        },
      },
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": "chat:killAgents",
          "ctrl+x": "chat:undo",
          "ctrl+z": null,
          escape: "chat:cancel",
        },
      },
      {
        context: "Chat",
        bindings: {
          "ctrl+x": "chat:stash",
          "ctrl+x ctrl+k": null,
        },
      },
    ]);

    expect(resolveKey("n", key(), ["Chat"], bindings)).toEqual({
      type: "none",
    });
    expect(resolveKey("z", key({ ctrl: true }), ["Chat"], bindings)).toEqual({
      type: "unbound",
    });
    expect(resolveKey("x", key({ ctrl: true }), ["Chat"], bindings)).toEqual({
      type: "match",
      action: "chat:stash",
    });
    expect(getBindingDisplayText("chat:stash", "Chat", bindings)).toBe(
      "ctrl+x",
    );
    expect(
      getBindingDisplayText("chat:submit", "Chat", bindings),
    ).toBeUndefined();

    expect(
      resolveKeyWithChordState(
        "x",
        key({ ctrl: true }),
        ["Chat"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "chat:stash" });
    expect(
      resolveKeyWithChordState(
        "z",
        key({ ctrl: true }),
        ["Chat"],
        bindings,
        null,
      ),
    ).toEqual({ type: "unbound" });
    expect(
      resolveKeyWithChordState(
        "",
        key({ escape: true, meta: true }),
        ["Chat"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "chat:cancel" });

    const pending = [stroke("x", { ctrl: true })];
    expect(
      resolveKeyWithChordState(
        "",
        key({ escape: true }),
        ["Chat"],
        bindings,
        pending,
      ),
    ).toEqual({ type: "chord_cancelled" });
    expect(
      resolveKeyWithChordState("", key(), ["Chat"], bindings, null),
    ).toEqual({ type: "none" });
    expect(
      resolveKeyWithChordState("", key(), ["Chat"], bindings, pending),
    ).toEqual({ type: "chord_cancelled" });

    const chordBindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": "chat:killAgents",
        },
      },
    ]);
    const started = resolveKeyWithChordState(
      "x",
      key({ ctrl: true }),
      ["Chat"],
      chordBindings,
      null,
    );
    expect(started.type).toBe("chord_started");
    if (started.type !== "chord_started") {
      throw new Error("expected chord to start");
    }
    expect(
      resolveKeyWithChordState(
        "q",
        key({ ctrl: true }),
        ["Chat"],
        chordBindings,
        started.pending,
      ),
    ).toEqual({ type: "chord_cancelled" });

    const malformedPrefix: ParsedBinding = {
      context: "Chat",
      action: "chat:killAgents",
      chord: new Array(2) as ParsedKeystroke[],
    };
    const malformedExact: ParsedBinding = {
      context: "Chat",
      action: "chat:undo",
      chord: new Array(1) as ParsedKeystroke[],
    };
    expect(
      resolveKeyWithChordState(
        "x",
        key({ ctrl: true }),
        ["Chat"],
        [malformedPrefix],
        null,
      ),
    ).toEqual({ type: "none" });
    expect(
      resolveKeyWithChordState(
        "x",
        key({ ctrl: true }),
        ["Chat"],
        [malformedExact],
        null,
      ),
    ).toEqual({ type: "none" });
  });
});
