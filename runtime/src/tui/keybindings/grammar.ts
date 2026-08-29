import {
  KEYBINDING_ACTION_NAMES,
  KEYBINDING_CONTEXT_NAMES,
  type BindingCommand,
  type KeybindingContextName,
} from "./types.js";

const ACTION_NAMES = new Set<string>(KEYBINDING_ACTION_NAMES);
const CONTEXT_NAMES = new Set<string>(KEYBINDING_CONTEXT_NAMES);
const COMMAND_BINDING_RE = /^command:[a-zA-Z0-9:_-]+$/u;

export const NON_REBINDABLE_KEYBINDINGS = Object.freeze([
  Object.freeze({
    key: "ctrl+c",
    defaultAction: "app:interrupt" as const,
    reason: "Cannot be rebound - used for interrupt/exit (hardcoded)",
  }),
  Object.freeze({
    key: "ctrl+d",
    defaultAction: "app:exit" as const,
    reason: "Cannot be rebound - used for exit (hardcoded)",
  }),
  Object.freeze({
    key: "ctrl+m",
    reason: "Cannot be rebound - identical to Enter in terminals (both send CR)",
  }),
] as const);

const MODIFIER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  alt: "alt",
  cmd: "cmd",
  command: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  opt: "alt",
  option: "alt",
  shift: "shift",
  super: "super",
  win: "super",
});

export function isKeybindingContextName(
  value: unknown,
): value is KeybindingContextName {
  return typeof value === "string" && CONTEXT_NAMES.has(value);
}

export function isBindingCommand(value: unknown): value is BindingCommand {
  if (typeof value !== "string") return false;
  return ACTION_NAMES.has(value) || COMMAND_BINDING_RE.test(value);
}

export function bindingCommandError(
  value: unknown,
  context: KeybindingContextName,
): string | null {
  if (typeof value !== "string") return "expected a keybinding action string";
  if (value.startsWith("command:")) {
    if (!COMMAND_BINDING_RE.test(value)) {
      return "command name may contain only alphanumeric characters, colons, hyphens, and underscores";
    }
    if (context !== "Chat") {
      return 'command bindings are supported only in the "Chat" context';
    }
    return null;
  }
  return ACTION_NAMES.has(value)
    ? null
    : `unknown action; expected a registered keybinding action`;
}

/**
 * Validate the persisted chord grammar without accepting modifier-only or
 * delimiter-only steps. A single literal space remains the supported alias
 * for the space key.
 */
export function keybindingChordError(value: unknown): string | null {
  if (typeof value !== "string") return "expected string";
  if (value === " ") return null;
  if (value.trim().length === 0) return "expected a non-empty chord";

  for (const step of value.trim().split(/\s+/u)) {
    const parts = step.split("+");
    if (parts.some((part) => part.trim().length === 0)) {
      return `empty key part in ${JSON.stringify(value)}`;
    }
    let mainKey = "";
    const modifiers = new Set<string>();
    for (const rawPart of parts) {
      const part = rawPart.trim().toLowerCase();
      const modifier = MODIFIER_ALIASES[part];
      if (modifier !== undefined) {
        if (modifiers.has(modifier)) {
          return `duplicate modifier ${JSON.stringify(rawPart)} in ${JSON.stringify(value)}`;
        }
        modifiers.add(modifier);
        continue;
      }
      if (mainKey.length > 0) {
        return `multiple keys in chord step ${JSON.stringify(step)}`;
      }
      mainKey = part;
    }
    if (mainKey.length === 0) {
      return `modifier-only chord step ${JSON.stringify(step)}`;
    }
  }
  return null;
}

/** Normalize aliases and modifier order for collision detection. */
export function normalizeKeyForComparison(key: string): string {
  if (key === " ") return "space";
  return key.trim().split(/\s+/u).map((step) => {
    const modifiers: string[] = [];
    let mainKey = "";
    for (const rawPart of step.split("+")) {
      const part = rawPart.trim().toLowerCase();
      const modifier = MODIFIER_ALIASES[part];
      if (modifier !== undefined) modifiers.push(modifier);
      else mainKey = part;
    }
    modifiers.sort();
    return [...modifiers, mainKey].join("+");
  }).join(" ");
}

export function nonRebindableBindingError(
  chord: string,
  action: BindingCommand | null,
): string | null {
  const normalized = normalizeKeyForComparison(chord);
  const definition = NON_REBINDABLE_KEYBINDINGS.find(
    (candidate) => normalizeKeyForComparison(candidate.key) === normalized,
  );
  if (definition === undefined) return null;
  if (
    "defaultAction" in definition &&
    action === definition.defaultAction
  ) return null;
  return definition.reason;
}
