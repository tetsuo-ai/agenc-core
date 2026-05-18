import { describe, expect, it, vi } from "vitest";

import {
  COPILOT_HEADERS,
  COPILOT_TOKEN_URL,
  DEFAULT_GITHUB_DEVICE_FLOW_CLIENT_ID,
  DEFAULT_GITHUB_DEVICE_SCOPE,
  GITHUB_DEVICE_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_DEVICE_VERIFICATION_URL,
  GitHubDeviceFlowError,
  exchangeForCopilotToken,
  getGitHubDeviceFlowClientId,
  isGitHubVerificationUri,
  pollForGitHubAccessToken,
  requestGitHubDeviceCode,
  startGitHubDeviceFlow,
} from "./device-flow.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function bodyParams(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(String(body ?? ""));
}

function headersFrom(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

describe("GitHub device flow", () => {
  it("uses the AgenC env override and falls back to the public device-flow client id", () => {
    expect(getGitHubDeviceFlowClientId({})).toBe(
      DEFAULT_GITHUB_DEVICE_FLOW_CLIENT_ID,
    );
    expect(
      getGitHubDeviceFlowClientId({
        AGENC_GITHUB_DEVICE_CLIENT_ID: "  local-client  ",
      }),
    ).toBe("local-client");
  });

  it("requests a device code with the read:user scope", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: GITHUB_DEVICE_VERIFICATION_URL,
        expires_in: 600,
        interval: 2,
      }),
    );

    const device = await requestGitHubDeviceCode({
      clientId: "client-1",
      fetchImpl,
    });

    expect(device).toEqual({
      device_code: "device-1",
      user_code: "ABCD-1234",
      verification_uri: GITHUB_DEVICE_VERIFICATION_URL,
      expires_in: 600,
      interval: 2,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      GITHUB_DEVICE_CODE_URL,
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(headersFrom(init).get("accept")).toBe("application/json");
    expect(bodyParams(init).get("client_id")).toBe("client-1");
    expect(bodyParams(init).get("scope")).toBe(DEFAULT_GITHUB_DEVICE_SCOPE);
  });

  it("falls back to read:user when a custom scope is rejected as invalid", async () => {
    const seenScopes: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const scope = bodyParams(init).get("scope") ?? "";
      seenScopes.push(scope);
      if (seenScopes.length === 1) {
        return jsonResponse({ error: "invalid_scope" }, 400);
      }
      return jsonResponse({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: GITHUB_DEVICE_VERIFICATION_URL,
      });
    });

    await expect(
      requestGitHubDeviceCode({
        clientId: "client-1",
        fetchImpl,
        scope: "read:user,models:read",
      }),
    ).resolves.toMatchObject({ device_code: "device-1" });
    expect(seenScopes).toEqual(["read:user,models:read", "read:user"]);
  });

  it("polls until an access token is returned and handles slow_down cadence", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down", interval: 7 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "oauth-1" }));
    const sleep = vi.fn(async () => {});

    const token = await pollForGitHubAccessToken("device-1", {
      clientId: "client-1",
      fetchImpl,
      initialIntervalSeconds: 2,
      sleep,
    });

    expect(token).toBe("oauth-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(GITHUB_DEVICE_ACCESS_TOKEN_URL);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(bodyParams(init).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(bodyParams(init).get("device_code")).toBe("device-1");
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("uses the device-code interval when the high-level flow polls pending authorization", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      order.push(String(input));
      if (input === GITHUB_DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: "device-1",
          user_code: "ABCD-1234",
          verification_uri: GITHUB_DEVICE_VERIFICATION_URL,
          expires_in: 600,
          interval: 3,
        });
      }
      if (
        input === GITHUB_DEVICE_ACCESS_TOKEN_URL &&
        order.filter((entry) => entry === GITHUB_DEVICE_ACCESS_TOKEN_URL)
          .length === 1
      ) {
        return jsonResponse({ error: "authorization_pending" });
      }
      if (input === GITHUB_DEVICE_ACCESS_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-1" });
      }
      if (input === COPILOT_TOKEN_URL) {
        return jsonResponse({
          token: "copilot-1",
          expires_at: 1_700_000_000,
          refresh_in: 3600,
          endpoints: { api: "https://api.githubcopilot.com" },
        });
      }
      return textResponse("unexpected url", 500);
    });
    const sleep = vi.fn(async () => {});
    const onDeviceCode = vi.fn(() => {
      order.push("prompted");
    });
    const openVerificationUri = vi.fn(async (uri: string) => {
      order.push(`opened:${uri}`);
    });

    const result = await startGitHubDeviceFlow({
      clientId: "client-1",
      fetchImpl,
      onDeviceCode,
      openBrowser: true,
      openVerificationUri,
      sleep,
    });

    expect(result.copilotToken.token).toBe("copilot-1");
    expect(onDeviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ user_code: "ABCD-1234" }),
    );
    expect(openVerificationUri).toHaveBeenCalledWith(
      GITHUB_DEVICE_VERIFICATION_URL,
    );
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(order).toEqual([
      GITHUB_DEVICE_CODE_URL,
      "prompted",
      `opened:${GITHUB_DEVICE_VERIFICATION_URL}`,
      GITHUB_DEVICE_ACCESS_TOKEN_URL,
      GITHUB_DEVICE_ACCESS_TOKEN_URL,
      COPILOT_TOKEN_URL,
    ]);
  });

  it("rejects unsafe verification URIs before opening or prompting", async () => {
    expect(isGitHubVerificationUri(GITHUB_DEVICE_VERIFICATION_URL)).toBe(true);
    expect(isGitHubVerificationUri("http://github.com/login/device")).toBe(
      false,
    );
    expect(
      isGitHubVerificationUri("https://github.com/login/device?x=1"),
    ).toBe(true);
    expect(
      isGitHubVerificationUri("https://127.0.0.1/login/device"),
    ).toBe(false);

    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: "https://127.0.0.1/login/device",
      }),
    );

    await expect(
      requestGitHubDeviceCode({ clientId: "client-1", fetchImpl }),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("keeps the default polling sleep referenced while waiting", async () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback: () => void, _ms?: number) => {
        queueMicrotask(callback);
        return { unref } as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "oauth-1" }));

    try {
      await expect(
        pollForGitHubAccessToken("device-1", {
          clientId: "client-1",
          fetchImpl,
          initialIntervalSeconds: 2,
        }),
      ).resolves.toBe("oauth-1");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
      expect(unref).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("throws typed terminal errors for expired_token and access_denied", async () => {
    const expiredFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "expired_token" }),
    );
    await expect(
      pollForGitHubAccessToken("device-1", {
        clientId: "client-1",
        fetchImpl: expiredFetch,
      }),
    ).rejects.toMatchObject({
      name: "GitHubDeviceFlowError",
      code: "expired_token",
    });

    const deniedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "access_denied" }),
    );
    await expect(
      pollForGitHubAccessToken("device-1", {
        clientId: "client-1",
        fetchImpl: deniedFetch,
      }),
    ).rejects.toMatchObject({
      name: "GitHubDeviceFlowError",
      code: "access_denied",
    });
  });

  it("turns HTTP failures into GitHubDeviceFlowError", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      textResponse("server down", 503),
    );

    await expect(
      requestGitHubDeviceCode({ clientId: "client-1", fetchImpl }),
    ).rejects.toMatchObject({
      code: "http_error",
      status: 503,
    });
  });

  it("turns network failures into GitHubDeviceFlowError", async () => {
    const cause = new Error("offline");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw cause;
    });

    await expect(
      pollForGitHubAccessToken("device-1", {
        clientId: "client-1",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "network_error",
      cause,
    });
  });

  it("rejects malformed access-token responses and immediate timeouts", async () => {
    const malformedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse(["not", "an", "object"]),
    );
    await expect(
      pollForGitHubAccessToken("device-1", {
        clientId: "client-1",
        fetchImpl: malformedFetch,
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });

    await expect(
      pollForGitHubAccessToken("device-1", {
        clientId: "client-1",
        fetchImpl: vi.fn<typeof fetch>(),
        timeoutSeconds: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("exchanges an OAuth token for a Copilot token with the required headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        token: "copilot-1",
        expires_at: 1_700_000_000,
        refresh_in: 3600,
        endpoints: { api: "https://api.githubcopilot.com" },
      }),
    );

    const token = await exchangeForCopilotToken("oauth-1", fetchImpl);

    expect(token.token).toBe("copilot-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      COPILOT_TOKEN_URL,
      expect.objectContaining({ method: "GET" }),
    );
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = headersFrom(init);
    expect(headers.get("authorization")).toBe("Bearer oauth-1");
    for (const [name, value] of Object.entries(COPILOT_HEADERS)) {
      expect(headers.get(name)).toBe(value);
    }
  });

  it("wraps Copilot token exchange HTTP and network failures", async () => {
    const httpFetch = vi.fn<typeof fetch>(async () =>
      textResponse("unauthorized", 401),
    );
    await expect(
      exchangeForCopilotToken("oauth-1", httpFetch),
    ).rejects.toMatchObject({ code: "http_error", status: 401 });

    const cause = new Error("offline");
    const networkFetch = vi.fn<typeof fetch>(async () => {
      throw cause;
    });
    await expect(
      exchangeForCopilotToken("oauth-1", networkFetch),
    ).rejects.toMatchObject({ code: "network_error", cause });
  });

  it("rejects malformed Copilot token responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ token: "copilot-1" }),
    );

    await expect(
      exchangeForCopilotToken("oauth-1", fetchImpl),
    ).rejects.toBeInstanceOf(GitHubDeviceFlowError);
    await expect(
      exchangeForCopilotToken("oauth-1", fetchImpl),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });
});
