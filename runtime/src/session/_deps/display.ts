/**
 * Display helpers for the post-compact stdout breadcrumb (and any
 * other non-React caller that needs a configured-shortcut hint or a
 * context-window upgrade tip).
 *
 * Wired to the real gut subsystems:
 *
 *   - `getShortcutDisplay` -> `src/tui/keybindings/shortcutFormat.ts`,
 *     which reverse-looks-up the gut `BindingCommand` registry and
 *     pretty-prints the configured key sequence. Upstream-only action
 *     labels (e.g. `app:toggleTranscript`, which the gut TUI does not
 *     implement today) cleanly fall back to the caller-supplied
 *     hardcoded display string.
 *
 *   - `getUpgradeMessage` -> `src/llm/context-window-upgrade.ts`,
 *     which inspects the live `ModelsManager` snapshot registered by
 *     bootstrap and returns a same-family larger-context model
 *     suggestion if one is available. Returns `null` when no upgrade
 *     candidate exists or no snapshot has been registered, which
 *     preserves the previous "tip omitted" behavior for callers that
 *     never wired the snapshot.
 */

export { getShortcutDisplay } from "../../tui/keybindings/shortcutFormat.js";
export { getUpgradeMessage } from "../../llm/context-window-upgrade.js";
