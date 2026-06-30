import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthBackend } from "../../auth/backend.js";
import {
  computePolicyLimitsChecksum,
  createPolicyLimitsService,
  stablePolicyLimitsStringify,
  type PolicyLimitsService,
} from "./index.js";
import { parsePolicyLimitsResponse } from "./types.js";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersFromCall(fetchMock: ReturnType<typeof vi.fn>): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function remoteBackend(overrides: Partial<AuthBackend> = {}): AuthBackend {
  return {
    kind: "remote",
    login: vi.fn(async () => ({ authenticated: true, provider: "remote" })),
    logout: vi.fn(async () => ({ authenticated: false })),
    whoami: vi.fn(async () => ({ authenticated: true, provider: "remote" })),
    vendKey: vi.fn(async (provider, sessionId) => ({
      provider,
      sessionId,
      apiKey: "managed-policy-key",
    })),
    inferAgencModel: vi.fn(async () => ({
      provider: "agenc",
      model: "agenc-opus-4-7",
    })),
    getSubscriptionTier: vi.fn(async () => "team"),
    ...overrides,
  };
}

describe("policy limits service", () => {
  let home = "";
  const services: PolicyLimitsService[] = [];

  beforeEach(async () => {
    home = await mkdtempHome();
  });

  afterEach(async () => {
    for (const service of services.splice(0)) {
      service.stopBackgroundPolling();
    }
    vi.restoreAllMocks();
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  });

  function makeService(
    options: Parameters<typeof createPolicyLimitsService>[0],
  ): PolicyLimitsService {
    const service = createPolicyLimitsService({
      agencHome: home,
      providerName: "anthropic",
      endpoint: "https://id.agenc.ag/v1/policy-limits",
      sleep: async () => {},
      ...options,
    });
    services.push(service);
    return service;
  }

  it("validates policy limit responses without carrying the donor schema wrapper", () => {
    const parsed = parsePolicyLimitsResponse({
      restrictions: { allow_remote_sessions: { allowed: false } },
    });
    expect(parsed?.restrictions.allow_remote_sessions?.allowed).toBe(false);
    expect(parsePolicyLimitsResponse({ restrictions: [] })).toBeNull();
    expect(
      parsePolicyLimitsResponse({
        restrictions: { allow_remote_sessions: { allowed: "no" } },
      }),
    ).toBeNull();

    const hostile = parsePolicyLimitsResponse(
      JSON.parse(
        '{"restrictions":{"__proto__":{"allowed":false},"toString":{"allowed":false}}}',
      ),
    );
    expect(Object.getPrototypeOf(hostile?.restrictions)).toBeNull();
    expect(hostile?.restrictions["__proto__"]?.allowed).toBe(false);
    expect(hostile?.restrictions["toString"]?.allowed).toBe(false);
  });

  it("fetches API-key policy limits, persists them, and denies configured policies", async () => {
    const fetchMock = vi.fn(async () =>
      response(200, {
        restrictions: { allow_remote_sessions: { allowed: false } },
      }),
    );
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
    });

    await service.loadPolicyLimits();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://id.agenc.ag/v1/policy-limits",
    );
    expect(headersFromCall(fetchMock).get("x-api-key")).toBe(
      "direct-policy-key",
    );
    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(false);
    expect(service.isPolicyAllowed("unknown_policy")).toBe(true);
    await expect(readFile(service.cachePath(), "utf8")).resolves.toContain(
      "allow_remote_sessions",
    );
    expect((await stat(service.cachePath())).mode & 0o777).toBe(0o600);
  });

  it("does not send auth headers to environment-controlled non-AgenC endpoints", async () => {
    const fetchMock = vi.fn(async () => response(404));
    const service = makeService({
      apiKey: "direct-policy-key",
      env: {
        HOME: home,
        AGENC_POLICY_LIMITS_URL: "http://127.0.0.1:9999/policy-limits",
      },
      fetchImpl: fetchMock,
    });

    await service.loadPolicyLimits();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://id.agenc.ag/v1/policy-limits",
    );
  });

  it("sends a checksum validator and uses the stale cache on 304", async () => {
    const stale = { allow_product_feedback: { allowed: false } };
    const fetchMock = vi.fn(async () => response(304));
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
    });
    await mkdir(dirname(service.cachePath()), { recursive: true });
    await writeFile(
      service.cachePath(),
      `${stablePolicyLimitsStringify({ restrictions: stale }, 2)}\n`,
    );

    await service.loadPolicyLimits();

    expect(headersFromCall(fetchMock).get("if-none-match")).toBe(
      `"${computePolicyLimitsChecksum(stale)}"`,
    );
    expect(service.isPolicyAllowed("allow_product_feedback")).toBe(false);
  });

  it("clears stale restrictions on 404 and fails open", async () => {
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: vi.fn(async () => response(404)),
    });
    await mkdir(dirname(service.cachePath()), { recursive: true });
    await writeFile(
      service.cachePath(),
      stablePolicyLimitsStringify({
        restrictions: { allow_remote_sessions: { allowed: false } },
      }),
    );

    await service.loadPolicyLimits();

    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(true);
    await expect(readFile(service.cachePath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not retry non-JSON successful responses", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const sleep = vi.fn(async () => {});
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
      sleep,
    });

    await service.loadPolicyLimits();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(true);
    await expect(readFile(service.cachePath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not retry invalid successful response shapes", async () => {
    const fetchMock = vi.fn(async () =>
      response(200, {
        restrictions: { allow_remote_sessions: { allowed: "no" } },
      }),
    );
    const sleep = vi.fn(async () => {});
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
      sleep,
    });

    await service.loadPolicyLimits();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(true);
  });

  it("retries transient failures and reuses stale cache when the API stays down", async () => {
    const retryFetch = vi
      .fn()
      .mockResolvedValueOnce(response(500, { error: "busy" }))
      .mockResolvedValueOnce(
        response(200, {
          restrictions: { allow_remote_sessions: { allowed: false } },
        }),
      );
    const sleep = vi.fn(async () => {});
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: retryFetch,
      sleep,
    });

    await service.loadPolicyLimits();

    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(false);

    const staleService = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: vi.fn(async () => response(500, { error: "down" })),
      maxRetries: 0,
    });
    await mkdir(dirname(staleService.cachePath()), { recursive: true });
    await writeFile(
      staleService.cachePath(),
      stablePolicyLimitsStringify({
        restrictions: { allow_product_feedback: { allowed: false } },
      }),
    );

    await staleService.loadPolicyLimits();

    expect(staleService.isPolicyAllowed("allow_product_feedback")).toBe(false);
  });

  it("keeps valid fetched restrictions in memory if disk persistence fails", async () => {
    const fileHome = join(home, "file-home");
    await writeFile(fileHome, "not a directory");
    const service = createPolicyLimitsService({
      agencHome: fileHome,
      providerName: "anthropic",
      apiKey: "direct-policy-key",
      endpoint: "https://id.agenc.ag/v1/policy-limits",
      fetchImpl: vi.fn(async () =>
        response(200, {
          restrictions: { allow_remote_sessions: { allowed: false } },
        }),
      ),
      sleep: async () => {},
    });
    services.push(service);

    await service.loadPolicyLimits();

    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(false);
  });

  it("does not retry auth failures", async () => {
    const fetchMock = vi.fn(async () => response(401, { error: "no" }));
    const sleep = vi.fn(async () => {});
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
      sleep,
    });

    await service.loadPolicyLimits();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(true);
  });

  it("gates remote-auth policy fetches to team, enterprise, and C4E tiers", async () => {
    const fetchMock = vi.fn(async () =>
      response(200, {
        restrictions: { allow_remote_control: { allowed: false } },
      }),
    );
    const backend = remoteBackend();
    const freeService = makeService({
      providerName: "agenc",
      authBackend: backend,
      authSubscriptionTier: "free",
      fetchImpl: fetchMock,
      sessionId: "session-free",
    });

    await freeService.loadPolicyLimits();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(backend.vendKey).not.toHaveBeenCalled();

    const teamService = makeService({
      providerName: "agenc",
      authBackend: backend,
      authSubscriptionTier: "team",
      fetchImpl: fetchMock,
      sessionId: "session-team",
    });

    await teamService.loadPolicyLimits();

    expect(backend.vendKey).toHaveBeenCalledWith("agenc", "session-team");
    expect(headersFromCall(fetchMock).get("x-api-key")).toBe(
      "managed-policy-key",
    );
    expect(teamService.isPolicyAllowed("allow_remote_control")).toBe(false);

    const enterpriseService = makeService({
      providerName: "agenc",
      authBackend: backend,
      authSubscriptionTier: "enterprise",
      fetchImpl: fetchMock,
      sessionId: "session-enterprise",
    });

    await enterpriseService.loadPolicyLimits();

    expect(backend.vendKey).toHaveBeenCalledWith(
      "agenc",
      "session-enterprise",
    );

    const c4eBackend = remoteBackend({
      getSubscriptionTier: vi.fn(async () => "c4e" as never),
    });
    const c4eService = makeService({
      providerName: "agenc",
      authBackend: c4eBackend,
      fetchImpl: fetchMock,
      sessionId: "session-c4e",
    });

    await c4eService.loadPolicyLimits();

    expect(c4eBackend.vendKey).toHaveBeenCalledWith("agenc", "session-c4e");
  });

  it("fails open when remote managed-key or subscription lookup fails", async () => {
    const fetchMock = vi.fn(async () => response(200, { restrictions: {} }));
    const vendFailure = makeService({
      providerName: "agenc",
      authBackend: remoteBackend({
        vendKey: vi.fn(async () => {
          throw new Error("no managed key");
        }),
      }),
      authSubscriptionTier: "team",
      fetchImpl: fetchMock,
    });

    await vendFailure.loadPolicyLimits();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vendFailure.isPolicyAllowed("allow_remote_sessions")).toBe(true);

    const tierFailure = makeService({
      providerName: "agenc",
      authBackend: remoteBackend({
        getSubscriptionTier: vi.fn(async () => {
          throw new Error("no tier");
        }),
      }),
      fetchImpl: fetchMock,
    });

    await tierFailure.loadPolicyLimits();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tierFailure.isPolicyAllowed("allow_remote_sessions")).toBe(true);
  });

  it("does not fetch for third-party providers or custom first-party base URLs", async () => {
    const fetchMock = vi.fn(async () => response(200, { restrictions: {} }));
    const thirdParty = makeService({
      providerName: "openai",
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
    });
    const customBase = makeService({
      providerName: "anthropic",
      baseURL: "http://127.0.0.1:9999/v1",
      apiKey: "direct-policy-key",
      fetchImpl: fetchMock,
    });

    await thirdParty.loadPolicyLimits();
    await customBase.loadPolicyLimits();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for essential traffic policy misses only", () => {
    const service = makeService({
      apiKey: "direct-policy-key",
      essentialTrafficOnly: true,
      fetchImpl: vi.fn(),
    });

    expect(service.isPolicyAllowed("allow_product_feedback")).toBe(false);
    expect(service.isPolicyAllowed("allow_remote_sessions")).toBe(true);
  });

  it("starts background polling idempotently", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const service = makeService({
      apiKey: "direct-policy-key",
      fetchImpl: vi.fn(),
    });

    service.startBackgroundPolling();
    service.startBackgroundPolling();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

async function mkdtempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-policy-limits-"));
}
