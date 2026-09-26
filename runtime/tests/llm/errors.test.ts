import { describe, expect, test } from "vitest";
import {
  LLMCaptivePortalError,
  LLMCertificateError,
  LLMFundsError,
  LLMAuthenticationError,
  classifyLLMFailure,
  mapLLMError,
} from "./errors.js";
import { ProviderHttpClientSession, ProviderHttpError } from "./client-session.js";

describe("LLM error network classification", () => {
  test.each(["cause", "originalError"])("uses a fixed billing message for a refusal in %s", (causeKey) => {
    const message = "Please check your plan and billing details.";
    const error = {
      status: 429,
      message: "Request failed with status code 429",
      [causeKey]: { status: 429, error: { code: "insufficient_quota", message } },
    };
    expect(mapLLMError("openai", error, 30_000)).toMatchObject({
      name: "LLMFundsError", message: `openai error: OpenAI says the account has no credits left or has reached its spending limit.`,
    });
  });

  test.each([
    undefined,
    'Insufficient credits. "request_id": "f00d-1234"',
    "Insufficient credits. 'request-id': 'f00d-1234'",
    'Insufficient credits. "trace": "f00d-1234"',
    'Insufficient credits. request_id=f00d-1234',
    'Insufficient credits. trace=f00d-1234',
  ])("ignores billing cause prose: %s", (message) => {
    const error = {
      status: 429,
      message: "Request failed with status code 429",
      cause: { status: 429, error: { code: "insufficient_quota", message } },
    };
    expect(mapLLMError("openai", error, 30_000)).toMatchObject({
      name: "LLMFundsError", message: "openai error: OpenAI says the account has no credits left or has reached its spending limit.",
    });
  });

  test("maps the full captured xAI response to funds with the default message", () => {
    const message = "Your team 16da42f5-6f8f-41c0-b62f-a77ec198037e has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.";
    const wireError = new ProviderHttpError({
      providerName: "grok", status: 403, headers: new Headers(),
      url: "https://api.x.ai/v1/responses", message: "Forbidden",
      body: { code: "permission-denied", error: message },
    });

    const mapped = mapLLMError("grok", wireError, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped).toMatchObject({ statusCode: 403, message: "grok error: xAI says the account has no credits left or has reached its spending limit." });
  });

  test("ignores the captured xAI wording even without the team ID", () => {
    const message = "Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.";
    expect(mapLLMError("grok", { status: 403, body: { error: message } }, 30_000))
      .toMatchObject({ name: "LLMFundsError", statusCode: 403, message: `grok error: xAI says the account has no credits left or has reached its spending limit.` });
  });

  test("maps a Gemini daily quota response body to a funds stop", () => {
    const wireError = new ProviderHttpError({ providerName: "gemini", status: 429,
      headers: new Headers(), url: "https://generativelanguage.googleapis.com/v1beta/models/test",
      message: "Resource exhausted", body: { error: { status: "RESOURCE_EXHAUSTED",
        details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } } });
    expect(mapLLMError("gemini", wireError, 0).name).toBe("LLMFundsError");
  });

  test.each([
    ["grok", 403, { error: "  Your team has used all available credits.  " }, "xAI"],
    ["xai", 403, { message: "Your team has reached its monthly spending limit." }, "xAI"],
    ["openai", 403, { body: { error: { code: "insufficient_quota", message: "Please check your plan and billing details." } } }, "OpenAI"],
    ["deepseek", 402, { body: { error: { message: "  Insufficient credits.  " } } }, "DeepSeek"],
    ["custom", 402, { body: { message: "Your credit balance is too low." } }, "custom"],
    ["custom", 403, { body: { error: { message: "Your credits are exhausted." } } }, "custom"],
  ])("uses fixed billing wording for %s HTTP %s", (provider, status, details, displayName) => {
    const mapped = mapLLMError(provider, { status, ...details }, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped).toMatchObject({
      statusCode: status,
      message: `${provider} error: ${displayName} says the account has no credits left or has reached its spending limit.`,
    });
  });

  test("ignores billing text containing secrets and request ids", () => {
    const mapped = mapLLMError("grok", {
      status: 403,
      body: {
        code: "permission-denied", request_id: "metadata-request", api_key: "metadata-secret",
        error: "  No credits left. Key xai-1234567890abcdefghijklmnop. Bearer short-token. Request ID: req_private. api_key=private-secret  ",
      },
    }, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped.message).toBe("grok error: xAI says the account has no credits left or has reached its spending limit.");
    expect(mapped.message).not.toMatch(/permission-denied|metadata-|xai-123|short-token|req_private|private-secret/);
    expect(mapped.message).toBe(mapped.message.trim());
  });

  test.each([
    'Insufficient credits. Bearer abc',
    'Your team has reached its monthly spending limit. Request ID f00d-1234',
    'Insufficient credits. Bearer short-token',
    'Insufficient credits. Request ID f00d-1234',
    'Insufficient credits. "request_id": "private-request"',
    'Insufficient credits. Authorization: Basic short-token',
    'Insufficient credits. Cookie: private',
    '<html>Insufficient credits.</html>',
    '{"error":{"message":"Insufficient credits."}}',
    '403 {"error":{"message":"Insufficient credits."}}',
  ])("uses the fixed billing message for provider text: %s", (text) => {
    for (const status of [402, 403]) {
      for (const body of [text, { error: text }, { error: { message: text } }]) {
        const mapped = mapLLMError("grok", {
          status, body, message: "HTTP 403",
        }, 30_000);
        expect(mapped).toBeInstanceOf(LLMFundsError);
        expect(mapped).toMatchObject({
          statusCode: status, message: "grok error: xAI says the account has no credits left or has reached its spending limit.",
        });
      }
    }
  });
  test.each([
    "Forbidden",
    "Access denied. You cannot view credits or change the spending limit.",
    "API key lacks permission to purchase credits.",
  ])("keeps a genuine permission 403 as authentication: %s", (message) => {
    const mapped = mapLLMError("grok", { status: 403, body: { error: message } }, 30_000);
    expect(mapped).toBeInstanceOf(LLMAuthenticationError);
    expect(mapped.message).toBe("grok authentication failed (HTTP 403)");
  });

  test("does not expose internal codes when a billing body has no message", () => {
    const mapped = mapLLMError("openai", {
      status: 403, body: { error: { code: "insufficient_quota" } },
      message: "insufficient_quota",
    }, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped.message).toBe("openai error: OpenAI says the account has no credits left or has reached its spending limit.");
  });

  test("uses the default billing message for an actual transport-generated HTTP 403 message", async () => {
    const session = new ProviderHttpClientSession({
      providerName: "openai", baseURL: "https://example.test/v1", wireApi: "responses",
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
        status: 403, headers: { "content-type": "application/json" },
      }),
    });
    const wireError = await session.requestJson({ body: {} }).catch((error: unknown) => error);
    expect(wireError).toBeInstanceOf(ProviderHttpError);
    expect(wireError).toMatchObject({ message: "HTTP 403", status: 403 });
    const mapped = mapLLMError("openai", wireError, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped).toMatchObject({
      statusCode: 403, message: "openai error: OpenAI says the account has no credits left or has reached its spending limit.",
    });
  });
  test("mapLLMError keeps the transport error as the cause of a generic provider error", () => {
    const socket = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const sdkError = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: socket,
    });
    const mapped = mapLLMError("grok", sdkError, 30_000);
    expect(mapped.message).toBe("grok error: Connection error.");
    expect((mapped as { cause?: unknown }).cause).toBe(sdkError);
    // Already-typed errors pass through untouched, as before.
    expect(mapLLMError("grok", mapped, 30_000)).toBe(mapped);
  });

  test("mapLLMError promotes TLS validation failures into LLMCertificateError", () => {
    const mapped = mapLLMError(
      "openai",
      {
        message: "unable to verify the first certificate",
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        issuer: "Corp Proxy CA",
        subject: "api.openai.com",
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: "2026-05-01T00:00:00Z",
      },
      30_000,
    );

    expect(mapped).toBeInstanceOf(LLMCertificateError);
    expect(mapped).toMatchObject<Partial<LLMCertificateError>>({
      providerName: "openai",
      tlsCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      issuer: "Corp Proxy CA",
      subject: "api.openai.com",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "2026-05-01T00:00:00Z",
    });
    expect((mapped as Error).message).toContain("valid_to=2026-05-01T00:00:00Z");
  });

  test("classifyLLMFailure keeps captive portal failures in provider_error", () => {
    const error = new LLMCaptivePortalError("openai", {
      expected: "json",
      contentType: "text/html; charset=utf-8",
      statusCode: 200,
      url: "https://example.test/v1/responses",
    });

    expect(classifyLLMFailure(error)).toBe("provider_error");
  });
});
