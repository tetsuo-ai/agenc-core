import { describe, expect, test, vi } from "vitest";

vi.mock("../ink.js", () => ({
  useInput: () => {},
}));

vi.mock("../context/notifications.js", () => ({
  useNotifications: () => ({
    addNotification: () => {},
    removeNotification: () => {},
  }),
}));

vi.mock("../../utils/debug.js", () => ({
  logForDebugging: () => {},
}));

import type { Key } from "../ink.js";
import {
  createChordInputHandler,
  formatKeybindingWarningNotification,
  formatKeybindingWarningSummary,
} from "../keybindings/KeybindingProviderSetup.js";
import { parseBindings } from "../keybindings/parser.js";
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from "../keybindings/types.js";

type HandlerRegistration = {
  action: string;
  context: KeybindingContextName;
  handler: () => void;
};

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

function inputEvent(): {
  stopped: boolean;
  stopImmediatePropagation: () => void;
} {
  return {
    stopped: false,
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
}

describe("KeybindingProviderSetup coverage swarm 049", () => {
  test("formats empty, plural, and unicode warning messages", () => {
    expect(formatKeybindingWarningSummary([])).toBeNull();
    expect(
      formatKeybindingWarningSummary([
        { type: "parse_error", severity: "error", message: "bad one" },
        { type: "parse_error", severity: "error", message: "bad two" },
      ]),
    ).toBe("Found 2 keybinding errors");
    expect(
      formatKeybindingWarningSummary([
        { type: "reserved", severity: "warning", message: "reserved one" },
        { type: "reserved", severity: "warning", message: "reserved two" },
      ]),
    ).toBe("Found 2 keybinding warnings");
    expect(
      formatKeybindingWarningSummary([
        { type: "parse_error", severity: "error", message: "bad" },
        { type: "reserved", severity: "warning", message: "reserved one" },
        { type: "reserved", severity: "warning", message: "reserved two" },
      ]),
    ).toBe("Found 1 keybinding error and 2 warnings");
    expect(
      formatKeybindingWarningNotification("Found 2 keybinding warnings", {
        AGENC_TUI_GLYPHS: "unicode",
      }),
    ).toBe("Found 2 keybinding warnings · /doctor for details");
  });

  test("leaves non-chord matches and misses available for child input handlers", () => {
    const bindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          enter: "chat:submit",
        },
      },
    ]);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const pendingStates: Array<ParsedKeystroke[] | null> = [];
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord: pending => {
        pendingStates.push(pending);
        pendingChordRef.current = pending;
      },
      activeContexts: new Set(["Chat"]),
      handlerRegistryRef: { current: new Map() },
    });

    const missEvent = inputEvent();
    handler("z", key(), missEvent);
    expect(missEvent.stopped).toBe(false);
    expect(pendingStates).toEqual([]);

    const matchEvent = inputEvent();
    handler("", key({ return: true }), matchEvent);
    expect(matchEvent.stopped).toBe(false);
    expect(pendingStates).toEqual([null]);
    expect(pendingChordRef.current).toBeNull();
  });

  test("uses registered handler contexts to resolve inactive chord bindings", () => {
    const bindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": "chat:killAgents",
        },
      },
    ]);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const setPendingChord = (pending: ParsedKeystroke[] | null): void => {
      pendingChordRef.current = pending;
    };
    const invoked = vi.fn();
    const registry = new Map<string, Set<HandlerRegistration>>([
      [
        "chat:killAgents",
        new Set([
          {
            action: "chat:killAgents",
            context: "Chat",
            handler: invoked,
          },
        ]),
      ],
    ]);
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord,
      activeContexts: new Set(),
      handlerRegistryRef: { current: registry },
    });

    const prefixEvent = inputEvent();
    handler("x", key({ ctrl: true }), prefixEvent);
    expect(prefixEvent.stopped).toBe(true);
    expect(pendingChordRef.current?.[0]?.key).toBe("x");

    const completionEvent = inputEvent();
    handler("k", key({ ctrl: true }), completionEvent);
    expect(completionEvent.stopped).toBe(true);
    expect(pendingChordRef.current).toBeNull();
    expect(invoked).toHaveBeenCalledTimes(1);
  });

  test("clears chord state without stopping when a completed chord has no handler", () => {
    const bindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": "chat:killAgents",
        },
      },
    ]);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord: pending => {
        pendingChordRef.current = pending;
      },
      activeContexts: new Set(["Chat"]),
      handlerRegistryRef: {
        current: new Map<string, Set<HandlerRegistration>>([
          ["chat:other", new Set()],
        ]),
      },
    });

    handler("x", key({ ctrl: true }), inputEvent());
    const completionEvent = inputEvent();
    handler("k", key({ ctrl: true }), completionEvent);

    expect(completionEvent.stopped).toBe(false);
    expect(pendingChordRef.current).toBeNull();
  });

  test("intercepts wheel input while a chord is pending", () => {
    const bindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": "chat:killAgents",
        },
      },
    ]);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord: pending => {
        pendingChordRef.current = pending;
      },
      activeContexts: new Set(["Chat"]),
      handlerRegistryRef: { current: new Map() },
    });

    handler("x", key({ ctrl: true }), inputEvent());
    const wheelEvent = inputEvent();
    handler("", key({ wheelDown: true }), wheelEvent);

    expect(wheelEvent.stopped).toBe(true);
    expect(pendingChordRef.current).toBeNull();
  });
});
