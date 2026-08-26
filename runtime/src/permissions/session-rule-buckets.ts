import { parseRuleString, serializeRuleValue } from "./rules.js";
import {
  PERMISSION_BEHAVIORS,
  type PermissionBehavior,
  type PermissionRuleValue,
} from "./types.js";

export const MAX_SESSION_PERMISSION_RULES_PER_BEHAVIOR = 4_096;
export const MAX_SESSION_PERMISSION_RULE_UTF8_BYTES = 4_096;
export const MAX_SESSION_PERMISSION_RULE_BUCKETS_UTF8_BYTES =
  8 * 1_024 * 1_024;

export interface CanonicalSessionPermissionRuleBuckets {
  readonly serialized: Readonly<
    Record<PermissionBehavior, readonly string[]>
  >;
  readonly parsed: Readonly<
    Record<PermissionBehavior, readonly PermissionRuleValue[]>
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the complete session-rule projection before it crosses or mutates
 * daemon authority. The aggregate bound stays well below the 16 MiB daemon
 * frame limit so the response cannot commit successfully and then fail in
 * transport.
 */
export function validateCanonicalSessionPermissionRuleBuckets(
  value: unknown,
  label = "session permission rules",
): CanonicalSessionPermissionRuleBuckets {
  if (!isRecord(value)) {
    throw new Error(`${label} must contain allow, deny, and ask buckets`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== PERMISSION_BEHAVIORS.length ||
    keys.some(
      (key) =>
        !(PERMISSION_BEHAVIORS as readonly string[]).includes(key),
    )
  ) {
    throw new Error(`${label} must contain only allow, deny, and ask buckets`);
  }

  const serialized = {} as Record<PermissionBehavior, readonly string[]>;
  const parsed = {} as Record<
    PermissionBehavior,
    readonly PermissionRuleValue[]
  >;
  for (const behavior of PERMISSION_BEHAVIORS) {
    const bucket = value[behavior];
    if (
      !Array.isArray(bucket) ||
      bucket.length > MAX_SESSION_PERMISSION_RULES_PER_BEHAVIOR
    ) {
      throw new Error(
        `${label} ${behavior} bucket exceeds ${MAX_SESSION_PERMISSION_RULES_PER_BEHAVIOR} rules or is invalid`,
      );
    }
    const seen = new Set<string>();
    const canonical: string[] = [];
    const values: PermissionRuleValue[] = [];
    for (const raw of bucket) {
      if (
        typeof raw !== "string" ||
        raw.length === 0 ||
        Buffer.byteLength(raw, "utf8") >
          MAX_SESSION_PERMISSION_RULE_UTF8_BYTES ||
        seen.has(raw)
      ) {
        throw new Error(`${label} ${behavior} bucket is non-canonical`);
      }
      const rule = parseRuleString(raw);
      if (
        rule === null ||
        raw.trim() !== raw ||
        rule.toolName.trim() !== rule.toolName ||
        /[()]/u.test(rule.toolName) ||
        serializeRuleValue(rule) !== raw
      ) {
        throw new Error(`${label} ${behavior} rule is non-canonical`);
      }
      seen.add(raw);
      canonical.push(raw);
      values.push(rule);
    }
    serialized[behavior] = Object.freeze(canonical);
    parsed[behavior] = Object.freeze(values);
  }

  const normalizedSerialized = Object.freeze({
    allow: serialized.allow,
    deny: serialized.deny,
    ask: serialized.ask,
  });
  if (
    Buffer.byteLength(JSON.stringify(normalizedSerialized), "utf8") >
    MAX_SESSION_PERMISSION_RULE_BUCKETS_UTF8_BYTES
  ) {
    throw new Error(
      `${label} exceed ${MAX_SESSION_PERMISSION_RULE_BUCKETS_UTF8_BYTES} aggregate UTF-8 bytes`,
    );
  }

  return Object.freeze({
    serialized: normalizedSerialized,
    parsed: Object.freeze({
      allow: parsed.allow,
      deny: parsed.deny,
      ask: parsed.ask,
    }),
  });
}
