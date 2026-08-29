import { describe, expect, expectTypeOf, it } from "vitest";

import {
  GROK_OAUTH_CREDENTIAL_PROVENANCE,
  providerCredentialEnvironmentProvenance,
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
  resolveProviderCredentialEnvironment,
} from "./provider-ingress.js";
import { BUILT_IN_PROVIDER_DEFINITIONS } from "./provider-info.js";

describe("provider environment ingress", () => {
  it("resolves every declared key and endpoint alias", () => {
    for (const [provider, definition] of Object.entries(
      BUILT_IN_PROVIDER_DEFINITIONS,
    )) {
      if (definition.credentials.kind === "api-key") {
        for (const envVar of definition.credentials.apiKey.envVars) {
          expect(
            resolveProviderApiKeyEnvironment(provider, {
              [envVar]: `  ${provider}-key  `,
            }),
          ).toEqual({ envVar, value: `${provider}-key` });
        }
      }
      for (const envVar of definition.baseURLEnvVars) {
        expect(
          resolveProviderBaseURLEnvironment(provider, {
            [envVar]: `  https://${provider}.example/v1  `,
          }),
        ).toEqual({ envVar, value: `https://${provider}.example/v1` });
      }
    }
  });

  it("uses registry order and skips empty values", () => {
    expect(
      resolveProviderApiKeyEnvironment("grok", {
        XAI_API_KEY: "  ",
        GROK_API_KEY: " grok-key ",
      }),
    ).toEqual({ envVar: "GROK_API_KEY", value: "grok-key" });
    expect(
      resolveProviderApiKeyEnvironment("gemini", {
        GEMINI_API_KEY: "first",
        GOOGLE_API_KEY: "second",
      }),
    ).toEqual({ envVar: "GEMINI_API_KEY", value: "first" });
    expect(
      resolveProviderBaseURLEnvironment("openai-compatible", {
        OPENAI_COMPATIBLE_BASE_URL: "",
        OPENAI_BASE_URL: "  ",
        OPENAI_API_BASE: " https://compatible.example/v1 ",
      }),
    ).toEqual({
      envVar: "OPENAI_API_BASE",
      value: "https://compatible.example/v1",
    });
  });

  it("treats the literal undefined sentinel as absent and falls back", () => {
    expect(
      resolveProviderApiKeyEnvironment("grok", {
        XAI_API_KEY: " undefined ",
        GROK_API_KEY: " grok-key ",
      }),
    ).toEqual({ envVar: "GROK_API_KEY", value: "grok-key" });
    expect(
      resolveProviderBaseURLEnvironment("openai", {
        OPENAI_BASE_URL: "UNDEFINED",
        OPENAI_API_BASE: " https://openai.example/v1 ",
      }),
    ).toEqual({
      envVar: "OPENAI_API_BASE",
      value: "https://openai.example/v1",
    });
  });

  it("resolves the complete ordered Bedrock SigV4 credential set", () => {
    const resolution = resolveProviderCredentialEnvironment("amazon-bedrock", {
      AWS_BEDROCK_ACCESS_KEY_ID: "undefined",
      AWS_ACCESS_KEY_ID: " fallback-access ",
      AWS_BEDROCK_SECRET_ACCESS_KEY: " UNDEFINED ",
      AWS_SECRET_ACCESS_KEY: " fallback-secret ",
      AWS_BEDROCK_SESSION_TOKEN: "undefined",
      AWS_SESSION_TOKEN: " fallback-session ",
      AWS_BEDROCK_REGION: "undefined",
      AWS_REGION: " ca-central-1 ",
      AWS_DEFAULT_REGION: "us-east-1",
    });

    expect(resolution).toEqual({
      kind: "aws-sigv4",
      accessKeyId: {
        role: "accessKeyId",
        envVar: "AWS_ACCESS_KEY_ID",
        value: "fallback-access",
      },
      secretAccessKey: {
        role: "secretAccessKey",
        envVar: "AWS_SECRET_ACCESS_KEY",
        value: "fallback-secret",
      },
      sessionToken: {
        role: "sessionToken",
        envVar: "AWS_SESSION_TOKEN",
        value: "fallback-session",
      },
      region: {
        role: "region",
        envVar: "AWS_REGION",
        value: "ca-central-1",
      },
      sources: [
        {
          role: "accessKeyId",
          envVar: "AWS_ACCESS_KEY_ID",
          value: "fallback-access",
        },
        {
          role: "secretAccessKey",
          envVar: "AWS_SECRET_ACCESS_KEY",
          value: "fallback-secret",
        },
        {
          role: "sessionToken",
          envVar: "AWS_SESSION_TOKEN",
          value: "fallback-session",
        },
        {
          role: "region",
          envVar: "AWS_REGION",
          value: "ca-central-1",
        },
      ],
      missingRequired: [],
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution?.sources)).toBe(true);
    expect(Object.isFrozen(resolution?.missingRequired)).toBe(true);
    expect(
      resolveProviderApiKeyEnvironment("amazon-bedrock", {
        AWS_ACCESS_KEY_ID: "fallback-access",
      }),
    ).toBeUndefined();
  });

  it("reports each missing required Bedrock field without requiring a session token", () => {
    expect(
      resolveProviderCredentialEnvironment("amazon-bedrock", {
        AWS_BEDROCK_ACCESS_KEY_ID: "access",
      }),
    ).toMatchObject({
      kind: "aws-sigv4",
      missingRequired: [
        {
          role: "secretAccessKey",
          envVars: [
            "AWS_BEDROCK_SECRET_ACCESS_KEY",
            "AWS_SECRET_ACCESS_KEY",
          ],
        },
      ],
    });
    const missingAccess = resolveProviderCredentialEnvironment(
      "amazon-bedrock",
      {
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      },
    );
    expect(missingAccess).toMatchObject({
      kind: "aws-sigv4",
      missingRequired: [
        {
          role: "accessKeyId",
          envVars: ["AWS_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
        },
      ],
    });
    expect(Object.isFrozen(missingAccess?.missingRequired[0])).toBe(true);
    expect(Object.isFrozen(missingAccess?.missingRequired[0]?.envVars)).toBe(
      true,
    );
    expect(
      resolveProviderCredentialEnvironment("amazon-bedrock", {
        AWS_BEDROCK_ACCESS_KEY_ID: "access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      }),
    ).toMatchObject({
      kind: "aws-sigv4",
      missingRequired: [],
    });
  });

  it("returns frozen registry-owned requirements for absent API keys", () => {
    const resolution = resolveProviderCredentialEnvironment("grok", {});

    expect(resolution).toEqual({
      kind: "api-key",
      sources: [],
      missingRequired: [
        {
          role: "apiKey",
          envVars: ["XAI_API_KEY", "GROK_API_KEY"],
        },
      ],
    });
    expect(Object.isFrozen(resolution?.missingRequired[0])).toBe(true);
    expect(Object.isFrozen(resolution?.missingRequired[0]?.envVars)).toBe(true);
  });

  it("maps resolved fields to frozen, value-free credential provenance", () => {
    const resolution = resolveProviderCredentialEnvironment("amazon-bedrock", {
      AWS_BEDROCK_ACCESS_KEY_ID: "access-secret",
      AWS_SECRET_ACCESS_KEY: "signing-secret",
      AWS_SESSION_TOKEN: "session-secret",
      AWS_REGION: "ca-central-1",
    });
    if (resolution === undefined) {
      throw new Error("expected Bedrock credential metadata");
    }

    const provenance = providerCredentialEnvironmentProvenance(resolution);
    expect(provenance).toEqual({
      kind: "environment",
      fields: [
        { role: "accessKeyId", envVar: "AWS_BEDROCK_ACCESS_KEY_ID" },
        { role: "secretAccessKey", envVar: "AWS_SECRET_ACCESS_KEY" },
        { role: "sessionToken", envVar: "AWS_SESSION_TOKEN" },
        { role: "region", envVar: "AWS_REGION" },
      ],
    });
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("signing-secret");
    expect(serialized).not.toContain("session-secret");
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(provenance?.fields)).toBe(true);
    expect(Object.isFrozen(provenance?.fields[0])).toBe(true);
  });

  it("omits empty environment provenance and owns the frozen Grok OAuth provenance", () => {
    const empty = resolveProviderCredentialEnvironment("grok", {});
    if (empty === undefined) {
      throw new Error("expected Grok credential metadata");
    }

    expect(providerCredentialEnvironmentProvenance(empty)).toBeUndefined();
    expect(GROK_OAUTH_CREDENTIAL_PROVENANCE).toEqual({
      kind: "oauth",
      provider: "grok",
    });
    expect(Object.isFrozen(GROK_OAUTH_CREDENTIAL_PROVENANCE)).toBe(true);
  });

  it("types credential fields with their exact roles", () => {
    const apiKey = resolveProviderCredentialEnvironment("grok", {
      XAI_API_KEY: "xai-key",
    });
    if (apiKey?.kind !== "api-key") {
      throw new Error("expected API-key credential metadata");
    }
    expectTypeOf(apiKey.apiKey?.role).toEqualTypeOf<"apiKey" | undefined>();
    expectTypeOf(apiKey.missingRequired[0]?.role).toEqualTypeOf<
      "apiKey" | undefined
    >();
    expectTypeOf(apiKey.sources[0]?.role).toEqualTypeOf<
      "apiKey" | undefined
    >();

    const sigV4 = resolveProviderCredentialEnvironment("amazon-bedrock", {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    if (sigV4?.kind !== "aws-sigv4") {
      throw new Error("expected AWS SigV4 credential metadata");
    }
    expectTypeOf(sigV4.accessKeyId?.role).toEqualTypeOf<
      "accessKeyId" | undefined
    >();
    expectTypeOf(sigV4.secretAccessKey?.role).toEqualTypeOf<
      "secretAccessKey" | undefined
    >();
    expectTypeOf(sigV4.sessionToken?.role).toEqualTypeOf<
      "sessionToken" | undefined
    >();
    expectTypeOf(sigV4.region?.role).toEqualTypeOf<"region" | undefined>();
    expectTypeOf(sigV4.missingRequired[0]?.role).toEqualTypeOf<
      "accessKeyId" | "secretAccessKey" | undefined
    >();
    expectTypeOf(sigV4.sources[0]?.role).toEqualTypeOf<
      | "accessKeyId"
      | "secretAccessKey"
      | "sessionToken"
      | "region"
      | undefined
    >();

    const none = resolveProviderCredentialEnvironment("agenc", {});
    if (none?.kind !== "none") {
      throw new Error("expected credential-free metadata");
    }
    expectTypeOf<typeof none.sources[number]>().toEqualTypeOf<never>();
  });

  it("does not leak aliases across providers", () => {
    expect(
      resolveProviderApiKeyEnvironment("lmstudio", {
        OPENAI_API_KEY: "not-an-lm-studio-key",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderBaseURLEnvironment("lmstudio", {
        OPENAI_BASE_URL: "https://not-lm-studio.example/v1",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderApiKeyEnvironment("agenc", {
        AGENC_API_KEY: "managed-auth-not-byok",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderApiKeyEnvironment("unknown", {
        OPENAI_API_KEY: "ignored",
      }),
    ).toBeUndefined();
  });
});
