import { expect, test, vi } from "vitest";

import {
  retryWithAuthRefresh,
  type AuthRefreshCallbacks,
  type UnauthorizedError,
} from "../../../../src/llm/providers/grok/auth-refresh.js";

function unauthorized(status: 401 | 403, message = "Forbidden"): UnauthorizedError {
  return Object.assign(new Error(message), { status }) as UnauthorizedError;
}

test("refreshed outcome retries the operation with the new bearer", async () => {
  const op = vi
    .fn<(bearer: string) => Promise<string>>()
    .mockRejectedValueOnce(unauthorized(401))
    .mockResolvedValueOnce("ok");
  const callbacks: AuthRefreshCallbacks = {
    refreshBearer: async () => ({ kind: "refreshed", bearer: "bearer-2" }),
  };

  await expect(retryWithAuthRefresh("bearer-1", op, callbacks)).resolves.toBe("ok");
  expect(op).toHaveBeenNthCalledWith(1, "bearer-1");
  expect(op).toHaveBeenNthCalledWith(2, "bearer-2");
});

test("exhausted outcome surfaces the reason in the thrown error", async () => {
  // Before this fix the raw 401/403 bubbled with just "Forbidden", which the
  // TUI rendered with zero context — users read it as "logged out" even when
  // the refresh failure was transient. The reason must ride along.
  const op = vi
    .fn<(bearer: string) => Promise<string>>()
    .mockRejectedValue(unauthorized(403, "Forbidden"));
  const callbacks: AuthRefreshCallbacks = {
    refreshBearer: async () => ({
      kind: "exhausted",
      reason: "xAI OAuth token refresh temporarily failed",
    }),
  };

  const thrown = await retryWithAuthRefresh("bearer-1", op, callbacks).then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error as Error & { status?: number; cause?: unknown },
  );
  expect(thrown.message).toContain("Forbidden");
  expect(thrown.message).toContain("xAI OAuth token refresh temporarily failed");
  expect(thrown.status).toBe(403);
  expect((thrown.cause as Error).message).toBe("Forbidden");
});

test("skipped outcome bubbles the original error unchanged", async () => {
  const original = unauthorized(401, "Unauthorized");
  const op = vi.fn<(bearer: string) => Promise<string>>().mockRejectedValue(original);
  const callbacks: AuthRefreshCallbacks = {
    refreshBearer: async () => ({
      kind: "skipped",
      reason: "grok_bearer_key_mode_has_no_refresh",
    }),
  };

  await expect(retryWithAuthRefresh("bearer-1", op, callbacks)).rejects.toBe(original);
});

test("non-auth errors are not retried", async () => {
  const boom = new Error("boom");
  const op = vi.fn<(bearer: string) => Promise<string>>().mockRejectedValue(boom);
  const refreshBearer = vi.fn();
  await expect(
    retryWithAuthRefresh("bearer-1", op, { refreshBearer } as unknown as AuthRefreshCallbacks),
  ).rejects.toBe(boom);
  expect(refreshBearer).not.toHaveBeenCalled();
});
