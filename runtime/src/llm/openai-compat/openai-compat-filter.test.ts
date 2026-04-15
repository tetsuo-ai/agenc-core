import { describe, it, expect, vi, afterEach } from "vitest";

import {
  validateBaseUrl,
  validateServerReachable,
  validateModelPresent,
  validateOpenAICompatConfig,
  OpenAICompatServerUnreachableError,
  OpenAICompatUnknownModelError,
} from "./openai-compat-filter.js";
import type { OpenAICompatProviderConfig } from "./types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mockFetchSuccess(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    }),
  );
}

function mockFetchError(error: Error): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

function mockFetchBadJson(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    }),
  );
}

function validModelsBody(ids: string[]): unknown {
  return { data: ids.map((id) => ({ id })) };
}

function minimalConfig(
  overrides: Partial<OpenAICompatProviderConfig> = {},
): OpenAICompatProviderConfig {
  return {
    model: "test-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "local",
    contextWindowTokens: 4096,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateBaseUrl
// ---------------------------------------------------------------------------

describe("validateBaseUrl", () => {
  describe("accepts local and LAN addresses", () => {
    it("accepts 127.0.0.1 (loopback)", () => {
      expect(() => validateBaseUrl("http://127.0.0.1:1234/v1")).not.toThrow();
    });

    it("accepts localhost", () => {
      expect(() => validateBaseUrl("http://localhost:1234/v1")).not.toThrow();
    });

    it("accepts 192.168.x.x (RFC-1918 class C)", () => {
      expect(() =>
        validateBaseUrl("http://192.168.1.100:8080/v1"),
      ).not.toThrow();
    });

    it("accepts 10.x.x.x (RFC-1918 class A)", () => {
      expect(() =>
        validateBaseUrl("http://10.0.0.1:8080/v1"),
      ).not.toThrow();
    });

    it("accepts 172.16.x.x (lower bound of RFC-1918 class B)", () => {
      expect(() =>
        validateBaseUrl("http://172.16.0.1:8080/v1"),
      ).not.toThrow();
    });

    it("accepts 172.31.x.x (upper bound of RFC-1918 class B)", () => {
      expect(() =>
        validateBaseUrl("http://172.31.0.1:8080/v1"),
      ).not.toThrow();
    });

    it("accepts ::1 (IPv6 loopback)", () => {
      expect(() => validateBaseUrl("http://[::1]:1234/v1")).not.toThrow();
    });
  });

  describe("rejects public and invalid addresses", () => {
    it("rejects a public domain", () => {
      expect(() => validateBaseUrl("http://api.openai.com/v1")).toThrow(Error);
    });

    it("rejects a public IP", () => {
      expect(() => validateBaseUrl("http://8.8.8.8:1234/v1")).toThrow(Error);
    });

    it("rejects 172.15.x.x (just below RFC-1918 class B range)", () => {
      expect(() =>
        validateBaseUrl("http://172.15.0.1:8080/v1"),
      ).toThrow(Error);
    });

    it("rejects 172.32.x.x (just above RFC-1918 class B range)", () => {
      expect(() =>
        validateBaseUrl("http://172.32.0.1:8080/v1"),
      ).toThrow(Error);
    });

    it("rejects an invalid URL string", () => {
      expect(() => validateBaseUrl("not-a-url")).toThrow(Error);
    });

    it("error message includes the offending hostname for public IP", () => {
      expect(() => validateBaseUrl("http://8.8.8.8:1234/v1")).toThrow(
        "8.8.8.8",
      );
    });

    it("error message includes the offending hostname for public domain", () => {
      expect(() => validateBaseUrl("http://api.openai.com/v1")).toThrow(
        "api.openai.com",
      );
    });

    it("does not throw OpenAICompatServerUnreachableError — plain Error only", () => {
      expect(() => validateBaseUrl("http://8.8.8.8:1234/v1")).not.toThrow(
        OpenAICompatServerUnreachableError,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// validateServerReachable
// ---------------------------------------------------------------------------

describe("validateServerReachable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("success cases", () => {
    it("returns model ID list from a valid /v1/models response", async () => {
      mockFetchSuccess(validModelsBody(["model-a", "model-b"]));
      const models = await validateServerReachable("http://127.0.0.1:1234/v1");
      expect(models).toEqual(["model-a", "model-b"]);
    });

    it("returns empty array when data array is empty", async () => {
      mockFetchSuccess({ data: [] });
      const models = await validateServerReachable("http://127.0.0.1:1234/v1");
      expect(models).toEqual([]);
    });

    it("strips trailing slash from baseUrl before appending /models", async () => {
      mockFetchSuccess(validModelsBody(["model-a"]));
      await validateServerReachable("http://127.0.0.1:1234/v1/");
      const calledUrl = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(calledUrl).toBe("http://127.0.0.1:1234/v1/models");
    });

    it("skips entries with non-string id fields", async () => {
      mockFetchSuccess({ data: [{ id: "real-model" }, { id: 42 }, {}] });
      const models = await validateServerReachable("http://127.0.0.1:1234/v1");
      expect(models).toEqual(["real-model"]);
    });
  });

  describe("throws OpenAICompatServerUnreachableError", () => {
    it("when fetch throws ECONNREFUSED", async () => {
      const err = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
      mockFetchError(err);
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("when fetch throws AbortError (timeout)", async () => {
      const err = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
      mockFetchError(err);
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("AbortError message mentions timeout", async () => {
      const err = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
      mockFetchError(err);
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow("timed out");
    });

    it("when server returns HTTP 500", async () => {
      mockFetchSuccess({}, 500);
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("when server returns HTTP 404", async () => {
      mockFetchSuccess({}, 404);
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("when response body is not valid JSON", async () => {
      mockFetchBadJson();
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("when response body has no data array", async () => {
      mockFetchSuccess({ models: ["model-a"] });
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("when response body is a plain string", async () => {
      mockFetchSuccess("not an object");
      await expect(
        validateServerReachable("http://127.0.0.1:1234/v1"),
      ).rejects.toThrow(OpenAICompatServerUnreachableError);
    });

    it("error includes the baseUrl in the message", async () => {
      const err = new Error("connect ECONNREFUSED");
      mockFetchError(err);
      await expect(
        validateServerReachable("http://127.0.0.1:9999/v1"),
      ).rejects.toThrow("http://127.0.0.1:9999/v1");
    });
  });
});

// ---------------------------------------------------------------------------
// validateModelPresent
// ---------------------------------------------------------------------------

describe("validateModelPresent", () => {
  const baseUrl = "http://127.0.0.1:1234/v1";

  describe("passes without throwing", () => {
    it("when model is in availableModels", () => {
      expect(() =>
        validateModelPresent("model-a", ["model-a", "model-b"], baseUrl),
      ).not.toThrow();
    });

    it("when model is the only entry in the list", () => {
      expect(() =>
        validateModelPresent("only-model", ["only-model"], baseUrl),
      ).not.toThrow();
    });
  });

  describe("throws OpenAICompatUnknownModelError", () => {
    it("when model is not in availableModels", () => {
      expect(() =>
        validateModelPresent("missing-model", ["model-a", "model-b"], baseUrl),
      ).toThrow(OpenAICompatUnknownModelError);
    });

    it("when availableModels is empty", () => {
      expect(() =>
        validateModelPresent("any-model", [], baseUrl),
      ).toThrow(OpenAICompatUnknownModelError);
    });

    it("when model is a substring but not an exact match", () => {
      expect(() =>
        validateModelPresent("gemma", ["google_gemma-4-26b"], baseUrl),
      ).toThrow(OpenAICompatUnknownModelError);
    });

    it("when model is a superstring of an available model", () => {
      expect(() =>
        validateModelPresent(
          "google_gemma-4-26b-extended",
          ["google_gemma-4-26b"],
          baseUrl,
        ),
      ).toThrow(OpenAICompatUnknownModelError);
    });

    it("error includes the requested model name", () => {
      expect(() =>
        validateModelPresent("missing-model", ["model-a"], baseUrl),
      ).toThrow("missing-model");
    });

    it("error includes the baseUrl", () => {
      expect(() =>
        validateModelPresent("missing-model", ["model-a"], baseUrl),
      ).toThrow(baseUrl);
    });
  });
});

// ---------------------------------------------------------------------------
// validateOpenAICompatConfig
// ---------------------------------------------------------------------------

describe("validateOpenAICompatConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on invalid baseUrl before hitting the network", async () => {
    // fetch should never be called — validateBaseUrl is synchronous
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      validateOpenAICompatConfig(
        minimalConfig({ baseUrl: "http://api.openai.com/v1" }),
      ),
    ).rejects.toThrow("api.openai.com");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("throws OpenAICompatServerUnreachableError when server unreachable", async () => {
    mockFetchError(new Error("connect ECONNREFUSED"));
    await expect(
      validateOpenAICompatConfig(minimalConfig()),
    ).rejects.toThrow(OpenAICompatServerUnreachableError);
  });

  it("throws OpenAICompatUnknownModelError when model not in list", async () => {
    mockFetchSuccess(validModelsBody(["other-model"]));
    await expect(
      validateOpenAICompatConfig(minimalConfig({ model: "test-model" })),
    ).rejects.toThrow(OpenAICompatUnknownModelError);
  });

  it("passes when all three checks succeed", async () => {
    mockFetchSuccess(validModelsBody(["test-model"]));
    await expect(
      validateOpenAICompatConfig(minimalConfig({ model: "test-model" })),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// live server gate (skipped unless OPENAI_COMPAT_BASE_URL is set)
// ---------------------------------------------------------------------------

const hasLiveServer = !!process.env.OPENAI_COMPAT_BASE_URL;

describe.skipIf(!hasLiveServer)("live server", () => {
  it("validateServerReachable returns model list from real server", async () => {
    const models = await validateServerReachable(
      process.env.OPENAI_COMPAT_BASE_URL!,
    );
    expect(models).toBeInstanceOf(Array);
    expect(models.length).toBeGreaterThan(0);
  });
});
