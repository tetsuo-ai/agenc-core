import { describe, expect, it } from "vitest";

import {
  resolveDefaultGrokCompactionThreshold,
  resolveGatewayStatefulResponses,
} from "./llm-stateful-defaults.js";

describe("resolveGatewayStatefulResponses", () => {
  it("enables Grok stateful responses with a dynamic compaction default when omitted", () => {
    const resolved = resolveGatewayStatefulResponses("grok", undefined);

    expect(resolved.usedDefaults).toBe(true);
    expect(resolved.config).toEqual({
      enabled: true,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: true,
        fallbackOnUnsupported: true,
      },
    });
  });

  it("fills missing Grok fields while preserving explicit partial overrides", () => {
    const resolved = resolveGatewayStatefulResponses("grok", {
      enabled: true,
      compaction: {
        enabled: false,
      },
    });

    expect(resolved.usedDefaults).toBe(true);
    expect(resolved.config).toEqual({
      enabled: true,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: false,
        fallbackOnUnsupported: true,
      },
    });
  });

  it("preserves explicit Grok store=false overrides", () => {
    const resolved = resolveGatewayStatefulResponses("grok", {
      enabled: true,
      store: false,
    });

    expect(resolved.usedDefaults).toBe(true);
    expect(resolved.config).toEqual({
      enabled: true,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: true,
        fallbackOnUnsupported: true,
      },
    });
  });

  it("preserves explicit Grok disable without forcing defaults", () => {
    const config = {
      enabled: false,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: false,
      },
    };
    const resolved = resolveGatewayStatefulResponses("grok", config);

    expect(resolved.usedDefaults).toBe(false);
    expect(resolved.config).toBe(config);
  });

  it("leaves non-Grok providers unchanged", () => {
    const config = {
      enabled: true,
      store: true,
      fallbackToStateless: false,
      compaction: {
        enabled: true,
        compactThreshold: 9_000,
        fallbackOnUnsupported: false,
      },
    };
    const resolved = resolveGatewayStatefulResponses("ollama", config);

    expect(resolved.usedDefaults).toBe(false);
    expect(resolved.config).toBe(config);
  });
});

describe("resolveDefaultGrokCompactionThreshold", () => {
  it("uses 30% of the resolved context window when available", () => {
    expect(resolveDefaultGrokCompactionThreshold(128_000)).toBe(38_400);
  });

  it("falls back to the legacy 16k threshold when the context window is unknown", () => {
    expect(resolveDefaultGrokCompactionThreshold()).toBe(16_000);
  });
});
