/**
 * G6: [llm.xai] capability profile → createProvider extra.
 * Drives shipped resolveXaiCapabilityExtra / host gate / defaults.
 */
import { describe, expect, it } from "vitest";

import { defaultConfig, normalizeRawConfig } from "../../src/config/schema.js";
import {
  defaultLlmXaiConfig,
  hasXaiCredentials,
  isDirectXaiInferenceHost,
  resolveLlmXaiConfig,
  resolveXaiBearerToken,
  resolveXaiCapabilityExtra,
  resolveXaiLiveWebSearchOptions,
} from "../../src/llm/xai-capability-config.js";
import { createProvider } from "../../src/llm/provider.js";
import { getProviderNativeToolDefinitions } from "../../src/llm/provider-native-search.js";
import type { LLMTool } from "../../src/llm/types.js";

const CLIENT_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

describe("isDirectXaiInferenceHost", () => {
  it("accepts default and first-party hosts", () => {
    expect(isDirectXaiInferenceHost(undefined)).toBe(true);
    expect(isDirectXaiInferenceHost("")).toBe(true);
    expect(isDirectXaiInferenceHost("https://api.x.ai/v1")).toBe(true);
    expect(isDirectXaiInferenceHost("https://us-east-1.api.x.ai/v1")).toBe(
      true,
    );
  });

  it("rejects OpenRouter and foreign hosts", () => {
    expect(isDirectXaiInferenceHost("https://openrouter.ai/api/v1")).toBe(
      false,
    );
    expect(isDirectXaiInferenceHost("http://127.0.0.1:8000/v1")).toBe(false);
  });
});

describe("resolveLlmXaiConfig defaults", () => {
  it("defaults full Grok surface on", () => {
    const d = defaultLlmXaiConfig();
    expect(d.web_search).toBe(true);
    expect(d.x_search).toBe(true);
    expect(d.code_execution).toBe(true);
    expect(d.enable_image_search).toBe(true);
    expect(d.enable_image_understanding).toBe(true);
    expect(d.enable_video_understanding).toBe(true);
  });

  it("defaultConfig seeds [llm.xai] with full surface on", () => {
    const cfg = defaultConfig();
    expect(cfg.llm?.xai?.web_search).toBe(true);
    expect(cfg.llm?.xai?.x_search).toBe(true);
    expect(cfg.llm?.xai?.code_execution).toBe(true);
    expect(cfg.llm?.xai?.enable_image_search).toBe(true);
  });

  it("normalizeRawConfig keeps llm.xai on typed path", () => {
    const out = normalizeRawConfig({
      llm: {
        xai: {
          web_search: true,
          x_search: true,
          code_execution: false,
        },
      },
    });
    expect(out.llm?.xai?.x_search).toBe(true);
    expect(out._unknown?.llm).toBeUndefined();
  });
});

describe("resolveXaiCapabilityExtra", () => {
  it("returns empty for non-grok providers", () => {
    expect(
      resolveXaiCapabilityExtra({
        provider: "openai",
        llmXai: { web_search: true, x_search: true, code_execution: true },
      }),
    ).toEqual({});
    expect(
      resolveXaiCapabilityExtra({
        provider: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        llmXai: { web_search: true, x_search: true },
      }),
    ).toEqual({});
  });

  it("returns empty when grok points at non-xAI host", () => {
    expect(
      resolveXaiCapabilityExtra({
        provider: "grok",
        baseURL: "https://openrouter.ai/api/v1",
        llmXai: { web_search: true, x_search: true },
      }),
    ).toEqual({});
  });

  it("default profile continuous-injects code_execution only (Pattern A search)", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      baseURL: "https://api.x.ai/v1",
      llmXai: resolveLlmXaiConfig(undefined),
    });
    // LIVE WebSearch/XSearch one-shots own search — no continuous web/x.
    expect(extra.webSearch).toBeUndefined();
    expect(extra.xSearch).toBeUndefined();
    // Full-surface default enables code_interpreter continuously.
    expect(extra.codeExecution).toBe(true);
  });

  it("honors code_execution continuous injection when enabled", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: {
        web_search: true,
        x_search: true,
        code_execution: true,
      },
    });
    expect(extra.webSearch).toBeUndefined();
    expect(extra.xSearch).toBeUndefined();
    expect(extra.codeExecution).toBe(true);
  });

  it("maps collections and remote_mcp when enabled", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: {
        collections: {
          enabled: true,
          vector_store_ids: ["collection_abc"],
          max_num_results: 5,
        },
        remote_mcp: {
          enabled: true,
          servers: [
            {
              server_url: "https://example.com/mcp",
              server_label: "deepwiki",
            },
          ],
        },
      },
    });
    expect(extra.collectionsSearch).toEqual({
      enabled: true,
      vectorStoreIds: ["collection_abc"],
      maxNumResults: 5,
    });
    expect(extra.remoteMcp).toEqual({
      enabled: true,
      servers: [
        {
          serverUrl: "https://example.com/mcp",
          serverLabel: "deepwiki",
        },
      ],
    });
  });

  it("env AGENC_XAI_CODE_EXECUTION forces continuous code_interpreter", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: { code_execution: false },
      env: { AGENC_XAI_CODE_EXECUTION: "1" },
    });
    expect(extra.codeExecution).toBe(true);
  });
});

