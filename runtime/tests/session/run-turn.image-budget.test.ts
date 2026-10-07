import { afterEach, describe, expect, test, vi } from "vitest";

import type { LLMContentPart, LLMMessage } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import {
  CONTEXT_IMAGE_BUDGET_ENV,
  OMITTED_IMAGE_TEXT,
  OVERSIZED_IMAGE_TEXT,
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
    // 6066 bytes over a 5000 budget: the oldest images go in one batch,
    // down to half the budget, which leaves the newest.
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
    expect((warnings[0]!.msg.payload as { message: string }).message).toContain("2 inline image(s)");
  });

  test("each screenshot turn repeats the previous request byte for byte until a batch", async () => {
    // Six 1022-byte screenshots fit a 6500-byte budget. The seventh drops
    // the oldest four, down to half the budget, and the eleventh the next four.
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "6500");
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "seen" }, { onChatStream: (messages) => seen.push(messages) });
    const { session } = mkSession({ provider });
    for (let turn = 0; turn < 12; turn += 1) {
      await drain(runTurn(session, mkCtx(), shot(`screen ${turn}`, 1000).content as LLMContentPart[]));
    }

    const imagesSent = seen.map((messages) => messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url") : []).length);
    expect(imagesSent).toEqual([1, 2, 3, 4, 5, 6, 3, 4, 5, 6, 3, 4]);
    const repeated = seen.slice(1).map((messages, index) =>
      JSON.stringify(messages.slice(0, seen[index]!.length)) === JSON.stringify(seen[index]));
    expect(repeated).toEqual([true, true, true, true, true, false, true, true, true, false, true]);
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

  test.each([
    { bytes: 4000, fits: true },
    { bytes: 7000, fits: false },
  ])("never substitutes an old screen for the current $bytes-byte attachment", async ({ bytes, fits }) => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "6000");
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "checked" }, { onChatStream: (messages) => seen.push(messages) });
    const old = shot("old screen", 3000);
    const current = shot("current screen", bytes).content as LLMContentPart[];
    const { session, state } = mkSession({ provider, history: [old] });
    await drain(runTurn(session, mkCtx(), current));

    const projected = seen[0]!.filter((message) => Array.isArray(message.content));
    const projectedParts = projected.map((message) => message.content as LLMContentPart[]);
    expect(projectedParts[0]).toContainEqual({ type: "text", text: OMITTED_IMAGE_TEXT });
    expect(projectedParts[0]?.some((part) => part.type === "image_url")).toBe(false);
    if (fits) {
      expect(projectedParts[1]).toEqual(current);
    } else {
      expect(projectedParts[1]).toContainEqual({ type: "text", text: OVERSIZED_IMAGE_TEXT });
      expect(projectedParts[1]?.some((part) => part.type === "image_url")).toBe(false);
    }
    const durableImages = state.history.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url") : []);
    expect(durableImages).toHaveLength(2);
  });
});
