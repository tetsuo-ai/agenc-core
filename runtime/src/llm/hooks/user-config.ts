/**
 * User-facing hooks config parser.
 *
 * Accepts the reference runtime's settings schema
 * (`{ PreToolUse: [{matcher, hooks: [{type, command|url, timeout?}]}] }`)
 * and produces the runtime's internal `HookDefinition[]` shape plus
 * any warnings surfaced during ingest.
 *
 * Scope today: `command` + `http` handler types only. Unsupported
 * handler types (`agent`, `prompt`) and unknown event names are
 * reported as warnings and skipped rather than rejecting the entire
 * config.
 *
 * @module
 */

import type {
  HookDefinition,
  HookEvent,
  HookKind,
} from "./types.js";

const SUPPORTED_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
];

const SUPPORTED_HANDLER_TYPES: readonly HookKind[] = ["command", "http"];

export interface UserHookCommandEntry {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
}

export interface UserHookHttpEntry {
  readonly type: "http";
  readonly url: string;
  readonly timeout?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export type UserHookEntry = UserHookCommandEntry | UserHookHttpEntry;

export interface UserHookMatcherEntry {
  readonly matcher?: string;
  readonly hooks: readonly UserHookEntry[];
}

export type UserHooksSettings = Partial<
  Record<HookEvent, readonly UserHookMatcherEntry[]>
>;

export interface BuildUserHookDefinitionsResult {
  readonly definitions: readonly HookDefinition[];
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // Upstream schema expresses timeout in seconds; runtime stores ms.
  return Math.floor(value * 1000);
}

function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Convert the user-facing hooks settings object into runtime hook
 * definitions. Invalid entries are skipped with a warning so one bad
 * stanza cannot disable the rest of the config.
 */
export function buildUserHookDefinitions(
  settings: unknown,
): BuildUserHookDefinitionsResult {
  if (settings === undefined || settings === null) {
    return { definitions: [], warnings: [] };
  }
  if (!isRecord(settings)) {
    return {
      definitions: [],
      warnings: ["hooks config must be an object keyed by hook event name"],
    };
  }

  const definitions: HookDefinition[] = [];
  const warnings: string[] = [];

  for (const [eventName, rawMatchers] of Object.entries(settings)) {
    if (!SUPPORTED_EVENTS.includes(eventName as HookEvent)) {
      warnings.push(
        `hooks.${eventName}: unsupported hook event; entry ignored`,
      );
      continue;
    }
    if (!Array.isArray(rawMatchers)) {
      warnings.push(
        `hooks.${eventName}: expected array of matcher groups; entry ignored`,
      );
      continue;
    }
    for (const [matcherIndex, rawMatcher] of rawMatchers.entries()) {
      if (!isRecord(rawMatcher)) {
        warnings.push(
          `hooks.${eventName}[${matcherIndex}]: matcher group must be an object`,
        );
        continue;
      }
      const matcher = coerceOptionalString(rawMatcher.matcher);
      const rawEntries = rawMatcher.hooks;
      if (!Array.isArray(rawEntries)) {
        warnings.push(
          `hooks.${eventName}[${matcherIndex}].hooks: expected array of handler entries`,
        );
        continue;
      }
      for (const [handlerIndex, rawHandler] of rawEntries.entries()) {
        if (!isRecord(rawHandler)) {
          warnings.push(
            `hooks.${eventName}[${matcherIndex}].hooks[${handlerIndex}]: handler must be an object`,
          );
          continue;
        }
        const type = rawHandler.type;
        if (typeof type !== "string") {
          warnings.push(
            `hooks.${eventName}[${matcherIndex}].hooks[${handlerIndex}]: missing handler type`,
          );
          continue;
        }
        if (!SUPPORTED_HANDLER_TYPES.includes(type as HookKind)) {
          warnings.push(
            `hooks.${eventName}[${matcherIndex}].hooks[${handlerIndex}]: handler type "${type}" is not yet supported; entry ignored`,
          );
          continue;
        }
        const timeoutMs = coerceTimeoutMs(rawHandler.timeout);
        if (type === "command") {
          const command = coerceOptionalString(rawHandler.command);
          if (!command) {
            warnings.push(
              `hooks.${eventName}[${matcherIndex}].hooks[${handlerIndex}]: command handler missing "command" field`,
            );
            continue;
          }
          definitions.push({
            event: eventName as HookEvent,
            kind: "command",
            target: command,
            ...(matcher !== undefined ? { matcher } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
        } else {
          const url = coerceOptionalString(rawHandler.url);
          if (!url) {
            warnings.push(
              `hooks.${eventName}[${matcherIndex}].hooks[${handlerIndex}]: http handler missing "url" field`,
            );
            continue;
          }
          definitions.push({
            event: eventName as HookEvent,
            kind: "http",
            target: url,
            ...(matcher !== undefined ? { matcher } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
        }
      }
    }
  }

  return { definitions, warnings };
}
