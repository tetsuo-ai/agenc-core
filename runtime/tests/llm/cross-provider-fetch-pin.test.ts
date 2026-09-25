import { describe, expect, test, vi } from "vitest";
import { createPinnedProviderFetch, fetchProviderRequest } from "../../src/llm/credential-redirect-fetch.js";
import { createProvider, readProviderFactoryOptions } from "../../src/llm/provider.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { wrapProviderForAgentSummary } from "../../src/agents/run-agent.js";

describe("cross-provider outbound boundary", () => {
  test("the summary-wrapped delegated child stays confined on its next preparation", async () => {
    const parent = new SessionProviderService({
      initialProvider: createProvider("grok", { model: "grok-4.7", apiKey: "parent" }),
      environment: { DEEPSEEK_API_KEY: "child-secret" },
    });
    const selection = { provider: "deepseek", model: "deepseek-v4-pro" };
    const prepared = await parent.prepareChild(selection, { model: selection.model });
    const wrapped = wrapProviderForAgentSummary(prepared.binding.instance, () => {});
    expect(readProviderFactoryOptions(wrapped).extra?.canonicalEndpointRequired).toBe(true);
    const child = parent.forkForChild(wrapped, selection, selection);
    await expect(child.prepare(selection, { model: selection.model,
      baseURL: "https://receiver.example/v1", apiKey: "child-secret" }))
      .rejects.toThrow(/default endpoint/u);
  });

  test("a custom child endpoint is refused by the local preview", async () => {
    const wire = vi.fn<typeof fetch>();
    const service = new SessionProviderService({
      initialProvider: createProvider("grok", { model: "grok-4.7", apiKey: "parent" }),
      environment: { DEEPSEEK_BASE_URL: "https://receiver.example/v1", DEEPSEEK_API_KEY: "secret" },
      resolvePreparationRequest: (selection) => ({ requested: { model: selection.model,
        extra: { fetchImpl: wire } } }),
    });
    await expect(service.previewChildDestination({ provider: "deepseek", model: "deepseek-v4-pro" }))
      .rejects.toThrow(/default endpoint/u);
    expect(wire).not.toHaveBeenCalled();
  });

  test("Grok's session fork preserves the child endpoint requirement through summary wrapping", async () => {
    const parent = new SessionProviderService({
      initialProvider: createProvider("deepseek", { model: "deepseek-v4-pro", apiKey: "parent" }),
      environment: { GROK_API_KEY: "child-secret" },
    });
    const selection = { provider: "grok", model: "grok-4.7" };
    const prepared = await parent.prepareChild(selection, { model: selection.model });
    const wrapped = wrapProviderForAgentSummary(prepared.binding.instance, () => {});
    const forked = wrapped.forkForSession?.({ conversationId: "grok-child" } as never);
    expect(forked).toBeDefined();
    expect(readProviderFactoryOptions(forked!).extra?.canonicalEndpointRequired).toBe(true);
    const child = parent.forkForChild(forked!, selection, selection);
    await expect(child.prepare(selection, { model: selection.model,
      baseURL: "https://receiver.example/v1", apiKey: "child-secret" }))
      .rejects.toThrow(/default endpoint/u);
  });
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

  test("ChatGPT bearer cannot follow a redirect or a crafted path", async () => {
    const wire = vi.fn<typeof fetch>(async () => new Response(null, { status: 307,
      headers: { Location: "https://receiver.example/steal" } }));
    const outbound = createPinnedProviderFetch(["https://chatgpt.com/backend-api/codex"], wire);
    await expect(outbound("https://chatgpt.com/backend-api/codex/responses", {
      headers: { Authorization: "Bearer subscription-token", "ChatGPT-Account-ID": "account" },
    })).rejects.toThrow(/redirect to another origin was refused/u);
    await expect(outbound("https://chatgpt.com/backend-api/other", {
      headers: { Authorization: "Bearer subscription-token" },
    })).rejects.toThrow(/outside its canonical endpoint was refused/u);
    expect(wire).toHaveBeenCalledOnce();
    expect(wire.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});
