import { describe, expect, test, vi } from "vitest";

import { parseBindings } from "./parser.js";
import { DEFAULT_BINDINGS } from "./defaultBindings.js";
import { getBindingDisplayText, resolveKeyWithChordState } from "./resolver.js";
import type { Key } from "../ink.js";
import type { KeybindingContextName, ParsedKeystroke } from "./types.js";

vi.mock("../ink.js", () => ({
  useInput: () => {},
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
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

const MENU_CONTEXTS = new Set<KeybindingContextName>([
  "Autocomplete",
  "Settings",
  "Confirmation",
  "Tabs",
  "Transcript",
  "HistorySearch",
  "ThemePicker",
  "Help",
  "Attachments",
  "Footer",
  "MessageSelector",
  "MessageActions",
  "DiffDialog",
  "ModelPicker",
  "Select",
  "Plugin",
]);

const NON_MENU_CONTEXTS = new Set<KeybindingContextName>([
  "Global",
  "Chat",
  "Task",
  "Scroll",
  "Workbench",
  "Explorer",
  "Surface",
  "Buffer",
  "Agents",
  "Composer",
]);

const WORKBENCH_CONTEXTS: readonly KeybindingContextName[] = [
  "Workbench",
  "Explorer",
  "Surface",
  "Buffer",
  "Agents",
  "Composer",
];

function eventForStroke(stroke: ParsedKeystroke): {
  readonly input: string;
  readonly key: Key;
} {
  const overrides: Partial<Key> = {
    ctrl: stroke.ctrl,
    shift: stroke.shift,
    meta: stroke.alt || stroke.meta,
    super: stroke.super,
  };

  switch (stroke.key) {
    case "escape":
      return { input: "", key: key({ ...overrides, escape: true }) };
    case "enter":
      return { input: "", key: key({ ...overrides, return: true }) };
    case "tab":
      return { input: "", key: key({ ...overrides, tab: true }) };
    case "backspace":
      return { input: "", key: key({ ...overrides, backspace: true }) };
    case "delete":
      return { input: "", key: key({ ...overrides, delete: true }) };
    case "up":
      return { input: "", key: key({ ...overrides, upArrow: true }) };
    case "down":
      return { input: "", key: key({ ...overrides, downArrow: true }) };
    case "left":
      return { input: "", key: key({ ...overrides, leftArrow: true }) };
    case "right":
      return { input: "", key: key({ ...overrides, rightArrow: true }) };
    case "pageup":
      return { input: "", key: key({ ...overrides, pageUp: true }) };
    case "pagedown":
      return { input: "", key: key({ ...overrides, pageDown: true }) };
    case "home":
      return { input: "", key: key({ ...overrides, home: true }) };
    case "end":
      return { input: "", key: key({ ...overrides, end: true }) };
    default:
      return { input: stroke.key, key: key(overrides) };
  }
}

describe("useKeybinding exports and resolver contract", () => {
  test("exports singular and aggregate hooks from the canonical module", async () => {
    const { useKeybinding, useKeybindings } = await import("./useKeybinding.js");

    expect(typeof useKeybinding).toBe("function");
    expect(typeof useKeybindings).toBe("function");
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

  test("maps footer PTY keys for coordinator row navigation and dismissal", () => {
    const bindings = parseBindings(DEFAULT_BINDINGS);

    expect(
      resolveKeyWithChordState(
        "x",
        key(),
        ["Footer", "Chat", "Global"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "footer:close" });

    expect(
      resolveKeyWithChordState(
        "",
        key({ return: true }),
        ["Footer", "Chat", "Global"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "footer:openSelected" });
  });

  test("keeps every default menu binding above workbench pane bindings", () => {
    const bindings = parseBindings(DEFAULT_BINDINGS);
    const unclassifiedContexts = [
      ...new Set(DEFAULT_BINDINGS.map((block) => block.context)),
    ].filter((context) => !MENU_CONTEXTS.has(context) && !NON_MENU_CONTEXTS.has(context));
    const menuBindings = bindings.filter((binding) =>
      MENU_CONTEXTS.has(binding.context) &&
      binding.action !== null &&
      binding.chord.length === 1
    );

    expect(unclassifiedContexts).toEqual([]);
    expect(menuBindings.length).toBeGreaterThan(0);

    for (const binding of menuBindings) {
      const stroke = binding.chord[0];
      if (!stroke) throw new Error(`missing stroke for ${binding.context}`);
      const event = eventForStroke(stroke);

      for (const workbenchContext of WORKBENCH_CONTEXTS) {
        expect(
          resolveKeyWithChordState(
            event.input,
            event.key,
            [workbenchContext, binding.context, "Global"],
            bindings,
            null,
          ),
          `${binding.context}:${binding.action ?? "unbound"} should win over ${workbenchContext}`,
        ).toEqual({ type: "match", action: binding.action });
      }
    }
  });
});
