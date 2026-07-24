import { describe, expect, it } from "vitest";

import { withTimeout } from "src/llm/timeout.js";
import {
  LLMTimeoutError,
  mapLLMError,
} from "src/llm/errors.js";

// gaphunt3 #42: withTimeout must preserve the external signal's real abort
// reason instead of fabricating a "<provider> request aborted after 0ms"
// timeout error. The fabricated AbortError/ABORT_ERR shape would otherwise be
// downstream-classified by mapLLMError as a (retryable) LLMTimeoutError, even
// though a user/external interrupt is not a provider timeout.

describe("gaphunt3 #42: withTimeout external-signal abort reason", () => {
  it("rejects with the signal's string reason, not 'aborted after 0ms'", async () => {
    const controller = new AbortController();
    const physical = Promise.withResolvers<string>();
    let providerSignal: AbortSignal | undefined;
    let settled = false;
    const promise = withTimeout<string>(
      (signal) => {
        providerSignal = signal;
        return physical.promise;
      },
      undefined, // no positive timeout configured
      "TestProvider",
      controller.signal,
    );
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort("interrupt");
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBe("interrupt");
    await Promise.resolve();
    expect(settled).toBe(false);
    physical.resolve("late result");

    const err = await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );

    // Message reflects the real abort reason, not a fabricated 0ms timeout.
    expect(err.message).toBe("interrupt");
    expect(err.message).not.toContain("after 0ms");
    expect(err.message).not.toMatch(/aborted after/);
  });

  it("does not downstream-classify the external abort as a retryable timeout", async () => {
    const controller = new AbortController();
    const physical = Promise.withResolvers<string>();
    const promise = withTimeout<string>(
      () => physical.promise,
      undefined,
      "TestProvider",
      controller.signal,
    );

    controller.abort("interrupt");
    physical.resolve("late result");

    const err = await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );

    // mapLLMError keys off name==="AbortError" / code==="ABORT_ERR" / /timeout/i.
    // The external-abort error must carry none of those, so it is NOT mapped to
    // the (retryable) LLMTimeoutError.
    expect((err as { name?: unknown }).name).not.toBe("AbortError");
    expect((err as { code?: unknown }).code).not.toBe("ABORT_ERR");

    const mapped = mapLLMError("TestProvider", err, 0);
    expect(mapped).not.toBeInstanceOf(LLMTimeoutError);
  });

  it("does not classify AbortController's default DOMException as a timeout", async () => {
    const controller = new AbortController();
    const physical = Promise.withResolvers<string>();
    const promise = withTimeout<string>(
      () => physical.promise,
      10 * 60_000,
      "TestProvider",
      controller.signal,
    );

    controller.abort();
    physical.resolve("late result");

    const err = await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );

    expect(err.name).not.toBe("AbortError");
    expect((err as { code?: unknown }).code).not.toBe("ABORT_ERR");
    expect(mapLLMError("TestProvider", err, 10 * 60_000)).not.toBeInstanceOf(
      LLMTimeoutError,
    );
  });

  it("preserves an Error reason verbatim (including its name/code)", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    (reason as { name?: unknown }).name = "CancelError";
    const physical = Promise.withResolvers<string>();

    const promise = withTimeout<string>(
      () => physical.promise,
      undefined,
      "TestProvider",
      controller.signal,
    );

    controller.abort(reason);
    physical.resolve("late result");

    const err = await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );

    expect(err).toBe(reason);
    expect(err.message).toBe("user cancelled");
    const mapped = mapLLMError("TestProvider", err, 0);
    expect(mapped).not.toBeInstanceOf(LLMTimeoutError);
  });

  it("still classifies a genuine internal timeout as LLMTimeoutError", async () => {
    const physical = Promise.withResolvers<string>();
    let providerSignal: AbortSignal | undefined;
    let settled = false;
    const promise = withTimeout<string>(
      (signal) => {
        providerSignal = signal;
        return physical.promise;
      },
      5, // small positive timeout
      "TestProvider",
    );
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(providerSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    physical.resolve("late result");

    const err = await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );

    expect((err as { name?: unknown }).name).toBe("AbortError");
    expect(err.message).toContain("aborted after 5ms");
    const mapped = mapLLMError("TestProvider", err, 5);
    expect(mapped).toBeInstanceOf(LLMTimeoutError);
  });

  it("does not start a provider call when the external signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before admission dispatch");
    controller.abort(reason);
    let invoked = false;

    await expect(
      withTimeout(
        async () => {
          invoked = true;
          return "unexpected";
        },
        100,
        "TestProvider",
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(invoked).toBe(false);
  });
});
