import { describe, expect, it, vi } from "vitest";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { buildPostCompactMessages, compactConversation } from "../../../src/services/compact/compact.js";
import { llmMessageToDurableResponseItem } from "../../../src/session/message-history-conversion.js";
import {
  toAgenCRuntimeMessages,
  fromAgenCRuntimeMessages,
} from "../../../src/session/runtime-message-conversion.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import { createGeminiEndpointPlan } from "../../../src/llm/providers/gemini/endpoint-plan.js";
import { GeminiProvider } from "../../../src/llm/providers/gemini/index.js";
import type { LLMMessage, LLMTool } from "../../../src/llm/types.js";

const secret = `sk-proj-${"a".repeat(64)}`;
const signature = "c2lnbmVkLWNhbGw=";
const writeTool: LLMTool = {
  type: "function",
  function: {
    name: "Write",
    description: "Write a file",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"],
    },
  },
};

/**
 * A mid-turn compaction keeps the current turn's last step from the durable
 * record. When that step's arguments look like a secret, the record is
 * redacted (an `API_KEY=` line is enough); Gemini 3 and newer still need the
 * call's real signature on the next request, or they answer HTTP 400.
 */
describe("Gemini signatures across compaction", () => {
  for (const [label, content] of [
    ["plain code", "print('hello')\n"],
    ["an API_KEY line", "API_KEY=placeholder\n"],
    ["a token-shaped secret", `API_KEY=${secret}\n`],
  ] as const) {
    it(`keeps the kept call's own signature (${label})`, async () => {
      const sessionId = `gemini-signature-compaction-${label.replaceAll(" ", "-")}`;
      const args = JSON.stringify({ file_path: "/synthetic/.env", content });
      const parts = [{
        functionCall: { name: "Write", args: JSON.parse(args), id: "call_4242" },
        thoughtSignature: signature,
      }];
      const toolResult = "wrote /synthetic/.env";
      const wire: LLMMessage[] = [
        ...Array.from({ length: 16 }, (_, index): LLMMessage => ({
          role: index % 2 ? "assistant" : "user",
          content: Array.from({ length: 140 }, (_, part) => `item-${index}.${part}: result=${part};\n`).join(""),
        })),
        { role: "user", content: Array.from({ length: 200 }, (_, part) => `task-${part}: step=${part};\n`).join("") },
        {
          role: "assistant", content: "",
          toolCalls: [{ id: "call_4242", name: "Write", arguments: args }],
          providerReasoningContent: JSON.stringify(parts),
          providerReasoningProvenance: { provider: "gemini", model: "gemini-4-argon" },
        },
        {
          role: "tool", content: toolResult, toolCallId: "call_4242", toolName: "Write",
          runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
            runId: sessionId, toolCallId: "call_4242", content: toolResult,
          }) },
        },
      ];
      const durable = wire.map(llmMessageToDurableResponseItem);
      const harness = createCompactionTransactionHarness([], { sessionId });
      try {
        for (const payload of durable) {
          harness.store.appendRollout({ type: "response_item", payload }, { durable: true });
        }
        const result = await compactConversation(toAgenCRuntimeMessages(wire), harness.context);
        expect(result.transaction).toBeDefined();
        expect(JSON.stringify(harness.store.readAll())).not.toContain(secret);
        const after = fromAgenCRuntimeMessages(buildPostCompactMessages(result));
        const kept = after.find((message) => message.toolCalls?.[0]?.id === "call_4242");
        expect(kept).toBeDefined();

        const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
          candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
        }));
        const provider = new GeminiProvider({
          credentialPlan: { kind: "api-key", credential: "gemini-test", source: "factory" },
          endpointPlan: createGeminiEndpointPlan(),
          model: "gemini-4-argon",
          fetchImpl,
        });
        await provider.chat(after, { tools: [writeTool] });
        const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
          contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        };
        const call = request.contents.flatMap((entry) => entry.parts)
          .find((part) => (part.functionCall as { id?: string } | undefined)?.id === "call_4242");
        expect(call?.thoughtSignature).toBe(signature);
        expect(JSON.stringify(request)).not.toContain(secret);
      } finally { harness.close(); }
    });
  }
});
