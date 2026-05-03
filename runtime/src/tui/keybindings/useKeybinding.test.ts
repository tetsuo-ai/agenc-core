import { describe, expect, test, vi } from "vitest";

import { parseBindings } from "./parser.js";
import { getBindingDisplayText, resolveKeyWithChordState } from "./resolver.js";
import type { Key } from "../ink.js";

vi.mock("../ink.js", () => ({
  useInput: () => {},
}));

vi.mock("./KeybindingContext.js", () => ({
  useOptionalKeybindingContext: () => undefined,
}));

function key(overrides: Partial<Key> = {}): Key {
  return {
    ctrl: false,
    shift: false,
    fn: false,
    meta: false,
    super: false,
    escape: false,
    return: false,
    tab: false,
    backspace: false,
    delete: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    ...overrides,
  } as Key;
}

describe("useKeybinding exports and resolver contract", () => {
  test("keeps the AgenC plural hook shim wired to the aggregate hook", async () => {
    const { useKeybinding, useKeybindings } = await import("./useKeybinding.js");
    const {
      useKeybinding: shimUseKeybinding,
      useKeybindings: shimUseKeybindings,
    } = await import("./useKeybindings.js");

    expect(shimUseKeybinding).toBe(useKeybinding);
    expect(shimUseKeybindings).toBe(useKeybindings);
  });

  test("resolves display text and chord state for aggregate hook callers", () => {
    const bindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": "chat:killAgents",
          "shift+tab": "chat:cycleMode",
        },
      },
    ]);

    expect(getBindingDisplayText("chat:cycleMode", "Chat", bindings)).toBe(
      "shift+tab",
    );

    const started = resolveKeyWithChordState(
      "x",
      key({ ctrl: true }),
      ["Chat", "Global"],
      bindings,
      null,
    );
    expect(started.type).toBe("chord_started");

    if (started.type !== "chord_started") {
      throw new Error("expected chord to start");
    }

    expect(
      resolveKeyWithChordState(
        "k",
        key({ ctrl: true }),
        ["Chat", "Global"],
        bindings,
        started.pending,
      ),
    ).toEqual({ type: "match", action: "chat:killAgents" });
  });
});
