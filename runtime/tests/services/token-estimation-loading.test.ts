import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  loads: 0,
  constructors: [] as unknown[],
  fail: false,
}));
vi.mock("@anthropic-ai/sdk", () => {
  sdk.loads++;
  return { default: class {
    beta = { messages: { countTokens: async () => ({ input_tokens: 23 }) } };
    constructor(options: unknown) {
      sdk.constructors.push(options);
      if (sdk.fail) throw new Error("client initialization unavailable");
    }
  } };
});

beforeEach(() => { vi.resetModules(); sdk.constructors.length = 0; sdk.fail = false; });
afterEach(() => { vi.resetModules(); });

async function paddedCount(value: number): Promise<number> {
  const { TOKEN_FALLBACK_MARGIN_RATIO, TOKEN_FALLBACK_MARGIN_TOKENS } =
    await import("../../src/llm/token-accounting.js");
  return value + Math.ceil(value * TOKEN_FALLBACK_MARGIN_RATIO) + TOKEN_FALLBACK_MARGIN_TOKENS;
}

describe("token estimation SDK loading", () => {
  it("keeps local estimates, missing credentials and injected clients independent of the SDK client", async () => {
    const loadsBefore = sdk.loads;
    const service = await import("../../src/services/tokenEstimation.js");
    const errors = await import("../../src/utils/errors.js");
    const runtimeErrors = await import("../../src/errors/runtime.js");
    expect(service.roughTokenCountEstimation("local text")).toBeGreaterThan(0);
    expect(errors.isAbortError(new errors.AbortError())).toBe(true);
    expect(runtimeErrors.isAbortError(new runtimeErrors.AbortError())).toBe(true);
    expect(await service.countTokensWithAPI("missing credentials")).toBeGreaterThan(0);
    const countTokens = vi.fn(async () => ({ input_tokens: 17 }));
    const client = { beta: { messages: { countTokens } } };
    expect(await service.countTokensWithAPI("injected object", { anthropicClient: client })).toBe(await paddedCount(17));
    const factory = vi.fn(async () => client);
    expect(await service.countTokensWithAPI("injected factory", { createAnthropicClient: factory })).toBe(await paddedCount(17));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sdk.loads).toBe(loadsBefore);
    expect(sdk.constructors).toEqual([]);
  });

  it("constructs clients only for API counting and retains each call's options", async () => {
    const loadsBefore = sdk.loads;
    const { countTokensWithAPI } = await import("../../src/services/tokenEstimation.js");
    expect(sdk.loads).toBe(loadsBefore);
    const expected = await paddedCount(23);
    expect(await countTokensWithAPI("first owned count", { apiKey: "test-first", baseURL: "https://one.invalid", timeoutMs: 101 })).toBe(expected);
    expect(await countTokensWithAPI("second owned count", { apiKey: "test-second", baseURL: "https://two.invalid", timeoutMs: 202 })).toBe(expected);
    expect(sdk.constructors).toEqual([
      { apiKey: "test-first", baseURL: "https://one.invalid", maxRetries: 1, timeout: 101 },
      { apiKey: "test-second", baseURL: "https://two.invalid", maxRetries: 1, timeout: 202 },
    ]);
  });

  it("retains the conservative fallback and diagnostic when client initialization fails", async () => {
    sdk.fail = true;
    const { countTokensWithAPI } = await import("../../src/services/tokenEstimation.js");
    const logError = vi.fn();
    expect(await countTokensWithAPI("failed client load", { apiKey: "test-failure", logError })).toBeGreaterThan(0);
    expect(sdk.constructors).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
