import { describe, expect, test } from "vitest";

import {
  MAX_SESSION_PERMISSION_RULE_BUCKETS_UTF8_BYTES,
  MAX_SESSION_PERMISSION_RULE_UTF8_BYTES,
  MAX_SESSION_PERMISSION_RULES_PER_BEHAVIOR,
  validateCanonicalSessionPermissionRuleBuckets,
} from "../../src/permissions/session-rule-buckets.js";

function buckets(allow: readonly unknown[] = []): Record<string, unknown> {
  return { allow, deny: [], ask: [] };
}

function bucketsAtSerializedBytes(targetBytes: number): Record<string, unknown> {
  const emptyBytes = Buffer.byteLength(
    JSON.stringify(buckets()),
    "utf8",
  );
  for (
    let count = 1;
    count <= MAX_SESSION_PERMISSION_RULES_PER_BEHAVIOR;
    count += 1
  ) {
    // Replacing [] with N quoted ASCII strings adds three bytes per rule
    // (two quotes plus a comma) except that the first rule has no comma.
    const payloadBytes = targetBytes - emptyBytes - (3 * count - 1);
    const minimumPayloadBytes = 6 * count;
    if (
      payloadBytes < minimumPayloadBytes ||
      payloadBytes > MAX_SESSION_PERMISSION_RULE_UTF8_BYTES * count
    ) {
      continue;
    }

    let paddingBytes = payloadBytes - minimumPayloadBytes;
    const rules = Array.from({ length: count }, (_, index) => {
      const prefix = `r${String(index).padStart(4, "0")}-`;
      const padding = Math.min(
        MAX_SESSION_PERMISSION_RULE_UTF8_BYTES - prefix.length,
        paddingBytes,
      );
      paddingBytes -= padding;
      return `${prefix}${"x".repeat(padding)}`;
    });
    if (paddingBytes !== 0) continue;
    const value = buckets(rules);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") === targetBytes) {
      return value;
    }
  }
  throw new Error(`cannot construct rule buckets at ${targetBytes} bytes`);
}

describe("canonical session permission rule buckets", () => {
  test("accepts the exact count boundary and rejects one more rule", () => {
    const exact = Array.from(
      { length: MAX_SESSION_PERMISSION_RULES_PER_BEHAVIOR },
      (_, index) => `tool-${index}`,
    );

    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(buckets(exact))
    ).not.toThrow();
    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(
        buckets([...exact, "tool-over-limit"]),
      )
    ).toThrow(/exceeds 4096 rules/u);
  });

  test("measures the per-rule boundary in UTF-8 bytes", () => {
    const exact = "é".repeat(MAX_SESSION_PERMISSION_RULE_UTF8_BYTES / 2);
    const over = `${exact}a`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(
      MAX_SESSION_PERMISSION_RULE_UTF8_BYTES,
    );
    expect(Buffer.byteLength(over, "utf8")).toBe(
      MAX_SESSION_PERMISSION_RULE_UTF8_BYTES + 1,
    );

    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(buckets([exact]))
    ).not.toThrow();
    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(buckets([over]))
    ).toThrow(/non-canonical/u);
  });

  test("accepts the exact aggregate byte boundary and rejects one byte more", () => {
    const exact = bucketsAtSerializedBytes(
      MAX_SESSION_PERMISSION_RULE_BUCKETS_UTF8_BYTES,
    );
    const over = bucketsAtSerializedBytes(
      MAX_SESSION_PERMISSION_RULE_BUCKETS_UTF8_BYTES + 1,
    );

    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(exact)
    ).not.toThrow();
    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(over)
    ).toThrow(/aggregate UTF-8 bytes/u);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a missing bucket", { allow: [], deny: [] }],
    ["an extra bucket", { allow: [], deny: [], ask: [], audit: [] }],
    ["a non-array bucket", { allow: "FileRead", deny: [], ask: [] }],
    ["a non-string rule", buckets([42])],
    ["an empty rule", buckets([""])],
    ["a duplicate rule", buckets(["FileRead", "FileRead"])],
    ["a normalized whole-tool wildcard", buckets(["system.bash(*)"])],
    ["an unmatched opening parenthesis", buckets(["system.bash(git"])],
    ["an unmatched closing parenthesis", buckets(["system.bash)"])],
    ["leading rule whitespace", buckets([" FileRead"])],
  ])("rejects malformed input: %s", (_label, value) => {
    expect(() =>
      validateCanonicalSessionPermissionRuleBuckets(value)
    ).toThrow();
  });
});