describe("hasXaiCredentials / resolveXaiBearerToken (OAuth wins)", () => {
  it("treats BYOK env as credentials when not logged in", () => {
    expect(hasXaiCredentials({ XAI_API_KEY: "k" })).toBe(true);
    // Without stored OAuth, BYOK is the bearer.
    expect(resolveXaiBearerToken({ XAI_API_KEY: "byok" })).toBe("byok");
  });

  it("falls back to session bearer when no OAuth store and no BYOK", () => {
    expect(resolveXaiBearerToken({}, "session-token")).toBe("session-token");
  });

  it("session bearer is used before env BYOK when OAuth store empty", () => {
    // OAuth store empty in unit test; session key still preferred over env
    // only after OAuth check — product path: OAuth store > session > BYOK.
    expect(
      resolveXaiBearerToken({ XAI_API_KEY: "byok" }, "session-token"),
    ).toBe("session-token");
  });
});

describe("G5 [llm.xai].enable_image_search product path", () => {
  it("resolveXaiLiveWebSearchOptions surfaces image flags from full defaults", () => {
    // Full-surface defaults: empty/partial config still enables image flags.
    expect(resolveXaiLiveWebSearchOptions(undefined)).toEqual({
      enableImageSearch: true,
      enableImageUnderstanding: true,
    });
    expect(
      resolveXaiLiveWebSearchOptions({
        enable_image_search: true,
        enable_image_understanding: true,
      }),
    ).toEqual({
      enableImageSearch: true,
      enableImageUnderstanding: true,
    });
    // Explicit off stays off.
    expect(
      resolveXaiLiveWebSearchOptions({
        enable_image_search: false,
        enable_image_understanding: false,
      }),
    ).toBeUndefined();
  });

  it("config flag reaches wire payload via LIVE one-shot options (shipped path)", () => {
    // Product path: [llm.xai].enable_image_search → resolveXaiLiveWebSearchOptions
    // → webSearchOptions on one-shot provider → getProviderNativeToolDefinitions.
    const liveOpts = resolveXaiLiveWebSearchOptions({
      enable_image_search: true,
      enable_image_understanding: true,
    });
    expect(liveOpts).toBeDefined();

    const defs = getProviderNativeToolDefinitions({
      provider: "grok",
      model: "grok-4.5",
      webSearch: true,
      webSearchOptions: {
        enableImageSearch: liveOpts!.enableImageSearch,
        enableImageUnderstanding: liveOpts!.enableImageUnderstanding,
      },
    });
    const web = defs.find((d) => d.toolType === "web_search");
    expect(web?.payload).toMatchObject({
      type: "web_search",
      enable_image_search: true,
      enable_image_understanding: true,
    });
    // Top-level, not under filters.
    expect(
      (web?.payload.filters as Record<string, unknown> | undefined)
        ?.enable_image_search,
    ).toBeUndefined();
  });

  it("createProvider one-shot with LIVE options emits enable_image_search", () => {
    const liveOpts = resolveXaiLiveWebSearchOptions({
      enable_image_search: true,
    });
    const provider = createProvider("grok", {
      apiKey: "k",
      model: "grok-4.5",
      tools: [],
      extra: {
        webSearch: true,
        searchMode: "on",
        webSearchOptions: {
          enableImageSearch: liveOpts?.enableImageSearch === true,
        },
      },
    });
    const plan = (
      provider as unknown as {
        buildRequestPlan: (
          m: unknown[],
        ) => { params: { tools?: readonly Record<string, unknown>[] } };
      }
    ).buildRequestPlan([{ role: "user", content: "images" }]);
    const web = plan.params.tools?.find((t) => t.type === "web_search");
    expect(web).toMatchObject({
      type: "web_search",
      enable_image_search: true,
    });
  });
});

