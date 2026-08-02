import { describe, expect, test, vi } from "vitest";

import calibrationCorpus from "./fixtures/token-accounting-calibration.v1.json" with {
  type: "json",
};

import {
  MAX_TOKEN_ACCOUNTING_REQUEST_BYTES,
  MAX_TOKEN_COUNT_SINGLE_FLIGHTS,
  MAX_TOKEN_COUNT_WAITER_BYTES,
  MAX_TOKEN_COUNT_WAITERS_GLOBAL,
  MAX_TOKEN_COUNT_WAITERS_PER_FLIGHT,
  TOKEN_COUNT_CACHE_MAX_BYTES,
  TOKEN_COUNT_CACHE_MAX_ENTRIES,
  TOKEN_COUNT_CACHE_TTL_MS,
  TOKEN_COUNT_PROVIDER_TIMEOUT_MS,
  TOKEN_ACCOUNTING_METRICS_MAX_PARTITIONS,
  TOKEN_FALLBACK_MARGIN_RATIO,
  TOKEN_FALLBACK_MARGIN_TOKENS,
  TokenAccountingError,
  TokenAccountingService,
  assertTokenAccountingWithinContext,
  canonicalTokenEndpointIdentity,
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
  estimateUtf8TokenUnits,
  requireAdmissibleTokenAccounting,
  type ProviderNativeTokenCountResult,
  type ProviderTokenCountCapability,
  type TokenAccountingRequest,
} from "./token-accounting.js";
import type { LLMContentPart, LLMTool } from "./types.js";

const COMPLETE_COMPONENTS = [
  "system",
  "messages",
  "tools",
  "tool_choice",
  "structured_output",
  "images",
  "documents",
  "provider_framing",
] as const;

const TOOL: LLMTool = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look up one value",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
};

function accountingRequest(
  content: string | LLMContentPart[] = "hello",
  overrides: Partial<Parameters<typeof createTokenAccountingRequest>[0]> = {},
): TokenAccountingRequest {
  const options = {
    maxOutputTokens: 64,
    ...overrides.options,
  };
  return createTokenAccountingRequest({
    provider: "test-provider",
    model: "test-model",
    messages: [{ role: "user", content }],
    options,
    contextWindowTokens: 8_192,
    reservedOutputTokens: 64,
    ...overrides,
    options,
  });
}

function capability(
  countTokens: ProviderTokenCountCapability["countTokens"],
  revisions: Partial<ProviderTokenCountCapability> = {},
): ProviderTokenCountCapability {
  return {
    capabilityVersion: revisions.capabilityVersion ?? "count-v1",
    adapterRevision: revisions.adapterRevision ?? "adapter-v1",
    configurationRevision:
      revisions.configurationRevision ?? "configuration-v1",
    countTokens,
  };
}

function completeCount(inputTokens: number): ProviderNativeTokenCountResult {
  return {
    inputTokens,
    complete: true,
    confidence: "exact",
    countedComponents: COMPLETE_COMPONENTS,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TokenAccountingService constants", () => {
  test("freezes the initial cache, concurrency, request, timeout, and margin bounds", () => {
    expect(TOKEN_COUNT_CACHE_MAX_ENTRIES).toBe(1_024);
    expect(TOKEN_COUNT_CACHE_MAX_BYTES).toBe(67_108_864);
    expect(TOKEN_COUNT_CACHE_TTL_MS).toBe(300_000);
    expect(MAX_TOKEN_COUNT_SINGLE_FLIGHTS).toBe(64);
    expect(MAX_TOKEN_COUNT_WAITERS_PER_FLIGHT).toBe(1_024);
    expect(MAX_TOKEN_COUNT_WAITERS_GLOBAL).toBe(4_096);
    expect(MAX_TOKEN_COUNT_WAITER_BYTES).toBe(4_194_304);
    expect(MAX_TOKEN_ACCOUNTING_REQUEST_BYTES).toBe(16_777_216);
    expect(TOKEN_COUNT_PROVIDER_TIMEOUT_MS).toBe(5_000);
    expect(TOKEN_ACCOUNTING_METRICS_MAX_PARTITIONS).toBe(4_096);
    expect(TOKEN_FALLBACK_MARGIN_RATIO).toBe(0.1);
    expect(TOKEN_FALLBACK_MARGIN_TOKENS).toBe(256);
  });
});

