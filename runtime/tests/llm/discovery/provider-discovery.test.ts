import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AuthBackend, AuthSubscriptionTier } from "../../auth/backend.js";
import { LocalAuthBackend } from "../../auth/backends/local.js";
import { resolveHomeContext } from "../../config/home.js";
import { defaultConfig } from "../../config/schema.js";
import {
  clearXaiOauthCredentials,
  saveXaiOauthCredentials,
} from "../../utils/xaiOauthCredentials.js";
import {
  clearOpenAiOauthCredentials,
  saveOpenAiOauthCredentials,
} from "../../utils/openAiOauthCredentials.js";
import {
  collectProviderAvailability,
  formatProviderAvailabilityReport,
} from "./provider-discovery.js";

type CredentialFieldRole =
  | "apiKey"
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken"
  | "region";

function environmentCredentialProvenance(
  ...fields: ReadonlyArray<
    readonly [role: CredentialFieldRole, envVar: string]
  >
): {
  readonly kind: "environment";
  readonly fields: readonly {
    readonly role: CredentialFieldRole;
    readonly envVar: string;
  }[];
} {
  return {
    kind: "environment",
    fields: fields.map(([role, envVar]) => ({ role, envVar })),
  };
}

function authBackend(
  kind: "local" | "remote",
  tier: AuthSubscriptionTier,
  overrides: Partial<
    Pick<AuthBackend, "vendKey" | "inferAgencModel" | "getSubscriptionTier">
  > = {},
): AuthBackend {
  return {
    kind,
    login: () => ({
      authenticated: true,
      provider: kind,
    }),
    logout: () => ({ authenticated: false }),
    whoami: () => ({
      authenticated: true,
      provider: kind,
    }),
    vendKey: overrides.vendKey ?? ((provider, sessionId) => ({
      kind: "api-key",
      provider,
      sessionId,
      apiKey: "managed-key",
    })),
    inferAgencModel: overrides.inferAgencModel ?? (() => ({
      provider: "grok",
      model: "grok-4.3",
    })),
    getSubscriptionTier: overrides.getSubscriptionTier ?? (() => tier),
  };
}

function byProvider<T extends { readonly provider: string }>(
  entries: readonly T[],
): Map<string, T> {
  return new Map(entries.map((entry) => [entry.provider, entry]));
}

