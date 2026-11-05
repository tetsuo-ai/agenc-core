import { installPreparedCompactionPressure } from "../helpers/prepared-compaction-pressure.js";
import { afterEach, expect, test, vi } from "vitest";
import type { LLMContentPart, LLMMessage } from "../../src/llm/types.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import {
  CONTEXT_IMAGE_BUDGET_ENV,
  OMITTED_IMAGE_TEXT,
  admitContextImageBytes,
  rememberPreparedContextImages,
  rememberSentContextImages,
  resetSentContextImages,
  unseenImageSourcesRemovedByCompaction,
} from "../../src/session/query-image-budget.js";
import { withheldImagePlaceholder } from "../../src/session/query-image-withheld.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { attachCompactionSession, createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";

afterEach(() => { vi.unstubAllEnvs(); setAutoCompactImplForTests(null); });

test("unseen image recovery names only images this process prepared after its last dispatch", () => {
  const messages: LLMMessage[] = [
    { role: "assistant", content: "", toolCalls: [
      { id: "read-1", name: "FileRead", arguments: '{"file_path":"/work/first.png"}' },
      { id: "read-2", name: "FileRead", arguments: '{"file_path":"/work/current.png"}' },
    ] },
    { role: "tool", toolCallId: "read-1", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,first" } }] },
    { role: "tool", toolCallId: "read-2", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,current" } }] },
  ];
  const session = {};
  // No request of this process: no evidence, so no image is named.
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual([]);
  rememberSentContextImages(session, messages.slice(0, 2));
  rememberPreparedContextImages(session, messages, messages, messages);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, messages.slice(0, 2)))
    .toEqual(['"/work/current.png"']);
  // A budget notice still counts as unseen; an undecodable image does not.
  const budgetNotice = admitContextImageBytes(messages, 1);
  rememberPreparedContextImages(session, messages, budgetNotice.messages, budgetNotice.messages);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual(['"/work/current.png"']);
  const undecodable = messages.map(message => message.toolCallId === "read-2"
    ? { ...message, content: [withheldImagePlaceholder((message.content as LLMContentPart[])[0]!, "[not a valid image]")] } : message);
  rememberPreparedContextImages(session, messages, messages, undecodable);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual([]);
  resetSentContextImages(session);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual([]);
});

test.each(["deepseek", "local-test"])("%s: image pressure never compacts; the current screenshot replaces the old one in one batch", async modelProviderId => {
  vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "180");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const first: LLMMessage = { role: "user", content: [{ type: "text", text: "First screenshot" }, { type: "image_url", image_url: { url: png } }] };
  const second: LLMMessage = { role: "user", content: [{ type: "text", text: "Current screenshot" }, { type: "image_url", image_url: { url: png } }] };
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "checked" }, { onChatStream: messages => requests.push(messages) });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider });
  const ctx = mkCtx({ modelProviderId });
  attachCompactionSession(session, harness);
  let compactions = 0;
  setAutoCompactImplForTests(async () => {
    compactions++;
    return { wasCompacted: true, compactionResult: {
      message: "Previous screenshot inspected.", replacementHistory: [
        { role: "user", content: "Previous screenshot inspected." }, second,
      ],
    } };
  });
  const parts = (messages: readonly LLMMessage[], text: string) =>
    messages.find(message => JSON.stringify(message.content).includes(text))?.content as LLMContentPart[];
  try {
    await drain(runTurn(session, ctx, first.content));
    await drain(runTurn(session, ctx, second.content));
    expect(compactions).toBe(0);
    expect(requests).toHaveLength(2);
    // The model sees the screenshot it was just sent; the answered one leaves.
    expect(parts(requests[1]!, "Current screenshot")).toEqual(second.content);
    expect(parts(requests[1]!, "First screenshot")).toContainEqual({ type: "text", text: OMITTED_IMAGE_TEXT });
    expect(JSON.stringify(requests[1])).not.toContain("not inspected");
    await drain(runTurn(session, ctx, "Continue without another screenshot."));
    expect(compactions).toBe(0);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.slice(0, requests[1]!.length))).toBe(JSON.stringify(requests[1]));
  } finally { session.mountRolloutStore(null); harness.close(); }
});

test("an unseen image omitted by durable compaction gets one stable read-again notice", async () => {
  vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "180");
  const first = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const current = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "checked" }, { onChatStream: messages => requests.push(messages) });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider });
  const ctx = mkCtx({ modelProviderId: "deepseek" });
  attachCompactionSession(session, harness);
  setAutoCompactImplForTests(async () => ({ wasCompacted: true, compactionResult: {
    message: "Previous screenshot inspected.", replacementHistory: [
      { role: "user", content: "Previous screenshot inspected. [omitted: secret redaction would have altered this binary payload]" },
    ],
  } }));
  try {
    await drain(runTurn(session, ctx, [{ type: "image_url", image_url: { url: first } }]));
    Object.assign(ctx.modelInfo, { autoCompactTokenLimit: 1_000 });
    installPreparedCompactionPressure(provider, request => JSON.stringify(request.messages).includes("Natural pressure") ? 18_130 : 100);
    await drain(runTurn(session, ctx, [{ type: "text", text: "Natural pressure. ".repeat(400) }, { type: "image_url", image_url: { url: current } }]));
    expect(requests).toHaveLength(2);
    const afterCompact = JSON.stringify(requests[1]);
    expect(afterCompact).toContain("Compaction removed 1 new image before you could inspect it");
    expect(afterCompact).not.toContain(current);
    await drain(runTurn(session, ctx, "Continue."));
    expect(JSON.stringify(requests[2]!.slice(0, requests[1]!.length))).toBe(afterCompact);
    expect(JSON.stringify(requests[2]).match(/Compaction removed 1 new image/g)).toHaveLength(1);
  } finally { session.mountRolloutStore(null); harness.close(); }
});

