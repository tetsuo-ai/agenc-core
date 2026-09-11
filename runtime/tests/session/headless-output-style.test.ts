import { writeFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

describe("headless compact output style", () => {
  test("puts Explanatory style on the openai-compatible provider payload", async () => {
    const provider = mkProvider();
    let captured = "";
    provider.chatStream = async (_messages, _onChunk, options) => {
      captured = options?.systemPrompt ?? "";
      return {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    };
    const { session } = mkSession({ provider });
    writeFileSync(
      session.services.configStore.homeContext.configTomlPath,
      'config_version = 2\noutputStyle = "Explanatory"\n',
    );
    await session.services.configStore.reload();
    const ctx = { ...mkCtx(), permissionInstructionsDeferred: true };
    const baseInstructions = await assembleBaseInstructionsForModel({
      session,
      ctx,
      registry: session.services.registry,
      provider: "openai-compatible",
      permissionContext: session.permissionModeRegistry.current(),
      profile: "compact",
    });

    await drain(runTurn(session, { ...ctx, baseInstructions }, "ping"));

    expect(captured).toContain("# Output Style: Explanatory");
    expect(captured).toContain("# Explanatory Style Active");
  });
});

