import { describe, expect, it, vi } from "vitest";
import { RemoteAuthBackend } from "../../../src/auth/backends/remote.js";

describe("remote authentication request deadlines", () => {
  it.each(["headers", "body"] as const)(
    "aborts model routing while waiting for response %s",
    async (stage) => {
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(controller.signal);
      const entered = Promise.withResolvers<AbortSignal | null | undefined>();
      const headers = Promise.withResolvers<Response>();
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const fetchImpl: typeof fetch = async (_input, init) => {
        const signal = init?.signal;
        const abort = (): void => {
          if (stage === "headers") headers.reject(signal?.reason);
          else body?.error(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (stage === "body") {
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                body = stream;
              },
              pull() {
                entered.resolve(signal);
              },
            }),
          );
          return response;
        }
        entered.resolve(signal);
        return headers.promise;
      };
      const backend = new RemoteAuthBackend({
        env: {},
        token: "test-token",
        fetchImpl,
      });
      const outcome = backend
        .inferAgencModel({
          provider: "agenc",
          requestedModel: "agenc:fast",
          sessionId: "timeout-test",
          subscriptionTier: "pro",
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      try {
        expect(await entered.promise).toBe(controller.signal);
        expect(timeout).toHaveBeenCalledWith(30_000);
        const reason = new DOMException(
          "request deadline elapsed",
          "TimeoutError",
        );
        controller.abort(reason);
        expect((await outcome).error).toMatchObject({ cause: reason });
      } finally {
        const cleanup = new Error("release stalled test request");
        if (stage === "headers") headers.reject(cleanup);
        else body?.error(cleanup);
        await outcome;
        timeout.mockRestore();
      }
    },
  );
});
