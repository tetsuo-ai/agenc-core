import { installPreparedCompactionPressure } from "../helpers/prepared-compaction-pressure.js";
import { afterEach, expect, test, vi } from "vitest";
import { OMITTED_BINARY_CARRIER_TEXT } from "../../src/llm/content-conversion.js";
import { redactSecretsInValue } from "../../src/secrets/sanitizer.js";
import { inspectImageDataUrl } from "../../src/utils/image-validation.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import { syntheticPng } from "../helpers/redacted-inline-image-fixture.js";
import type { LLMContentPart, LLMMessage } from "../../src/llm/types.js";
import { clearSession } from "../../src/commands/clear.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import {
  CONTEXT_IMAGE_BUDGET_ENV,
  EVICTED_IMAGE_TEXT,
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
  rememberSentContextImages(session, messages.slice(0, 2), messages);
  rememberPreparedContextImages(session, messages, messages, messages);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, messages.slice(0, 2)))
    .toEqual(['"/work/current.png"']);
  // A budget notice still counts as unseen; an undecodable image does not.
  const budgetNotice = admitContextImageBytes(messages, 1, () => true);
  rememberPreparedContextImages(session, messages, budgetNotice.messages, budgetNotice.messages);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual(['"/work/current.png"']);
  const undecodable = messages.map(message => message.toolCallId === "read-2"
    ? { ...message, content: [withheldImagePlaceholder((message.content as LLMContentPart[])[0]!, "[not a valid image]")] } : message);
  rememberPreparedContextImages(session, messages, messages, undecodable);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual([]);
  resetSentContextImages(session);
  expect(unseenImageSourcesRemovedByCompaction(session, messages, [])).toEqual([]);
});

test("the record of presented images keeps every request since the last compaction", () => {
  const x: LLMMessage = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,screen-x" } }] };
  const text: LLMMessage = { role: "user", content: "Summarize the repository." };
  const session = {};
  // A vision request shows X.
  rememberPreparedContextImages(session, [x], [x], [x]);
  rememberSentContextImages(session, [x], [x]);
  // One request goes to a text-only model, whose image policy withholds X;
  // X is still in the conversation.
  rememberPreparedContextImages(session, [text], [text], [text]);
  rememberSentContextImages(session, [text], [x, text]);
  // Back on a vision model, X is offered again and a compaction drops it
  // before that request is sent. The model saw X, so it is not named.
  rememberPreparedContextImages(session, [x], [x], [x]);
  expect(unseenImageSourcesRemovedByCompaction(session, [x], [])).toEqual([]);
  // A compaction starts a new record.
  resetSentContextImages(session);
  rememberSentContextImages(session, [text], [text]);
  rememberPreparedContextImages(session, [x], [x], [x]);
  expect(unseenImageSourcesRemovedByCompaction(session, [x], [])).toEqual(["the newly attached image"]);
});

test("an image that left the conversation stops counting at the next request", () => {
  const x: LLMMessage = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,screen-x" } }] };
  const text: LLMMessage = { role: "user", content: "Summarize the repository." };
  const session = {};
  rememberPreparedContextImages(session, [x], [x], [x]);
  rememberSentContextImages(session, [x], [x]);
  // /clear, a manual compaction or a cleared agent history leaves X out of the
  // conversation; the next request's record no longer holds it.
  rememberPreparedContextImages(session, [text], [text], [text]);
  rememberSentContextImages(session, [text], [text]);
  // The same screen attached again and compacted away before any request of
  // this conversation sent it is named.
  rememberPreparedContextImages(session, [text, x], [text, x], [text, x]);
  expect(unseenImageSourcesRemovedByCompaction(session, [text, x], [])).toEqual(["the newly attached image"]);
});

// fx30 review (item 1): with an accumulating record, /clear left the cleared conversation's images in it, so the same
// screen attached again later counted as shown and the compaction notice missed it.
test("after /clear, an image the new conversation never sent is named when compaction removes it", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "checked" }, { onChatStream: messages => requests.push(messages) });
  Object.assign(provider, { name: "deepseek" });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider });
  Object.assign(session.config, { model: "deepseek-flash" });
  const ctx = mkCtx({ modelProviderId: "deepseek" });
  attachCompactionSession(session, harness);
  setAutoCompactImplForTests(async () => ({ wasCompacted: true, compactionResult: {
    message: "Earlier work summarized.", replacementHistory: [{ role: "user", content: "Earlier work summarized." }],
  } }));
  try {
    // The first conversation shows screen X.
    await drain(runTurn(session, ctx, [{ type: "text", text: "Screen X" }, { type: "image_url", image_url: { url: png } }]));
    expect(JSON.stringify(requests[0])).toContain(png);
    // /clear starts a new conversation on the same session object; its first request carries no image.
    await clearSession(session);
    await drain(runTurn(session, ctx, "Summarize the repository."));
    expect(JSON.stringify(requests[1])).not.toContain(png);
    // The new conversation attaches the same screen, and natural compaction removes it before any request sent it.
    Object.assign(ctx.modelInfo, { autoCompactTokenLimit: 1_000 });
    installPreparedCompactionPressure(provider, request => JSON.stringify(request.messages).includes("Natural pressure") ? 18_130 : 100);
    await drain(runTurn(session, ctx, [{ type: "text", text: "Natural pressure. ".repeat(400) },
      { type: "image_url", image_url: { url: png } }]));
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2])).toContain("Earlier work summarized.");
    // This conversation never showed X, so the notice names it, as 0.19.29 does.
    expect(JSON.stringify(requests[2])).toContain("Compaction removed 1 new image");
  } finally { session.mountRolloutStore(null); harness.close(); }
});

