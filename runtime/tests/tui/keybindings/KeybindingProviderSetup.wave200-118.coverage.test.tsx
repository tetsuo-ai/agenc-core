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
import { createChordInputHandler } from "./KeybindingProviderSetup.js";
import { parseBindings } from "./parser.js";
import type { ParsedKeystroke } from "./types.js";

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

function inputEvent(): { stopped: boolean; stopImmediatePropagation: () => void } {
  return {
    stopped: false,
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
}

describe("KeybindingProviderSetup wave200-118 coverage", () => {
  test("keeps propagation stable for ignored, unbound, and cancelled chord inputs", () => {
    const bindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          "ctrl+x ctrl+k": null,
          "ctrl+x ctrl+u": "chat:killAgents",
        },
      },
    ]);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const pendingStates: Array<ParsedKeystroke[] | null> = [];
    const setPendingChord = (pending: ParsedKeystroke[] | null): void => {
      pendingStates.push(pending);
      pendingChordRef.current = pending;
    };
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord,
      activeContexts: new Set(["Chat"]),
      handlerRegistryRef: { current: null } as Parameters<
        typeof createChordInputHandler
      >[0]["handlerRegistryRef"],
      inputCaptureRegistryRef: { current: new Set() },
    });

    const ignoredWheelEvent = inputEvent();
    handler("", key({ wheelUp: true }), ignoredWheelEvent);
    expect(ignoredWheelEvent.stopped).toBe(false);
    expect(pendingStates).toEqual([]);

    const unboundPrefixEvent = inputEvent();
    handler("x", key({ ctrl: true }), unboundPrefixEvent);
    expect(unboundPrefixEvent.stopped).toBe(true);
    expect(pendingChordRef.current?.[0]?.key).toBe("x");

    const unboundCompletionEvent = inputEvent();
    handler("k", key({ ctrl: true }), unboundCompletionEvent);
    expect(unboundCompletionEvent.stopped).toBe(true);
    expect(pendingChordRef.current).toBeNull();

    const cancelledPrefixEvent = inputEvent();
    handler("x", key({ ctrl: true }), cancelledPrefixEvent);
    expect(cancelledPrefixEvent.stopped).toBe(true);
    expect(pendingChordRef.current?.[0]?.key).toBe("x");

    const cancelledEvent = inputEvent();
    handler("", key({ escape: true }), cancelledEvent);
    expect(cancelledEvent.stopped).toBe(true);
    expect(pendingChordRef.current).toBeNull();
    expect(pendingStates.at(-1)).toBeNull();
  });
});
