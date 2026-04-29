import { KEYBINDING_ACTIONS, KEYBINDING_CONTEXTS } from "./schema.js";
import { chordToString, parseChord, parseKeystroke } from "./parser.js";
import {
  getReservedShortcuts,
  normalizeKeyForComparison,
} from "./reservedShortcuts.js";
import type {
  KeybindingBlock,
  KeybindingContextName,
  ParsedBinding,
} from "./types.js";

export type KeybindingWarningType =
  | "parse_error"
  | "duplicate"
  | "reserved"
  | "invalid_context"
  | "invalid_action";

export type KeybindingWarning = {
  type: KeybindingWarningType;
  severity: "error" | "warning";
  message: string;
  key?: string;
  context?: string;
  action?: string;
  suggestion?: string;
};

function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== "object" || obj === null) return false;
  const block = obj as Record<string, unknown>;
  return (
    typeof block.context === "string" &&
    typeof block.bindings === "object" &&
    block.bindings !== null
  );
}

function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock);
}

const VALID_CONTEXTS = KEYBINDING_CONTEXTS;
const VALID_ACTIONS = new Set<string>(KEYBINDING_ACTIONS);

function isValidContext(value: string): value is KeybindingContextName {
  return (VALID_CONTEXTS as readonly string[]).includes(value);
}

function validateKeystroke(keystroke: string): KeybindingWarning | null {
  const parts = keystroke.toLowerCase().split("+");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      return {
        type: "parse_error",
        severity: "error",
        message: `Empty key part in "${keystroke}"`,
        key: keystroke,
        suggestion: 'Remove extra "+" characters',
      };
    }
  }

  const parsed = parseKeystroke(keystroke);
  if (
    !parsed.key &&
    !parsed.ctrl &&
    !parsed.alt &&
    !parsed.shift &&
    !parsed.meta &&
    !parsed.super
  ) {
    return {
      type: "parse_error",
      severity: "error",
      message: `Could not parse keystroke "${keystroke}"`,
      key: keystroke,
    };
  }

  return null;
}

function validateBlock(
  block: unknown,
  blockIndex: number,
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = [];

  if (typeof block !== "object" || block === null) {
    warnings.push({
      type: "parse_error",
      severity: "error",
      message: `Keybinding block ${blockIndex + 1} is not an object`,
    });
    return warnings;
  }

  const record = block as Record<string, unknown>;
  const rawContext = record.context;
  let contextName: string | undefined;

  if (typeof rawContext !== "string") {
    warnings.push({
      type: "parse_error",
      severity: "error",
      message: `Keybinding block ${blockIndex + 1} missing "context" field`,
    });
  } else if (!isValidContext(rawContext)) {
    warnings.push({
      type: "invalid_context",
      severity: "error",
      message: `Unknown context "${rawContext}"`,
      context: rawContext,
      suggestion: `Valid contexts: ${VALID_CONTEXTS.join(", ")}`,
    });
  } else {
    contextName = rawContext;
  }

  if (typeof record.bindings !== "object" || record.bindings === null) {
    warnings.push({
      type: "parse_error",
      severity: "error",
      message: `Keybinding block ${blockIndex + 1} missing "bindings" field`,
    });
    return warnings;
  }

  const bindings = record.bindings as Record<string, unknown>;
  for (const [key, action] of Object.entries(bindings)) {
    for (const step of key === " " ? [key] : key.trim().split(/\s+/)) {
      const keyError = validateKeystroke(step);
      if (keyError) {
        keyError.context = contextName;
        keyError.key = key;
        warnings.push(keyError);
      }
    }

    if (action !== null && typeof action !== "string") {
      warnings.push({
        type: "invalid_action",
        severity: "error",
        message: `Invalid action for "${key}": must be a string or null`,
        key,
        context: contextName,
      });
    } else if (typeof action === "string" && action.startsWith("command:")) {
      if (!/^command:[a-zA-Z0-9:\-_]+$/.test(action)) {
        warnings.push({
          type: "invalid_action",
          severity: "warning",
          message: `Invalid command binding "${action}" for "${key}"`,
          key,
          context: contextName,
          action,
        });
      }
      if (contextName && contextName !== "Chat") {
        warnings.push({
          type: "invalid_action",
          severity: "warning",
          message: `Command binding "${action}" must be in "Chat" context, not "${contextName}"`,
          key,
          context: contextName,
          action,
          suggestion: 'Move this binding to a block with "context": "Chat"',
        });
      }
    } else if (typeof action === "string" && !VALID_ACTIONS.has(action)) {
      warnings.push({
        type: "invalid_action",
        severity: "error",
        message: `Unknown action "${action}"`,
        key,
        context: contextName,
        action,
      });
    } else if (action === "voice:pushToTalk") {
      const keystroke = parseChord(key)[0];
      if (
        keystroke &&
        !keystroke.ctrl &&
        !keystroke.alt &&
        !keystroke.shift &&
        !keystroke.meta &&
        !keystroke.super &&
        /^[a-z]$/.test(keystroke.key)
      ) {
        warnings.push({
          type: "invalid_action",
          severity: "warning",
          message: `Binding "${key}" to voice:pushToTalk prints into the input during warmup; use space or a modifier combo like meta+k`,
          key,
          context: contextName,
          action,
        });
      }
    }
  }

  return warnings;
}

