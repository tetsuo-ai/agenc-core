import { describe, it, expect, vi } from "vitest";
import { LLMEntityExtractor } from "./llm-entity-extractor.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";

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

describe("LLMEntityExtractor", () => {
  it("extracts entities from conversation text", async () => {
    const llm = mockLLM(
      JSON.stringify([
        {
          entityName: "Python",
          entityType: "language",
          fact: "User prefers Python for data analysis",
          confidence: 0.9,
        },
        {
          entityName: "Alice",
          entityType: "person",
          fact: "Alice is working on the project",
          confidence: 0.8,
        },
      ]),
    );

    const extractor = new LLMEntityExtractor({ llmProvider: llm });
    const results = await extractor.extract(
      "Alice said she prefers Python for data analysis tasks",
      "session-1",
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.entityName).toBe("Python");
    expect(results[0]!.entityType).toBe("language");
    expect(results[0]!.confidence).toBe(0.9);
    expect(results[1]!.entityName).toBe("Alice");
  });

  it("rejects entities not found in source text (substring grounding)", async () => {
    const llm = mockLLM(
      JSON.stringify([
        {
          entityName: "Python",
          entityType: "language",
          fact: "User uses Python",
          confidence: 0.9,
        },
        {
          entityName: "JavaScript",
          entityType: "language",
          fact: "User also uses JavaScript",
          confidence: 0.7,
        },
      ]),
    );

    const extractor = new LLMEntityExtractor({ llmProvider: llm });
    const results = await extractor.extract(
      "I prefer Python for backend development",
      "session-1",
    );

    // Only Python should pass — JavaScript is not in the source text
    expect(results).toHaveLength(1);
    expect(results[0]!.entityName).toBe("Python");
  });

  it("returns empty array on LLM failure (never blocks)", async () => {
    const llm = mockLLM("");
    (llm.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("LLM unavailable"),
    );

    const extractor = new LLMEntityExtractor({ llmProvider: llm });
    const results = await extractor.extract(
      "Some conversation about Python and testing",
      "session-1",
    );

    expect(results).toHaveLength(0);
  });

  it("returns empty array for invalid JSON response", async () => {
    const llm = mockLLM("I found some entities but here is no JSON");

    const extractor = new LLMEntityExtractor({ llmProvider: llm });
    const results = await extractor.extract(
      "Talk about Python and machine learning",
      "session-1",
    );

    expect(results).toHaveLength(0);
  });

  it("returns empty array for short/empty input", async () => {
    const llm = mockLLM("[]");
    const extractor = new LLMEntityExtractor({ llmProvider: llm });

    expect(await extractor.extract("", "s")).toHaveLength(0);
    expect(await extractor.extract("hi", "s")).toHaveLength(0);
    // LLM should not even be called for short input
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("truncates long input to maxInputChars", async () => {
    const llm = mockLLM("[]");
    const extractor = new LLMEntityExtractor({
      llmProvider: llm,
      maxInputChars: 100,
    });

    const longText = "Python ".repeat(200);
    await extractor.extract(longText, "session-1");

    const callArgs = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessage = callArgs.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage.content.length).toBeLessThanOrEqual(120); // 100 + "[truncated]"
  });

  it("applies low default confidence for entities without explicit confidence", async () => {
    const llm = mockLLM(
      JSON.stringify([
        {
          entityName: "pytest",
          entityType: "tool",
          fact: "Used pytest for testing",
          // no confidence field
        },
      ]),
    );

    const extractor = new LLMEntityExtractor({ llmProvider: llm });
    const results = await extractor.extract(
      "We used pytest for testing the application",
      "session-1",
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe(0.3); // default low confidence
  });

  it("handles entities with case-insensitive grounding", async () => {
    const llm = mockLLM(
      JSON.stringify([
        {
          entityName: "PYTHON",
          entityType: "language",
          fact: "User likes Python",
          confidence: 0.8,
        },
      ]),
    );

    const extractor = new LLMEntityExtractor({ llmProvider: llm });
    const results = await extractor.extract(
      "I really enjoy working with python for scripting",
      "session-1",
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.entityName).toBe("PYTHON");
  });
});
