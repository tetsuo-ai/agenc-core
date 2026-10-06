import { describe, expect, it } from "vitest";
import {
  redactLiteralSecrets,
  redactLiteralSecretsHoldingPrefix,
} from "../../src/utils/redact-literal-secrets.js";

describe("redactLiteralSecrets", () => {
  const secret = 'credential-private"phrase\\tail';

  it("redacts a secret that JSON serialization escaped, one and two levels deep", () => {
    const once = JSON.stringify({ headers: { "X-Service-Credential": secret } });
    const twice = JSON.stringify({ message: once });
    for (const text of [once, twice]) {
      const redacted = redactLiteralSecrets(text, [secret]);
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain("credential-private");
      expect(redacted).not.toContain("phrase");
    }
  });

  it("still redacts the raw literal and leaves other text alone", () => {
    expect(redactLiteralSecrets(`token=${secret}; next`, [secret])).toBe("token=[REDACTED]; next");
    expect(redactLiteralSecrets("nothing here", [secret])).toBe("nothing here");
  });
});

describe("redactLiteralSecretsHoldingPrefix", () => {
  it("holds a shorter complete secret while a longer secret could still be arriving", () => {
    const secrets = ["credential-private", "credential-private-\u00e9-phrase"];
    expect(redactLiteralSecretsHoldingPrefix("startup: credential-private", secrets)).toEqual({
      redacted: "startup: ",
      pending: "credential-private",
    });
    expect(redactLiteralSecrets("credential-private-\u00e9-phrase\n", secrets)).toBe("[REDACTED]\n");
  });

  it("holds a complete match that the pending tail would otherwise split", () => {
    expect(redactLiteralSecretsHoldingPrefix("xx abab", ["abab"])).toEqual({ redacted: "xx ", pending: "abab" });
  });

  it("redacts a complete secret before holding the start of its next occurrence", () => {
    expect(redactLiteralSecretsHoldingPrefix("credential-private-phrase credential-pri", ["credential-private-phrase"])).toEqual({
      redacted: "[REDACTED] ",
      pending: "credential-pri",
    });
  });

  it("holds the longest raw or JSON-escaped trailing prefix", () => {
    const secret = 'credential-private"phrase\\tail';
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(redactLiteralSecretsHoldingPrefix(`before ${escaped.slice(0, -4)}`, [secret])).toEqual({
      redacted: "before ",
      pending: escaped.slice(0, -4),
    });
    expect(redactLiteralSecretsHoldingPrefix("before credential-priv", [secret])).toEqual({
      redacted: "before ",
      pending: "credential-priv",
    });
    const twice = JSON.stringify(escaped).slice(1, -1);
    expect(redactLiteralSecretsHoldingPrefix(`before ${twice.slice(0, -4)}`, [secret])).toEqual({
      redacted: "before ",
      pending: twice.slice(0, -4),
    });
    expect(redactLiteralSecretsHoldingPrefix("abcd", ["abcdxx", "bcdyyy"])).toEqual({
      redacted: "",
      pending: "abcd",
    });
  });

  it("redacts overlapping secrets while retaining a later incomplete match", () => {
    expect(redactLiteralSecretsHoldingPrefix("abcde fg", ["abcde", "cdefg", "fghij"])).toEqual({
      redacted: "[REDACTED] ",
      pending: "fg",
    });
    expect(redactLiteralSecretsHoldingPrefix("abcdefgh fgh", ["abcde", "defgh", "fghij"])).toEqual({
      redacted: "[REDACTED] ",
      pending: "fgh",
    });
  });
});
