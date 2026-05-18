import { describe, expect, test, vi } from "vitest";
import {
  MAX_CONSECUTIVE_AUTH_FAILURES,
  retryWithOAuthRefresh,
} from "./refresh-loop.js";

describe("retryWithOAuthRefresh", () => {
  test("retains the upstream consecutive auth failure budget", () => {
    expect(MAX_CONSECUTIVE_AUTH_FAILURES).toBe(10);
  });

  test("retries a 401 with a refreshed token", async () => {
    const state = {
      accessToken: "token-1",
      refreshToken: "refresh-1",
      consecutiveAuthFailures: 0,
    };
    const operation = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 401 }))
      .mockResolvedValueOnce("ok");
    const refreshAccessToken = vi.fn().mockResolvedValue({
      kind: "refreshed",
      accessToken: "token-2",
    });

    const result = await retryWithOAuthRefresh(
      state,
      operation,
      { refreshAccessToken },
    );

    expect(result.value).toBe("ok");
    expect(result.state).toBe(state);
    expect(state.accessToken).toBe("token-2");
    expect(state.consecutiveAuthFailures).toBe(0);
    expect(operation).toHaveBeenNthCalledWith(1, "token-1");
    expect(operation).toHaveBeenNthCalledWith(2, "token-2");
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  test("stops after the bounded refresh budget", async () => {
    const state = {
      accessToken: "token-1",
      refreshToken: "refresh-1",
      consecutiveAuthFailures: 0,
    };
    const unauthorized = () =>
      Object.assign(new Error("unauthorized"), { status: 401 });
    const operation = vi.fn().mockRejectedValue(unauthorized());
    const refreshAccessToken = vi.fn().mockResolvedValue({
      kind: "refreshed",
      accessToken: "still-bad",
    });

    await expect(
      retryWithOAuthRefresh(
        state,
        operation,
        { refreshAccessToken },
        { maxConsecutiveFailures: 2 },
      ),
    ).rejects.toMatchObject({ status: 401 });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(state.accessToken).toBe("still-bad");
    expect(state.consecutiveAuthFailures).toBe(2);
  });

  test("preserves consecutive auth failures across failed calls", async () => {
    const unauthorized = () =>
      Object.assign(new Error("unauthorized"), { status: 401 });
    const refreshAccessToken = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "exhausted",
        reason: "refresh revoked",
      })
      .mockResolvedValueOnce({
        kind: "refreshed",
        accessToken: "token-2",
        refreshToken: "refresh-2",
      });
    const state = {
      accessToken: "token-1",
      refreshToken: "refresh-1",
      consecutiveAuthFailures: 0,
    };

    await expect(
      retryWithOAuthRefresh(
        state,
        vi.fn().mockRejectedValue(unauthorized()),
        { refreshAccessToken },
        { maxConsecutiveFailures: 3 },
      ),
    ).rejects.toMatchObject({ status: 401 });

    expect(state.consecutiveAuthFailures).toBe(1);
    expect(state.accessToken).toBe("token-1");

    await expect(
      retryWithOAuthRefresh(
        state,
        vi.fn().mockRejectedValue(unauthorized()),
        { refreshAccessToken },
        { maxConsecutiveFailures: 3 },
      ),
    ).rejects.toMatchObject({ status: 401 });

    expect(refreshAccessToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attempt: 2,
        refreshToken: "refresh-1",
      }),
    );
    expect(state.accessToken).toBe("token-2");
    expect(state.refreshToken).toBe("refresh-2");
    expect(state.consecutiveAuthFailures).toBe(3);
  });
});
