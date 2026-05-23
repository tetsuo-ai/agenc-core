import { describe, expect, it } from "vitest";

import { DEFAULT_BINDINGS } from "../../../src/tui/keybindings/defaultBindings.js";
import { KEYBINDING_ACTION_NAMES, KEYBINDING_CONTEXT_NAMES } from "../../../src/tui/keybindings/types.js";
import { WORKBENCH_ACTIONS, WORKBENCH_CONTEXTS } from "../../../src/tui/workbench/keymap.js";
import { descriptorForSurface } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";

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
      e: "explorer:edit",
      "@": "explorer:attach",
      a: "explorer:addFile",
      r: "explorer:rename",
      d: "explorer:delete",
    });
    expect(byContext.get("Surface")).toMatchObject({
      q: "workbench:closeSurface",
      enter: "surface:open",
      e: "surface:edit",
      "@": "surface:attach",
      x: "surface:stop",
    });
    expect(byContext.get("Buffer")).toMatchObject({
      enter: "buffer:externalEditor",
      "ctrl+s": "buffer:save",
      "ctrl+w q": "buffer:close",
      "ctrl+w x": "buffer:closeDiscard",
    });
    expect(byContext.get("Buffer")).not.toHaveProperty("q");
    expect(byContext.get("Buffer")).not.toHaveProperty("ctrl+z");
    expect(byContext.get("Agents")).toMatchObject({
      enter: "agents:open",
      x: "agents:stop",
    });
    expect(byContext.get("Confirmation")).toMatchObject({
      d: "workbench:openDiff",
    });
  });

  it("keeps TEST surface footer hints aligned with surface navigation bindings", () => {
    const surfaceBindings = new Map(Object.entries(DEFAULT_BINDINGS.find((block) => block.context === "Surface")?.bindings ?? {}));
    const testSurface = descriptorForSurface("test");

    expect(surfaceBindings.get("g")).toBe("surface:top");
    expect(surfaceBindings.get("enter")).toBe("surface:open");
    expect(testSurface.footerHints).toContain("enter edit");
    expect(testSurface.footerHints).toContain("o keep focus");
    expect(testSurface.footerHints).not.toContain("g edit");
  });

  it("keeps SEARCH surface edit hints represented in descriptor key metadata", () => {
    const surfaceBindings = new Map(Object.entries(DEFAULT_BINDINGS.find((block) => block.context === "Surface")?.bindings ?? {}));
    const searchSurface = descriptorForSurface("search");

    expect(surfaceBindings.get("enter")).toBe("surface:open");
    expect(searchSurface.footerHints).toContain("enter edit");
    expect(searchSurface.keybindings).toContain("enter");
  });

  it("keeps SHELL surface edit shortcuts represented in descriptor metadata", () => {
    const surfaceBindings = new Map(Object.entries(DEFAULT_BINDINGS.find((block) => block.context === "Surface")?.bindings ?? {}));
    const shellSurface = descriptorForSurface("shell");

    expect(surfaceBindings.get("g")).toBe("surface:top");
    expect(surfaceBindings.get("enter")).toBe("surface:open");
    expect(shellSurface.footerHints).toContain("g/enter edit");
    expect(shellSurface.keybindings).toEqual(expect.arrayContaining(["g", "enter"]));
  });

  it("keeps action-bearing surface descriptor shortcuts represented in footer hints", () => {
    const diffSurface = descriptorForSurface("diff");
    const searchSurface = descriptorForSurface("search");

    expect(diffSurface.keybindings).toContain("@");
    expect(diffSurface.footerHints).toContain("@ attach");
    expect(searchSurface.keybindings).toContain("A");
    expect(searchSurface.footerHints).toContain("A attach");
  });
});
