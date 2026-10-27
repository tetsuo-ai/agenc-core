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
      credentialStatus: "present",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });
    expect(entries.get("anthropic")).toMatchObject({
      usable: false,
      credentialStatus: "missing",
    });
    expect(entries.get("anthropic")).not.toHaveProperty(
      "credentialProvenance",
    );
    expect(entries.get("ollama")).toMatchObject({
      usable: true,
      credentialStatus: "not-required",
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
      credentialStatus: "optional",
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
      credentialStatus: "present",
      localStatus: "up",
      localStatusCode: 200,
    });
    expect(entries.get("openai-compatible")).toMatchObject({
      usable: true,
      credentialStatus: "present",
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

  it("prints JSON reports without booting a session", async () => {
    const io = createIo();
    await expect(
      runAgenCProvidersCli(
        { kind: "providers", json: true, checkLocal: false },
        {
          authBackend: authBackend("remote", "team"),
          config: defaultConfig(),
          env: { XAI_API_KEY: "xai-key" },
          io,
        },
      ),
    ).resolves.toBe(0);

    const parsed = JSON.parse(io.stdoutText()) as {
      readonly subscriptionTier: string;
      readonly entries: readonly {
        readonly provider: string;
        readonly credentialStatus: string;
        readonly credentialProvenance?: unknown;
      }[];
    };
    expect(parsed.subscriptionTier).toBe("team");
    const grok = parsed.entries.find((entry) => entry.provider === "grok");
    expect(grok).toMatchObject({
      credentialStatus: "present",
      credentialProvenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });
    expect(grok).not.toHaveProperty("keyStatus");
    expect(grok).not.toHaveProperty("credentialSource");
    expect(io.stderrText()).toBe("");
  });
});
