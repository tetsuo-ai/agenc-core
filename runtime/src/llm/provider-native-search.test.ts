import { describe, expect, it } from "vitest";
import {
  getProviderNativeAdvertisedToolNames,
  getProviderNativeToolRoutingDecisions,
  getProviderNativeToolDefinitions,
  getProviderNativeWebSearchRoutingDecision,
  isResearchLikeText,
  supportsGrokServerSideTools,
} from "./provider-native-search.js";

describe("provider-native-search", () => {
  it("only enables Grok server-side tools for supported models", () => {
    expect(supportsGrokServerSideTools("grok-4-1-fast-reasoning")).toBe(true);
    expect(supportsGrokServerSideTools("grok-4-0709")).toBe(true);
    expect(supportsGrokServerSideTools("grok-code-fast-1")).toBe(false);
  });

  it("does not advertise web_search for unsupported Grok models", () => {
    expect(getProviderNativeAdvertisedToolNames({
      provider: "grok",
      model: "grok-code-fast-1",
      webSearch: true,
      searchMode: "auto",
    })).toEqual([]);
  });

  it("builds documented xAI native tool definitions from the capability surface", () => {
    const definitions = getProviderNativeToolDefinitions({
      provider: "grok",
      model: "grok-4-1-fast-reasoning",
      webSearch: true,
      webSearchOptions: {
        allowedDomains: ["docs.x.ai"],
        enableImageUnderstanding: true,
      },
      xSearch: true,
      xSearchOptions: {
        allowedXHandles: ["xai"],
        fromDate: "2026-03-01",
        toDate: "2026-03-27",
        enableVideoUnderstanding: true,
      },
      codeExecution: true,
      collectionsSearch: {
        enabled: true,
        vectorStoreIds: ["collection-123"],
        maxNumResults: 8,
      },
      remoteMcp: {
        enabled: true,
        servers: [
          {
            serverUrl: "https://mcp.example.com/sse",
            serverLabel: "docs",
            allowedTools: ["search_docs"],
          },
        ],
      },
    });

    expect(definitions.map((definition) => definition.name)).toEqual([
      "web_search",
      "x_search",
      "code_interpreter",
      "file_search",
      "mcp:docs",
    ]);
    expect(definitions[0]?.payload).toEqual({
      type: "web_search",
      filters: { allowed_domains: ["docs.x.ai"] },
      enable_image_understanding: true,
    });
    expect(definitions[1]?.payload).toEqual({
      type: "x_search",
      allowed_x_handles: ["xai"],
      from_date: "2026-03-01",
      to_date: "2026-03-27",
      enable_video_understanding: true,
    });
    expect(definitions[3]?.payload).toEqual({
      type: "file_search",
      vector_store_ids: ["collection-123"],
      max_num_results: 8,
    });
    expect(definitions[4]?.payload).toEqual({
      type: "mcp",
      server_url: "https://mcp.example.com/sse",
      server_label: "docs",
      allowed_tools: ["search_docs"],
    });
  });

  it("does not route web_search for generic current-state prompts", () => {
    const decision = getProviderNativeWebSearchRoutingDecision({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        webSearch: true,
        searchMode: "auto",
      },
      messageText: "What is the current working directory?",
      history: [],
    });

    expect(decision).toBeUndefined();
  });

  it("routes web_search for explicit research turns on supported models", () => {
    const decision = getProviderNativeWebSearchRoutingDecision({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        webSearch: true,
        searchMode: "auto",
      },
      messageText: "Compare Phaser and PixiJS from official docs and cite sources",
      history: [],
    });

    expect(decision?.toolName).toBe("web_search");
  });

  it("routes x_search for X-specific prompts", () => {
    const decisions = getProviderNativeToolRoutingDecisions({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        xSearch: true,
      },
      messageText: "What are people saying about xAI on X right now?",
      history: [],
    });

    expect(decisions.map((decision) => decision.toolName)).toEqual(["x_search"]);
  });

  it("routes file_search for uploaded-collection prompts", () => {
    const decisions = getProviderNativeToolRoutingDecisions({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        collectionsSearch: {
          enabled: true,
          vectorStoreIds: ["collection-123"],
        },
      },
      messageText:
        "Use the uploaded collection and internal documents to answer the policy question.",
      history: [],
    });

    expect(decisions.map((decision) => decision.toolName)).toEqual(["file_search"]);
  });

  it("routes code_interpreter for calculation and data-analysis prompts", () => {
    const decisions = getProviderNativeToolRoutingDecisions({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        codeExecution: true,
      },
      messageText:
        "Calculate the regression on this dataset [120000, 135000, 98000, 156000] and show your working.",
      history: [],
    });

    expect(decisions.map((decision) => decision.toolName)).toEqual([
      "code_interpreter",
    ]);
  });

  it("routes hybrid collection analysis to file_search plus code_interpreter", () => {
    const decisions = getProviderNativeToolRoutingDecisions({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        collectionsSearch: {
          enabled: true,
          vectorStoreIds: ["collection-123"],
        },
        codeExecution: true,
      },
      messageText:
        "Using the uploaded knowledge base, calculate the totals from the internal reports and show your working.",
      history: [],
    });

    expect(decisions.map((decision) => decision.toolName)).toEqual([
      "file_search",
      "code_interpreter",
    ]);
  });

  it("routes remote MCP servers when the prompt matches configured metadata", () => {
    const decisions = getProviderNativeToolRoutingDecisions({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        remoteMcp: {
          enabled: true,
          servers: [
            {
              serverUrl: "https://mcp.deepwiki.com/mcp",
              serverLabel: "deepwiki",
              serverDescription: "DeepWiki repository and documentation explorer",
              allowedTools: ["search_docs", "read_repo"],
            },
          ],
        },
      },
      messageText:
        "Use DeepWiki to explore the repository documentation and search docs for the adapter behavior.",
      history: [],
    });

    expect(decisions.map((decision) => decision.toolName)).toEqual([
      "mcp:deepwiki",
    ]);
  });

  it("does not treat implementation mechanics language as research", () => {
    expect(
      isResearchLikeText(
        "Implement CLI in packages/cli and print a short mechanics explanation for the chosen route.",
      ),
    ).toBe(false);
  });
});
