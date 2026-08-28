import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OPENAI_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
  resolveSessionStreamIdleTimeoutMs,
  resolveStreamIdleTimeoutMs,
} from "../../src/llm/stream-watchdog.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";

// Idle-tolerance resolution for providers with silent server-side
// generation. xAI can emit ZERO bytes while generating function-call
// arguments, so provider silence must not create a deadline by default.
// Operators may still opt in, and provider suggestions can make that
// explicitly configured window safer.

describe("resolveSessionStreamIdleTimeoutMs", () => {
  const originalEnv = process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
    else process.env.AGENC_STREAM_IDLE_TIMEOUT_MS = originalEnv;
  });

  it("is unbounded with no inputs", () => {
    expect(resolveSessionStreamIdleTimeoutMs({})).toBe(0);
  });

  it("does not turn a provider suggestion into an implicit deadline", () => {
    expect(
      resolveSessionStreamIdleTimeoutMs({ providerSuggestedMs: 300_000 }),
    ).toBe(0);
  });

  it("uses a provider default only when env and config are absent", () => {
    expect(
      resolveSessionStreamIdleTimeoutMs({
        providerDefaultMs: OPENAI_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
      }),
    ).toBe(8 * 60_000);
  });

  it("lets an explicit zero config disable a provider default", () => {
    expect(
      resolveSessionStreamIdleTimeoutMs({
        configuredMs: 0,
        providerDefaultMs: OPENAI_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
      }),
    ).toBe(0);
  });

  it("lets config win when it is at or above the provider suggestion", () => {
    expect(
      resolveSessionStreamIdleTimeoutMs({
        configuredMs: 600_000,
        providerSuggestedMs: 300_000,
      }),
    ).toBe(600_000);
  });

  it("floors config below the provider suggestion (stale 30s scaffold must not kill grok)", () => {
    expect(
      resolveSessionStreamIdleTimeoutMs({
        configuredMs: 30_000,
        providerSuggestedMs: 300_000,
      }),
    ).toBe(300_000);
  });

  it("uses config alone for providers without a suggestion", () => {
    expect(resolveSessionStreamIdleTimeoutMs({ configuredMs: 45_000 })).toBe(
      45_000,
    );
  });

  it("env var beats both, in either direction", () => {
    process.env.AGENC_STREAM_IDLE_TIMEOUT_MS = "15000";
    expect(
      resolveSessionStreamIdleTimeoutMs({
        configuredMs: 600_000,
        providerSuggestedMs: 300_000,
      }),
    ).toBe(15_000);
  });

  it("an explicit zero env value disables an explicit config value", () => {
    process.env.AGENC_STREAM_IDLE_TIMEOUT_MS = "0";
    expect(
      resolveSessionStreamIdleTimeoutMs({
        configuredMs: 600_000,
        providerDefaultMs: OPENAI_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
        providerSuggestedMs: 900_000,
      }),
    ).toBe(0);
  });

  it("resolveStreamIdleTimeoutMs still honors a direct preferred value", () => {
    expect(resolveStreamIdleTimeoutMs(120_000)).toBe(120_000);
    expect(resolveStreamIdleTimeoutMs()).toBe(0);
  });

  it("grok does not declare an implicit per-chunk deadline", () => {
    const provider = new GrokProvider({ apiKey: "test", model: "grok-4.5" });
    expect(provider.suggestedStreamIdleTimeoutMs).toBeUndefined();
    expect(provider.defaultStreamIdleTimeoutMs).toBeUndefined();
  });

  it("declares the hard default only for the first-party OpenAI provider", () => {
    const openai = new OpenAIProvider({ apiKey: "test", model: "gpt-5" });
    const compatible = new OpenAIProvider({
      apiKey: "test",
      model: "local-model",
      providerName: "openai-compatible",
    });

    expect(openai.defaultStreamIdleTimeoutMs).toBe(
      OPENAI_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    );
    expect(compatible.defaultStreamIdleTimeoutMs).toBeUndefined();
  });
});
