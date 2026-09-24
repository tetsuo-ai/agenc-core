import { describe, expect, test } from "vitest";

import {
  accountingOptionsForProvider,
  providerNativeToolsForAccounting,
} from "../../src/budget/admitted-model-call.js";
import type { ProviderFactoryOptions } from "../../src/llm/provider.js";
import type { LLMChatOptions, LLMProvider, LLMTool } from "../../src/llm/types.js";

const unused = async (): Promise<never> => {
  throw new Error("unused");
};

function stubProvider(name: string): LLMProvider {
  return {
    name,
    chat: unused,
    chatStream: unused,
    healthCheck: unused,
  };
}

const readTool: LLMTool = {
  type: "function",
  function: {
    name: "Read",
    description: "read",
    parameters: { type: "object", properties: {} },
  },
};

const request: LLMChatOptions = {
  model: "test-model",
  maxOutputTokens: 256,
};

const geminiExtra = {
  gemini: {
    credentialPlan: {
      kind: "api-key",
      credential: "test-key",
      source: "factory",
    },
    endpointPlan: {
      kind: "developer",
      nativeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    },
    cachedContent: "cachedContents/project-context",
  },
} as const;

describe("accountingOptionsForProvider", () => {
  test("fills omitted request fields from factory extras and always pins the window", () => {
    const factory: ProviderFactoryOptions = {
      tools: [readTool],
      extra: { systemPrompt: "factory prompt", temperature: 0.2 },
    };
    expect(accountingOptionsForProvider(stubProvider("grok"), factory, request, 8_192)).toEqual({
      ...request,
      contextWindowTokens: 8_192,
      systemPrompt: "factory prompt",
      tools: [readTool],
      temperature: 0.2,
    });
  });

  test("keeps request-scoped prompt, tools, temperature, and cache key", () => {
    const factory: ProviderFactoryOptions = {
      tools: [readTool],
      extra: {
        systemPrompt: "factory prompt",
        temperature: 0.2,
        ...geminiExtra,
      },
    };
    const options: LLMChatOptions = {
      ...request,
      systemPrompt: "request prompt",
      tools: [],
      temperature: 0,
      promptCacheKey: "cachedContents/request-context",
    };
    expect(accountingOptionsForProvider(stubProvider("gemini"), factory, options, 4_096)).toEqual({
      ...options,
      contextWindowTokens: 4_096,
    });
  });

  test("reads Gemini cached content only from the canonical extra.gemini bag", () => {
    const factory: ProviderFactoryOptions = {
      extra: {
        cachedContent: "cachedContents/retired-top-level",
        ...geminiExtra,
      },
    };
    expect(
      accountingOptionsForProvider(stubProvider("gemini"), factory, request, 4_096).promptCacheKey,
    ).toBe("cachedContents/project-context");
    expect(
      accountingOptionsForProvider(stubProvider("grok"), factory, request, 4_096).promptCacheKey,
    ).toBeUndefined();
    expect(
      accountingOptionsForProvider(
        stubProvider("gemini"),
        { extra: { cachedContent: "cachedContents/retired-top-level" } },
        request,
        4_096,
      ).promptCacheKey,
    ).toBeUndefined();
  });
});

describe("providerNativeToolsForAccounting", () => {
  const extra = { webSearch: true, xSearch: true, codeExecution: true };

  test("emits nothing unless the admitted identity is grok", () => {
    expect(providerNativeToolsForAccounting(stubProvider("deepseek"), "deepseek", "grok-4.5", extra, request)).toEqual([]);
    expect(providerNativeToolsForAccounting(stubProvider("grok"), "deepseek", "grok-3", extra, request)).toEqual([]);
  });

  test("counts grok server tools when either the instance or the admitted name is grok", () => {
    const byInstance = providerNativeToolsForAccounting(
      stubProvider("grok"),
      "agenc",
      "grok-4.5",
      extra,
      request,
    );
    const byAdmittedName = providerNativeToolsForAccounting(
      stubProvider("agenc"),
      "grok",
      "grok-4.5",
      extra,
      request,
    );
    expect(byInstance.map((tool) => tool.toolType).sort()).toEqual([
      "code_interpreter",
      "web_search",
      "x_search",
    ]);
    expect(byAdmittedName).toEqual(byInstance);
  });

  test("toolChoice none and an allowlist both shrink the counted catalog", () => {
    expect(
      providerNativeToolsForAccounting(stubProvider("grok"), "grok", "grok-4.5", extra, {
        ...request,
        toolChoice: "none",
      }),
    ).toEqual([]);
    expect(
      providerNativeToolsForAccounting(stubProvider("grok"), "grok", "grok-4.5", extra, {
        ...request,
        toolRouting: { allowedToolNames: ["web_search", "   ", "missing"] },
      }).map((tool) => tool.name),
    ).toEqual(["web_search"]);
  });
});