describe("provider discovery", () => {
  it("detects BYOK keys, local model servers, and missing hosted keys", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const authHeader = new Headers(init?.headers).get("authorization");
      if (url === "http://localhost:11434/api/tags") {
        return new Response("{}", { status: 200 });
      }
      if (url === "http://localhost:1234/v1/models") {
        return new Response("{}", {
          status: authHeader === "Bearer studio-key" ? 200 : 401,
        });
      }
      return new Response("{}", { status: 404 });
    });

    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      config: defaultConfig(),
      env: {
        OPENAI_API_KEY: "   ",
        XAI_API_KEY: "xai-key",
        LMSTUDIO_API_KEY: "studio-key",
      },
      fetchImpl,
    });
    const entries = byProvider(report.entries);

    expect(report).toMatchObject({
      authBackendKind: "local",
      subscriptionTier: "free",
    });
    expect(entries.get("grok")).toMatchObject({
      usable: true,
      credentialStatus: "present",
    });
    expect(entries.get("grok")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "XAI_API_KEY"]),
    );
    expect(entries.get("anthropic")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
    });
    expect(entries.get("anthropic")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("openai")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
    });
    expect(entries.get("openai")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("ollama")).toMatchObject({
      usable: true,
      credentialStatus: "not-required",
      localStatus: "up",
    });
    expect(entries.get("ollama")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("lmstudio")).toMatchObject({
      usable: true,
      credentialStatus: "present",
      localStatus: "up",
    });
    expect(entries.get("lmstudio")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "LMSTUDIO_API_KEY"]),
    );
  });

  it("detects subscription-managed provider keys", async () => {
    const calls: string[] = [];
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        vendKey: (provider, sessionId) => {
          calls.push(`${provider}:${sessionId}`);
          return {
            kind: "api-key" as const,
            provider,
            sessionId,
            apiKey: `managed-${provider}`,
          };
        },
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const entries = byProvider(report.entries);

    // Managed subscription vending is OpenRouter-only. Other remote providers
    // remain explicit BYOK routes.
    expect(entries.get("openrouter")).toMatchObject({
      usable: true,
      credentialStatus: "managed",
      subscriptionTier: "team",
    });
    expect(entries.get("openai")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
      subscriptionTier: "team",
    });
    expect(entries.get("agenc")).toMatchObject({
      usable: true,
      credentialStatus: "not-required",
      subscriptionTier: "team",
    });
    expect(calls).toContain("openrouter:cli");
    expect(calls).not.toContain("openai:cli");
  });

  it("rejects a non-API-key credential from managed API-key discovery", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        vendKey: (provider, sessionId) => ({
          kind: "aws-sigv4",
          provider,
          sessionId,
          accessKeyId: "managed-access",
          secretAccessKey: "managed-secret",
        }),
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const openrouter = byProvider(report.entries).get("openrouter");

    expect(openrouter).toMatchObject({
      usable: false,
      credentialStatus: "unavailable",
    });
    expect(openrouter?.detail).toContain(
      "expected api-key credential for openrouter, received aws-sigv4",
    );
  });

  it("uses runtime local-provider env resolution for probe URLs", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      requestedUrls.push(String(input));
      return new Response("{}", { status: 200 });
    });

    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      config: defaultConfig(),
      env: {
        OLLAMA_BASE_URL: "http://10.0.0.5:11434/v1",
      },
      fetchImpl,
    });
    const entries = byProvider(report.entries);

    expect(entries.get("ollama")).toMatchObject({
      usable: true,
      localStatus: "up",
      localUrl: "http://10.0.0.5:11434/api/tags",
    });
    expect(requestedUrls).toContain("http://10.0.0.5:11434/api/tags");
  });

  it("reports the actual env aliases that supplied provider keys", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: {
        GROK_API_KEY: "grok-key",
        OPENAI_API_KEY: "shared-local-key",
        GOOGLE_API_KEY: "google-key",
        MISTRAL_API_KEY: "mistral-key",
        NVIDIA_API_KEY: "nvidia-key",
        MINIMAX_API_KEY: "minimax-key",
        GH_TOKEN: "github-key",
      },
    });
    const entries = byProvider(report.entries);

    expect(entries.get("grok")).toMatchObject({
      usable: true,
      credentialStatus: "present",
    });
    expect(entries.get("grok")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "GROK_API_KEY"]),
    );
    expect(entries.get("lmstudio")).toMatchObject({
      credentialStatus: "optional",
    });
    expect(entries.get("lmstudio")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("openai-compatible")).toMatchObject({
      credentialStatus: "present",
    });
    expect(entries.get("openai-compatible")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "OPENAI_API_KEY"]),
    );
    expect(entries.get("mistral")).toMatchObject({
      credentialStatus: "present",
    });
    expect(entries.get("mistral")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "MISTRAL_API_KEY"]),
    );
    expect(entries.get("nvidia-nim")).toMatchObject({
      credentialStatus: "present",
    });
    expect(entries.get("nvidia-nim")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "NVIDIA_API_KEY"]),
    );
    expect(entries.get("minimax")).toMatchObject({
      credentialStatus: "present",
    });
    expect(entries.get("minimax")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "MINIMAX_API_KEY"]),
    );
    expect(entries.get("gemini")).toMatchObject({
      credentialStatus: "present",
    });
    expect(entries.get("gemini")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "GOOGLE_API_KEY"]),
    );
    expect(entries.get("github")).toMatchObject({
      credentialStatus: "present",
    });
    expect(entries.get("github")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "GH_TOKEN"]),
    );
  });

  it("projects forced Gemini access-token and ADC plans instead of API-key aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-provider-gemini-plan-"));
    const adcPath = join(root, "application-default.json");
    writeFileSync(adcPath, "{}", { mode: 0o600 });
    try {
      const accessTokenReport = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env: {
          GEMINI_AUTH_MODE: "access-token",
          GEMINI_ACCESS_TOKEN: "gemini-access-token",
          GEMINI_API_KEY: "must-not-win",
          GEMINI_PROJECT_ID: "authority-project",
          GEMINI_VERTEX_LOCATION: "us-central1",
        },
      });
      expect(byProvider(accessTokenReport.entries).get("gemini")).toMatchObject({
        usable: true,
        credentialStatus: "present",
        detail: "Gemini credential found via GEMINI_ACCESS_TOKEN",
      });

      const adcReport = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env: {
          GEMINI_AUTH_MODE: "adc",
          GOOGLE_APPLICATION_CREDENTIALS: adcPath,
          GOOGLE_API_KEY: "must-not-win",
          GEMINI_PROJECT_ID: "authority-project",
          GEMINI_VERTEX_LOCATION: "global",
        },
      });
      expect(byProvider(adcReport.entries).get("gemini")).toMatchObject({
        usable: true,
        credentialStatus: "present",
        detail: "Gemini credential found via GOOGLE_APPLICATION_CREDENTIALS",
      });

      const missingForcedReport = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env: {
          GEMINI_AUTH_MODE: "access-token",
          GEMINI_API_KEY: "must-not-fallback",
          GEMINI_PROJECT_ID: "authority-project",
          GEMINI_VERTEX_LOCATION: "us-central1",
        },
      });
      expect(byProvider(missingForcedReport.entries).get("gemini")).toMatchObject({
        usable: false,
        credentialStatus: "missing",
        detail: "set GEMINI_ACCESS_TOKEN",
      });

      const missingTargetReport = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env: {
          GEMINI_AUTH_MODE: "access-token",
          GEMINI_ACCESS_TOKEN: "token-without-vertex-target",
        },
      });
      expect(byProvider(missingTargetReport.entries).get("gemini")).toMatchObject({
        usable: false,
        credentialStatus: "unavailable",
        detail: expect.stringContaining("requires both project and location"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the saved Gemini BYOK selected by the canonical credential plan", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-provider-gemini-byok-"));
    const env = { AGENC_HOME: agencHome, GEMINI_AUTH_MODE: "api-key" };
    try {
      await new LocalAuthBackend({ agencHome, env }).saveByokKey({
        provider: "gemini",
        apiKey: "saved-gemini-key",
      });
      const report = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env,
      });

      expect(byProvider(report.entries).get("gemini")).toMatchObject({
        usable: true,
        credentialStatus: "present",
        detail: "Gemini credential found via saved Gemini BYOK",
      });
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it("reports a saved BYOK key for a non-Gemini provider", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-provider-saved-byok-"));
    const env = { AGENC_HOME: agencHome };
    try {
      await new LocalAuthBackend({ agencHome, env }).saveByokKey({
        provider: "anthropic",
        apiKey: "saved-anthropic-key",
      });
      const report = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env,
      });

      expect(byProvider(report.entries).get("anthropic")).toMatchObject({
        usable: true,
        credentialStatus: "present",
        detail: "BYOK credential found via saved BYOK",
      });
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it("reports Grok Composer as keyless through the canonical authority", async () => {
    const baseConfig = defaultConfig();
    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: {
        ...baseConfig,
        providers: {
          ...baseConfig.providers,
          grok: {
            ...baseConfig.providers?.grok,
            default_model: "grok-composer-2.5-fast",
          },
        },
      },
      env: {},
    });

    expect(byProvider(report.entries).get("grok")).toMatchObject({
      model: "grok-composer-2.5-fast",
      usable: true,
      credentialStatus: "not-required",
      detail: "available",
    });
  });

  it("reports OpenAI sign-in from the discovery HomeContext", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-provider-openai-sign-in-"));
    const env = {
      AGENC_HOME: join(root, "state"),
      HOME: join(root, "unrelated-home"),
    };
    const home = resolveHomeContext(env, { platformHome: root });
    try {
      expect(
        saveOpenAiOauthCredentials(home, {
          accessToken: "openai-subscription-token",
          accountId: "openai-account",
        }).success,
      ).toBe(true);

      const report = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env,
      });

      expect(byProvider(report.entries).get("openai")).toMatchObject({
        usable: true,
        credentialStatus: "present",
        detail: "OpenAI sign-in credential found",
      });
    } finally {
      clearOpenAiOauthCredentials(home);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks a configured OpenAI endpoint against stored sign-in credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-provider-openai-endpoint-"));
    const env = { AGENC_HOME: join(root, "state") };
    const home = resolveHomeContext(env, { platformHome: root });
    const baseConfig = defaultConfig();
    const config = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        openai: {
          ...baseConfig.providers?.openai,
          base_url: "https://gateway.example/v1",
        },
      },
    };
    try {
      expect(
        saveOpenAiOauthCredentials(home, {
          apiKey: "stored-openai-platform-key",
        }).success,
      ).toBe(true);

      const report = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config,
        env,
      });

      expect(byProvider(report.entries).get("openai")).toMatchObject({
        usable: false,
        credentialStatus: "unavailable",
        detail: expect.stringContaining(
          "bound to the first-party OpenAI endpoint",
        ),
      });
    } finally {
      clearOpenAiOauthCredentials(home);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports OAuth provenance when OAuth wins over grok BYOK aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-provider-oauth-"));
    const env = {
      AGENC_HOME: join(root, "home"),
      HOME: root,
      XAI_API_KEY: "xai-byok-key",
      GROK_API_KEY: "grok-byok-key",
    };
    const home = resolveHomeContext(env, { platformHome: root });

    try {
      expect(
        saveXaiOauthCredentials(home, {
          accessToken: "xai-oauth-token",
          accountLabel: "oauth@example.test",
          expiresAt: Date.now() + 60_000,
        }).success,
      ).toBe(true);

      const report = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env,
      });
      const grok = byProvider(report.entries).get("grok");

      expect(grok).toMatchObject({
        usable: true,
        credentialStatus: "present",
        detail: "xAI OAuth credential found",
      });
      expect(grok?.credentialProvenance).toEqual({
        kind: "oauth",
        provider: "grok",
      });
      expect(grok?.detail).not.toContain("BYOK");
    } finally {
      clearXaiOauthCredentials(home);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat shared credentials as hosted provider credentials", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: {
        OPENAI_API_KEY: "shared-local-key",
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
      },
    });
    const entries = byProvider(report.entries);

    expect(entries.get("openai")).toMatchObject({
      usable: true,
      credentialStatus: "present",
    });
    expect(entries.get("openai")?.credentialProvenance).toEqual(
      environmentCredentialProvenance(["apiKey", "OPENAI_API_KEY"]),
    );
    expect(entries.get("mistral")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
      detail: "set MISTRAL_API_KEY",
    });
    expect(entries.get("mistral")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("nvidia-nim")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
      detail: "set NVIDIA_API_KEY",
    });
    expect(entries.get("nvidia-nim")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("minimax")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
      detail: "set MINIMAX_API_KEY",
    });
    expect(entries.get("minimax")).not.toHaveProperty("credentialProvenance");
    expect(entries.get("github")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
      detail: "set GITHUB_TOKEN or GH_TOKEN",
    });
    expect(entries.get("github")).not.toHaveProperty("credentialProvenance");
  });

  it.each([
    {
      name: "no credentials",
      env: {},
      usable: false,
      credentialStatus: "missing",
      detail:
        "set AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID and AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      provenance: undefined,
    },
    {
      name: "access-only generic alias",
      env: { AWS_ACCESS_KEY_ID: "aws-access" },
      usable: false,
      credentialStatus: "missing",
      detail:
        "set AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      provenance: environmentCredentialProvenance([
        "accessKeyId",
        "AWS_ACCESS_KEY_ID",
      ]),
    },
    {
      name: "secret-only Bedrock alias",
      env: { AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret" },
      usable: false,
      credentialStatus: "missing",
      detail: "set AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID",
      provenance: environmentCredentialProvenance([
        "secretAccessKey",
        "AWS_BEDROCK_SECRET_ACCESS_KEY",
      ]),
    },
    {
      name: "Bedrock aliases",
      env: {
        AWS_BEDROCK_ACCESS_KEY_ID: "aws-access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret",
      },
      usable: true,
      credentialStatus: "present",
      detail:
        "BYOK credential found via AWS_BEDROCK_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY",
      provenance: environmentCredentialProvenance(
        ["accessKeyId", "AWS_BEDROCK_ACCESS_KEY_ID"],
        ["secretAccessKey", "AWS_BEDROCK_SECRET_ACCESS_KEY"],
      ),
    },
    {
      name: "Bedrock access and generic secret aliases",
      env: {
        AWS_BEDROCK_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
      usable: true,
      credentialStatus: "present",
      detail:
        "BYOK credential found via AWS_BEDROCK_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
      provenance: environmentCredentialProvenance(
        ["accessKeyId", "AWS_BEDROCK_ACCESS_KEY_ID"],
        ["secretAccessKey", "AWS_SECRET_ACCESS_KEY"],
      ),
    },
    {
      name: "generic access and Bedrock secret aliases with optional fields",
      env: {
        AWS_ACCESS_KEY_ID: "aws-access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret",
        AWS_SESSION_TOKEN: "aws-session",
        AWS_DEFAULT_REGION: "us-west-2",
      },
      usable: true,
      credentialStatus: "present",
      detail:
        "BYOK credential found via AWS_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY + AWS_SESSION_TOKEN + AWS_DEFAULT_REGION",
      provenance: environmentCredentialProvenance(
        ["accessKeyId", "AWS_ACCESS_KEY_ID"],
        ["secretAccessKey", "AWS_BEDROCK_SECRET_ACCESS_KEY"],
        ["sessionToken", "AWS_SESSION_TOKEN"],
        ["region", "AWS_DEFAULT_REGION"],
      ),
    },
    {
      name: "generic aliases",
      env: {
        AWS_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
      usable: true,
      credentialStatus: "present",
      detail:
        "BYOK credential found via AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
      provenance: environmentCredentialProvenance(
        ["accessKeyId", "AWS_ACCESS_KEY_ID"],
        ["secretAccessKey", "AWS_SECRET_ACCESS_KEY"],
      ),
    },
  ])(
    "resolves the Bedrock credential matrix: $name",
    async ({ env, usable, credentialStatus, detail, provenance }) => {
      const report = await collectProviderAvailability({
        authBackend: authBackend("local", "free"),
        checkLocal: false,
        config: defaultConfig(),
        env,
      });
      const bedrock = byProvider(report.entries).get("amazon-bedrock");

      expect(bedrock).toMatchObject({ usable, credentialStatus, detail });
      if (provenance === undefined) {
        expect(bedrock).not.toHaveProperty("credentialProvenance");
      } else {
        expect(bedrock?.credentialProvenance).toEqual(provenance);
      }
    },
  );

  it("formats the discovery report for the providers CLI", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: { OPENAI_API_KEY: "openai-key" },
    });

    const text = formatProviderAvailabilityReport(report);

    expect(text).toContain("Auth: local; subscription: free");
    expect(text).toMatch(
      /Provider\s+Model\s+Usable\s+Credential\s+Local\s+Tier\s+Detail/u,
    );
    expect(text).not.toMatch(/Provider\s+Model\s+Usable\s+Key\s+Local/u);
    expect(text).toContain("openai");
    expect(text).toContain("present(OPENAI_API_KEY)");
  });
});
