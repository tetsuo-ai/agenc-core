/**
 * Hook event scheduling metadata for permission-facing lifecycle events.
 *
 * The configured hook runtime uses this table to decide whether an event
 * matches against tool names, a session-start source, or no matcher at all.
 */

import type { HookEventName } from "../config/schema.js";

type HookEventMatcherKind = "tool" | "source" | "none";

interface HookEventScheduleEntry {
  readonly event: HookEventName;
  readonly matcher: HookEventMatcherKind;
}

const hookEventSchedule: readonly HookEventScheduleEntry[] = Object.freeze([
  { event: "PreToolUse", matcher: "tool" },
  { event: "PostToolUse", matcher: "tool" },
  { event: "PermissionRequest", matcher: "tool" },
  { event: "UserPromptSubmit", matcher: "none" },
  { event: "SessionStart", matcher: "source" },
  { event: "Stop", matcher: "none" },
] as const);

const matcherByEvent = new Map<HookEventName, HookEventMatcherKind>(
  hookEventSchedule.map((entry) => [entry.event, entry.matcher]),
);

function hookEventMatcherKind(
  event: HookEventName,
): HookEventMatcherKind | undefined {
  return matcherByEvent.get(event);
}

export function hookEventIgnoresConfiguredMatcher(
  event: HookEventName,
): boolean {
  return hookEventMatcherKind(event) === "none";
}

export function hookMatcherInputsForToolName(
  toolName: string,
  aliases: readonly string[] = [],
): readonly string[] {
  const inputs =
    toolName === "apply_patch" ? ["apply_patch", "Write", "Edit"] : [toolName];
  return uniqueStrings([...inputs, ...aliases]);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
