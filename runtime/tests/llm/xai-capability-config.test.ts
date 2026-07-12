/**
 * G6: [llm.xai] capability profile → createProvider extra.
 * Drives shipped resolveXaiCapabilityExtra / host gate / defaults.
 */
import { describe, expect, it } from "vitest";

import { defaultConfig, normalizeRawConfig } from "../../src/config/schema.js";
import {
  defaultLlmXaiConfig,
  isDirectXaiInferenceHost,
  resolveLlmXaiConfig,
  resolveXaiCapabilityExtra,
} from "../../src/llm/xai-capability-config.js";
import { createProvider } from "../../src/llm/provider.js";
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
  it("defaults web_search on and expensive flags off", () => {
    const d = defaultLlmXaiConfig();
    expect(d.web_search).toBe(true);
    expect(d.x_search).toBe(false);
    expect(d.code_execution).toBe(false);
    expect(d.enable_image_search).toBe(false);
  });

  it("defaultConfig seeds [llm.xai] with same deliberate defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.llm?.xai?.web_search).toBe(true);
    expect(cfg.llm?.xai?.x_search).toBe(false);
    expect(cfg.llm?.xai?.code_execution).toBe(false);
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

  it("default profile enables webSearch only", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      baseURL: "https://api.x.ai/v1",
      llmXai: resolveLlmXaiConfig(undefined),
    });
    expect(extra.webSearch).toBe(true);
    expect(extra.xSearch).toBeUndefined();
    expect(extra.codeExecution).toBeUndefined();
  });

  it("honors x_search and code_execution when enabled", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: {
        web_search: true,
        x_search: true,
        code_execution: true,
      },
    });
    expect(extra.webSearch).toBe(true);
    expect(extra.xSearch).toBe(true);
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

  it("env AGENC_XAI_X_SEARCH forces xSearch on", () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      llmXai: { x_search: false },
      env: { AGENC_XAI_X_SEARCH: "1" },
    });
    expect(extra.xSearch).toBe(true);
  });
});

describe("G6 end-to-end: extra drives GrokProvider native tools", () => {
  it("createProvider with resolved extra attaches server tools for grok-4.5", () => {
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
    expect(types).toContain("web_search");
    expect(types).toContain("x_search");
    expect(types).toContain("code_interpreter");
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
