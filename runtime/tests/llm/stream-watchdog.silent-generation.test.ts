import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveSessionStreamIdleTimeoutMs,
  resolveStreamIdleTimeoutMs,
} from "../../src/llm/stream-watchdog.js";

// Idle-tolerance resolution for providers with silent server-side
// generation. xAI emits ZERO bytes (no SSE keepalives) while generating
// function-call arguments — 51s measured for a ~250-line file — so any
// watchdog window shorter than the provider-declared tolerance kills
// healthy streams and forces full-regeneration reconnect loops. This is
// the failure the 0.7.3 provider-level fix and the 90s session default
// each only half-addressed.

describe("resolveSessionStreamIdleTimeoutMs", () => {
  const originalEnv = process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
    else process.env.AGENC_STREAM_IDLE_TIMEOUT_MS = originalEnv;
  });

  it("defaults to 90s with no inputs", () => {
    expect(resolveSessionStreamIdleTimeoutMs({})).toBe(90_000);
  });

  it("uses the provider suggestion when nothing is configured", () => {
    expect(
      resolveSessionStreamIdleTimeoutMs({ providerSuggestedMs: 300_000 }),
    ).toBe(300_000);
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

  it("resolveStreamIdleTimeoutMs still honors a direct preferred value", () => {
    expect(resolveStreamIdleTimeoutMs(120_000)).toBe(120_000);
    expect(resolveStreamIdleTimeoutMs()).toBe(90_000);
  });
});
