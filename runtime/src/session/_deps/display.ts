/**
 * Display helpers for the post-compact stdout breadcrumb (and any
 * other non-React caller that needs a configured-shortcut hint or a
 * context-window upgrade tip).
 *
 * Wired to the real gut subsystems:
 *
 *   - `getShortcutDisplay` -> a non-React fallback for runtime-only
 *     call sites. The interactive TUI uses the upstream keybinding
 *     provider directly; this helper keeps background/session text from
 *     importing TUI implementation files.
 *
 *   - `getUpgradeMessage` -> `src/llm/context-window-upgrade.ts`,
 *     which inspects the live `ModelsManager` snapshot registered by
 *     bootstrap and returns a same-family larger-context model
 *     suggestion if one is available. Returns `null` when no upgrade
 *     candidate exists or no snapshot has been registered, which
 *     preserves the previous "tip omitted" behavior for callers that
 *     never wired the snapshot.
 */

export { getUpgradeMessage } from "../../llm/context-window-upgrade.js";

export function getShortcutDisplay(
  _action: string,
  _context: string,
  fallback: string,
): string {
  return fallback;
}
