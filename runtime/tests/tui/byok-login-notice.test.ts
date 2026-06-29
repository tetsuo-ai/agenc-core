import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getAPIProvider,
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
  apiKeyStatus: VerificationStatus,
  hasRemoteAuthSession = false,
): boolean {
  return (
    usesAnthropicAccountFlow() &&
    !hasRemoteAuthSession &&
    (apiKeyStatus === "invalid" || apiKeyStatus === "missing")
  );
}

// Env keys that getAPIProvider() inspects; cleared between cases so each test
// starts from a clean provider-detection state.
const PROVIDER_ENV_KEYS = [
  "AGENC_USE_GEMINI",
  "AGENC_USE_MISTRAL",
  "AGENC_USE_GITHUB",
  "AGENC_USE_MINIMAX",
  "XAI_API_KEY",
  "AGENC_USE_OPENAI",
  "NVIDIA_NIM",
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

    expect(getAPIProvider()).toBe("xai");
    expect(usesAnthropicAccountFlow()).toBe(false);
    expect(loginNoticeVisible("missing")).toBe(false);
    expect(loginNoticeVisible("invalid")).toBe(false);
  });

  test("gemini BYOK provider: login notice is suppressed", () => {
    process.env.AGENC_USE_GEMINI = "1";

    expect(getAPIProvider()).toBe("gemini");
    expect(usesAnthropicAccountFlow()).toBe(false);
    expect(loginNoticeVisible("missing")).toBe(false);
  });

  test("openai BYOK provider: login notice is suppressed", () => {
    process.env.AGENC_USE_OPENAI = "1";

    expect(getAPIProvider()).toBe("openai");
    expect(usesAnthropicAccountFlow()).toBe(false);
    expect(loginNoticeVisible("missing")).toBe(false);
  });

  test("firstParty (Anthropic) with missing/invalid credential: login notice is shown", () => {
    // No BYOK env set → defaults to firstParty.
    expect(getAPIProvider()).toBe("firstParty");
    expect(usesAnthropicAccountFlow()).toBe(true);
    expect(loginNoticeVisible("missing")).toBe(true);
    expect(loginNoticeVisible("invalid")).toBe(true);
  });

  test("firstParty with a valid credential: login notice is not shown", () => {
    expect(getAPIProvider()).toBe("firstParty");
    expect(loginNoticeVisible("valid")).toBe(false);
  });

  test("firstParty with remote AgenC auth: login notice is suppressed", () => {
    expect(getAPIProvider()).toBe("firstParty");
    expect(usesAnthropicAccountFlow()).toBe(true);
    expect(loginNoticeVisible("missing", true)).toBe(false);
    expect(loginNoticeVisible("invalid", true)).toBe(false);
  });
});
