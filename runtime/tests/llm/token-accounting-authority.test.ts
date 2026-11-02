import { describe, expect, test, vi } from "vitest";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import { createTokenAccountingRequest, TokenAccountingService } from "../../src/llm/token-accounting.js";

const request = () => createTokenAccountingRequest({
  provider: "anthropic", model: "claude-sonnet-4-5",
  endpointIdentity: "https://count.example/v1", messages: [{ role: "user", content: "same prompt" }],
  options: {}, reservedOutputTokens: 64,
});

function provider(apiKey: string, fetchImpl: typeof fetch) {
  return new AnthropicProvider({ apiKey, model: "claude-sonnet-4-5", baseURL: "https://count.example/v1", fetchImpl });
}

function counter(tokens: number, gate: Promise<void> = Promise.resolve()) {
  return vi.fn<typeof fetch>(async () => {
    await gate;
    return new Response(JSON.stringify({ input_tokens: tokens }), { headers: { "content-type": "application/json" } });
  });
}

describe("native token counts stay with the calling provider authority", () => {
  test.each(["credential", "transport"])("does not reuse a cached count across a different %s", async difference => {
    const service = new TokenAccountingService();
    const parentFetch = counter(123);
    const childFetch = difference === "credential" ? parentFetch : counter(456);
    const parent = provider("fixture-parent", parentFetch);
    const child = provider(difference === "credential" ? "fixture-child" : "fixture-parent", childFetch);
    const first = await service.count(request(), { capability: parent.tokenCountCapability });
    expect(first).toMatchObject({ inputTokens: 392, cacheStatus: "miss", source: "provider_native" });
    const second = await service.count(request(), { capability: child.tokenCountCapability });
    expect(second).toMatchObject({ inputTokens: difference === "credential" ? 392 : 758, cacheStatus: "miss" });
    expect(parentFetch.mock.calls.length + (childFetch === parentFetch ? 0 : childFetch.mock.calls.length)).toBe(2);
    expect(await service.count(request(), { capability: child.tokenCountCapability })).toMatchObject({ cacheStatus: "hit" });
    expect(await service.count(request(), { capability: parent.tokenCountCapability })).toMatchObject({ cacheStatus: "hit" });
  });

  test("concurrent child and invoking-session counts do not join another authority's flight", async () => {
    const service = new TokenAccountingService();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const parentFetch = counter(123, gate), childFetch = counter(456, gate);
    const parent = provider("fixture-parent", parentFetch), child = provider("fixture-child", childFetch);
    const first = service.count(request(), { capability: parent.tokenCountCapability });
    const second = service.count(request(), { capability: child.tokenCountCapability });
    const joined = service.count(request(), { capability: child.tokenCountCapability });
    release();
    expect(await first).toMatchObject({ inputTokens: 392, cacheStatus: "miss" });
    expect(await second).toMatchObject({ inputTokens: 758, cacheStatus: "miss" });
    expect(await joined).toMatchObject({ inputTokens: 758, cacheStatus: "shared" });
    expect(parentFetch).toHaveBeenCalledOnce();
    expect(childFetch).toHaveBeenCalledOnce();
  });
});
