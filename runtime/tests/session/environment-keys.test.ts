import { describe, expect, it } from "vitest";

import {
  CANONICAL_SESSION_ENV_KEYS,
  SESSION_CREDENTIAL_ENV_PREFIX,
  canonicalSessionEnvironmentKeys,
  isDynamicSessionCredentialEnvironmentKey,
} from "../../src/session/environment.js";

describe("isDynamicSessionCredentialEnvironmentKey", () => {
  it("accepts only the dedicated uppercase credential prefix plus a suffix", () => {
    expect(isDynamicSessionCredentialEnvironmentKey("AGENC_CREDENTIAL_FOO")).toBe(
      true,
    );
    expect(
      isDynamicSessionCredentialEnvironmentKey("AGENC_CREDENTIAL_FOO_BAR"),
    ).toBe(true);
    expect(isDynamicSessionCredentialEnvironmentKey("AGENC_CREDENTIAL_A1")).toBe(
      true,
    );
  });

  it("rejects missing suffixes, lowercase, and unrelated keys", () => {
    expect(isDynamicSessionCredentialEnvironmentKey(SESSION_CREDENTIAL_ENV_PREFIX))
      .toBe(false);
    expect(isDynamicSessionCredentialEnvironmentKey("AGENC_CREDENTIAL_foo")).toBe(
      false,
    );
    expect(
      isDynamicSessionCredentialEnvironmentKey("agenc_credential_FOO"),
    ).toBe(false);
    expect(isDynamicSessionCredentialEnvironmentKey("AGENC_MODEL")).toBe(false);
    expect(isDynamicSessionCredentialEnvironmentKey("PATH")).toBe(false);
    expect(isDynamicSessionCredentialEnvironmentKey("")).toBe(false);
  });
});

describe("canonicalSessionEnvironmentKeys", () => {
  it("always starts with the static daemon client surface", () => {
    const keys = canonicalSessionEnvironmentKeys();
    expect(keys.slice(0, CANONICAL_SESSION_ENV_KEYS.length)).toEqual([
      ...CANONICAL_SESSION_ENV_KEYS,
    ]);
    expect(keys).toContain("AGENC_MODEL");
    expect(keys).toContain("AGENC_PROVIDER");
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it("adds present MCP credential keys, sorted and de-duplicated", () => {
    const keys = canonicalSessionEnvironmentKeys(
      {
        AGENC_CREDENTIAL_ZETA: "a",
        HOME: "/home/other",
        AGENC_CREDENTIAL_foo: "x",
      },
      { AGENC_CREDENTIAL_ALPHA: "b", AGENC_CREDENTIAL_ZETA: "c" },
    );
    const dynamic = keys.slice(CANONICAL_SESSION_ENV_KEYS.length);
    expect(dynamic).toEqual(["AGENC_CREDENTIAL_ALPHA", "AGENC_CREDENTIAL_ZETA"]);
    expect(keys).not.toContain("HOME");
    expect(keys).not.toContain("AGENC_CREDENTIAL_foo");
  });
});
