import { describe, expect, it, vi } from "vitest";

import type { AuthBackend, AuthSubscriptionTier } from "../../auth/backend.js";
import { defaultConfig } from "../../config/schema.js";
import {
  collectProviderAvailability,
  formatProviderAvailabilityReport,
} from "./provider-discovery.js";

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
      keyStatus: "present",
      keyEnvVar: "XAI_API_KEY",
    });
    expect(entries.get("anthropic")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "ANTHROPIC_API_KEY",
    });
    expect(entries.get("openai")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "OPENAI_API_KEY",
    });
    expect(entries.get("ollama")).toMatchObject({
      usable: true,
      keyStatus: "not-required",
      localStatus: "up",
    });
    expect(entries.get("lmstudio")).toMatchObject({
      usable: true,
      keyStatus: "present",
      localStatus: "up",
    });
  });

  it("detects subscription-managed provider keys", async () => {
    const calls: string[] = [];
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        vendKey: (provider, sessionId) => {
          calls.push(`${provider}:${sessionId}`);
          return { provider, sessionId, apiKey: `managed-${provider}` };
        },
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const entries = byProvider(report.entries);

    // Managed subscription vending is OpenRouter-only (b461d139 "use
    // OpenRouter for managed Pro models"); previously-managed providers such
    // as openai now surface as plain BYOK-missing rows.
    expect(entries.get("openrouter")).toMatchObject({
      usable: true,
      keyStatus: "managed",
      subscriptionTier: "team",
    });
    expect(entries.get("openai")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      subscriptionTier: "team",
    });
    expect(entries.get("agenc")).toMatchObject({
      usable: true,
      keyStatus: "not-required",
      subscriptionTier: "team",
    });
    expect(calls).toContain("openrouter:cli");
    expect(calls).not.toContain("openai:cli");
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
        MISTRAL_API_KEY: "mistral-key",
        NVIDIA_API_KEY: "nvidia-key",
        MINIMAX_API_KEY: "minimax-key",
        GITHUB_TOKEN: "github-key",
      },
    });
    const agencAliasReport = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: {
        AGENC_XAI_API_KEY: "agenc-key",
      },
    });
    const entries = byProvider(report.entries);
    const agencAliasEntries = byProvider(agencAliasReport.entries);

    expect(entries.get("grok")).toMatchObject({
      usable: true,
      keyStatus: "present",
      keyEnvVar: "GROK_API_KEY",
    });
    expect(agencAliasEntries.get("grok")).toMatchObject({
      usable: true,
      keyStatus: "present",
      keyEnvVar: "AGENC_XAI_API_KEY",
    });
    expect(entries.get("lmstudio")).toMatchObject({
      keyStatus: "present",
      keyEnvVar: "OPENAI_API_KEY",
    });
    expect(entries.get("openai-compatible")).toMatchObject({
      keyStatus: "present",
      keyEnvVar: "OPENAI_API_KEY",
    });
    expect(entries.get("mistral")).toMatchObject({
      keyStatus: "present",
      keyEnvVar: "MISTRAL_API_KEY",
    });
    expect(entries.get("nvidia-nim")).toMatchObject({
      keyStatus: "present",
      keyEnvVar: "NVIDIA_API_KEY",
    });
    expect(entries.get("minimax")).toMatchObject({
      keyStatus: "present",
      keyEnvVar: "MINIMAX_API_KEY",
    });
    expect(entries.get("github")).toMatchObject({
      keyStatus: "present",
      keyEnvVar: "GITHUB_TOKEN",
    });
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
      keyStatus: "present",
      keyEnvVar: "OPENAI_API_KEY",
    });
    expect(entries.get("mistral")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "MISTRAL_API_KEY",
    });
    expect(entries.get("nvidia-nim")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "NVIDIA_API_KEY",
    });
    expect(entries.get("minimax")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "MINIMAX_API_KEY",
    });
    expect(entries.get("github")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "GITHUB_TOKEN",
    });
  });

  it("requires both Bedrock access and secret credentials", async () => {
    const missingSecret = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: {
        AWS_ACCESS_KEY_ID: "aws-access",
      },
    });
    const usable = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: {
        AWS_BEDROCK_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(byProvider(missingSecret.entries).get("amazon-bedrock")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      keyEnvVar: "AWS_ACCESS_KEY_ID",
      detail: expect.stringContaining("AWS_SECRET_ACCESS_KEY"),
    });
    expect(byProvider(usable.entries).get("amazon-bedrock")).toMatchObject({
      usable: true,
      keyStatus: "present",
      keyEnvVar: "AWS_BEDROCK_ACCESS_KEY_ID",
    });
  });

  it("formats the discovery report for the providers CLI", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      checkLocal: false,
      config: defaultConfig(),
      env: { OPENAI_API_KEY: "openai-key" },
    });

    const text = formatProviderAvailabilityReport(report);

    expect(text).toContain("Auth: local; subscription: free");
    expect(text).toContain("openai");
    expect(text).toContain("present(OPENAI_API_KEY)");
  });
});
