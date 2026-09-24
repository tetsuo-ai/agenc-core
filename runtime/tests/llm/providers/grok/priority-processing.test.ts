// xAI priority processing (docs.x.ai/developers/advanced-api-usage/priority-processing,
// read 2026-09-24): `service_tier: "priority"` on a Responses request asks for
// higher scheduling priority at 2x every token rate, and the response's
// `service_tier` names the tier actually used ("priority", or "default" when
// the request ran at the default tier). AgenC sends it for the session's
// "priority" tier on the Grok rows that list a Fast tier, and never on the xAI
// sign-in route, whose priority behavior xAI does not document.
import { describe, expect, test, vi } from "vitest";

import type { LLMChatOptions, LLMMessage } from "../../types.js";
import { GrokProvider } from "./adapter.js";

const messages: LLMMessage[] = [{ role: "user", content: "hello" }];

function completedResponse(
  model: string,
  serviceTier: string | undefined,
): Record<string, unknown> {
  return {
    id: "resp_tier",
    status: "completed",
    incomplete_details: null,
    model,
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
    output_text: "ok",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      request_id: null,
    }),
  };
}

function streamFromEvents(
  events: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function grokWithWire(params: {
  readonly model: string;
  readonly authMode?: "api_key" | "oauth";
  readonly servedTier?: string;
  readonly stream?: boolean;
}) {
  const provider = new GrokProvider({
    apiKey: "xai-test",
    model: params.model,
    ...(params.authMode !== undefined ? { authMode: params.authMode } : {}),
  });
  const bodies: Record<string, unknown>[] = [];
  const create = vi.fn((body: Record<string, unknown>) => {
    bodies.push(body);
    const response = completedResponse(
      String(body.model),
      params.servedTier,
    );
    return withResponse(
      params.stream === true
        ? streamFromEvents([
            { type: "response.output_text.delta", delta: "ok" },
            { type: "response.completed", response },
          ])
        : response,
    );
  });
  (provider as unknown as { client: unknown }).client = {
    responses: { create },
  };
  return { provider, bodies };
}

describe("xAI priority processing on the Responses wire", () => {
  test.each(["grok-4.7", "grok-4.6"])(
    "a priority turn on %s sends service_tier priority",
    async (model) => {
      const { provider, bodies } = grokWithWire({ model });
      await provider.chat(messages, { serviceTier: "priority" });
      expect(bodies[0]?.service_tier).toBe("priority");
    },
  );

  test("a streamed priority turn sends service_tier priority", async () => {
    const { provider, bodies } = grokWithWire({ model: "grok-4.7", stream: true });
    await provider.chatStream(messages, () => {}, { serviceTier: "priority" });
    expect(bodies[0]).toMatchObject({ stream: true, service_tier: "priority" });
  });

  test.each<[string, string, LLMChatOptions, ("api_key" | "oauth")?]>([
    ["no service tier", "grok-4.7", {}],
    ["the default tier", "grok-4.7", { serviceTier: "default" }],
    ["OpenAI's flex tier, which xAI does not document", "grok-4.7", { serviceTier: "flex" }],
    ["a model without a Fast tier (grok-4.5)", "grok-4.5", { serviceTier: "priority" }],
    ["a model without a Fast tier (grok-4.3)", "grok-4.3", { serviceTier: "priority" }],
    ["the multi-agent model", "grok-4.20-multi-agent-0309", { serviceTier: "priority" }],
    ["the xAI sign-in route", "grok-4.7", { serviceTier: "priority" }, "oauth"],
  ])("sends no service_tier for %s", async (_label, model, options, authMode) => {
    const { provider, bodies } = grokWithWire({
      model,
      ...(authMode !== undefined ? { authMode } : {}),
    });
    await provider.chat(messages, options);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("service_tier");
  });

  test("an explicit API-key provider sends the tier like an unmarked one", async () => {
    const { provider, bodies } = grokWithWire({ model: "grok-4.7", authMode: "api_key" });
    await provider.chat(messages, { serviceTier: "priority" });
    expect(bodies[0]?.service_tier).toBe("priority");
  });

  test("the tier follows the model the request actually names", async () => {
    // A request-scoped override to a model without a Fast tier drops it, and
    // an override to a Fast model gains it.
    const fastProvider = grokWithWire({ model: "grok-4.7" });
    await fastProvider.provider.chat(messages, {
      serviceTier: "priority",
      model: "grok-4.5",
    });
    expect(fastProvider.bodies[0]).toMatchObject({ model: "grok-4.5" });
    expect(fastProvider.bodies[0]).not.toHaveProperty("service_tier");

    const plainProvider = grokWithWire({ model: "grok-4.5" });
    await plainProvider.provider.chat(messages, {
      serviceTier: "priority",
      model: "grok-4.6",
    });
    expect(plainProvider.bodies[0]).toMatchObject({
      model: "grok-4.6",
      service_tier: "priority",
    });
  });
});

describe("xAI served tier on the response", () => {
  test.each([
    ["priority", "fast"],
    ["fast", "fast"],
    ["default", undefined],
    [undefined, undefined],
  ])("chat reads service_tier %s as speed %s", async (servedTier, speed) => {
    const { provider } = grokWithWire({
      model: "grok-4.7",
      ...(servedTier !== undefined ? { servedTier } : {}),
    });
    const result = await provider.chat(messages, { serviceTier: "priority" });
    expect(result.usage.speed).toBe(speed);
  });

  test.each([
    ["priority", "fast"],
    ["default", undefined],
  ])("a stream reads the completed response's service_tier %s as speed %s", async (servedTier, speed) => {
    const { provider } = grokWithWire({
      model: "grok-4.7",
      servedTier,
      stream: true,
    });
    const result = await provider.chatStream(messages, () => {}, {
      serviceTier: "priority",
    });
    expect(result.usage.speed).toBe(speed);
  });
});
