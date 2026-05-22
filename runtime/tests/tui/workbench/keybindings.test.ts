import { describe, expect, it } from "vitest";

import { DEFAULT_BINDINGS } from "../../../src/tui/keybindings/defaultBindings.js";
import { KEYBINDING_ACTION_NAMES, KEYBINDING_CONTEXT_NAMES } from "../../../src/tui/keybindings/types.js";
import { WORKBENCH_ACTIONS, WORKBENCH_CONTEXTS } from "../../../src/tui/workbench/keymap.js";

describe("workbench keybinding contract", () => {
  it("registers every workbench context and action with the global keybinding schema", () => {
    for (const context of WORKBENCH_CONTEXTS) {
      expect(KEYBINDING_CONTEXT_NAMES).toContain(context);
      expect(DEFAULT_BINDINGS.some((block) => block.context === context)).toBe(true);
    }

    for (const action of WORKBENCH_ACTIONS) {
      expect(KEYBINDING_ACTION_NAMES).toContain(action);
    }
  });

  it("binds root, explorer, surface, and agent controls", () => {
    const byContext = new Map(DEFAULT_BINDINGS.map((block) => [block.context, block.bindings]));

    expect(byContext.get("Workbench")).toMatchObject({
      "ctrl+w h": "workbench:focusExplorer",
      "ctrl+w j": "workbench:focusComposer",
      "ctrl+w k": "workbench:focusUp",
      "ctrl+w d": "workbench:openDiff",
    });
    expect(byContext.get("Explorer")).toMatchObject({
      j: "explorer:down",
      k: "explorer:up",
      h: "explorer:collapse",
      l: "explorer:expand",
      "@": "explorer:attach",
    });
    expect(byContext.get("Surface")).toMatchObject({
      q: "workbench:closeSurface",
      enter: "surface:open",
      "@": "surface:attach",
      x: "surface:stop",
    });
    expect(byContext.get("Agents")).toMatchObject({
      enter: "agents:open",
      x: "agents:stop",
    });
    expect(byContext.get("Confirmation")).toMatchObject({
      d: "workbench:openDiff",
    });
  });
});
