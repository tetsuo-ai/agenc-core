/**
 * Reverse lookup + display formatting for the gut keybinding registry.
 *
 * Both upstream openclaude and AgenC expose a
 * `getShortcutDisplay(action, context, fallback)` helper that takes an
 * action name, finds the configured key sequence, and returns it
 * pretty-printed (e.g. `Ctrl+R`). Their action-name space is wider than
 * gut's and their context names are capitalized (`'Global'`, `'Chat'`,
 * `'Modal'`), so the gut port has to do two things:
 *
 *   1. Provide a programmatic reverse lookup from `BindingCommand` to a
 *      key sequence, since `DEFAULT_BINDINGS` is keyed the other way
 *      (key sequence -> command). Other parts of the TUI also benefit
 *      (status bar hints, modal footer text, etc.).
 *   2. Translate upstream-style action/context labels such as
 *      `'app:toggleTranscript'` / `'Global'` into the AgenC canonical
 *      `BindingCommand` + `BindingContext` pair. The caller passes a
 *      fallback so unmapped upstream-only actions still get a coherent
 *      display string.
 *
 * The helper is sync-only because it has to be callable from non-React
 * paths like `manual-compact.ts::buildDisplayText`. Bindings are read
 * directly from `DEFAULT_BINDINGS`; user overrides from
 * `~/.agenc/keybindings.json` are merged through `loadUserBindingsSync()`
 * so shortcut hints follow the same binding map as the live provider.
 */

import {
  KNOWN_BINDING_COMMANDS,
  KNOWN_BINDING_CONTEXTS,
  type BindingCommand,
  type BindingContext,
  type BindingMap,
} from "./defaultBindings.js";
import { loadUserBindingsSync } from "./loadUserBindings.js";

const MODIFIER_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  meta: "Meta",
};

const SPECIAL_KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PageUp",
  pagedown: "PageDown",
  wheelup: "WheelUp",
  wheeldown: "WheelDown",
  home: "Home",
  end: "End",
};

/**
 * Pretty-print a single normalized chord token like `ctrl+shift+a` as
 * `Ctrl+Shift+A`. Multi-chord sequences (whitespace separated, e.g.
 * `ctrl+x ctrl+e`) are pretty-printed chord-by-chord with a space
 * preserved between them.
 */
export function formatKeySequence(normalized: string): string {
  if (typeof normalized !== "string" || normalized.length === 0) return "";
  return normalized
    .split(/\s+/)
    .filter((c) => c.length > 0)
    .map((chord) =>
      chord
        .split("+")
        .map((part) => {
          if (MODIFIER_LABELS[part]) return MODIFIER_LABELS[part];
          if (SPECIAL_KEY_LABELS[part]) return SPECIAL_KEY_LABELS[part];
          if (part.length === 1) return part.toUpperCase();
          return part;
        })
        .join("+"),
    )
    .join(" ");
}

function findKeysForCommand(
  command: BindingCommand,
  map: BindingMap,
): string[] {
  const matches: string[] = [];
  for (const key of Object.keys(map)) {
    if (map[key] === command) {
      matches.push(key);
    }
  }
  return matches;
}

/**
 * Reverse-lookup helper: given a gut `BindingCommand`, return every
 * pretty-printed shortcut bound to that command, walking the active
 * context first and falling back to the global context.
 *
 * Duplicate bindings that appear in both maps are de-duped while keeping
 * the first-seen order stable.
 */
export function getDisplaysForCommand(
  command: BindingCommand,
  context: BindingContext,
  bindings: Record<BindingContext, BindingMap> = loadUserBindingsSync().bindings,
): string[] {
  const order: BindingContext[] =
    context === "global" ? ["global"] : [context, "global"];
  const displays: string[] = [];
  const seen = new Set<string>();
  for (const ctx of order) {
    const map = bindings[ctx];
    if (!map) continue;
    for (const hit of findKeysForCommand(command, map)) {
      const display = formatKeySequence(hit);
      if (seen.has(display)) continue;
      seen.add(display);
      displays.push(display);
    }
  }
  return displays;
}

/**
 * Reverse-lookup helper: given a gut `BindingCommand`, return the first
 * pretty-printed display string of the configured shortcut, walking
 * the active context first and falling back to the global context.
 *
 * Returns `undefined` when the command isn't bound in either map.
 * Callers that have a presentation fallback (e.g. `'ctrl+o'`) should
 * default to that string when this helper returns `undefined`.
 */
export function getDisplayForCommand(
  command: BindingCommand,
  context: BindingContext,
  bindings: Record<BindingContext, BindingMap> = loadUserBindingsSync().bindings,
): string | undefined {
  const order: BindingContext[] =
    context === "global" ? ["global"] : [context, "global"];
  for (const ctx of order) {
    const map = bindings[ctx];
    if (!map) continue;
    const keys = Object.keys(map);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (map[key] === command) return formatKeySequence(key);
    }
  }
  return undefined;
}

/**
 * Translate an action label coming from upstream code paths (kept for
 * compatibility with ported logic that hasn't been rewritten to use
 * gut's `BindingCommand` enum directly) into a `BindingCommand` if
 * one exists. Unknown actions return `undefined`.
 *
 * Mapping rules:
 *   - If the action already matches a known `BindingCommand`, it is
 *     returned as-is.
 *   - Upstream-only actions that have no equivalent gut binding (such
 *     return `undefined` so the caller falls back to its hardcoded
 *     display string.
 */
function resolveActionToCommand(action: string): BindingCommand | undefined {
  const trimmed = action.trim();
  if (KNOWN_BINDING_COMMANDS.has(trimmed as BindingCommand)) {
    return trimmed as BindingCommand;
  }
  return undefined;
}

/**
 * Translate an upstream-style context name (`'Global'`, `'Chat'`,
 * `'Modal'`) into a gut `BindingContext`. Already-lowercase names are
 * accepted as-is. Unknown names default to `'global'` so the lookup
 * still walks the global map.
 */
function resolveContextName(name: string): BindingContext {
  const lowered = name.trim().toLowerCase();
  if ((KNOWN_BINDING_CONTEXTS as readonly string[]).includes(lowered)) {
    return lowered as BindingContext;
  }
  return "global";
}

/**
 * Get the display text for a configured shortcut without React hooks.
 *
 * Mirrors the upstream contract: returns the pretty-printed key
 * sequence when the action exists in the gut keybinding registry,
 * otherwise returns the caller-supplied `fallback`.
 *
 * Use this in non-React contexts (commands, services, post-compact
 * stdout breadcrumbs). React-rendered code paths can read the same
 * data via `useKeybinding` + a sibling hook.
 *
 * @param action - Action name. Either a gut `BindingCommand` literal
 *   (e.g. `'history:search'`) or an upstream-only action label whose
 *   gut equivalent is unknown.
 * @param context - Keybinding context. Accepts both gut casing
 *   (`'global'`) and upstream casing (`'Global'`).
 * @param fallback - Display string to return when the action is not
 *   bound in the gut registry.
 */
export function getShortcutDisplay(
  action: string,
  context: string,
  fallback: string,
): string {
  const command = resolveActionToCommand(action);
  if (command === undefined) return fallback;
  const ctx = resolveContextName(context);
  const display = getDisplayForCommand(command, ctx);
  return display ?? fallback;
}
