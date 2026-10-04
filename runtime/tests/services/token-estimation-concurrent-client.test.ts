import { afterEach, expect, it, vi } from "vitest";
import { countTokensWithAPI } from "../../src/services/tokenEstimation.js";
import { TOKEN_FALLBACK_MARGIN_RATIO, TOKEN_FALLBACK_MARGIN_TOKENS } from "../../src/llm/token-accounting.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps credentials and endpoints isolated across concurrent real SDK clients", async () => {
  const observed: { url: string; key: string | null; body: string }[] = [];
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-api-key");
    observed.push({ url: String(url), key, body: String(init?.body) });
    if (observed.length === 2) release();
    await bothArrived;
    return new Response(JSON.stringify({ input_tokens: key === "test-first" ? 21 : 31 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const padded = (value: number) => value + Math.ceil(value * TOKEN_FALLBACK_MARGIN_RATIO) + TOKEN_FALLBACK_MARGIN_TOKENS;
  expect(await Promise.all([
    countTokensWithAPI("first owned count", { apiKey: "test-first", baseURL: "https://one.invalid" }),
    countTokensWithAPI("second owned count", { apiKey: "test-second", baseURL: "https://two.invalid" }),
  ])).toEqual([padded(21), padded(31)]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(observed).toEqual(expect.arrayContaining([
    { url: expect.stringContaining("https://one.invalid/"), key: "test-first", body: expect.stringContaining("first owned count") },
    { url: expect.stringContaining("https://two.invalid/"), key: "test-second", body: expect.stringContaining("second owned count") },
  ]));
});