describe("conservative complete-request fallback", () => {
  test.each([
    ["ASCII", "plain ASCII"],
    ["combining", "e\u0301"],
    ["CJK", "漢字かな"],
    ["emoji and ZWJ", "👩‍💻 🧑🏽‍🚀"],
    ["compatibility-normalization expansion", "ﷺ"],
    ["malformed surrogate", "\ud800"],
    ["code", "function f(x) { return x?.value ?? null; }"],
    ["long whitespace", " \t\n".repeat(1_000)],
  ])("uses UTF-8 bytes for %s", (_name, content) => {
    const result = estimateTokenAccountingRequest(accountingRequest(content));

    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.source).toBe("conservative_fallback");
    expect(result.confidence).toBe("conservative");
    expect(result.coverage.complete).toBe(true);
    expect(result.totalTokens).toBe(
      result.inputTokens + result.reservedOutputTokens,
    );
  });

  test("uses a whole-request ceiling and never loses short-message framing", () => {
    const counts = [0, 1, 2, 100].map((messageCount) => {
      const request = accountingRequest("", {
        messages: Array.from({ length: messageCount }, () => ({
          role: "user" as const,
          content: "x",
        })),
      });
      return estimateTokenAccountingRequest(request).inputTokens;
    });

    expect(counts.every((count) => count > 0)).toBe(true);
    expect(counts[2]).toBeGreaterThan(counts[1] ?? 0);
    expect(counts[3]).toBeGreaterThan(counts[2] ?? 0);
    expect(estimateUtf8TokenUnits("x", 4)).toBe(1);
    expect(estimateUtf8TokenUnits("👩‍💻", 4)).toBeGreaterThan(1);
    expect(estimateUtf8TokenUnits("ﷺ", 1)).toBe(
      new TextEncoder().encode("ﷺ".normalize("NFKD")).byteLength,
    );
  });

  test("accounts for system, tools, forced choice, schema, and output once", () => {
    const plain = estimateTokenAccountingRequest(accountingRequest("hello"));
    const rich = estimateTokenAccountingRequest(
      accountingRequest("hello", {
        options: {
          systemPrompt: "Follow the policy exactly.",
          tools: [TOOL, { ...TOOL, function: { ...TOOL.function, name: "find" } }],
          toolChoice: { type: "function", name: "lookup" },
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "answer",
              schema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"],
              },
              strict: true,
            },
          },
          maxOutputTokens: 512,
        },
        reservedOutputTokens: 512,
      }),
    );
    const beforeMargin = rich.inputTokens - rich.safetyMarginTokens;

    expect(rich.inputTokens).toBeGreaterThan(plain.inputTokens);
    expect(rich.coverage.countedComponents).toEqual(
      expect.arrayContaining([
        "system",
        "messages",
        "tools",
        "tool_choice",
        "structured_output",
        "provider_framing",
        "reserved_output",
      ]),
    );
    expect(rich.safetyMarginTokens).toBe(
      Math.ceil(beforeMargin * TOKEN_FALLBACK_MARGIN_RATIO) +
        TOKEN_FALLBACK_MARGIN_TOKENS,
    );
  });

  test("accounts exact provider-native tool payloads and rejects remote catalog expansion", () => {
    const plain = estimateTokenAccountingRequest(accountingRequest("hello"));
    const search = estimateTokenAccountingRequest(
      accountingRequest("hello", {
        providerNativeTools: [
          {
            name: "web_search",
            toolType: "web_search",
            payload: {
              type: "web_search",
              allowed_domains: ["example.com"],
            },
          },
        ],
      }),
    );

    expect(search.inputTokens).toBeGreaterThan(plain.inputTokens);
    expect(search.coverage.countedComponents).toContain("tools");
    expect(search.coverage.contentTypes).toContain("tool_schema");
    expect(search.admissible).toBe(true);

    const remoteMcp = estimateTokenAccountingRequest(
      accountingRequest("hello", {
        providerNativeTools: [
          {
            name: "mcp:remote",
            toolType: "mcp",
            payload: { type: "mcp", server_url: "https://mcp.example" },
          },
        ],
      }),
    );
    expect(remoteMcp.admissible).toBe(false);
    expect(remoteMcp.coverage.uncertainComponents).toContain(
      "providerNativeTools[0].remote_mcp_catalog",
    );
  });

  test("has explicit inline media strategies and fails closed for remote media", async () => {
    const inline = accountingRequest([
      { type: "text", text: "inspect" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=" },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0xLjQ=",
        },
      },
    ]);
    const inlineResult = estimateTokenAccountingRequest(inline);

    expect(inlineResult.admissible).toBe(true);
    expect(inlineResult.coverage.contentTypes).toEqual(
      expect.arrayContaining(["image_inline", "document_inline", "text"]),
    );
    expect(inlineResult.coverage.countedComponents).toEqual(
      expect.arrayContaining(["images", "documents"]),
    );

    const remote = accountingRequest([
      { type: "image_url", image_url: { url: "https://media.example/a.png" } },
    ]);
    const fallback = estimateTokenAccountingRequest(remote);
    expect(fallback.admissible).toBe(false);
    expect(fallback.confidence).toBe("unknown");
    expect(() => requireAdmissibleTokenAccounting(fallback)).toThrow(
      TokenAccountingError,
    );

    const service = new TokenAccountingService();
    const native = await service.count(remote, {
      capability: capability(async () => completeCount(77)),
    });
    expect(native.admissible).toBe(true);
    expect(native.coverage.complete).toBe(true);
    expect(native.coverage.contentTypes).toContain("image_remote");
  });

  test("rejects provider-specific blocks when no complete native count exists", () => {
    const request = accountingRequest([
      { type: "audio", source: "opaque" } as unknown as LLMContentPart,
    ]);
    const result = estimateTokenAccountingRequest(request);

    expect(result.admissible).toBe(false);
    expect(result.coverage.contentTypes).toContain("provider_specific");
    expect(result.coverage.uncertainComponents).toHaveLength(1);
  });

  test("fails closed for provider-expanded cached Gemini content", async () => {
    const request = accountingRequest("summarize the cache", {
      provider: "gemini",
      options: {
        maxOutputTokens: 64,
        promptCacheKey: "cachedContents/project-context",
      },
    });
    const fallback = estimateTokenAccountingRequest(request);

    expect(fallback).toMatchObject({
      admissible: false,
      confidence: "unknown",
      coverage: {
        uncertainComponents: ["provider_cached_content"],
      },
    });

    const complete = await new TokenAccountingService().count(request, {
      capability: capability(async () => completeCount(23)),
    });
    expect(complete).toMatchObject({
      inputTokens: 23,
      source: "provider_native",
      admissible: true,
    });
  });
});

