import { describe, it, expect, vi } from "vitest";
import { runReflection } from "./reflection.js";
import { AgentIdentityManager } from "./agent-identity.js";
import { InMemoryBackend } from "./in-memory/backend.js";
import type { LLMProvider } from "../llm/types.js";

function mockLLM(response: string): LLMProvider {
  return {
    name: "mock",
    chat: vi.fn(async () => ({
      content: response,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "mock",
    })) as unknown as LLMProvider["chat"],
    chatStream: vi.fn() as unknown as LLMProvider["chatStream"],
    healthCheck: vi.fn(async () => true),
  };
}

function makeHistory(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i}: discussing Python testing patterns`,
  }));
}

describe("runReflection", () => {
  it("extracts learned traits and updates agent identity", async () => {
    const identityMgr = new AgentIdentityManager({ memoryBackend: new InMemoryBackend() });
    await identityMgr.upsert({ agentId: "a1", name: "Test", corePersonality: "helpful", workspaceId: "ws1" });

    const llm = mockLLM(JSON.stringify({
      learned_traits: ["prefers pytest over unittest", "writes concise code"],
      beliefs: {},
      communication_style: "direct and technical",
    }));

    const result = await runReflection({
      llmProvider: llm,
      identityManager: identityMgr,
      agentId: "a1",
      workspaceId: "ws1",
      recentHistory: makeHistory(15),
    });

    expect(result).not.toBeNull();
    expect(result!.learnedTraits).toContain("prefers pytest over unittest");
    expect(result!.communicationStyle).toBe("direct and technical");

    // Verify identity was updated
    const identity = await identityMgr.load("a1", "ws1");
    expect(identity!.learnedTraits).toContain("prefers pytest over unittest");
    expect(identity!.communicationStyle).toBe("direct and technical");
  });

  it("skips reflection for short sessions (< 10 messages)", async () => {
    const identityMgr = new AgentIdentityManager({ memoryBackend: new InMemoryBackend() });
    const llm = mockLLM("{}");

    const result = await runReflection({
      llmProvider: llm,
      identityManager: identityMgr,
      agentId: "a1",
      recentHistory: makeHistory(5), // Too short
    });

    expect(result).toBeNull();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("stores beliefs with evidence (rejects ungrounded)", async () => {
    const identityMgr = new AgentIdentityManager({ memoryBackend: new InMemoryBackend() });
    await identityMgr.upsert({ agentId: "a1", name: "Test", corePersonality: "x", workspaceId: "ws1" });

    const llm = mockLLM(JSON.stringify({
      learned_traits: [],
      beliefs: {
        testing: {
          belief: "pytest is better",
          confidence: 0.85,
          evidence: ["used pytest 5 times successfully", "unittest had issues"],
        },
        ungrounded: {
          belief: "tabs are better",
          confidence: 0.5,
          evidence: [], // No evidence — should be rejected by identityManager
        },
      },
    }));

    const result = await runReflection({
      llmProvider: llm,
      identityManager: identityMgr,
      agentId: "a1",
      workspaceId: "ws1",
      recentHistory: makeHistory(15),
    });

    expect(result!.beliefs).toHaveLength(1);
    expect(result!.beliefs[0]!.topic).toBe("testing");
  });

  it("handles LLM failure gracefully", async () => {
    const identityMgr = new AgentIdentityManager({ memoryBackend: new InMemoryBackend() });
    const llm = mockLLM("");
    (llm.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("LLM down"));

    const result = await runReflection({
      llmProvider: llm,
      identityManager: identityMgr,
      agentId: "a1",
      recentHistory: makeHistory(15),
    });

    expect(result).toBeNull();
  });
});
