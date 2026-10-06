import { describe, expect, it } from "vitest";
import { createMemoizedSecretRedactor, redactSecretsInValue } from "../../src/secrets/sanitizer.js";
import { canonicalRedactionFixtures } from "./canonical-redaction-corpus.js";

describe("caller-owned secret redaction reuse", () => {
  it.each(canonicalRedactionFixtures)("preserves canonical redaction on repeated input: $name", ({ input, expected }) => {
    const redact = createMemoizedSecretRedactor();
    expect(redact(input)).toBe(expected);
    expect(redact(input)).toBe(expected);
  });

  it("rechecks sensitive keys and mutated nested values without reusing object results", () => {
    const redact = createMemoizedSecretRedactor();
    const clean = "ordinary sentence with enough characters to be reused";
    const value: Record<string, unknown> = { content: clean, nested: [clean] };
    const first = redact(value);
    expect(first).toEqual(value);
    first.content = "caller mutation";
    value.api_key = clean;
    value.nested = ["password=" + "a".repeat(32)];
    expect(redact(value)).toEqual(redactSecretsInValue(value));
    expect(value.content).toBe(clean);
    expect(redact({ content: clean }).content).toBe(clean);
  });

  it("preserves aliases and cycles within each fresh traversal", () => {
    const redact = createMemoizedSecretRedactor();
    const child = { content: "ordinary repeated non-secret content for this record" };
    const value: Record<string, unknown> = { left: child, right: child };
    value.self = value;
    const a = redact(value), b = redact(value);
    expect(a.self).toBe(a);
    expect(a.left).toBe(a.right);
    expect(b.left).toBe(b.right);
    expect(b).not.toBe(a);
    expect(b.left).not.toBe(a.left);
  });

  it("keeps exact-string semantics across same-length edits and cache churn", () => {
    const redact = createMemoizedSecretRedactor();
    const secret = "password=" + "a".repeat(40);
    const clean = "ordinary words ".repeat(4).slice(0, secret.length);
    expect(clean.length).toBe(secret.length);
    expect(redact(clean)).toBe(clean);
    expect(redact(secret)).toBe(redactSecretsInValue(secret));
    for (let i = 0; i < 600; i++) {
      const value = `${i}: ordinary words `.repeat(100);
      expect(redact(value)).toBe(redactSecretsInValue(value));
    }
    expect(redact(clean)).toBe(clean);
    const oversized = "ordinary words ".repeat(3_000);
    expect(redact(oversized)).toBe(redactSecretsInValue(oversized));
  });
});
