import { describe, expect, test, vi } from "vitest";

import { createProvider } from "../../src/llm/provider.js";
import type { LLMMessage, LLMProvider } from "../../src/llm/types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";

describe("Grok child session isolation", () => {
  test("parallel children continue their own response after replies finish out of order", async () => {
    const parent = createProvider("grok", {
      apiKey: "xai-test",
      model: "grok-4-fast",
      extra: { incrementalContinuation: true },
    });
    const fork = (): LLMProvider => parent.forkForSession?.({
      cwd: process.cwd(),
      sandboxExecutionBroker: new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: process.cwd(),
      }),
    }) ?? parent;
    const alpha = fork();
    const beta = fork();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstReply = Promise.withResolvers<void>();
    const secondReply = Promise.withResolvers<void>();
    const bodies: Record<string, unknown>[] = [];
    const create = vi.fn((body: Record<string, unknown>) => {
      bodies.push(body);
      const ordinal = bodies.length;
      if (ordinal === 1) firstStarted.resolve();
      if (ordinal === 2) secondStarted.resolve();
      return {
        withResponse: async () => ({
          response: new Response("", { status: 200 }),
          request_id: null,
          data: {
            async *[Symbol.asyncIterator]() {
              if (ordinal === 1) await firstReply.promise;
              if (ordinal === 2) await secondReply.promise;
              yield {
                type: "response.completed",
                response: {
                  id: ordinal === 1 ? "resp_alpha" : "resp_beta",
                  status: "completed",
                  model: "grok-4-fast",
                  output_text: "done",
                  output: [{
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  }],
                  usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
                },
              };
            },
          },
        }),
      };
    });
    const providers = new Set([parent, alpha, beta]);
    for (const provider of providers) {
      (provider as unknown as { client: unknown }).client = { responses: { create } };
    }

    const alphaMessages: LLMMessage[] = [{ role: "user", content: "alpha private context" }];
    const betaMessages: LLMMessage[] = [{ role: "user", content: "beta private context" }];
    // Each child's main loop sends its own conversation id as prompt_cache_key.
    const alphaOptions = { promptCacheKey: "conv-alpha" };
    const betaOptions = { promptCacheKey: "conv-beta" };
    try {
      const alphaTurn = alpha.chatStream(alphaMessages, () => {}, alphaOptions);
      await firstStarted.promise;
      const betaTurn = beta.chatStream(betaMessages, () => {}, betaOptions);
      await secondStarted.promise;
      secondReply.resolve();
      await betaTurn;
      firstReply.resolve();
      await alphaTurn;

      await beta.chatStream([
        ...betaMessages,
        { role: "assistant", content: "done" },
        { role: "user", content: "continue beta" },
      ], () => {}, betaOptions);

      expect(bodies[2]?.previous_response_id).toBe("resp_beta");
      expect(JSON.stringify(bodies[2]?.input)).toContain("continue beta");
      expect(JSON.stringify(bodies[2]?.input)).not.toContain("private context");
    } finally {
      firstReply.resolve();
      secondReply.resolve();
      await Promise.all([...providers].map((provider) => provider.dispose?.()));
    }
  });
});