describe("native count selection, identity, and caching", () => {
  test("uses complete native counts and falls back on errors or partial results", async () => {
    const request = accountingRequest("hello");
    const nativeService = new TokenAccountingService();
    const native = await nativeService.count(request, {
      capability: capability(async () => completeCount(12)),
    });
    expect(native).toMatchObject({
      inputTokens: 12,
      totalTokens: 76,
      source: "provider_native",
      confidence: "exact",
      cacheStatus: "miss",
      admissible: true,
    });

    const highConfidence = await new TokenAccountingService().count(request, {
      capability: capability(async () => ({
        ...completeCount(100),
        confidence: "high",
      })),
    });
    expect(highConfidence).toMatchObject({
      inputTokens: 366,
      safetyMarginTokens: 266,
      source: "provider_native",
      confidence: "high",
    });

    const errorService = new TokenAccountingService();
    const failed = await errorService.count(request, {
      capability: capability(async () => {
        throw new Error("rate limited");
      }),
    });
    expect(failed.source).toBe("conservative_fallback");
    expect(failed.inputTokens).toBeGreaterThan(0);
    expect(errorService.debugState().cacheEntries).toBe(0);

    const partialService = new TokenAccountingService();
    const partial = await partialService.count(request, {
      capability: capability(async () => ({
        inputTokens: 1,
        complete: false,
        confidence: "high",
        countedComponents: ["messages"],
      })),
    });
    expect(partial.source).toBe("conservative_fallback");
    expect(partial.inputTokens).toBeGreaterThan(1);
    expect(partialService.debugState().cacheEntries).toBe(0);

    const zeroService = new TokenAccountingService();
    const zeroCount = vi.fn(async () => completeCount(0));
    const zero = await zeroService.count(request, {
      capability: capability(zeroCount),
    });
    expect(zero.source).toBe("conservative_fallback");
    expect(zero.inputTokens).toBeGreaterThan(0);
    expect(zeroService.debugState().cacheEntries).toBe(0);
    await zeroService.count(request, { capability: capability(zeroCount) });
    expect(zeroCount).toHaveBeenCalledTimes(2);
  });

  test("deduplicates a complete digest and returns a subsequent cache hit", async () => {
    const deferred = Promise.withResolvers<ProviderNativeTokenCountResult>();
    const countTokens = vi.fn(() => deferred.promise);
    const service = new TokenAccountingService();
    const countCapability = capability(countTokens);
    const request = accountingRequest("same");

    const first = service.count(request, { capability: countCapability });
    const second = service.count(request, { capability: countCapability });
    await flushPromises();
    expect(countTokens).toHaveBeenCalledTimes(1);
    deferred.resolve(completeCount(20));

    expect((await first).cacheStatus).toBe("miss");
    expect((await second).cacheStatus).toBe("shared");
    expect(
      (await service.count(request, { capability: countCapability })).cacheStatus,
    ).toBe("hit");
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  test("binds the provider call and cache entry to an immutable request snapshot", async () => {
    let observedRequest: TokenAccountingRequest | undefined;
    const countTokens = vi.fn(async (request: TokenAccountingRequest) => {
      observedRequest = request;
      return completeCount(20);
    });
    const countCapability = capability(countTokens);
    const service = new TokenAccountingService();
    const request = accountingRequest("before", {
      options: {
        maxOutputTokens: 64,
        systemPrompt: "before",
        tools: [structuredClone(TOOL)],
      },
    });

    const pending = service.count(request, { capability: countCapability });
    (request.messages[0] as { content: string }).content = "after";
    const mutableOptions = request.options as {
      systemPrompt: string;
      tools: Array<{
        function: { description: string };
      }>;
    };
    mutableOptions.systemPrompt = "after";
    mutableOptions.tools[0]!.function.description = "mutated after digest";

    await expect(pending).resolves.toMatchObject({ cacheStatus: "miss" });
    expect(observedRequest).toMatchObject({
      messages: [{ role: "user", content: "before" }],
      options: {
        systemPrompt: "before",
        tools: [
          {
            function: { description: "Look up one value" },
          },
        ],
      },
    });
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest?.messages[0])).toBe(true);
    expect(Object.isFrozen(observedRequest?.options.tools?.[0])).toBe(true);

    const equivalent = accountingRequest("before", {
      options: {
        maxOutputTokens: 64,
        systemPrompt: "before",
        tools: [structuredClone(TOOL)],
      },
    });
    await expect(
      service.count(equivalent, { capability: countCapability }),
    ).resolves.toMatchObject({ cacheStatus: "hit" });
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  test("strips credentials/query but separates endpoint paths and revisions", async () => {
    expect(
      canonicalTokenEndpointIdentity(
        "https://alice:secret@API.EXAMPLE/v1/?key=secret#fragment",
        "openai-compatible",
      ),
    ).toBe("https://api.example/v1");
    expect(canonicalTokenEndpointIdentity("socket-a", "local")).not.toBe(
      canonicalTokenEndpointIdentity("socket-b", "local"),
    );
    expect(
      canonicalTokenEndpointIdentity("https://api.example/v1//count", "local"),
    ).not.toBe(
      canonicalTokenEndpointIdentity("https://api.example/v1/count", "local"),
    );

    const countTokens = vi.fn(async () => completeCount(40));
    const service = new TokenAccountingService();
    const base = accountingRequest("identity", {
      endpointIdentity: "https://alice:one@api.example/v1?key=one",
      modelRevision: "model-r1",
    });
    const sameCanonical = accountingRequest("identity", {
      endpointIdentity: "https://bob:two@API.EXAMPLE/v1/?key=two#ignored",
      modelRevision: "model-r1",
    });
    await service.count(base, { capability: capability(countTokens) });
    expect(
      (await service.count(sameCanonical, {
        capability: capability(countTokens),
      })).cacheStatus,
    ).toBe("hit");

    const variants: Array<{
      request?: TokenAccountingRequest;
      capability?: ProviderTokenCountCapability;
    }> = [
      {
        request: accountingRequest("identity", {
          endpointIdentity: "https://api.example/v2",
          modelRevision: "model-r1",
        }),
      },
      {
        request: accountingRequest("identity", {
          endpointIdentity: "https://api.example/v1",
          modelRevision: "model-r2",
        }),
      },
      {
        request: accountingRequest("identity", {
          endpointIdentity: "https://api.example/v1",
          modelRevision: "model-r1",
          tokenizerRevision: "tokenizer-r2",
        }),
      },
      {
        request: accountingRequest("identity", {
          model: "TEST-MODEL",
          endpointIdentity: "https://api.example/v1",
          modelRevision: "model-r1",
        }),
      },
      { capability: capability(countTokens, { adapterRevision: "adapter-v2" }) },
      {
        capability: capability(countTokens, {
          configurationRevision: "configuration-v2",
        }),
      },
      {
        capability: capability(countTokens, {
          capabilityVersion: "count-v2",
        }),
      },
      {
        request: accountingRequest("identity", {
          endpointIdentity: "https://api.example/v1",
          modelRevision: "model-r1",
          reservedOutputTokens: 65,
        }),
      },
    ];
    for (const variant of variants) {
      await service.count(variant.request ?? base, {
        capability: variant.capability ?? capability(countTokens),
      });
    }
    expect(countTokens).toHaveBeenCalledTimes(1 + variants.length);
  });

  test("enforces TTL, true LRU entry eviction, and cache-byte accounting", async () => {
    let now = 1_000;
    const countTokens = vi.fn(async () => completeCount(10));
    const countCapability = capability(countTokens);
    const service = new TokenAccountingService({
      now: () => now,
      cacheMaxEntries: 2,
      cacheTtlMs: 10,
      providerTimeoutMs: 1_000,
    });
    const a = accountingRequest("a");
    const b = accountingRequest("b");
    const c = accountingRequest("c");

    await service.count(a, { capability: countCapability });
    await service.count(b, { capability: countCapability });
    await service.count(a, { capability: countCapability });
    await service.count(c, { capability: countCapability });
    await service.count(b, { capability: countCapability });
    expect(countTokens).toHaveBeenCalledTimes(4);
    expect(service.debugState().cacheEntries).toBe(2);

    now += 11;
    await service.count(b, { capability: countCapability });
    expect(countTokens).toHaveBeenCalledTimes(5);

    const byteBounded = new TokenAccountingService({ cacheMaxBytes: 1 });
    await byteBounded.count(a, { capability: countCapability });
    await byteBounded.count(a, { capability: countCapability });
    expect(byteBounded.debugState()).toMatchObject({
      cacheEntries: 0,
      cacheBytes: 0,
    });
  });
});

describe("bounded shared preflights", () => {
  test("reserves waiter bytes before starting a physical call", async () => {
    const countTokens = vi.fn(async () => completeCount(1));
    const service = new TokenAccountingService({ maxWaiterBytes: 512 });

    await expect(
      service.count(accountingRequest("no waiter capacity"), {
        capability: capability(countTokens),
      }),
    ).resolves.toMatchObject({
      source: "conservative_fallback",
      cacheStatus: "bypass",
    });
    expect(countTokens).not.toHaveBeenCalled();
    expect(service.debugState().physicalFlights).toBe(0);
  });

  test("detaches one aborted waiter without cancelling the remaining waiter", async () => {
    const deferred = Promise.withResolvers<ProviderNativeTokenCountResult>();
    let providerSignal: AbortSignal | undefined;
    const countCapability = capability((_request, signal) => {
      providerSignal = signal;
      return deferred.promise;
    });
    const service = new TokenAccountingService();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = accountingRequest("shared abort");
    const first = service.count(request, {
      capability: countCapability,
      signal: firstController.signal,
    });
    const second = service.count(request, {
      capability: countCapability,
      signal: secondController.signal,
    });
    await flushPromises();

    firstController.abort(new Error("first left"));
    await expect(first).rejects.toThrow("first left");
    expect(providerSignal?.aborted).toBe(false);
    expect(service.debugState().waiters).toBe(1);

    deferred.resolve(completeCount(33));
    await expect(second).resolves.toMatchObject({ inputTokens: 33 });
  });

  test("last-waiter cancellation retains physical ownership and discards late success", async () => {
    const generations: Array<ReturnType<typeof Promise.withResolvers<ProviderNativeTokenCountResult>>> = [];
    const signals: AbortSignal[] = [];
    const countCapability = capability((_request, signal) => {
      signals.push(signal);
      const deferred = Promise.withResolvers<ProviderNativeTokenCountResult>();
      generations.push(deferred);
      return deferred.promise;
    });
    const service = new TokenAccountingService({ maxSingleFlights: 1 });
    const controller = new AbortController();
    const request = accountingRequest("abandoned");
    const first = service.count(request, {
      capability: countCapability,
      signal: controller.signal,
    });
    await flushPromises();
    controller.abort(new Error("cancelled"));
    await expect(first).rejects.toThrow("cancelled");

    expect(signals[0]?.aborted).toBe(true);
    expect(service.debugState()).toMatchObject({
      physicalFlights: 1,
      attachableFlights: 0,
      abandonedFlights: 1,
      cacheEntries: 0,
    });
    const overflow = await service.count(request, { capability: countCapability });
    expect(overflow.cacheStatus).toBe("bypass");
    expect(generations).toHaveLength(1);

    generations[0]?.resolve(completeCount(99));
    await vi.waitFor(() => {
      expect(service.debugState()).toMatchObject({
        physicalFlights: 0,
        abandonedFlights: 0,
        cacheEntries: 0,
      });
    });

    const replacement = service.count(request, { capability: countCapability });
    await flushPromises();
    expect(generations).toHaveLength(2);
    generations[1]?.resolve(completeCount(44));
    await expect(replacement).resolves.toMatchObject({ inputTokens: 44 });
  });

  test("keeps all 64 timed-out physical calls owned and bypasses call 65", async () => {
    const deferred: Array<ReturnType<typeof Promise.withResolvers<ProviderNativeTokenCountResult>>> = [];
    const countTokens = vi.fn(() => {
      const next = Promise.withResolvers<ProviderNativeTokenCountResult>();
      deferred.push(next);
      return next.promise;
    });
    const countCapability = capability(countTokens);
    const service = new TokenAccountingService({ providerTimeoutMs: 10 });
    const calls = Array.from({ length: MAX_TOKEN_COUNT_SINGLE_FLIGHTS }, (_, index) =>
      service.count(accountingRequest(`flight-${index}`), {
        capability: countCapability,
      }),
    );
    await flushPromises();
    expect(countTokens).toHaveBeenCalledTimes(64);

    const timedOut = await Promise.all(calls);
    expect(timedOut.every((result) => result.cacheStatus === "bypass")).toBe(
      true,
    );
    expect(service.debugState()).toMatchObject({
      physicalFlights: 64,
      abandonedFlights: 64,
      waiters: 0,
    });

    const sixtyFifth = await service.count(accountingRequest("flight-65"), {
      capability: countCapability,
    });
    expect(sixtyFifth).toMatchObject({
      source: "conservative_fallback",
      cacheStatus: "bypass",
    });
    expect(countTokens).toHaveBeenCalledTimes(64);

    deferred.forEach((pending) => pending.resolve(completeCount(1)));
    await vi.waitFor(() => {
      expect(service.debugState()).toMatchObject({
        physicalFlights: 0,
        abandonedFlights: 0,
        cacheEntries: 0,
      });
    });
  });

  test("bounds one digest at 1,024 waiters without launching a replacement", async () => {
    const deferred = Promise.withResolvers<ProviderNativeTokenCountResult>();
    const countTokens = vi.fn(() => deferred.promise);
    const service = new TokenAccountingService();
    const countCapability = capability(countTokens);
    const request = accountingRequest("many waiters");
    const waiters = Array.from({ length: MAX_TOKEN_COUNT_WAITERS_PER_FLIGHT }, () =>
      service.count(request, { capability: countCapability }),
    );
    await flushPromises();
    expect(service.debugState()).toMatchObject({
      physicalFlights: 1,
      waiters: 1_024,
      waiterBytes: 1_048_576,
    });

    const overflow = await service.count(request, { capability: countCapability });
    expect(overflow.cacheStatus).toBe("bypass");
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(service.debugState().waiters).toBe(1_024);

    deferred.resolve(completeCount(50));
    await Promise.all(waiters);
    expect(service.debugState().waiters).toBe(0);
  });

  test("bounds the process at 4,096 waiters and the declared byte reservation", async () => {
    const pending = Array.from({ length: 4 }, () =>
      Promise.withResolvers<ProviderNativeTokenCountResult>(),
    );
    let physicalCall = 0;
    const countTokens = vi.fn(() => pending[physicalCall++]!.promise);
    const service = new TokenAccountingService();
    const countCapability = capability(countTokens);
    const calls = Array.from({ length: 4 }).flatMap((_, digest) =>
      Array.from({ length: MAX_TOKEN_COUNT_WAITERS_PER_FLIGHT }, () =>
        service.count(accountingRequest(`global-${digest}`), {
          capability: countCapability,
        }),
      ),
    );
    await flushPromises();
    expect(service.debugState()).toMatchObject({
      physicalFlights: 4,
      waiters: MAX_TOKEN_COUNT_WAITERS_GLOBAL,
      waiterBytes: MAX_TOKEN_COUNT_WAITER_BYTES,
    });

    const overflow = await service.count(accountingRequest("global-overflow"), {
      capability: countCapability,
    });
    expect(overflow.cacheStatus).toBe("bypass");
    expect(countTokens).toHaveBeenCalledTimes(4);

    pending.forEach((entry) => entry.resolve(completeCount(70)));
    await Promise.all(calls);
    expect(service.debugState()).toMatchObject({ waiters: 0, waiterBytes: 0 });
  });

  test("times out to fallback but owns an abort-ignoring call until settlement", async () => {
    const deferred = Promise.withResolvers<ProviderNativeTokenCountResult>();
    let signal: AbortSignal | undefined;
    const service = new TokenAccountingService({ providerTimeoutMs: 10 });
    const resultPromise = service.count(accountingRequest("timeout"), {
      capability: capability((_request, providerSignal) => {
        signal = providerSignal;
        return deferred.promise;
      }),
    });

    await expect(resultPromise).resolves.toMatchObject({
      source: "conservative_fallback",
      cacheStatus: "bypass",
    });
    expect(signal?.aborted).toBe(true);
    expect(service.debugState().physicalFlights).toBe(1);
    deferred.resolve(completeCount(100));
    await vi.waitFor(() => {
      expect(service.debugState()).toMatchObject({
        physicalFlights: 0,
        cacheEntries: 0,
      });
    });
  });
});

describe("validation, context enforcement, and telemetry", () => {
  test("has zero fallback undercounts on the committed calibration corpus", () => {
    const service = new TokenAccountingService();

    for (const sample of calibrationCorpus.cases) {
      const result = estimateTokenAccountingRequest(
        createTokenAccountingRequest({
          provider: sample.provider,
          model: sample.model,
          messages: [{ role: "user", content: sample.content }],
          options: {},
          reservedOutputTokens: 0,
        }),
      );
      expect(result.inputTokens, sample.id).toBeGreaterThanOrEqual(
        sample.referenceInputTokens,
      );
      service.recordProviderUsage(result, sample.referenceInputTokens);
    }

    expect(
      service.metricsSnapshot().every((metric) => metric.undercountSamples === 0),
    ).toBe(true);
  });

  test("rejects over-large and non-canonicalizable complete requests", async () => {
    const byteBounded = new TokenAccountingService({ maxRequestBytes: 128 });
    await expect(
      byteBounded.count(accountingRequest("x".repeat(500))),
    ).rejects.toMatchObject({ code: "request_too_large" });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const request = accountingRequest("cycle", {
      options: {
        tools: [
          {
            ...TOOL,
            function: { ...TOOL.function, parameters: cyclic },
          },
        ],
      },
    });
    await expect(new TokenAccountingService().count(request)).rejects.toMatchObject(
      { code: "request_not_canonicalizable" },
    );
  });

  test("enforces input plus reserved output against the context window", () => {
    const result = estimateTokenAccountingRequest(accountingRequest("context"));

    expect(() =>
      assertTokenAccountingWithinContext(result, result.totalTokens),
    ).not.toThrow();
    expect(() =>
      assertTokenAccountingWithinContext(result, result.totalTokens - 1),
    ).toThrow(/exceeds context window/u);
    expect(() => assertTokenAccountingWithinContext(result, 0)).toThrow(
      TokenAccountingError,
    );
  });

  test("emits only aggregate provider/model/content metrics", () => {
    const service = new TokenAccountingService();
    const result = estimateTokenAccountingRequest(
      accountingRequest("TOP SECRET PROMPT", {
        endpointIdentity: "https://user:password@private.example/v1?token=secret",
      }),
    );
    service.recordProviderUsage(result, result.inputTokens + 7);
    const snapshot = service.metricsSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toEqual([
      expect.objectContaining({
        provider: "test-provider",
        model: "test-model",
        source: "conservative_fallback",
        samples: 1,
        reportedInputTokens: result.inputTokens + 7,
        undercountSamples: 1,
        maximumUndercountTokens: 7,
      }),
    ]);
    expect(serialized).not.toContain("TOP SECRET PROMPT");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("digest");
  });

  test("bounds aggregate metric cardinality", () => {
    const service = new TokenAccountingService();
    const result = estimateTokenAccountingRequest(accountingRequest("metric"));

    for (
      let index = 0;
      index <= TOKEN_ACCOUNTING_METRICS_MAX_PARTITIONS;
      index += 1
    ) {
      service.recordProviderUsage(
        { ...result, model: `model-${index}` },
        result.inputTokens,
      );
    }

    const snapshot = service.metricsSnapshot();
    expect(snapshot).toHaveLength(TOKEN_ACCOUNTING_METRICS_MAX_PARTITIONS);
    expect(snapshot).toContainEqual(
      expect.objectContaining({ provider: "other", model: "other" }),
    );
  });
});
