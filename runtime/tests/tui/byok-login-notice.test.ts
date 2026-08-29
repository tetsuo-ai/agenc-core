import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getAPIProvider,
  isRegistryOwnedNonAnthropicModel,
  usesAnthropicAccountFlow,
} from "../../src/utils/model/providers.js";
import type { VerificationStatus } from "../../src/tui/hooks/useApiKeyVerification.js";

/**
 * Regression test for "byok-login-notice".
 *
 * The PromptInput footer used to render "Not logged in · Run /login" purely on
 * apiKeyStatus ('invalid' | 'missing'). apiKeyStatus only reflects Anthropic /
 * hosted auth, so it reports 'missing' for a working non-Anthropic BYOK provider
 * (e.g. XAI_API_KEY set, grok working) — a false alarm.
 *
 * The fix gates the notice behind usesAnthropicAccountFlow(): the notice is only
 * shown for genuine first-party (Anthropic) users, and suppressed for any active
 * BYOK provider. This test pins that gating logic.
 */

// Mirrors the render-gate condition in
// src/tui/components/PromptInput/Notifications.tsx
function loginNoticeVisible(
  provider: string,
  apiKeyStatus: VerificationStatus,
  hasRemoteAuthSession = false,
  mainLoopModel = "",
): boolean {
  return (
    usesAnthropicAccountFlow(provider) &&
    !isRegistryOwnedNonAnthropicModel(mainLoopModel) &&
    !hasRemoteAuthSession &&
    (apiKeyStatus === "invalid" || apiKeyStatus === "missing")
  );
}

// Credential/model inputs are isolated; provider identity is passed explicitly.
const PROVIDER_ENV_KEYS = [
  "XAI_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
] as const;

describe("byok-login-notice", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of PROVIDER_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("xai BYOK provider: login notice is suppressed even when apiKeyStatus is 'missing'", () => {
    process.env.XAI_API_KEY = "xai-test-key";

    expect(getAPIProvider("grok")).toBe("xai");
    expect(usesAnthropicAccountFlow("grok")).toBe(false);
    expect(loginNoticeVisible("grok", "missing")).toBe(false);
    expect(loginNoticeVisible("grok", "invalid")).toBe(false);
  });

  test("gemini BYOK provider: login notice is suppressed", () => {
    expect(getAPIProvider("gemini")).toBe("gemini");
    expect(usesAnthropicAccountFlow("gemini")).toBe(false);
    expect(loginNoticeVisible("gemini", "missing")).toBe(false);
  });

  test("openai BYOK provider: login notice is suppressed", () => {
    expect(getAPIProvider("openai")).toBe("openai");
    expect(usesAnthropicAccountFlow("openai")).toBe(false);
    expect(loginNoticeVisible("openai", "missing")).toBe(false);
  });

  test("firstParty (Anthropic) with missing/invalid credential: login notice is shown", () => {
    expect(getAPIProvider("anthropic")).toBe("firstParty");
    expect(usesAnthropicAccountFlow("anthropic")).toBe(true);
    expect(loginNoticeVisible("anthropic", "missing")).toBe(true);
    expect(loginNoticeVisible("anthropic", "invalid")).toBe(true);
  });

  test("firstParty with a valid credential: login notice is not shown", () => {
    expect(getAPIProvider("anthropic")).toBe("firstParty");
    expect(loginNoticeVisible("anthropic", "valid")).toBe(false);
  });

  test("firstParty with remote AgenC auth: login notice is suppressed", () => {
    expect(getAPIProvider("anthropic")).toBe("firstParty");
    expect(usesAnthropicAccountFlow("anthropic")).toBe(true);
    expect(loginNoticeVisible("anthropic", "missing", true)).toBe(false);
    expect(loginNoticeVisible("anthropic", "invalid", true)).toBe(false);
  });

  test("explicit grok selection suppresses the Anthropic login notice", () => {
    expect(getAPIProvider("grok")).toBe("xai");
    expect(isRegistryOwnedNonAnthropicModel("grok-4.5")).toBe(true);
    expect(loginNoticeVisible("grok", "missing", false, "grok-4.5")).toBe(false);
    expect(loginNoticeVisible("grok", "invalid", false, "grok-4.5")).toBe(false);
  });

  test("registry ownership: anthropic and unknown models stay on the notice path", () => {
    expect(isRegistryOwnedNonAnthropicModel("gpt-5")).toBe(true);
    expect(isRegistryOwnedNonAnthropicModel("claude-opus-5")).toBe(false);
    expect(isRegistryOwnedNonAnthropicModel("")).toBe(false);
    expect(loginNoticeVisible("anthropic", "missing", false, "claude-opus-5")).toBe(true);
  });
});
