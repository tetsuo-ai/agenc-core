import { describe, expect, it, vi } from "vitest";

import { rememberSuccessfulLookup } from "../../src/llm/remember-successful-lookup.js";

function tables<T>() {
  return {
    inFlight: new Map<string, Promise<T>>(),
    success: new Map<string, T>(),
  };
}

describe("rememberSuccessfulLookup", () => {
  it("returns a cached success without calling load again", async () => {
    const store = tables<string>();
    const load = vi.fn(async () => "ok");

    await expect(
      rememberSuccessfulLookup(store, "k", load, (value) => value === "ok"),
    ).resolves.toBe("ok");
    await expect(
      rememberSuccessfulLookup(store, "k", load, (value) => value === "ok"),
    ).resolves.toBe("ok");

    expect(load).toHaveBeenCalledTimes(1);
    expect(store.success.get("k")).toBe("ok");
    expect(store.inFlight.size).toBe(0);
  });

  it("does not cache a completed lookup that isSuccess rejects", async () => {
    const store = tables<string | undefined>();
    const load = vi
      .fn(async (): Promise<string | undefined> => undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("ok");

    await expect(
      rememberSuccessfulLookup(store, "k", load, (value) => value !== undefined),
    ).resolves.toBeUndefined();
    await expect(
      rememberSuccessfulLookup(store, "k", load, (value) => value !== undefined),
    ).resolves.toBe("ok");

    expect(load).toHaveBeenCalledTimes(2);
    expect(store.success.get("k")).toBe("ok");
  });

  it("clears in-flight state after a thrown load so the next caller retries", async () => {
    const store = tables<string>();
    const load = vi
      .fn(async (): Promise<string> => "ok")
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce("ok");

    await expect(
      rememberSuccessfulLookup(store, "k", load, () => true),
    ).rejects.toThrow("503");
    expect(store.inFlight.size).toBe(0);
    expect(store.success.size).toBe(0);

    await expect(
      rememberSuccessfulLookup(store, "k", load, () => true),
    ).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent callers onto one in-flight load", async () => {
    const store = tables<string>();
    const pending = Promise.withResolvers<string>();
    const load = vi.fn(() => pending.promise);

    const first = rememberSuccessfulLookup(store, "k", load, () => true);
    const second = rememberSuccessfulLookup(store, "k", load, () => true);

    expect(load).toHaveBeenCalledTimes(1);
    expect(store.inFlight.has("k")).toBe(true);

    pending.resolve("shared");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "shared",
      "shared",
    ]);
    expect(store.inFlight.size).toBe(0);
    expect(store.success.get("k")).toBe("shared");
  });
});