describe("G6 end-to-end: extra drives GrokProvider native tools", () => {
  it("createProvider with resolved extra attaches code_interpreter not search", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: {
        web_search: true,
        x_search: true,
        code_execution: true,
      },
    });
    const provider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4.5",
      tools: [CLIENT_TOOL],
      extra,
    });
    const plan = (
      provider as unknown as {
        buildRequestPlan: (
          messages: unknown[],
        ) => { params: { tools?: readonly Record<string, unknown>[] } };
      }
    ).buildRequestPlan([{ role: "user", content: "hi" }]);
    const tools = plan.params.tools ?? [];
    const types = tools.map((t) => t.type);
    expect(types).toContain("function");
    expect(types).toContain("code_interpreter");
    // Search stays on LIVE tools (Pattern A) — not continuous main-loop.
    expect(types).not.toContain("web_search");
    expect(types).not.toContain("x_search");
  });

  it("openrouter never gets xAI server tools via resolver", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      llmXai: {
        web_search: true,
        x_search: true,
        code_execution: true,
      },
    });
    expect(extra).toEqual({});
  });
});

describe("G2/G7/G8 productize via [llm.xai] flags", () => {
  it("G2: code_execution flag injects code_interpreter only when on", () => {
    const off = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: { code_execution: false },
    });
    expect(off.codeExecution).toBeUndefined();

    const on = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: { code_execution: true },
    });
    const provider = createProvider("grok", {
      apiKey: "k",
      model: "grok-4.5",
      tools: [],
      extra: on,
    });
    const plan = (
      provider as unknown as {
        buildRequestPlan: (
          m: unknown[],
        ) => { params: { tools?: readonly Record<string, unknown>[] } };
      }
    ).buildRequestPlan([{ role: "user", content: "calc" }]);
    expect(plan.params.tools?.some((t) => t.type === "code_interpreter")).toBe(
      true,
    );
  });

  it("G7: collections config injects file_search with vector_store_ids", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: {
        collections: {
          enabled: true,
          vector_store_ids: ["collection_1"],
          max_num_results: 3,
        },
      },
    });
    const provider = createProvider("grok", {
      apiKey: "k",
      model: "grok-4.5",
      tools: [],
      extra,
    });
    const plan = (
      provider as unknown as {
        buildRequestPlan: (
          m: unknown[],
        ) => { params: { tools?: readonly Record<string, unknown>[] } };
      }
    ).buildRequestPlan([{ role: "user", content: "search docs" }]);
    const fileSearch = plan.params.tools?.find((t) => t.type === "file_search");
    expect(fileSearch).toMatchObject({
      type: "file_search",
      vector_store_ids: ["collection_1"],
      max_num_results: 3,
    });
  });

  it("G8: remote_mcp injects type mcp server tools", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: {
        remote_mcp: {
          enabled: true,
          servers: [
            {
              server_url: "https://example.com/mcp",
              server_label: "docs",
              allowed_tools: ["search"],
            },
          ],
        },
      },
    });
    const provider = createProvider("grok", {
      apiKey: "k",
      model: "grok-4.5",
      tools: [],
      extra,
    });
    const plan = (
      provider as unknown as {
        buildRequestPlan: (
          m: unknown[],
        ) => { params: { tools?: readonly Record<string, unknown>[] } };
      }
    ).buildRequestPlan([{ role: "user", content: "mcp" }]);
    const mcp = plan.params.tools?.find((t) => t.type === "mcp");
    expect(mcp).toMatchObject({
      type: "mcp",
      server_url: "https://example.com/mcp",
      server_label: "docs",
      allowed_tools: ["search"],
    });
  });
});
