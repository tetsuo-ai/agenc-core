import { describe, expect, test, vi } from "vitest";
import { ProviderHttpClient } from "./client.js";

describe("ProviderHttpClient", () => {
  test("createTurnSession preserves provider contract fields while merging overrides", () => {
    const client = new ProviderHttpClient({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      defaultHeaders: { "OpenAI-Project": "proj-root" }, // branding-scan: allow real provider header
      defaultQuery: { "api-version": "2025-04-01-preview" },
      authHeaders: { Authorization: "Bearer root-token" },
      requestRetry: { maxRetries: 2 },
    });

    const session = client.createTurnSession({
      defaultHeaders: { "x-turn-id": "turn-1" },
      authHeaders: { "OpenAI-Organization": "org-1" }, // branding-scan: allow real provider header
    });

    expect(session.providerName).toBe("openai");
    expect(session.wireApi).toBe("responses");
    expect(session.requestRetryBudget.maxRetries).toBe(2);
    expect(session.streamIdleTimeoutMs).toBe(0);
  });

  test("bindConversationId and clear/reset helpers affect every turn session built from the client", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hi" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "resp_2", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "resp_3", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new ProviderHttpClient({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
    });
    client.bindConversationId("conv-123");

    await client.createTurnSession().requestJson({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: false,
      },
    });
    await client.createTurnSession().requestJson({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] },
        ],
        stream: false,
      },
    });
    client.clearResponsesResponseId();
    expect(
      (
        client as unknown as {
          responsesContinuationState?: {
            lastRequest?: unknown;
            lastResponseId?: string;
            lastResponseOutput?: unknown;
          };
        }
      ).responsesContinuationState,
    ).toMatchObject({
      lastRequest: undefined,
      lastResponseId: undefined,
      lastResponseOutput: undefined,
    });
    await client.createTurnSession().requestJson({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "after clear" }] },
        ],
        stream: false,
      },
    });

    const secondBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    const thirdBody = JSON.parse(
      String((fetchImpl.mock.calls[2]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;

    expect(secondBody.prompt_cache_key).toBe("conv-123");
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(thirdBody.prompt_cache_key).toBe("conv-123");
    expect(thirdBody.previous_response_id).toBeUndefined();
  });
});
