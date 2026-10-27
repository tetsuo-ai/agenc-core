import { expect, test, vi } from "vitest";
import { isProviderFundsFailure } from "../../src/llm/funds.js";
import { KimiProvider } from "../../src/llm/providers/kimi/index.js";
import { KIMI_CHAT_MODELS } from "../../src/llm/registry/kimi-models.js";

const refusal = { error: { type: "exceeded_current_quota_error", message: "Your account is suspended due to insufficient balance, please recharge your account or check your plan and billing details" } };

test("Moonshot billing suspension is distinct from temporary throttling", () => {
  expect(isProviderFundsFailure("kimi", { status: 429, body: refusal })).toBe(true);
  expect(isProviderFundsFailure("kimi", { status: 429, body: JSON.stringify(refusal) })).toBe(true);
  expect(isProviderFundsFailure("kimi", { cause: { status: 429, body: refusal } })).toBe(true);
  expect(isProviderFundsFailure("openai-compatible", { status: 429, body: refusal })).toBe(false);
  expect(isProviderFundsFailure("kimi", { status: 429, body: { error: { type: "rate_limit_reached_error", message: "Too many requests" } } })).toBe(false);
  expect(isProviderFundsFailure("kimi", { status: 429, body: { error: { type: "exceeded_current_quota_error", message: "Token rate exceeded" } } })).toBe(false);
});

test.each(KIMI_CHAT_MODELS.flatMap(model => [false, true].map(stream => ({ model, stream }))))("$model stops after one unfunded request, stream=$stream", async ({ model, stream }) => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(refusal), { status: 429, headers: { "content-type": "application/json" } }));
  const provider = new KimiProvider({ model, apiKey: "test-key", fetchImpl });
  const result = stream ? provider.chatStream([{ role: "user", content: "hello" }], () => undefined) : provider.chat([{ role: "user", content: "hello" }]);
  await expect(result).rejects.toMatchObject({ name: "LLMFundsError" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