test("a request on a text-only model in between does not make a shown image look unseen at compaction", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "checked" }, { onChatStream: messages => requests.push(messages) });
  Object.assign(provider, { name: "deepseek" });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider });
  Object.assign(session.config, { model: "deepseek-flash" });
  const ctx = mkCtx({ modelProviderId: "deepseek" });
  attachCompactionSession(session, harness);
  setAutoCompactImplForTests(async () => ({ wasCompacted: true, compactionResult: {
    message: "Earlier work summarized.", replacementHistory: [{ role: "user", content: "Earlier work summarized." }],
  } }));
  try {
    await drain(runTurn(session, ctx, [{ type: "text", text: "Screen X" }, { type: "image_url", image_url: { url: png } }]));
    expect(JSON.stringify(requests[0])).toContain(png);
    // /model to the text-only deepseek-v4-pro for one request, then back.
    Object.assign(session.config, { model: "deepseek-v4-pro" });
    await drain(runTurn(session, ctx, "Summarize the repository."));
    expect(JSON.stringify(requests[1])).not.toContain(png);
    Object.assign(session.config, { model: "deepseek-flash" });
    Object.assign(ctx.modelInfo, { autoCompactTokenLimit: 1_000 });
    installPreparedCompactionPressure(provider, request => JSON.stringify(request.messages).includes("Natural pressure") ? 18_130 : 100);
    await drain(runTurn(session, ctx, "Natural pressure. ".repeat(400)));
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2])).toContain("Earlier work summarized.");
    expect(JSON.stringify(requests[2])).not.toContain("Compaction removed");
  } finally { session.mountRolloutStore(null); harness.close(); }
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
    // Only the turn-aware admission knows the request of its own turn showed it.
    expect(parts(requests[1]!, "First screenshot")).toContainEqual({
      type: "text", text: modelProviderId === "deepseek" ? EVICTED_IMAGE_TEXT : OMITTED_IMAGE_TEXT,
    });
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
    expect(JSON.stringify(requests[6]).split(EVICTED_IMAGE_TEXT)).toHaveLength(5);
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

test("compaction keeps the screenshots of the tail it retains (lt30 Flt30-5)", async () => {
  // lt30 O-r1: after a compaction the five FileRead screenshots of the kept tail reached the model as an omission
  // note, and the kept analysis was about exactly those screens. A screenshot whose base64 holds a run the durable
  // record cannot store unchanged is omitted there, and the replacement history is read back from that record.
  const shot = syntheticPng(true);
  expect(inspectImageDataUrl(shot)?.ok).toBe(true);
  expect(redactSecretsInValue(shot)).not.toBe(shot);
  const harness = createCompactionTransactionHarness([]);
  const reads = [1, 2, 3, 4, 5].map(index => ({ id: `read-${index}`, path: `/app/shots/0${index}.png` }));
  const result = (id: string, path: string): LLMMessage => {
    const content: LLMContentPart[] = [{ type: "text", text: `Read image ${path}` }, { type: "image_url", image_url: { url: shot } }];
    return { role: "tool", toolCallId: id, toolName: "FileRead", content, runtimeOnly: {
      toolResultIntegrity: createToolResultIntegrity({ runId: harness.store.sessionId, toolCallId: id, content }) } };
  };
  const history: LLMMessage[] = [
    { role: "user", content: "Review the five screens." },
    { role: "assistant", content: "", toolCalls: reads.map(({ id, path }) => ({ id, name: "FileRead", arguments: JSON.stringify({ file_path: path }) })) },
    ...reads.map(({ id, path }) => result(id, path)),
    { role: "assistant", content: "Analysis of the five screens: the header overlaps the menu on 03." },
  ];
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "fixed" }, { onChatStream: messages => requests.push(messages) });
  Object.assign(provider, { name: "deepseek" });
  const { session } = mkSession({ provider, history });
  Object.assign(session.config, { model: "deepseek-flash" });
  const ctx = mkCtx({ modelProviderId: "deepseek" });
  attachCompactionSession(session, harness);
  // The compaction summarizes the first request and keeps the tail: the reads, their screenshots and the analysis.
  setAutoCompactImplForTests(async (offered: unknown) => ({ wasCompacted: true, compactionResult: {
    message: "Earlier work summarized.",
    replacementHistory: [{ role: "user", content: "Earlier work summarized." }, ...(offered as LLMMessage[]).slice(1)],
  } }));
  const screens = (messages: readonly LLMMessage[]): number => JSON.stringify(messages).split(shot).length - 1;
  try {
    Object.assign(ctx.modelInfo, { autoCompactTokenLimit: 1_000 });
    installPreparedCompactionPressure(provider, request =>
      JSON.stringify(request.messages).includes("Review the five screens") ? 18_130 : 100);
    await drain(runTurn(session, ctx, "Fix the header on screen 03."));
    expect(requests).toHaveLength(1);
    const afterCompact = JSON.stringify(requests[0]);
    expect(afterCompact).toContain("Earlier work summarized.");
    expect(afterCompact).not.toContain("Review the five screens");
    expect(screens(requests[0]!)).toBe(5);
    expect(afterCompact).not.toContain(OMITTED_BINARY_CARRIER_TEXT);
    // The durable record still leaves them out.
    const durable = JSON.stringify(harness.store.readAll());
    expect(durable).toContain(OMITTED_BINARY_CARRIER_TEXT);
    expect(durable).not.toContain(shot);
    // The next turn still shows them.
    await drain(runTurn(session, ctx, "Check the fix."));
    expect(requests).toHaveLength(2);
    expect(screens(requests[1]!)).toBe(5);
  } finally { session.mountRolloutStore(null); harness.close(); }
});
