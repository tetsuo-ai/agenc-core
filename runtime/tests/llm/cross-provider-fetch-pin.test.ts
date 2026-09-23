import { describe, expect, test, vi } from "vitest";
import { createPinnedProviderFetch, fetchProviderRequest } from "../../src/llm/credential-redirect-fetch.js";
import { createProvider } from "../../src/llm/provider.js";
import { SessionProviderService } from "../../src/session/provider-service.js";

describe("cross-provider outbound boundary", () => {
  test("refuses a direct provider fetch to another origin before sending credentials", async () => {
    const wire = vi.fn<typeof fetch>(async () => new Response("ok"));
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent" }),
      environment: { DEEPSEEK_API_KEY: "child-secret" },
    });
    const prepared = await service.prepareChild(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { model: "deepseek-v4-pro", extra: { fetchImpl: wire } },
    );
    const outbound = prepared.binding.factoryOptions.extra?.fetchImpl as typeof fetch;
    const error = await outbound("https://receiver.example/v1/chat/completions", {
      headers: { Authorization: "Bearer child-secret" },
    }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/refused/u);
    expect((error as Error).message).not.toMatch(/receiver\.example|child-secret|Authorization/u);
    await expect(outbound("https://receiver.example/v1/models"))
      .rejects.toThrow(/refused/u);
    expect(wire).not.toHaveBeenCalled();
    await expect(outbound("https://api.deepseek.com/v1/models"))
      .resolves.toBeInstanceOf(Response);
    expect(wire).toHaveBeenCalledOnce();
  });

  test("same-provider child and main session retain a custom endpoint", async () => {
    const wire = vi.fn<typeof fetch>(async () => new Response("ok"));
    const service = new SessionProviderService({
      initialProvider: createProvider("deepseek", {
        model: "deepseek-v4-pro", apiKey: "key", baseURL: "https://receiver.example/v1",
      }),
      environment: { DEEPSEEK_API_KEY: "key" },
    });
    const requested = {
      model: "deepseek-v4-pro",
      baseURL: "https://receiver.example/v1",
      extra: { fetchImpl: wire },
    };
    const child = await service.prepareChild(
      { provider: "deepseek", model: "deepseek-v4-pro" }, requested,
    );
    const main = await service.prepare(
      { provider: "deepseek", model: "deepseek-v4-pro" }, requested,
    );
    for (const prepared of [child, main]) {
      const outbound = prepared.binding.factoryOptions.extra?.fetchImpl as typeof fetch;
      await expect(outbound("https://receiver.example/v1/models"))
        .resolves.toBeInstanceOf(Response);
    }
    expect(wire).toHaveBeenCalledTimes(2);
  });

  test("refuses a credential-bearing streaming redirect without exposing Location", async () => {
    const location = "https://child-secret.receiver.example/v1/stream?key=child-secret";
    const wire = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 307,
      headers: { Location: location },
    }));
    const error = await fetchProviderRequest(
      "https://api.deepseek.com/v1/chat/completions",
      { headers: { Authorization: "Bearer child-secret" }, redirect: "follow" },
      wire,
    ).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("child-secret");
    expect((error as Error).message).not.toContain("receiver.example");
    expect(wire).toHaveBeenCalledOnce();
    expect(wire.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  test("pinned fetch refuses a redirect even when the first request has no credential", async () => {
    const wire = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://secret.receiver.example/models" },
    }));
    const outbound = createPinnedProviderFetch(["https://api.deepseek.com/v1"], wire);
    await expect(outbound("https://api.deepseek.com/v1/models"))
      .rejects.toThrow("Provider redirect to another origin was refused");
    expect(wire).toHaveBeenCalledOnce();
    expect(wire.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});
