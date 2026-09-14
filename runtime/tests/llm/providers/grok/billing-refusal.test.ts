import { APIError } from "openai";
import { describe, expect, test, vi } from "vitest";

import { StreamModelError } from "../../../phases/stream-model.js";
import { isTransientProviderError } from "../../../recovery/api-errors.js";
import { isRetryableStreamError } from "../../../session/run-turn-stream-retry.js";
import { LLMAuthenticationError, LLMProviderError } from "../../errors.js";
import type { LLMMessage } from "../../types.js";
import { GrokProvider } from "./adapter.js";
import { isUnauthorizedError } from "./auth-refresh.js";
import { readXaiBillingRefusal } from "./billing-refusal.js";

// The body xAI returned to every request of a Terminal-Bench run on 2026-09-14 once the account reached its
// spending limit. Each turn failed as "grok authentication failed (HTTP 403)" with no reason.
const SPENDING_LIMIT = {
  code: "personal-team-blocked:spending-limit",
  error:
    "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.",
};
const FORBIDDEN = { error: { message: "Forbidden" } };
const messages: LLMMessage[] = [{ role: "user", content: "run it" }];

const sdkError = (status: number, body?: Record<string, unknown>) =>
  APIError.generate(status, body, undefined, new Headers());

function grokRejecting(error: unknown) {
  const refreshBearer = vi.fn().mockResolvedValue({ kind: "refreshed", bearer: "xai-refreshed" });
  const create = vi.fn(() => {
    throw error;
  });
  const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4.6" }).withAuthRefreshCallbacks({
    refreshBearer,
  });
  (provider as any).client = { responses: { create } };
  return { provider, create, refreshBearer };
}

const rejection = (pending: Promise<unknown>) => pending.then(() => undefined, (thrown: unknown) => thrown);

describe("xAI billing refusal", () => {
  test("the SDK keeps the status and text of xAI's flat body but drops its code", () => {
    const error = sdkError(403, SPENDING_LIMIT);
    expect(error.code).toBeUndefined();
    expect(readXaiBillingRefusal(error)).toEqual({ status: 403 });
  });

  test.each([
    [
      "the evidenced code with generic text",
      403,
      { error: { code: "personal-team-blocked:spending-limit", message: "Forbidden" } },
      { status: 403, code: "personal-team-blocked:spending-limit" },
    ],
    ["another personal-team-blocked reason", 403, { error: { code: "personal-team-blocked:organization-policy", message: "Forbidden" } }, undefined],
    ["a denial that mentions credits and a spending-limit", 403, { error: { message: "Access denied. Request mentioned credits and a spending-limit." } }, undefined],
    ["a denial that quotes the wording mid-sentence", 403, { error: { message: "Access denied: You have run out of credits or need a Grok subscription." } }, undefined],
    ["a plain permission 403", 403, FORBIDDEN, undefined],
    ["a 403 without a body", 403, undefined, undefined],
    ["the evidenced body on a 401", 401, SPENDING_LIMIT, undefined],
    ["the evidenced body on a 402", 402, SPENDING_LIMIT, undefined],
    ["the evidenced body on a 429", 429, SPENDING_LIMIT, undefined],
  ])("reads %s", (_label, status, body, expected) => {
    expect(readXaiBillingRefusal(sdkError(status, body))).toEqual(expected);
  });

  test("a chat request fails once with a terminal billing error and no token refresh", async () => {
    const { provider, create, refreshBearer } = grokRejecting(sdkError(403, SPENDING_LIMIT));
    const error = await rejection(provider.chat(messages));

    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error).not.toBeInstanceOf(LLMAuthenticationError);
    expect(error).toMatchObject({ statusCode: 403 });
    expect((error as Error).message).toContain("run out of credits");
    expect((error as Error).message).not.toMatch(/authentication|40[13]/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(refreshBearer).not.toHaveBeenCalled();
    expect(isUnauthorizedError(sdkError(403, SPENDING_LIMIT))).toBe(false);
    expect(isTransientProviderError(error)).toBe(false);
    expect(isRetryableStreamError(new StreamModelError(error))).toBe(false);
  });

  test("a streamed request surfaces the same billing error without a second call", async () => {
    const { provider, create } = grokRejecting(sdkError(403, SPENDING_LIMIT));
    const error = await rejection(provider.chatStream(messages, () => {}));

    expect(error).toBeInstanceOf(LLMProviderError);
    expect((error as Error).message).toContain("spending limit");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("a genuine 403 still refreshes the OAuth token and fails as authentication", async () => {
    const { provider, create, refreshBearer } = grokRejecting(sdkError(403, FORBIDDEN));

    await expect(provider.chat(messages)).rejects.toBeInstanceOf(LLMAuthenticationError);
    expect(isUnauthorizedError(sdkError(403, FORBIDDEN))).toBe(true);
    expect(refreshBearer).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(3);
  });
});
