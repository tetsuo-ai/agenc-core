import { describe, expect, it } from "vitest";

import { DEFAULT_BINDINGS } from "../../../src/tui/keybindings/defaultBindings.js";
import {
  KEYBINDING_ACTION_NAMES,
  KEYBINDING_CONTEXT_NAMES,
  type KeybindingAction,
  type KeybindingContextName,
} from "../../../src/tui/keybindings/types.js";
import { descriptorForSurface } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";
import { bufferKeybindingContext } from "../../../src/tui/workbench/buffer/keybindingContext.js";
import {
  INLINE_BUFFER_CAPABILITIES,
  NEOVIM_BUFFER_CAPABILITIES,
} from "../../../src/tui/workbench/buffer/providers/types.js";

const WORKBENCH_CONTEXTS = [
  "WorkspaceTabs",
  "Workbench",
  "Explorer",
  "Surface",
  "Buffer",
  "BufferHost",
  "Agents",
  "Composer",
] as const satisfies readonly KeybindingContextName[];

const WORKBENCH_ACTIONS = [
  "workspace:switchAgent",
  "workspace:switchEditor",
  "workspace:cycleView",
  "workbench:focusExplorer",
  "workbench:focusSurface",
  "workbench:focusRail",
  "workbench:focusAgents",
  "workbench:focusComposer",
  "workbench:focusUp",
  "workbench:focusNext",
  "workbench:closeSurface",
  "workbench:openDiff",
  "workbench:openSearch",
  "explorer:up",
  "explorer:down",
  "explorer:top",
  "explorer:bottom",
  "explorer:expand",
  "explorer:collapse",
  "explorer:open",
  "explorer:openKeepFocus",
  "explorer:edit",
  "explorer:editKeepFocus",
  "explorer:attach",
  "explorer:addFile",
  "explorer:rename",
  "explorer:delete",
  "explorer:revealActive",
  "surface:up",
  "surface:down",
  "surface:pageUp",
  "surface:pageDown",
  "surface:top",
  "surface:bottom",
  "surface:open",
  "surface:openKeepFocus",
  "surface:edit",
  "surface:attach",
  "surface:attachAll",
  "surface:groupUp",
  "surface:groupDown",
  "surface:accept",
  "surface:reject",
  "surface:stop",
  "buffer:save",
  "buffer:revert",
  "buffer:close",
  "buffer:closeDiscard",
  "buffer:externalEditor",
  "buffer:undo",
  "buffer:redo",
  "buffer:hover",
  "buffer:definition",
  "buffer:up",
  "buffer:down",
  "buffer:left",
  "buffer:right",
  "buffer:pageUp",
  "buffer:pageDown",
  "buffer:lineStart",
  "buffer:lineEnd",
  "buffer:top",
  "buffer:bottom",
  "buffer:selectUp",
  "buffer:selectDown",
  "buffer:selectLeft",
  "buffer:selectRight",
  "buffer:selectLineStart",
  "buffer:selectLineEnd",
  "agents:up",
  "agents:down",
  "agents:open",
  "agents:stop",
] as const satisfies readonly KeybindingAction[];