/** Compaction at the first prepared request of a fresh process. */
async function compactAtFirstRequest(options: {
  readonly history: LLMMessage[];
  readonly prompt: LLMContentPart[] | string;
  readonly provider?: string;
  readonly model?: string;
  readonly priorTurn?: string;
}): Promise<LLMMessage[][]> {
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "checked" }, { onChatStream: messages => requests.push(messages) });
  if (options.provider !== undefined) Object.assign(provider, { name: options.provider });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider, history: options.history,
    ...(options.model !== undefined ? { modelInfo: { slug: options.model } } : {}) });
  if (options.model !== undefined) Object.assign(session.config, { model: options.model });
  const base = mkCtx({ modelProviderId: options.provider ?? "deepseek" });
  const ctx = mkCtx({ modelProviderId: options.provider ?? "deepseek",
    modelInfo: { ...base.modelInfo, ...(options.model !== undefined ? { slug: options.model } : {}) } });
  attachCompactionSession(session, harness);
  setAutoCompactImplForTests(async () => ({ wasCompacted: true, compactionResult: {
    message: "Earlier work summarized.", replacementHistory: [{ role: "user", content: "Earlier work summarized." }],
  } }));
  try {
    if (options.priorTurn !== undefined) await drain(runTurn(session, ctx, options.priorTurn));
    Object.assign(ctx.modelInfo, { autoCompactTokenLimit: 1_000 });
    installPreparedCompactionPressure(provider, request => JSON.stringify(request.messages).includes("Natural pressure") ? 18_130 : 100);
    await drain(runTurn(session, ctx, options.prompt));
  } finally { session.mountRolloutStore(null); harness.close(); }
  return requests;
}

test("after a resume, compaction names no image an earlier process already showed", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  // History written by an earlier process: the model inspected the screen.
  const history: LLMMessage[] = [
    { role: "user", content: "Check the screen." },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "FileRead", arguments: '{"file_path":"/app/shots/01.png"}' }] },
    { role: "tool", toolCallId: "read-1", toolName: "FileRead", content: [
      { type: "text", text: "Read image /app/shots/01.png" }, { type: "image_url", image_url: { url: png } },
    ] },
    { role: "assistant", content: "The screen looks right." },
  ];
  const requests = await compactAtFirstRequest({ history, prompt: "Natural pressure. ".repeat(400) });
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain("Compaction removed");
});

test("a text-only model gets no unseen-image notice for an image it could never receive", async () => {
  const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const requests = await compactAtFirstRequest({
    history: [], provider: "deepseek", model: "deepseek-v4-pro", priorTurn: "Look at the repository.",
    prompt: [{ type: "text", text: "Natural pressure. ".repeat(400) }, { type: "image_url", image_url: { url: gif } }],
  });
  expect(requests).toHaveLength(2);
  // The model policy kept the image from every request.
  expect(JSON.stringify(requests)).not.toContain(gif);
  expect(JSON.stringify(requests[1])).not.toContain("Compaction removed");
});


test("compaction after an eviction names only the image no request showed", async () => {
  // Six 1022-byte screens fit a 6500-byte budget. The seventh request
  // evicts the four oldest, which the model had already seen. A natural
  // compaction at the next request must not call them unseen; it must name
  // the eighth screen, which it removes before any request showed it.
  vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "6500");
  const screen = (index: number): LLMContentPart[] => [
    { type: "text", text: `screen ${index}` },
    { type: "image_url", image_url: { url: `data:image/png;base64,${String(index).padStart(4, "0")}${"B".repeat(996)}` } },
  ];
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "seen" }, { onChatStream: messages => requests.push(messages) });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider, modelInfo: { contextWindow: 1_048_576 } });
  Object.assign(session.config, { taskTokenBudget: 0 });
  const ctx = mkCtx({ modelProviderId: "deepseek", modelInfo: session.modelInfo });
  attachCompactionSession(session, harness);
  setAutoCompactImplForTests(async () => ({ wasCompacted: true, compactionResult: {
    message: "Screens summarized.", replacementHistory: [{ role: "user", content: "Screens summarized." }],
  } }));
  try {
    for (let index = 1; index <= 7; index++) await drain(runTurn(session, ctx, screen(index)));
    expect(requests).toHaveLength(7);
    expect(JSON.stringify(requests[6]).split(OMITTED_IMAGE_TEXT)).toHaveLength(5);
    Object.assign(ctx.modelInfo, { autoCompactTokenLimit: 1_000 });
    installPreparedCompactionPressure(provider, request => JSON.stringify(request.messages).includes("Natural pressure") ? 18_130 : 100);
    await drain(runTurn(session, ctx, [{ type: "text", text: "Natural pressure. ".repeat(400) }, ...screen(8)]));
    expect(requests).toHaveLength(8);
    const afterCompact = JSON.stringify(requests[7]);
    expect(afterCompact).not.toContain("screen 8");
    expect(afterCompact).toContain("Compaction removed 1 new image before you could inspect it. Missing image sources: the newly attached image.");
    expect(afterCompact.match(/Compaction removed/g)).toHaveLength(1);
  } finally { session.mountRolloutStore(null); harness.close(); }
});
