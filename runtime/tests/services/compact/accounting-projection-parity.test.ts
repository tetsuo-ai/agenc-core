import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../../../src/services/compact/_deps/runtime.js";
import { createTokenAccountingRequest, estimateTokenAccountingRequest } from "../../../src/llm/token-accounting.js";
import type { LLMMessage } from "../../../src/llm/types.js";
import type { CompactContext, RuntimeMessage } from "../../../src/services/compact/types.js";

// #2520: admission accounts the original LLMMessage, retained provider reasoning
// included, while the compaction pressure gate accounts a projection of the same
// history. When the projection dropped `providerReasoningContent`, the gate read
// a fraction of admission's number, so auto-compaction never fired on a
// reasoning-heavy turn while admission refused the very next request.
function history(reasoningBytes: number): {
  readonly runtime: RuntimeMessage[];
  readonly wire: LLMMessage[];
} {
  const reasoning = "r".repeat(reasoningBytes);
  const runtime: RuntimeMessage[] = [];
  const wire: LLMMessage[] = [];
  for (let index = 0; index < 12; index += 1) {
    const assistant = index % 2 === 1;
    const base = {
      role: (assistant ? "assistant" : "user") as "assistant" | "user",
      content: `turn ${index}`,
    };
    runtime.push({
      ...base,
      originalRole: base.role,
      ...(assistant
        ? {
            providerReasoningContent: reasoning,
            providerReasoningProvenance: "provider_response" as const,
          }
        : {}),
    });
    wire.push({
      ...base,
      ...(assistant
        ? {
            providerReasoningContent: reasoning,
            providerReasoningProvenance: "provider_response" as const,
          }
        : {}),
    });
  }
  return { runtime, wire };
}

function admissionTotal(wire: readonly LLMMessage[]): number {
  return estimateTokenAccountingRequest(
    createTokenAccountingRequest({
      provider: "zai-coding-plan",
      model: "glm-5.3",
      messages: wire,
      options: { contextWindowTokens: 950_000, maxOutputTokens: 4_000 },
      contextWindowTokens: 950_000,
      reservedOutputTokens: 4_000,
    }),
  ).totalTokens;
}

function gateTotal(runtime: readonly RuntimeMessage[]): number {
  return estimateMessagesTokens(runtime, {
    provider: { name: "zai-coding-plan" },
    options: {
      mainLoopModel: "glm-5.3",
      contextWindowTokens: 950_000,
      maxOutputTokens: 4_000,
    },
  } as unknown as CompactContext);
}

describe("compaction pressure accounting parity", () => {
  it("charges retained provider reasoning exactly as admission does", () => {
    const { runtime, wire } = history(40_000);
    expect(gateTotal(runtime)).toBe(admissionTotal(wire));
  });

  it("still matches when no reasoning is retained", () => {
    const { runtime, wire } = history(0);
    const bare = runtime.map(({ providerReasoningContent: _c, providerReasoningProvenance: _p, ...rest }) => rest);
    const bareWire = wire.map(({ providerReasoningContent: _c, providerReasoningProvenance: _p, ...rest }) => rest);
    expect(gateTotal(bare)).toBe(admissionTotal(bareWire));
  });

  it("reasoning materially changes the measured pressure, so dropping it would understate it", () => {
    const withReasoning = gateTotal(history(40_000).runtime);
    const withoutReasoning = gateTotal(
      history(0).runtime.map(({ providerReasoningContent: _c, providerReasoningProvenance: _p, ...rest }) => rest),
    );
    expect(withReasoning).toBeGreaterThan(withoutReasoning * 2);
  });

  it("charges assistant phase metadata, which admission also counts", () => {
    const runtime: RuntimeMessage[] = [
      { role: "user", originalRole: "user", content: "ask" },
      {
        role: "assistant",
        originalRole: "assistant",
        content: "answer",
        phase: "final_answer",
      },
    ];
    const wire: LLMMessage[] = [
      { role: "user", content: "ask" },
      { role: "assistant", content: "answer", phase: "final_answer" },
    ];
    expect(gateTotal(runtime)).toBe(admissionTotal(wire));
  });

  it("ignores a phase value that is not part of the wire union", () => {
    const runtime: RuntimeMessage[] = [
      { role: "user", originalRole: "user", content: "ask" },
      {
        role: "assistant",
        originalRole: "assistant",
        content: "answer",
        phase: "not_a_wire_phase",
      },
    ];
    const wire: LLMMessage[] = [
      { role: "user", content: "ask" },
      { role: "assistant", content: "answer" },
    ];
    expect(gateTotal(runtime)).toBe(admissionTotal(wire));
  });
});