describe("workbench keybinding contract", () => {
  it("uses host navigation only until a provider owns the first file", () => {
    expect(
      bufferKeybindingContext({
        filePath: null,
        providerStatus: "idle",
        provider: {
          kind: "inline",
          label: "unopened BUFFER placeholder",
          fallbackReason: null,
          capabilities: INLINE_BUFFER_CAPABILITIES,
        },
      }),
    ).toBe("BufferHost");

    expect(
      bufferKeybindingContext({
        filePath: "src/app.ts",
        providerStatus: "ready",
        provider: {
          kind: "inline",
          label: "basic inline BUFFER fallback",
          fallbackReason: null,
          capabilities: INLINE_BUFFER_CAPABILITIES,
        },
      }),
    ).toBe("Buffer");

    expect(
      bufferKeybindingContext({
        filePath: "src/app.ts",
        providerStatus: "ready",
        provider: {
          kind: "neovim",
          label: "embedded Neovim",
          fallbackReason: null,
          capabilities: NEOVIM_BUFFER_CAPABILITIES,
        },
      }),
    ).toBe("BufferHost");
  });

  it("registers every workbench context and action with the global keybinding schema", () => {
    for (const context of WORKBENCH_CONTEXTS) {
      expect(KEYBINDING_CONTEXT_NAMES).toContain(context);
      expect(DEFAULT_BINDINGS.some((block) => block.context === context)).toBe(
        true,
      );
    }

    for (const action of WORKBENCH_ACTIONS) {
      expect(KEYBINDING_ACTION_NAMES).toContain(action);
    }
  });

  it("binds root, explorer, surface, and agent controls", () => {
    const byContext = new Map(
      DEFAULT_BINDINGS.map((block) => [block.context, block.bindings]),
    );

    expect(byContext.get("Workbench")).toMatchObject({
      "ctrl+w h": "workbench:focusExplorer",
      "ctrl+w j": "workbench:focusComposer",
      "ctrl+w k": "workbench:focusUp",
      "ctrl+w d": "workbench:openDiff",
    });
    expect(byContext.get("WorkspaceTabs")).toMatchObject({
      "alt+1": "workspace:switchAgent",
      "alt+2": "workspace:switchEditor",
      "alt+`": "workspace:cycleView",
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
      "shift+tab": "workbench:focusComposer",
      "ctrl+x h": "workbench:focusExplorer",
      "ctrl+x j": "workbench:focusComposer",
      "ctrl+x l": "workbench:focusRail",
      "ctrl+s": "buffer:save",
      "ctrl+x q": "buffer:close",
      "ctrl+x x": "buffer:closeDiscard",
    });
    expect(byContext.get("Buffer")).not.toHaveProperty("q");
    expect(byContext.get("Buffer")).not.toHaveProperty("ctrl+z");
    expect(byContext.get("BufferHost")).toMatchObject({
      "shift+tab": "workbench:focusComposer",
      "ctrl+s": "buffer:save",
      "ctrl+r": "buffer:passthrough",
      "ctrl+x": "buffer:passthrough",
      "ctrl+k": "buffer:passthrough",
      "ctrl+g": "buffer:passthrough",
      "alt+h": "workbench:focusExplorer",
      "alt+j": "workbench:focusComposer",
      "alt+l": "workbench:focusRail",
      "alt+r": "workbench:toggleFileRail",
      "alt+q": "buffer:close",
      "alt+e": "buffer:externalEditor",
      "alt+z": "workbench:toggleSurfaceMaximized",
    });
    expect(byContext.get("BufferHost")).not.toHaveProperty("alt+u");
    expect(byContext.get("BufferHost")).not.toHaveProperty("alt+d");
    expect(byContext.get("Agents")).toMatchObject({
      enter: "agents:open",
      x: "agents:stop",
    });
    expect(byContext.get("Confirmation")).toMatchObject({
      d: "workbench:openDiff",
    });
  });

  it("keeps TEST surface footer hints aligned with surface navigation bindings", () => {
    const surfaceBindings = new Map(
      Object.entries(
        DEFAULT_BINDINGS.find((block) => block.context === "Surface")
          ?.bindings ?? {},
      ),
    );
    const testSurface = descriptorForSurface("test");

    expect(surfaceBindings.get("g")).toBe("surface:top");
    expect(surfaceBindings.get("enter")).toBe("surface:open");
    expect(testSurface.footerHints).toContain("enter edit");
    expect(testSurface.footerHints).toContain("o keep focus");
    expect(testSurface.footerHints).not.toContain("g edit");
  });

  it("keeps SEARCH surface edit hints represented in descriptor key metadata", () => {
    const surfaceBindings = new Map(
      Object.entries(
        DEFAULT_BINDINGS.find((block) => block.context === "Surface")
          ?.bindings ?? {},
      ),
    );
    const searchSurface = descriptorForSurface("search");

    expect(surfaceBindings.get("enter")).toBe("surface:open");
    expect(surfaceBindings.get("o")).toBe("surface:openKeepFocus");
    expect(searchSurface.footerHints).toContain("enter edit");
    expect(searchSurface.footerHints).toContain("o keep focus");
    expect(searchSurface.keybindings).toEqual(
      expect.arrayContaining(["enter", "o"]),
    );
  });

  it("keeps SHELL surface edit shortcuts represented in descriptor metadata", () => {
    const surfaceBindings = new Map(
      Object.entries(
        DEFAULT_BINDINGS.find((block) => block.context === "Surface")
          ?.bindings ?? {},
      ),
    );
    const shellSurface = descriptorForSurface("shell");

    expect(surfaceBindings.get("g")).toBe("surface:top");
    expect(surfaceBindings.get("enter")).toBe("surface:open");
    expect(shellSurface.footerHints).toContain("g/enter edit");
    expect(shellSurface.keybindings).toEqual(
      expect.arrayContaining(["g", "enter"]),
    );
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
