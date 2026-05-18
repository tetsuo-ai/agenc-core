import { describe, expect, test } from "vitest";

import { DEFAULT_BINDINGS } from "./defaultBindings.js";
import { isKeybindingCustomizationEnabled } from "./loadUserBindings.js";
import { KEYBINDING_ACTIONS, KEYBINDING_CONTEXTS } from "./schema.js";

function bindingsFor(context: string): Record<string, string | null> {
  const block = DEFAULT_BINDINGS.find((entry) => entry.context === context);
  if (!block) throw new Error(`Missing ${context} default bindings`);
  return block.bindings;
}

describe("default keybindings", () => {
  test("preserves AgenC global, chat, transcript, and selection vocabulary", () => {
    expect(bindingsFor("Global")).toMatchObject({
      "ctrl+c": "app:interrupt",
      "ctrl+d": "app:exit",
      "ctrl+l": "app:redraw",
      "ctrl+t": "app:toggleTodos",
      "ctrl+o": "app:toggleTranscript",
    });

    expect(Object.values(bindingsFor("Chat"))).toContain("chat:cycleMode");
    expect(bindingsFor("Transcript")).toMatchObject({
      "ctrl+e": "transcript:toggleShowAll",
      escape: "transcript:exit",
    });
    expect(bindingsFor("Scroll")).toMatchObject({
      "ctrl+shift+c": "selection:copy",
      "cmd+c": "selection:copy",
    });
  });

  test("schema exports cover every enabled default context and action", () => {
    const contexts = new Set(KEYBINDING_CONTEXTS);
    const actions = new Set(KEYBINDING_ACTIONS);

    for (const block of DEFAULT_BINDINGS) {
      expect(contexts.has(block.context), block.context).toBe(true);
      for (const action of Object.values(block.bindings)) {
        if (action === null || action.startsWith("command:")) continue;
        expect(actions.has(action), action).toBe(true);
      }
    }
  });

  test("enables user customization in AgenC without remote feature gates", () => {
    expect(isKeybindingCustomizationEnabled()).toBe(true);
  });
});
