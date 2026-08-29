import { describe, expect, test } from "vitest";

import {
  redactSecretValueForDisplay,
  SECRET_ENV_KEYS,
} from "../../src/utils/providerSecrets.js";

describe("provider secret inventory", () => {
  test("redacts arbitrary Anthropic bearer tokens by their canonical source", () => {
    const token = "opaque-anthropic-bearer";

    expect(SECRET_ENV_KEYS).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(
      redactSecretValueForDisplay(token, {
        ANTHROPIC_AUTH_TOKEN: token,
      }),
    ).toBe("opa...rer");
  });
});
