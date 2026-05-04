import { describe, expect, it, vi } from "vitest";

import { createSessionAppStateBridge } from "./app-state-bridge.js";

describe("TUI app-state slash-command bridge", () => {
  it("publishes the live AppState setter alongside model and expanded-view setters", () => {
    const setModel = vi.fn();
    const setExpandedView = vi.fn();
    let state = { value: 1 } as never;
    const setAppState = vi.fn((updater: (prev: never) => never) => {
      state = updater(state);
    });

    const bridge = createSessionAppStateBridge(
      setModel,
      setExpandedView,
      setAppState,
    );

    bridge.setModel?.("grok-4");
    bridge.setExpandedView?.("tasks");
    bridge.setAppState?.((prev) => ({
      ...(prev as Record<string, unknown>),
      value: 2,
    }));

    expect(setModel).toHaveBeenCalledWith("grok-4");
    expect(setExpandedView).toHaveBeenCalledWith("tasks");
    expect(setAppState).toHaveBeenCalledOnce();
    expect(state).toEqual({ value: 2 });
  });
});
