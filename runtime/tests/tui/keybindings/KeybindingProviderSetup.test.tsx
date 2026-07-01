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

import {
  createChordInputHandler,
  formatKeybindingWarningNotification,
  formatKeybindingWarningSummary,
} from "./KeybindingProviderSetup.js";
import { DEFAULT_BINDINGS } from "./defaultBindings.js";
import { parseBindings } from "./parser.js";
import { resolveKeyWithChordState } from "./resolver.js";
import type { Key } from "../ink.js";
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedKey,
} from "../ink/parse-keypress.js";
import { InputEvent } from "../ink/events/input-event.js";
import type { KeybindingContextName, ParsedKeystroke } from "./types.js";

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

function inputEvent(): InputEvent & { stopped: boolean } {
  return {
    stopped: false,
    didStopImmediatePropagation() {
      return this.stopped;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  } as InputEvent & { stopped: boolean };
}

function parseInputEvent(sequence: string): InputEvent {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence);
  expect(items).toHaveLength(1);
  const item = items[0];
  expect(item?.kind).toBe("key");
  return new InputEvent(item as ParsedKey);
}

describe("KeybindingProviderSetup", () => {
  test("summarizes warning counts without upstream utility dependencies", () => {
    expect(
      formatKeybindingWarningSummary([
        { type: "parse_error", severity: "error", message: "bad" },
        { type: "reserved", severity: "warning", message: "reserved" },
      ]),
    ).toBe("Found 1 keybinding error and 1 warning");
  });

  test("uses ASCII-safe warning notification separators in ASCII glyph mode", () => {
    expect(
      formatKeybindingWarningNotification("Found 1 keybinding error", {
        AGENC_TUI_GLYPHS: "ascii",
      }),
    ).toBe("Found 1 keybinding error - /doctor for details");
  });

  test("intercepts chord prefixes and invokes registered handlers on completion", () => {
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
    let invoked = 0;
    const registry = new Map<string, Set<HandlerRegistration>>([
      [
        "chat:killAgents",
        new Set([
          {
            action: "chat:killAgents",
            context: "Chat",
            handler: () => {
              invoked++;
            },
          },
        ]),
      ],
    ]);

    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord,
      activeContexts: new Set(["Chat"]),
      handlerRegistryRef: { current: registry },
      inputCaptureRegistryRef: { current: new Set() },
    });

    const prefixEvent = inputEvent();
    handler("x", key({ ctrl: true }), prefixEvent);
    expect(prefixEvent.stopped).toBe(true);
    expect(pendingChordRef.current?.[0]?.key).toBe("x");
    expect(invoked).toBe(0);

    const completionEvent = inputEvent();
    handler("k", key({ ctrl: true }), completionEvent);
    expect(completionEvent.stopped).toBe(true);
    expect(pendingChordRef.current).toBeNull();
    expect(invoked).toBe(1);
  });

  test("consumes completed workbench chords even before an action handler is registered", () => {
    const bindings = parseBindings([
      {
        context: "Workbench",
        bindings: {
          "ctrl+w d": "workbench:openDiff",
        },
      },
    ]);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const captured: string[] = [];
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord: pending => {
        pendingChordRef.current = pending;
      },
      activeContexts: new Set(["Workbench"]),
      handlerRegistryRef: { current: new Map() },
      inputCaptureRegistryRef: {
        current: new Set([
          {
            context: "Workbench",
            handler: input => {
              captured.push(input);
              return true;
            },
          },
        ]),
      },
    });

    const prefixEvent = inputEvent();
    handler("w", key({ ctrl: true }), prefixEvent);
    expect(prefixEvent.stopped).toBe(true);

    const completionEvent = inputEvent();
    handler("d", key(), completionEvent);

    expect(completionEvent.stopped).toBe(true);
    expect(pendingChordRef.current).toBeNull();
    expect(captured).toEqual([]);
  });

  test("runs active input captures before child input handlers", () => {
    const bindings = parseBindings(DEFAULT_BINDINGS);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const captured: string[] = [];
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord: pending => {
        pendingChordRef.current = pending;
      },
      activeContexts: new Set(["Buffer"]),
      handlerRegistryRef: { current: new Map() },
      inputCaptureRegistryRef: {
        current: new Set([
          {
            context: "Buffer",
            handler: input => {
              captured.push(input);
              return true;
            },
          },
        ]),
      },
    });

    const event = inputEvent();
    handler("i", key(), event);

    expect(captured).toEqual(["i"]);
    expect(event.stopped).toBe(true);
  });

  test("runs registered input captures even when their context is not separately active", () => {
    const bindings = parseBindings(DEFAULT_BINDINGS);
    const pendingChordRef = { current: null as ParsedKeystroke[] | null };
    const captured: string[] = [];
    const handler = createChordInputHandler({
      bindings,
      pendingChordRef,
      setPendingChord: pending => {
        pendingChordRef.current = pending;
      },
      activeContexts: new Set(),
      handlerRegistryRef: { current: new Map() },
      inputCaptureRegistryRef: {
        current: new Set([
          {
            context: "Chat",
            handler: input => {
              captured.push(input);
              return true;
            },
          },
        ]),
      },
    });

    const event = inputEvent();
    handler("", key({ escape: true }), event);

    expect(captured).toEqual([""]);
    expect(event.stopped).toBe(true);
  });

  test("resolves raw footer x and enter input from terminal bytes", () => {
    const bindings = parseBindings(DEFAULT_BINDINGS);

    const closeEvent = parseInputEvent("x");
    expect(
      resolveKeyWithChordState(
        closeEvent.input,
        closeEvent.key,
        ["Footer", "Chat", "Global"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "footer:close" });

    const openEvent = parseInputEvent("\r");
    expect(
      resolveKeyWithChordState(
        openEvent.input,
        openEvent.key,
        ["Footer", "Chat", "Global"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "footer:openSelected" });
  });

  test("resolves enter to autocomplete before chat submit while suggestions are active", () => {
    const bindings = parseBindings(DEFAULT_BINDINGS);
    const event = parseInputEvent("\r");

    expect(
      resolveKeyWithChordState(
        event.input,
        event.key,
        ["Autocomplete", "Chat", "Global"],
        bindings,
        null,
      ),
    ).toEqual({ type: "match", action: "autocomplete:confirm" });
  });
});
