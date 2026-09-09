import { describe, expect, test } from "vitest";

import {
  migrateRetiredOpenAiCredential,
  OpenAiCredentialMigrationError,
} from "../../src/config/openai-credential-migration.js";

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function chatgptAccountJwt(accountId: string): string {
  return unsignedJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

describe("migrateRetiredOpenAiCredential", () => {
  test.each([
    [undefined],
    [null],
    ["not-an-object"],
    [[]],
  ])("rejects non-object retired record %j", (value) => {
    expect(() => migrateRetiredOpenAiCredential(value, undefined)).toThrow(
      expect.objectContaining({
        name: "OpenAiCredentialMigrationError",
        field: "agenc",
        message: "Retired native OpenAI credentials are not an object.",
      }),
    );
  });

  test("rejects unknown fields instead of dropping them", () => {
    expect(() =>
      migrateRetiredOpenAiCredential(
        { apiKey: "retired-api-key", extra: "drop-me" },
        undefined,
      ),
    ).toThrow(/unsupported fields/u);
  });

  test.each([
    [{ apiKey: "   " }],
    [{ accessToken: "" }],
    [{ refreshToken: 1 }],
    [{ idToken: false }],
    [{ accountId: "\t" }],
    [{ lastRefreshAt: -1 }],
    [{ lastRefreshFailureAt: Number.POSITIVE_INFINITY }],
  ])("rejects malformed field set %j", (value) => {
    expect(() => migrateRetiredOpenAiCredential(value, undefined)).toThrow(
      /malformed/u,
    );
  });

  test("rejects a record with no usable platform or ChatGPT credential", () => {
    expect(() =>
      migrateRetiredOpenAiCredential({ refreshToken: "retired-refresh" }, undefined),
    ).toThrow(/no usable platform or ChatGPT credential/u);
    expect(() =>
      migrateRetiredOpenAiCredential(
        { accessToken: "retired-access-token" },
        undefined,
      ),
    ).toThrow(/no usable platform or ChatGPT credential/u);
  });

  test("imports a platform key and discards the unused profile link", () => {
    const migrated = migrateRetiredOpenAiCredential(
      {
        apiKey: " retired-api-key ",
        profileId: "discarded-profile-link",
        lastRefreshAt: 1_700_000_000,
      },
      undefined,
    );
    expect(migrated).toEqual({
      apiKey: "retired-api-key",
      lastRefreshAt: 1_700_000_000,
      authMode: "apiKey",
    });
    expect(migrated).not.toHaveProperty("profileId");
  });

  test("derives ChatGPT account identity from the access token JWT", () => {
    const accessToken = chatgptAccountJwt("acct-from-access");
    const migrated = migrateRetiredOpenAiCredential(
      { accessToken, refreshToken: "retired-refresh" },
      undefined,
    );
    expect(migrated).toEqual({
      accessToken,
      refreshToken: "retired-refresh",
      accountId: "acct-from-access",
      authMode: "chatgpt",
    });
  });

  test("prefers an explicit account id over a JWT claim", () => {
    const accessToken = chatgptAccountJwt("acct-from-access");
    const migrated = migrateRetiredOpenAiCredential(
      {
        accessToken,
        accountId: "acct-explicit",
      },
      undefined,
    );
    expect(migrated.accountId).toBe("acct-explicit");
    expect(migrated.authMode).toBe("chatgpt");
  });

  test("merges when the current vault already holds the same values", () => {
    const current = {
      apiKey: "retired-api-key",
      accessToken: "retired-access-token",
      accountId: "acct-openai",
      authMode: "apiKey" as const,
    };
    expect(
      migrateRetiredOpenAiCredential(
        {
          apiKey: "retired-api-key",
          accessToken: "retired-access-token",
          accountId: "acct-openai",
        },
        current,
      ),
    ).toEqual(current);
  });

  test("refuses a field conflict with the current vault", () => {
    expect(() =>
      migrateRetiredOpenAiCredential(
        { apiKey: "retired-api-key" },
        { apiKey: "canonical-api-key", authMode: "apiKey" },
      ),
    ).toThrow(/conflict with openAiOauth\.apiKey/u);
  });

  test("refuses an authMode conflict when the imported record would switch modes", () => {
    expect(() =>
      migrateRetiredOpenAiCredential(
        { apiKey: "retired-api-key" },
        {
          accessToken: "retired-access-token",
          accountId: "acct-openai",
          authMode: "chatgpt",
        },
      ),
    ).toThrow(/conflict with openAiOauth\.authMode/u);
  });
});
