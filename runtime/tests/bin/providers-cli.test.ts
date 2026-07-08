import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config/schema.js";
import type { AuthBackend, AuthProviderSlug, AuthSessionId, AuthSubscriptionTier } from "../auth/backend.js";
import {
  collectProviderAvailability,
  formatAgenCProvidersCliHelpText,
  parseAgenCProvidersCliArgs,
  runAgenCProvidersCli,
  type AgenCProvidersCliIo,
} from "./providers-cli.js";

function createIo(): AgenCProvidersCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
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

describe("providers CLI", () => {
  it("parses the top-level providers command", () => {
    expect(parseAgenCProvidersCliArgs(["hello"])).toBeNull();
    expect(parseAgenCProvidersCliArgs(["providers"])).toEqual({
      kind: "providers",
      json: false,
      checkLocal: true,
    });
    expect(parseAgenCProvidersCliArgs(["providers", "--json"])).toEqual({
      kind: "providers",
      json: true,
      checkLocal: true,
    });
    expect(parseAgenCProvidersCliArgs(["providers", "--no-local-check"]))
      .toEqual({
        kind: "providers",
        json: false,
        checkLocal: false,
      });
    expect(parseAgenCProvidersCliArgs(["providers", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCProvidersCliHelpText(),
    });
    expect(parseAgenCProvidersCliArgs(["providers", "extra"])).toEqual({
      kind: "error",
      message: "providers command does not accept argument 'extra'",
    });
  });

  it("reports BYOK keys and local server health", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://localhost:11434/api/tags") {
        return new Response("{}", { status: 200 });
      }
      if (url === "http://localhost:1234/v1/models") {
        return new Response("{}", { status: 503 });
      }
      if (url === "http://localhost:8000/v1/models") {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      config: defaultConfig(),
      env: {
        XAI_API_KEY: "xai-key",
        OPENAI_API_KEY: "openai-key",
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
    expect(entries.get("ollama")).toMatchObject({
      usable: true,
      keyStatus: "not-required",
      localStatus: "up",
      localStatusCode: 200,
    });
    expect(entries.get("lmstudio")).toMatchObject({
      usable: false,
      localStatus: "down",
      localStatusCode: 503,
    });
    expect(entries.get("openai-compatible")).toMatchObject({
      usable: true,
      keyStatus: "present",
      localStatus: "up",
    });
  });

  it("passes configured bearer credentials to key-backed local probes", async () => {
    const seenHeaders = new Map<string, string | null>();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const authHeader = new Headers(init?.headers).get("authorization");
      seenHeaders.set(url, authHeader);
      if (url === "http://localhost:1234/v1/models") {
        return new Response("{}", {
          status: authHeader === "Bearer studio-key" ? 200 : 401,
        });
      }
      if (url === "http://localhost:8000/v1/models") {
        return new Response("{}", {
          status: authHeader === "Bearer compat-key" ? 200 : 401,
        });
      }
      return new Response("{}", { status: 200 });
    });

    const report = await collectProviderAvailability({
      authBackend: authBackend("local", "free"),
      config: defaultConfig(),
      env: {
        LMSTUDIO_API_KEY: "studio-key",
        OPENAI_COMPATIBLE_API_KEY: "compat-key",
      },
      fetchImpl,
    });
    const entries = byProvider(report.entries);

    expect(entries.get("lmstudio")).toMatchObject({
      usable: true,
      keyStatus: "present",
      localStatus: "up",
      localStatusCode: 200,
    });
    expect(entries.get("openai-compatible")).toMatchObject({
      usable: true,
      keyStatus: "present",
      localStatus: "up",
      localStatusCode: 200,
    });
    expect(seenHeaders.get("http://localhost:1234/v1/models")).toBe(
      "Bearer studio-key",
    );
    expect(seenHeaders.get("http://localhost:8000/v1/models")).toBe(
      "Bearer compat-key",
    );
  });

  it("marks hosted and managed-key providers usable for paid remote auth", async () => {
    const calls: string[] = [];
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "pro", {
        vendKey: (provider, sessionId) => {
          calls.push(`vendKey:${provider}:${sessionId}`);
          return { provider, sessionId, apiKey: `managed-${provider}` };
        },
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const entries = byProvider(report.entries);

    // Managed key vending is restricted to OpenRouter (b461d139 "use
    // OpenRouter for managed Pro models"); grok/openai rows are no longer
    // vended and fall back to BYOK-missing.
    expect(entries.get("openrouter")).toMatchObject({
      usable: true,
      keyStatus: "managed",
      subscriptionTier: "pro",
    });
    expect(entries.get("grok")).toMatchObject({
      usable: false,
      keyStatus: "missing",
      subscriptionTier: "pro",
    });
    expect(entries.get("agenc")).toMatchObject({
      usable: true,
      keyStatus: "not-required",
      subscriptionTier: "pro",
    });
    // Exactly two vends happen: the managed OpenRouter provider row, and the
    // hosted agenc route verifying its inferred grok delegate. No other
    // provider row (openai, anthropic, ...) is vended anymore.
    expect([...calls].sort()).toEqual([
      "vendKey:grok:cli",
      "vendKey:openrouter:cli",
    ]);
  });

  it("marks managed-key provider rows unusable when vending fails", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "pro", {
        vendKey: (provider, sessionId) => {
          if (provider === "openrouter") throw new Error("openrouter denied");
          return { provider, sessionId, apiKey: "managed-key" };
        },
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const entries = byProvider(report.entries);

    expect(entries.get("openrouter")).toMatchObject({
      usable: false,
      keyStatus: "unavailable",
    });
    expect(entries.get("openrouter")?.detail).toContain("openrouter denied");
  });

  it("rejects managed-key vending with an empty or mismatched key response", async () => {
    // OpenRouter is the only provider with a live managed vending route, so
    // the mismatch and empty-key rejections are exercised in two passes.
    const mismatchReport = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        vendKey: (_provider, sessionId) => ({
          provider: "grok",
          sessionId,
          apiKey: "managed-key",
        }),
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const mismatchEntries = byProvider(mismatchReport.entries);

    expect(mismatchEntries.get("openrouter")).toMatchObject({
      usable: false,
      keyStatus: "unavailable",
    });
    expect(mismatchEntries.get("openrouter")?.detail).toContain(
      "provider mismatch",
    );

    const emptyKeyReport = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        vendKey: (provider, sessionId) => ({ provider, sessionId, apiKey: " " }),
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const emptyKeyEntries = byProvider(emptyKeyReport.entries);

    expect(emptyKeyEntries.get("openrouter")).toMatchObject({
      usable: false,
      keyStatus: "unavailable",
    });
    expect(emptyKeyEntries.get("openrouter")?.detail).toContain("empty key");
  });

  it("marks hosted AgenC routing unusable when inference fails", async () => {
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        inferAgencModel: () => {
          throw new Error("routing denied");
        },
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const entries = byProvider(report.entries);

    expect(entries.get("agenc")).toMatchObject({
      usable: false,
      keyStatus: "not-required",
      subscriptionTier: "team",
    });
    expect(entries.get("agenc")?.detail).toContain("routing denied");
  });

  it("marks hosted AgenC routing unusable when inferred key vending fails", async () => {
    const calls: string[] = [];
    const report = await collectProviderAvailability({
      authBackend: authBackend("remote", "team", {
        inferAgencModel: () => ({
          provider: "openai",
          model: "gpt-5",
        }),
        vendKey: (provider: AuthProviderSlug | string, sessionId: AuthSessionId) => {
          calls.push(`vendKey:${provider}:${sessionId}`);
          if (provider === "openai") throw new Error("openai denied");
          return { provider, sessionId, apiKey: "managed-key" };
        },
      }),
      checkLocal: false,
      config: defaultConfig(),
      env: {},
    });
    const entries = byProvider(report.entries);

    expect(entries.get("agenc")).toMatchObject({
      usable: false,
      keyStatus: "not-required",
      subscriptionTier: "team",
    });
    expect(entries.get("agenc")?.detail).toContain("openai denied");
    expect(calls).toContain("vendKey:openai:cli");
  });

  it("prints JSON reports without booting a session", async () => {
    const io = createIo();
    await expect(
      runAgenCProvidersCli(
        { kind: "providers", json: true, checkLocal: false },
        {
          authBackend: authBackend("remote", "team"),
          config: defaultConfig(),
          env: {},
          io,
        },
      ),
    ).resolves.toBe(0);

    const parsed = JSON.parse(io.stdoutText()) as {
      readonly subscriptionTier: string;
      readonly entries: readonly { readonly provider: string }[];
    };
    expect(parsed.subscriptionTier).toBe("team");
    expect(parsed.entries.some((entry) => entry.provider === "grok")).toBe(true);
    expect(io.stderrText()).toBe("");
  });
});
