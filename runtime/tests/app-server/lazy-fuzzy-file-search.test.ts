import { describe, expect, test, vi } from "vitest";
import { createLazyFuzzyFileSearch } from "../../src/app-server/lazy-fuzzy-file-search.js";
import type { AgenCFuzzyFileSearch } from "../../src/app-server/fuzzy-file-search.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("lazy fuzzy search lifecycle", () => {
  test("unused shutdown does not load the index", async () => {
    const load = vi.fn<() => Promise<AgenCFuzzyFileSearch>>();
    const service = createLazyFuzzyFileSearch(load);
    const closing = service.close!();
    expect(service.close!()).toBe(closing);
    await closing;
    await expect(service.search({ query: "file", roots: ["/repo"] })).rejects.toThrow("fuzzy-file search service is closed");
    expect(load).not.toHaveBeenCalled();
  });

  test("concurrent searches share initialization and forward authority and cancellation", async () => {
    const loading = deferred<AgenCFuzzyFileSearch>();
    const load = vi.fn(() => loading.promise);
    const result = { files: [] };
    const search = vi.fn().mockResolvedValue(result);
    const close = vi.fn().mockResolvedValue(undefined);
    const service = createLazyFuzzyFileSearch(load);
    const params = { query: "file", roots: ["/repo"] };
    const options = { allowedRoots: ["/repo"], signal: new AbortController().signal, cancellationScope: "client" };
    const requests = [service.search(params, options), service.search(params, options)];
    expect(load).toHaveBeenCalledTimes(1);
    loading.resolve({ search, close });
    expect(await Promise.all(requests)).toEqual([result, result]);
    expect(search).toHaveBeenCalledWith(params, options);
    expect(search).toHaveBeenCalledTimes(2);
    await service.close!();
    await service.close!();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("shutdown during loading disposes the service without starting a search", async () => {
    const loading = deferred<AgenCFuzzyFileSearch>();
    const service = createLazyFuzzyFileSearch(() => loading.promise);
    const request = service.search({ query: "file", roots: ["/repo"] });
    const rejected = expect(request).rejects.toThrow("fuzzy-file search service is closed");
    const closing = service.close!();
    const search = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    loading.resolve({ search, close });
    await rejected;
    await closing;
    expect(search).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("service failures retain their identity", async () => {
    const failure = new Error("search failure");
    const service = createLazyFuzzyFileSearch(async () => ({ search: async () => { throw failure; } }));
    await expect(service.search({ query: "file", roots: ["/repo"] })).rejects.toBe(failure);
    await service.close!();
  });
});
