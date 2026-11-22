import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config/schema.js";
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
      config: defaultConfig(),
      env: {
        XAI_API_KEY: "xai-key",
        OPENAI_API_KEY: "openai-key",
      },
      fetchImpl,
    });
    const entries = byProvider(report.entries);

    // No AgenC account: the report carries provider entries only.
    expect(Object.keys(report)).toEqual(["entries"]);
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
          config: defaultConfig(),
          env: { XAI_API_KEY: "xai-key" },
          io,
        },
      ),
    ).resolves.toBe(0);

    const parsed = JSON.parse(io.stdoutText()) as {
      readonly entries: readonly {
        readonly provider: string;
        readonly credentialStatus: string;
        readonly credentialProvenance?: unknown;
      }[];
    };
    expect(parsed).not.toHaveProperty("subscriptionTier");
    expect(parsed).not.toHaveProperty("authBackendKind");
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
