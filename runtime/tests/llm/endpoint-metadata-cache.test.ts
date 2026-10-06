import { describe, expect, it, vi } from "vitest";
import { EndpointMetadataCache, endpointMetadataForTransport, refreshEndpointMetadata } from "../../src/llm/endpoint-metadata-cache.js";

const request = { baseUrl: "https://example.test/v1", url: "https://example.test/v1/models", method: "GET", timeoutMs: 1000 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("EndpointMetadataCache", () => {
  it("clones the initial downloader, concurrent waiters and hits", async () => {
    const cache = new EndpointMetadataCache();
    const scope = cache.observe("openai", "account-a");
    const pending = deferred<{ data: number[] }>();
    const download = vi.fn(() => pending.promise);
    const a = cache.get(scope, request, download);
    const b = cache.get(scope, request, download);
    const input = { data: [1] };
    pending.resolve(input);
    const first = await a as typeof input;
    first.data.push(2);
    input.data.push(3);
    expect(await b).toEqual({ data: [1] });
    const hit = await cache.get(scope, request, download) as typeof input;
    hit.data.push(4);
    expect(await cache.get(scope, request, download)).toEqual({ data: [1] });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each([
    { baseUrl: "https://example.test/v1/" },
    { url: "https://example.test/v1/models?account=b" },
    { method: "POST" }, { body: "{}" }, { timeoutMs: 999 },
    { headers: { authorization: "Bearer b" } },
    { headers: { "openai-organization": "b" } },
  ])("separates request authority %j", async (change) => {
    const cache = new EndpointMetadataCache();
    const scope = cache.observe("openai", "a");
    const download = vi.fn(async () => ({ count: download.mock.calls.length }));
    expect(await cache.get(scope, request, download)).toEqual({ count: 1 });
    expect(await cache.get(scope, { ...request, ...change }, download)).toEqual({ count: 2 });
  });

  it("canonicalizes effective header names/order, not their values", async () => {
    const cache = new EndpointMetadataCache();
    const scope = cache.observe("openai", "a");
    const download = vi.fn(async () => ({}));
    await cache.get(scope, { ...request, headers: { Authorization: "Bearer a", X: "one" } }, download);
    await cache.get(scope, { ...request, headers: { x: "one", authorization: "Bearer a" } }, download);
    expect(download).toHaveBeenCalledTimes(1);
    await cache.get(scope, { ...request, headers: { x: "One", authorization: "Bearer a" } }, download);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("isolates providers, transports, and A to B to A rotations", async () => {
    const transportA = vi.fn<typeof fetch>();
    const transportB = vi.fn<typeof fetch>();
    const cache = endpointMetadataForTransport(transportA);
    expect(endpointMetadataForTransport(transportA)).toBe(cache);
    expect(endpointMetadataForTransport(transportB)).not.toBe(cache);
    const download = vi.fn(async () => ({}));
    await cache.get(cache.observe("openai", "a"), request, download);
    await cache.get(cache.observe("deepseek", "a"), request, download);
    await cache.get(cache.observe("openai", "b"), request, download);
    await cache.get(cache.observe("openai", "a"), request, download);
    expect(download).toHaveBeenCalledTimes(4);
  });

  it("starts nonsliding monotonic expiry at completion, with no stale-on-error", async () => {
    let now = 0;
    const cache = new EndpointMetadataCache({ now: () => now, reuseMs: 10 });
    const scope = cache.observe("openai", "a");
    const pending = deferred<object>();
    const first = cache.get(scope, request, () => pending.promise);
    now = 100;
    pending.resolve({ limit: 100 });
    await first;
    now = 109;
    const download = vi.fn(async () => undefined);
    expect(await cache.get(scope, request, download)).toEqual({ limit: 100 });
    now = 110;
    expect(await cache.get(scope, request, download)).toBeUndefined();
    expect(download).toHaveBeenCalledTimes(1);
    const retryScope = cache.observe("openai", "a");
    expect(await cache.get(retryScope, request, async () => ({ limit: 20 }))).toEqual({ limit: 20 });
  });

  it.each(["success", "failure"])("fences pending %s through refresh without deleting newer pending", async (outcome) => {
    const cache = new EndpointMetadataCache();
    const oldScope = cache.observe("openai", "a");
    const old = deferred<object>();
    const oldResult = cache.get(oldScope, request, () => old.promise);
    await Promise.resolve();
    refreshEndpointMetadata();
    const newScope = cache.observe("openai", "a");
    const next = deferred<object>();
    const download = vi.fn(() => next.promise);
    const newResult = cache.get(newScope, request, download);
    await Promise.resolve();
    if (outcome === "success") old.resolve({ old: true });
    else old.reject(new Error("old transport failure"));
    expect(await oldResult).toEqual(outcome === "success" ? { old: true } : undefined);
    const joined = cache.get(newScope, request, download);
    next.resolve({ new: true });
    expect(await newResult).toEqual({ new: true });
    expect(await joined).toEqual({ new: true });
    expect(download).toHaveBeenCalledTimes(1);
    expect(await cache.get(newScope, request, download)).toEqual({ new: true });
  });

  it("does not retain rejected, absent or invalid JSON values", async () => {
    const cache = new EndpointMetadataCache();
    for (const download of [async () => { throw new Error("offline"); }, async () => undefined,
      async () => { const cycle: Record<string, unknown> = {}; cycle.self = cycle; return cycle; }]) {
      const scope = cache.observe("openai", "a");
      expect(await cache.get(scope, request, download)).toBeUndefined();
      expect(cache.observe("openai", "a")).not.toBe(scope);
    }
  });

  it("evicts LRU entries with correct byte accounting and skips oversize values", async () => {
    const cache = new EndpointMetadataCache({ maxEntries: 2, maxEntryBytes: 8, maxBytes: 8 });
    const scope = cache.observe("openai", "a");
    const download = vi.fn(async () => "ab"); // four UTF-8 bytes including quotes
    const req = (body: string) => ({ ...request, body });
    await cache.get(scope, req("a"), download);
    await cache.get(scope, req("b"), download);
    await cache.get(scope, req("a"), download); // a is MRU
    await cache.get(scope, req("c"), download); // evicts b
    await cache.get(scope, req("a"), download);
    expect(download).toHaveBeenCalledTimes(3);
    await cache.get(scope, req("b"), download);
    expect(download).toHaveBeenCalledTimes(4);
    const large = vi.fn(async () => "123456789");
    await cache.get(scope, req("large"), large);
    await cache.get(scope, req("large"), large);
    expect(large).toHaveBeenCalledTimes(2);
    cache.clear();
    await cache.get(cache.observe("openai", "a"), req("a"), download);
    expect(download).toHaveBeenCalledTimes(5);
  });

  it("falls back uncached at pending saturation, including invalidated work", async () => {
    const cache = new EndpointMetadataCache({ maxPending: 1 });
    const old = deferred<object>();
    const scope = cache.observe("openai", "a");
    const a = cache.get(scope, request, () => old.promise);
    await Promise.resolve();
    cache.invalidate(scope);
    const nextScope = cache.observe("openai", "a");
    const next = vi.fn(async () => ({ next: true }));
    await cache.get(nextScope, request, next);
    await cache.get(nextScope, request, next);
    expect(next).toHaveBeenCalledTimes(2);
    old.resolve({ old: true });
    await a;
    await cache.get(nextScope, request, next);
    await cache.get(nextScope, request, next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
