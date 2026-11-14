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
    { providerName: "deepseek", modelProviderId: undefined, budget: undefined, kept: true },
    { providerName: "stub-provider", modelProviderId: "deepseek", budget: undefined, kept: true },
    { providerName: "deepseek", modelProviderId: "openai-compatible", budget: undefined, kept: false },
    { providerName: "openai-compatible", modelProviderId: undefined, budget: undefined, kept: false },
    { providerName: "deepseek", modelProviderId: undefined, budget: "6291456", kept: false },
    { providerName: "openai-compatible", modelProviderId: undefined, budget: "25165824", kept: true },
  ])("routes the default and override to the selected provider: $providerName/$modelProviderId/$budget", async ({ providerName, modelProviderId, budget, kept }) => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, budget);
    const url = `data:image/png;base64,${"A".repeat(8 * 1024 * 1024 - 22)}`;
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "checked" }, { onChatStream: messages => seen.push(messages) });
    Object.assign(provider, { name: providerName });
    const { session, state } = mkSession({ provider, model: "deepseek-flash", modelInfo: { contextWindow: 1_048_576 } });
    await drain(runTurn(session, mkCtx({ modelProviderId, modelInfo: session.modelInfo }), [
      { type: "text", text: "Inspect this screen." }, { type: "image_url", image_url: { url } },
    ]));
    expect(seen).toHaveLength(1);
    const images = (messages: readonly LLMMessage[]) => messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image_url") : []);
    expect(images(seen[0]!)).toHaveLength(kept ? 1 : 0);
    if (kept) expect(images(seen[0]!)[0]).toEqual({ type: "image_url", image_url: { url } });
    expect(images(state.history)).toHaveLength(1);
  });

  test("native DeepSeek dispatches a full 24 MiB history before evicting one batch", async () => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, undefined);
    const image = (index: number): LLMMessage => ({ role: "user", content: [
      { type: "text", text: `Screen ${index}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${String(index).padEnd(1024 * 1024 - 22, "A")}` } },
    ] });
    const history: LLMMessage[] = Array.from({ length: 24 }, (_, index) => [
      image(index), { role: "assistant" as const, content: `Inspected screen ${index}.` },
    ]).flat();
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({ content: "checked" }, { onChatStream: messages => seen.push(messages) });
    Object.assign(provider, { name: "deepseek" });
    const { session, state } = mkSession({ provider, history, model: "deepseek-flash", modelInfo: { contextWindow: 1_048_576 } });
    Object.assign(session.config, { taskTokenBudget: 0 });
    const ctx = mkCtx({ modelProviderId: "deepseek", modelInfo: session.modelInfo });
    await drain(runTurn(session, ctx, "Review the screens."));
    await drain(runTurn(session, ctx, image(24).content));
    const count = (messages: readonly LLMMessage[]) => messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image_url") : []).length;
    expect(seen.map(count)).toEqual([24, 2]);
    expect(count(state.history)).toBe(25);
  });

  test.each([
    { budget: 6000, currentBytes: 4000, expected: ["current"], provider: undefined },
    { budget: 6000, currentBytes: 7000, expected: [], provider: undefined },
    { budget: 10000, currentBytes: 4000, expected: ["old", "current"], provider: undefined },
    { budget: 0, currentBytes: 4000, expected: ["old", "current"], provider: undefined },
    { budget: 6000, currentBytes: 4000, expected: ["current"], provider: "deepseek" },
    { budget: 6000, currentBytes: 7000, expected: [], provider: "deepseek" },
    { budget: 10000, currentBytes: 4000, expected: ["old", "current"], provider: "deepseek" },
    { budget: 0, currentBytes: 4000, expected: ["old", "current"], provider: "deepseek" },
  ])("counts fresh image mentions: $currentBytes bytes with budget $budget ($provider)", async ({ budget, currentBytes, expected, provider: modelProviderId }) => {
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
    ] },
    // A prefix-cache provider owns the current turn's images; the old screen
    // belongs to an answered earlier turn.
    ...(modelProviderId === undefined ? [] : [{ role: "assistant" as const, content: "That is the old screen." }])] });
    await drain(runTurn(session, mkCtx(modelProviderId === undefined ? {} : { modelProviderId }), "inspect @current.png"));
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
