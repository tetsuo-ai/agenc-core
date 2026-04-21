/**
 * Reader for `~/.agenc/keybindings.json`.
 *
 * User bindings layer on top of `DEFAULT_BINDINGS`: for each known
 * context, every binding in the user file replaces (or adds) a single
 * entry. Keys the user doesn't override keep their defaults. Unknown
 * contexts, unknown commands, and malformed JSON are logged via
 * `silentLogger` (so tests stay quiet) and skipped — the reader never
 * throws.
 *
 * File shape (minimal):
 * ```json
 * {
 *   "chat":  { "ctrl+j": "chat:submit" },
 *   "modal": { "ctrl+enter": "modal:confirm" }
 * }
 * ```
 *
 * There is no Zod / runtime schema dependency here by design: the file
 * is small, user-maintained, and the validation rules are narrow enough
 * to express directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { silentLogger, type Logger } from "../../utils/logger.js";
import {
  DEFAULT_BINDINGS,
  KNOWN_BINDING_CONTEXTS,
  KNOWN_BINDING_COMMANDS,
  normalizeKeySequence,
  type BindingCommand,
  type BindingContext,
  type BindingMap,
} from "./defaultBindings.js";

/**
 * File name inside the user's AgenC config directory. Kept as a constant
 * so tests can reference the same path without duplicating the literal.
 */
export const USER_BINDINGS_FILENAME = "keybindings.json";

/**
 * Resolve the absolute path to the user's bindings file from a `HOME`
 * directory. Exported so tests can assert the resolved path shape
 * without needing to shell out.
 */
export function userBindingsPath(home: string): string {
  return path.join(home, ".agenc", USER_BINDINGS_FILENAME);
}

/**
 * Internal helper for merging a single context's user overrides onto the
 * defaults. Accepts the full defaults map so it can copy through entries
 * the user didn't touch.
 */
function mergeContext(
  context: BindingContext,
  defaults: BindingMap,
  overrides: Record<string, unknown> | undefined,
  logger: Logger,
): BindingMap {
  // Start from a shallow copy so the defaults stay pristine for the
  // other contexts / later callers.
  const out: BindingMap = { ...defaults };
  if (!overrides) return out;

  for (const [rawKey, rawValue] of Object.entries(overrides)) {
    if (typeof rawValue !== "string") {
      logger.warn(
        `[keybindings] ignoring non-string binding for ${context}.${rawKey}`,
      );
      continue;
    }
    if (!KNOWN_BINDING_COMMANDS.has(rawValue as BindingCommand)) {
      logger.warn(
        `[keybindings] unknown command '${rawValue}' for ${context}.${rawKey}`,
      );
      continue;
    }
    const normalized = normalizeKeySequence(rawKey);
    if (normalized.length === 0) {
      logger.warn(
        `[keybindings] empty or malformed key sequence in ${context}: '${rawKey}'`,
      );
      continue;
    }
    out[normalized] = rawValue as BindingCommand;
  }

  return out;
}

/**
 * Load and merge user overrides from `${home}/.agenc/keybindings.json`.
 *
 * Behavior:
 *   - File missing -> return `DEFAULT_BINDINGS` (new copy).
 *   - Malformed JSON -> log a warning, return defaults.
 *   - Top-level value not a JSON object -> log a warning, return defaults.
 *   - Unknown context key -> log a warning, skip the context.
 *   - Unknown command -> log a warning, skip the binding.
 *   - Known context / known command -> overwrite the default entry for
 *     that normalized key sequence.
 *
 * The function never throws. The optional `logger` argument is here for
 * tests; production callers get the module-level `silentLogger` so the
 * reader stays quiet during startup.
 */
export function loadUserBindings(
  home: string,
  logger: Logger = silentLogger,
): Record<BindingContext, BindingMap> {
  // Always start from a deep-enough copy of DEFAULT_BINDINGS so callers
  // can mutate the returned map freely without poisoning the defaults.
  const merged: Record<BindingContext, BindingMap> = {
    global: { ...DEFAULT_BINDINGS.global },
    chat: { ...DEFAULT_BINDINGS.chat },
    modal: { ...DEFAULT_BINDINGS.modal },
  };

  const filePath = userBindingsPath(home);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      // Expected when the user hasn't customized anything.
      return merged;
    }
    logger.warn(
      `[keybindings] failed to read ${filePath}: ${readableError(err)}`,
    );
    return merged;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[keybindings] malformed JSON in ${filePath}: ${readableError(err)}`,
    );
    return merged;
  }

  if (!isPlainObject(parsed)) {
    logger.warn(
      `[keybindings] expected top-level object in ${filePath}, got ${typeof parsed}`,
    );
    return merged;
  }

  const knownContextSet = new Set<BindingContext>(KNOWN_BINDING_CONTEXTS);

  for (const [contextKey, contextValue] of Object.entries(parsed)) {
    if (!knownContextSet.has(contextKey as BindingContext)) {
      logger.warn(
        `[keybindings] ignoring unknown context '${contextKey}' in ${filePath}`,
      );
      continue;
    }
    if (!isPlainObject(contextValue)) {
      logger.warn(
        `[keybindings] expected object for context '${contextKey}' in ${filePath}`,
      );
      continue;
    }
    const context = contextKey as BindingContext;
    merged[context] = mergeContext(
      context,
      merged[context],
      contextValue,
      logger,
    );
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function readableError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
