import { describe, expect, test } from "vitest";
import {
  LLMCaptivePortalError,
  LLMCertificateError,
  classifyLLMFailure,
  mapLLMError,
} from "./errors.js";

describe("LLM error network classification", () => {
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
