/**
 * G4: empty/unknown models must not enable provider-native server tools.
 * Drives shipped supportsGrokServerSideTools + getProviderNativeToolDefinitions.
 */
import { describe, expect, it } from "vitest";

import {
  getProviderNativeToolDefinitions,
  supportsGrokServerSideTools,
} from "../../src/llm/provider-native-search.js";

describe("supportsGrokServerSideTools (fail-closed)", () => {
  it("returns false for empty / undefined / blank model", () => {
    expect(supportsGrokServerSideTools(undefined)).toBe(false);
    expect(supportsGrokServerSideTools("")).toBe(false);
    expect(supportsGrokServerSideTools("   ")).toBe(false);
  });

  it("returns true for grok-4 family only", () => {
    expect(supportsGrokServerSideTools("grok-4.5")).toBe(true);
    expect(supportsGrokServerSideTools("grok-4.3")).toBe(true);
    expect(supportsGrokServerSideTools("grok-4-fast")).toBe(true);
    expect(supportsGrokServerSideTools("grok-4.20-multi-agent-0309")).toBe(
      true,
    );
  });

  it("returns false for non-grok-4 models", () => {
    expect(supportsGrokServerSideTools("grok-3")).toBe(false);
    expect(supportsGrokServerSideTools("grok-code-fast-1")).toBe(false);
    expect(supportsGrokServerSideTools("gpt-4o")).toBe(false);
  });
});

describe("getProviderNativeToolDefinitions empty-model gate", () => {
  it("emits zero tools when model is empty even if flags are on", () => {
    const defs = getProviderNativeToolDefinitions({
      provider: "grok",
      model: "",
      webSearch: true,
      xSearch: true,
      codeExecution: true,
    });
    expect(defs).toEqual([]);
  });

  it("emits zero tools when model is undefined even if flags are on", () => {
    const defs = getProviderNativeToolDefinitions({
      provider: "grok",
      model: undefined,
      webSearch: true,
      xSearch: true,
      codeExecution: true,
    });
    expect(defs).toEqual([]);
  });

  it("still emits tools for grok-4.5 when flags are on", () => {
    const defs = getProviderNativeToolDefinitions({
      provider: "grok",
      model: "grok-4.5",
      webSearch: true,
      xSearch: true,
      codeExecution: true,
    });
    const types = defs.map((d) => d.toolType).sort();
    expect(types).toEqual(["code_interpreter", "web_search", "x_search"]);
  });

  it("never emits tools for non-grok provider", () => {
    const defs = getProviderNativeToolDefinitions({
      provider: "openai",
      model: "grok-4.5",
      webSearch: true,
      xSearch: true,
      codeExecution: true,
    });
    expect(defs).toEqual([]);
  });
});
