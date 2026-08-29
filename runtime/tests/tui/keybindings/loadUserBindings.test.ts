import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));

import type { AgenCConfig } from "../../../src/config/schema.js";
import {
  disposeKeybindingSubscription,
  initializeKeybindingSubscription,
  isKeybindingCustomizationEnabled,
  loadKeybindingsSync,
  loadKeybindingsSyncWithWarnings,
  resetKeybindingLoaderForTesting,
  subscribeToKeybindingChanges,
  type KeybindingConfigStore,
} from "../../../src/tui/keybindings/loadUserBindings.js";
import { resolveKey } from "../../../src/tui/keybindings/resolver.js";

class FakeConfigStore implements KeybindingConfigStore {
  #snapshot: AgenCConfig;
  readonly listeners = new Set<(config: AgenCConfig) => void>();

  constructor(snapshot: AgenCConfig = {}) {
    this.#snapshot = snapshot;
  }

  current(): AgenCConfig {
    return this.#snapshot;
  }

  subscribe(listener: (config: AgenCConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: AgenCConfig): void {
    this.#snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function key(overrides: Record<string, boolean> = {}) {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    downArrow: false,
    end: false,
    escape: false,
    home: false,
    leftArrow: false,
    meta: false,
    pageDown: false,
    pageUp: false,
    return: false,
    rightArrow: false,
    shift: false,
    super: false,
    tab: false,
    upArrow: false,
    wheelDown: false,
    wheelUp: false,
    ...overrides,
  } as never;
}

beforeEach(() => resetKeybindingLoaderForTesting());

describe("canonical keybinding projection", () => {
  test("uses defaults without a ConfigStore snapshot", () => {
    expect(isKeybindingCustomizationEnabled()).toBe(true);
    expect(loadKeybindingsSync()).not.toHaveLength(0);
    expect(loadKeybindingsSyncWithWarnings().warnings).toEqual([]);
  });

  test("projects actions and explicit unbinds from one ConfigStore snapshot", () => {
    const store = new FakeConfigStore({
      tui: {
        keybindings: [
          {
            context: "Chat",
            bindings: { "ctrl+y": "chat:newline" },
            unbind: ["enter"],
          },
        ],
      },
    });

    const result = loadKeybindingsSyncWithWarnings(store);
    expect(result.warnings).toEqual([]);
    expect(result.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "chat:newline", context: "Chat" }),
        expect.objectContaining({ action: null, context: "Chat" }),
      ]),
    );
    expect(
      resolveKey("", key({ return: true }), ["Chat", "Global"], result.bindings),
    ).toEqual({ type: "unbound" });
    expect(loadKeybindingsSync()).toBe(result.bindings);
  });

  test("rejects an entire invalid injected snapshot instead of dropping entries", () => {
    const store = new FakeConfigStore({
      tui: {
        keybindings: [
          {
            context: "Chat",
            bindings: {
              "ctrl+y": "chat:newline",
              "ctrl+z": "chat:not-real" as never,
            },
          },
        ],
      },
    });
    const result = loadKeybindingsSyncWithWarnings(store);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "invalid_action" }),
    ]));
    expect(result.bindings.some((binding) => binding.action === "chat:newline"))
      .toBe(false);
  });

  test("hot reload subscribes to ConfigStore and disposes cleanly", () => {
    const store = new FakeConfigStore();
    const changes: unknown[] = [];
    const unsubscribe = subscribeToKeybindingChanges((result) => {
      changes.push(result);
    });

    initializeKeybindingSubscription(store);
    initializeKeybindingSubscription(store);
    expect(store.listeners.size).toBe(1);

    store.emit({
      tui: {
        keybindings: [{
          context: "Chat",
          bindings: { "ctrl+y": "chat:newline" },
        }],
      },
    });
    expect(changes).toHaveLength(1);

    unsubscribe();
    disposeKeybindingSubscription();
    expect(store.listeners.size).toBe(0);
  });
});