export function checkDuplicateKeysInJson(
  jsonString: string,
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = [];
  const bindingsBlockPattern =
    /"bindings"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = bindingsBlockPattern.exec(jsonString)) !== null) {
    const blockContent = blockMatch[1];
    if (!blockContent) continue;

    const textBeforeBlock = jsonString.slice(0, blockMatch.index);
    const contextMatch = textBeforeBlock.match(
      /"context"\s*:\s*"([^"]+)"[^{]*$/,
    );
    const context = contextMatch?.[1] ?? "unknown";

    const keyPattern = /"([^"]+)"\s*:/g;
    const keysByName = new Map<string, number>();

    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyPattern.exec(blockContent)) !== null) {
      const key = keyMatch[1];
      if (!key) continue;

      const count = (keysByName.get(key) ?? 0) + 1;
      keysByName.set(key, count);

      if (count === 2) {
        warnings.push({
          type: "duplicate",
          severity: "warning",
          message: `Duplicate key "${key}" in ${context} bindings`,
          key,
          context,
          suggestion:
            "This key appears multiple times in the same context. JSON uses the last value, earlier values are ignored.",
        });
      }
    }
  }

  return warnings;
}

export function validateUserConfig(userBlocks: unknown): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = [];

  if (!Array.isArray(userBlocks)) {
    warnings.push({
      type: "parse_error",
      severity: "error",
      message: "keybindings.json must contain an array",
      suggestion: "Wrap your bindings in [ ]",
    });
    return warnings;
  }

  for (let i = 0; i < userBlocks.length; i += 1) {
    warnings.push(...validateBlock(userBlocks[i], i));
  }

  return warnings;
}

export function checkDuplicates(
  blocks: KeybindingBlock[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = [];
  const seenByContext = new Map<string, Map<string, string>>();

  for (const block of blocks) {
    const contextMap =
      seenByContext.get(block.context) ?? new Map<string, string>();
    seenByContext.set(block.context, contextMap);

    for (const [key, action] of Object.entries(block.bindings)) {
      const normalizedKey = normalizeKeyForComparison(key);
      const existingAction = contextMap.get(normalizedKey);

      if (existingAction && existingAction !== action) {
        warnings.push({
          type: "duplicate",
          severity: "warning",
          message: `Duplicate binding "${key}" in ${block.context} context`,
          key,
          context: block.context,
          action: action ?? "null (unbind)",
          suggestion: `Previously bound to "${existingAction}". Only the last binding will be used.`,
        });
      }

      contextMap.set(normalizedKey, action ?? "null");
    }
  }

  return warnings;
}

export function checkReservedShortcuts(
  bindings: ParsedBinding[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = [];
  const reserved = getReservedShortcuts();

  for (const binding of bindings) {
    const keyDisplay = chordToString(binding.chord);
    const normalizedKey = normalizeKeyForComparison(keyDisplay);

    for (const reservedShortcut of reserved) {
      if (
        normalizeKeyForComparison(reservedShortcut.key) === normalizedKey
      ) {
        warnings.push({
          type: "reserved",
          severity: reservedShortcut.severity,
          message: `"${keyDisplay}" may not work: ${reservedShortcut.reason}`,
          key: keyDisplay,
          context: binding.context,
          action: binding.action ?? undefined,
        });
      }
    }
  }

  return warnings;
}

function getUserBindingsForValidation(
  userBlocks: KeybindingBlock[],
): ParsedBinding[] {
  const bindings: ParsedBinding[] = [];
  for (const block of userBlocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      bindings.push({
        chord: parseChord(key),
        action,
        context: block.context,
      });
    }
  }
  return bindings;
}

export function validateKeybindings(userBlocks: unknown): KeybindingWarning[] {
  const warnings = validateUserConfig(userBlocks);
  if (!isKeybindingBlockArray(userBlocks)) return warnings;

  warnings.push(...checkDuplicates(userBlocks));
  warnings.push(
    ...checkReservedShortcuts(getUserBindingsForValidation(userBlocks)),
  );

  return warnings;
}
