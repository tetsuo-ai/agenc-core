/**
 * Configured hook discovery.
 *
 * Flattens AgenC's validated hook config into executable hook entries.
 */

import type { HookEventName, HooksMap } from "../../config/schema.js";
import { HOOK_EVENT_NAMES } from "../../config/schema.js";
import type { IndividualHookConfig } from "./types.js";

export function flattenHooks(
  config: HooksMap | undefined,
  sourcePath: string,
): readonly IndividualHookConfig[] {
  if (!config) return [];
  const out: IndividualHookConfig[] = [];
  for (const event of HOOK_EVENT_NAMES) {
    const matchers = config[event] ?? [];
    for (const matcher of matchers) {
      const matcherEnabled = matcher.enabled !== false;
      for (const command of matcher.hooks) {
        out.push({
          event,
          ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
          command,
          source: "config",
          sourcePath,
          enabled: matcherEnabled && command.enabled !== false,
          index: out.length,
        });
      }
    }
  }
  return out;
}

export function groupHooksByEvent(
  hooks: readonly IndividualHookConfig[],
): ReadonlyMap<HookEventName, readonly IndividualHookConfig[]> {
  const map = new Map<HookEventName, IndividualHookConfig[]>();
  for (const event of HOOK_EVENT_NAMES) map.set(event, []);
  for (const hook of hooks) {
    map.get(hook.event)?.push(hook);
  }
  return map;
}
