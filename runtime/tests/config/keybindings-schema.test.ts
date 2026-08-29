import { describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import {
  CANONICAL_CONFIG_VERSION,
  CANONICAL_CONFIG_VERSION_KEY,
  validateStrictConfigDocument,
} from "../../src/config/repository.js";
import { serializeConfigToml } from "../../src/config/serialize.js";

function document(keybindings: unknown): Record<string, unknown> {
  return {
    [CANONICAL_CONFIG_VERSION_KEY]: CANONICAL_CONFIG_VERSION,
    tui: { keybindings },
  };
}

describe("canonical tui.keybindings schema", () => {
  test("round-trips ordered action and unbind blocks without null loss", () => {
    const keybindings = [
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+e": "chat:externalEditor",
          "ctrl+y": "command:todos",
        },
        unbind: ["shift+tab"],
      },
      { context: "Global", bindings: {} },
    ];
    const raw = document(keybindings);

    const validated = validateStrictConfigDocument(raw);
    expect(validated.tui?.keybindings).toEqual(keybindings);

    const serialized = serializeConfigToml(raw);
    expect(
      validateStrictConfigDocument(parseToml(serialized)),
    ).toEqual(validated);
  });

  test.each([
    ["unknown block field", [{ context: "Chat", bindings: {}, extra: true }]],
    ["unknown context", [{ context: "Unknown", bindings: {} }]],
    ["unknown action", [{ context: "Chat", bindings: { a: "chat:nope" } }]],
    ["retired model-picker context", [{ context: "ModelPicker", bindings: {} }]],
    ["retired fast-mode action", [{ context: "Chat", bindings: { a: "chat:fastMode" } }]],
    [
      "retired model-picker decrease action",
      [{ context: "Chat", bindings: { a: "modelPicker:decreaseEffort" } }],
    ],
    [
      "retired model-picker increase action",
      [{ context: "Chat", bindings: { a: "modelPicker:increaseEffort" } }],
    ],
    ["malformed chord", [{ context: "Chat", bindings: { "ctrl++": "chat:submit" } }]],
    ["command outside Chat", [{ context: "Global", bindings: { a: "command:todos" } }]],
    [
      "binding/unbind conflict",
      [{ context: "Chat", bindings: { "ctrl+x": "chat:submit" }, unbind: ["control+x"] }],
    ],
    [
      "cross-block alias conflict",
      [
        { context: "Chat", bindings: { "option+x": "chat:submit" } },
        { context: "Chat", bindings: { "alt+x": "chat:newline" } },
      ],
    ],
    [
      "hardcoded shortcut override",
      [{ context: "Global", bindings: { "ctrl+c": "app:redraw" } }],
    ],
    [
      "hardcoded shortcut unbind",
      [{ context: "Global", unbind: ["control+d"] }],
    ],
  ])("rejects %s", (_label, keybindings) => {
    expect(() => validateStrictConfigDocument(document(keybindings))).toThrow();
  });

  test("requires each block to state bindings and/or unbind", () => {
    expect(() =>
      validateStrictConfigDocument(document([{ context: "Chat" }])),
    ).toThrow(/expected bindings and\/or unbind/u);
  });

  test("allows an exact hardcoded default echo as a semantic no-op", () => {
    expect(() => validateStrictConfigDocument(document([{
      context: "Global",
      bindings: { "control+c": "app:interrupt" },
    }]))).not.toThrow();
  });
});
