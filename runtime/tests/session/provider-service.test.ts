import { describe, expect, test, vi } from "vitest";
import { resolveHomeContext } from "../../src/config/home.js";
import { createProvider } from "../../src/llm/provider.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import type { Session } from "../../src/session/session.js";
import {
  getAPIProvider,
  getSelectedProviderEnvironment,
  getSelectedProviderModel,
  runWithStartupProviderSelection,
} from "../../src/utils/model/providers.js";

function initialProvider(model: string) {
  return createProvider("openai-compatible", {
    model,
    baseURL: "http://127.0.0.1:18000/v1",
  });
}

function completion(label: string): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${label}`,
      model: `model-${label}`,
      choices: [
        {
          message: { role: "assistant", content: label },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("SessionProviderService", () => {
  test("retains the explicit credential home in every provider binding", () => {
    const home = resolveHomeContext(
      { AGENC_HOME: "/tmp/agenc-provider-home-a" },
      { platformHome: "/tmp" },
    );
    const service = new SessionProviderService({
      initialProvider: createProvider("openai-compatible", {
        credentialHome: home,
        model: "initial",
        baseURL: "http://127.0.0.1:18000/v1",
      }),
    });

    expect(service.current().factoryOptions.credentialHome).toBe(home);
    const prepared = service.prepare(
      { provider: "openai-compatible", model: "next" },
      { credentialHome: home },
    );
    expect(prepared.binding.factoryOptions.credentialHome).toBe(home);
  });

  test("projects model API consumers from the async session binding", async () => {
    const previous = process.env.AGENC_PROVIDER;
    process.env.AGENC_PROVIDER = "anthropic";
    try {
      const github = new SessionProviderService({
        initialProvider: createProvider("github", {
          apiKey: "github-test",
          model: "gpt-4o",
        }),
      });
      const openai = new SessionProviderService({
        initialProvider: createProvider("openai", {
          apiKey: "openai-test",
          model: "gpt-5",
        }),
      });
      const githubSession = {
        services: { providerService: github },
      } as unknown as Session;
      const openaiSession = {
        services: { providerService: openai },
      } as unknown as Session;

      const [githubResult, openaiResult] = await Promise.all([
        runWithCurrentRuntimeSession(githubSession, async () => {
          await Promise.resolve();
          return getAPIProvider();
        }),
        runWithCurrentRuntimeSession(openaiSession, async () => {
          await Promise.resolve();
          return getAPIProvider();
        }),
      ]);

      expect(githubResult).toBe("github");
      expect(openaiResult).toBe("openai");
    } finally {
      if (previous === undefined) delete process.env.AGENC_PROVIDER;
      else process.env.AGENC_PROVIDER = previous;
    }
  });

  test("keeps concurrent sessions on their own endpoint, credential, and model", async () => {
    const fetchA = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://provider-a.example/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key-a");
      return completion("a");
    });
    const fetchB = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://provider-b.example/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key-b");
      return completion("b");
    });
    const serviceA = new SessionProviderService({
      initialProvider: initialProvider("initial-a"),
      environment: {
        OPENAI_COMPATIBLE_API_KEY: "key-a",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider-a.example/v1",
      },
    });
    const serviceB = new SessionProviderService({
      initialProvider: initialProvider("initial-b"),
      environment: {
        OPENAI_COMPATIBLE_API_KEY: "key-b",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider-b.example/v1",
      },
    });

    serviceA.commit(
      serviceA.prepare(
        { provider: "openai-compatible", model: "model-a" },
        { extra: { fetchImpl: fetchA } },
      ),
    );
    serviceB.commit(
      serviceB.prepare(
        { provider: "openai-compatible", model: "model-b" },
        { extra: { fetchImpl: fetchB } },
      ),
    );

    const [a, b] = await Promise.all([
      serviceA.current().instance.chat([{ role: "user", content: "a" }]),
      serviceB.current().instance.chat([{ role: "user", content: "b" }]),
    ]);
    expect(a.content).toBe("a");
    expect(b.content).toBe("b");
    expect(serviceA.current()).toMatchObject({
      provider: "openai-compatible",
      model: "model-a",
      factoryOptions: {
        apiKey: "key-a",
        baseURL: "https://provider-a.example/v1",
      },
    });
    expect(serviceB.current()).toMatchObject({
      provider: "openai-compatible",
      model: "model-b",
      factoryOptions: {
        apiKey: "key-b",
        baseURL: "https://provider-b.example/v1",
      },
    });
  });

  test("never falls back to startup provider authority when live sessions are ambiguous", () => {
    const serviceA = new SessionProviderService({
      initialProvider: initialProvider("model-a"),
      environment: { OPENAI_COMPATIBLE_API_KEY: "key-a" },
    });
    const serviceB = new SessionProviderService({
      initialProvider: initialProvider("model-b"),
      environment: { OPENAI_COMPATIBLE_API_KEY: "key-b" },
    });
    const sessionA = {
      services: { providerService: serviceA },
    } as unknown as Session;
    const sessionB = {
      services: { providerService: serviceB },
    } as unknown as Session;

    setCurrentRuntimeSession(sessionA);
    setCurrentRuntimeSession(sessionB);
    try {
      runWithStartupProviderSelection(
        { provider: "grok", model: "startup-model", environment: {} },
        () => {
          expect(() => getSelectedProviderModel()).toThrow(
            /Ambiguous runtime session/,
          );
          expect(
            runWithCurrentRuntimeSession(sessionA, () => ({
              model: getSelectedProviderModel(),
              key: getSelectedProviderEnvironment().OPENAI_COMPATIBLE_API_KEY,
            })),
          ).toEqual({ model: "model-a", key: "key-a" });
          expect(
            runWithCurrentRuntimeSession(sessionB, () => ({
              model: getSelectedProviderModel(),
              key: getSelectedProviderEnvironment().OPENAI_COMPATIBLE_API_KEY,
            })),
          ).toEqual({ model: "model-b", key: "key-b" });
        },
      );
    } finally {
      clearCurrentRuntimeSession();
    }
  });

  test("post-bootstrap process env mutation cannot change the session provider", async () => {
    const previous = process.env.AGENC_PROVIDER;
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", {
        apiKey: "openai-test",
        model: "gpt-5",
      }),
    });
    const session = {
      services: { providerService: service },
    } as unknown as Session;

    try {
      await runWithCurrentRuntimeSession(session, async () => {
        expect(getAPIProvider()).toBe("openai");
        process.env.AGENC_PROVIDER = "github";
        await Promise.resolve();
        expect(getAPIProvider()).toBe("openai");
        process.env.AGENC_PROVIDER = "anthropic";
        await Promise.resolve();
        expect(getAPIProvider()).toBe("openai");
      });
    } finally {
      if (previous === undefined) delete process.env.AGENC_PROVIDER;
      else process.env.AGENC_PROVIDER = previous;
    }
  });

  test("credentials never change an explicit provider selection", () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
      environment: { MINIMAX_API_KEY: "minimax-only-key" },
    });
    const prepared = service.prepare(
      { provider: "openai-compatible", model: "local-model" },
      {},
    );
    expect(prepared.binding.provider).toBe("openai-compatible");
    expect(prepared.binding.factoryOptions.apiKey).toBeUndefined();
  });

  test("rejects obsolete selectors even when set to a historically false value", () => {
    expect(() =>
      new SessionProviderService({
        initialProvider: initialProvider("initial"),
        environment: { AGENC_USE_OPENAI: "0" },
      }),
    ).toThrow(/obsolete provider selector.*AGENC_USE_OPENAI.*AGENC_PROVIDER=openai/i);
  });

  test("fails closed when two switches were prepared from the same revision", () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
    });
    const first = service.prepare(
      { provider: "openai-compatible", model: "first" },
      {},
    );
    const stale = service.prepare(
      { provider: "openai-compatible", model: "stale" },
      {},
    );
    service.commit(first);
    expect(() => service.commit(stale)).toThrow(/changed while.*prepared/i);
    expect(service.current().model).toBe("first");
  });
});
