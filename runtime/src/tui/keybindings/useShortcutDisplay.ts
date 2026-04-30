// Cherry-picked from openclaude src/keybindings/useShortcutDisplay.ts.
//
// openclaude's hook reads the resolved binding via
// useOptionalKeybindingContext().getDisplayText(action, context) and
// logs a tengu_keybinding_fallback_used event through their analytics
// service when the binding isn't found.
//
// AgenC has the same display-text concept via the static
// getShortcutDisplay(action, context, fallback) helper in
// shortcutFormat.ts. AgenC has no analytics layer wired into the TUI,
// so the fallback-tracking effect is dropped.

import { getShortcutDisplay } from "./shortcutFormat.js";

export function useShortcutDisplay(
  action: string,
  context: string,
  fallback: string,
): string {
  return getShortcutDisplay(action, context, fallback);
}
