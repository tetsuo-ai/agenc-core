import { afterEach, describe, expect, test, vi } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import * as attachments from "../../src/prompts/attachments/orchestrator.js";
import { runTurn } from "../../src/session/run-turn.js";
import { CONTEXT_IMAGE_BUDGET_ENV } from "../../src/session/query-image-budget.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("image budget at the final sampling boundary", () => {
  test.each([
    { budget: 6000, currentBytes: 4000, expected: ["current"] },
    { budget: 6000, currentBytes: 7000, expected: [] },
    { budget: 10000, currentBytes: 4000, expected: ["old", "current"] },
    { budget: 0, currentBytes: 4000, expected: ["old", "current"] },
  ])("counts fresh image mentions: $currentBytes bytes with budget $budget", async ({ budget, currentBytes, expected }) => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, String(budget));
    const oldUrl = `data:image/png;base64,${"A".repeat(4000)}`;
    const currentUrl = `data:image/png;base64,${"B".repeat(currentBytes)}`;
    vi.spyOn(attachments, "getAttachments").mockResolvedValue([{ kind: "image_mention", images: [{
      path: "/app/current.png", mediaType: "image/png", url: currentUrl,
    }] }]);
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "checked" }, { onChatStream: (messages) => seen.push(messages) });
    const { session, events, state } = mkSession({ provider, history: [{ role: "user", content: [
      { type: "image_url", image_url: { url: oldUrl } },
    ] }] });
    await drain(runTurn(session, mkCtx(), "inspect @current.png"));
    const urls = seen[0]!.flatMap((message) => Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === "image_url" ? [part.image_url.url] : []) : []);
    expect(urls.map((url) => url === currentUrl ? "current" : "old")).toEqual(expected);
    if (budget > 0) expect(urls.reduce((total, url) => total + url.length, 0)).toBeLessThanOrEqual(budget);
    const warnings = events.filter((event) => event.msg.type === "warning"
      && event.msg.payload.cause === "context_images_omitted");
    expect(warnings).toHaveLength(expected.length < 2 ? 1 : 0);
    expect(state.history[0]?.content).toEqual([{ type: "image_url", image_url: { url: oldUrl } }]);
  });
});
