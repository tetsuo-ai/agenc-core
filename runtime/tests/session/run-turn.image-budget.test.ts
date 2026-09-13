import { afterEach, describe, expect, test, vi } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import {
  CONTEXT_IMAGE_BUDGET_ENV,
  OMITTED_IMAGE_TEXT,
} from "../../src/session/query-image-budget.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

function shot(label: string, bytes: number): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: label },
      { type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(bytes)}` } },
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("context image budget in the turn loop", () => {
  test("the wire carries only the newest screenshots and the history keeps them all", async () => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "5000");
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "I see it." }, {
      onChatStream: (messages) => seen.push(messages),
    });
    const history = [shot("first", 2000), shot("second", 2000), shot("third", 2000)];
    const { session, events, state } = mkSession({ provider, history });
    await drain(runTurn(session, mkCtx(), "what do you see?"));

    expect(seen).toHaveLength(1);
    const wire = seen[0]!.filter((message) => Array.isArray(message.content));
    const kinds = wire.map((message) =>
      (message.content as Array<{ type: string; text?: string }>)
        .map((part) => (part.type === "image_url" ? "IMG" : part.text === OMITTED_IMAGE_TEXT ? "OMITTED" : part.text))
        .join("|"),
    );
    // 6000 bytes of images over a 5000 budget: keep newest up to 2500 = one image.
    expect(kinds).toEqual(["first|OMITTED", "second|OMITTED", "third|IMG"]);
    // Durable history is untouched.
    const stored = state.history.filter((message) => Array.isArray(message.content));
    expect(
      stored.flatMap((message) => message.content as Array<{ type: string }>).filter((part) => part.type === "image_url"),
    ).toHaveLength(3);
    const warnings = events.filter(
      (event) => event.msg.type === "warning" && (event.msg.payload as { cause?: string }).cause === "context_images_omitted",
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0]!.msg.payload as { message: string }).message).toContain("2 earlier inline image(s)");
  });

  test("under the budget nothing changes", async () => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "50000");
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "ok" }, { onChatStream: (messages) => seen.push(messages) });
    const { session, events } = mkSession({ provider, history: [shot("first", 2000), shot("second", 2000)] });
    await drain(runTurn(session, mkCtx(), "again"));
    const images = seen[0]!.flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<{ type: string }>).filter((part) => part.type === "image_url") : [],
    );
    expect(images).toHaveLength(2);
    expect(events.some((event) => event.msg.type === "warning" && (event.msg.payload as { cause?: string }).cause === "context_images_omitted")).toBe(false);
  });
});
