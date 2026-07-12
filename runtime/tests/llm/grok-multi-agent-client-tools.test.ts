/**
 * G0: multi-agent models must not receive client-side function tools.
 * Drives shipped helpers: isGrokMultiAgentModel + GrokProvider.buildRequestPlan.
 */
import { describe, expect, it } from "vitest";

import { isGrokMultiAgentModel } from "../../src/llm/provider-native-search.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import {
  resolveModelCapabilityHints,
} from "../../src/llm/registry/model-catalog.js";
import type { LLMTool } from "../../src/llm/types.js";

const CLIENT_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "exec_command",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

describe("isGrokMultiAgentModel", () => {
  it("detects multi-agent family and aliases", () => {
    expect(isGrokMultiAgentModel("grok-4.20-multi-agent-0309")).toBe(true);
    expect(isGrokMultiAgentModel("grok-4.20-multi-agent")).toBe(true);
    expect(isGrokMultiAgentModel("grok-4-20-multi-agent-latest")).toBe(true);
    expect(isGrokMultiAgentModel("x-ai/grok-4.20-multi-agent-0309")).toBe(true);
    expect(isGrokMultiAgentModel("grok:grok-4.20-multi-agent-0309")).toBe(true);
  });

  it("rejects non multi-agent models", () => {
    expect(isGrokMultiAgentModel("grok-4.5")).toBe(false);
    expect(isGrokMultiAgentModel("grok-4.3")).toBe(false);
    expect(isGrokMultiAgentModel("grok-4.20-0309-reasoning")).toBe(false);
    expect(isGrokMultiAgentModel(undefined)).toBe(false);
    expect(isGrokMultiAgentModel("")).toBe(false);
  });
});

describe("G0 multi-agent client tool strip (shipped request path)", () => {
  it("catalog advertises no client tool use for multi-agent", () => {
    const hints = resolveModelCapabilityHints({
      provider: "grok",
      model: "grok-4.20-multi-agent-0309",
    });
    expect(hints?.supportsToolUse).toBe(false);
    // Parallel tool use is only meaningful with client tools; catalog entry
    // sets supportsParallelToolCalls false (asserted via supportsToolUse gate).
    expect(hints?.supportsStructuredOutputWithTools).toBe(false);
  });

  it("buildRequestPlan emits zero type:function tools", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-multi-agent-0309",
      tools: [CLIENT_TOOL],
      webSearch: true,
      codeExecution: true,
    });
    const plan = (
      provider as unknown as {
        buildRequestPlan: (
          messages: unknown[],
        ) => {
          params: { tools?: readonly Record<string, unknown>[] };
        };
      }
    ).buildRequestPlan([{ role: "user", content: "research" }]);

    const tools = plan.params.tools ?? [];
    expect(tools.filter((t) => t.type === "function")).toEqual([]);
    expect(tools.some((t) => t.type === "web_search")).toBe(true);
    expect(tools.some((t) => t.type === "code_interpreter")).toBe(true);
  });
});
