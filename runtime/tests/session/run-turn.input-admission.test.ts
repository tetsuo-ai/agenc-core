import { afterEach, expect, test, vi } from "vitest";
import { createCsvAgentInvocationEnvelope, materializeAgentInvocationMessages } from "../../src/contracts/agent-invocation-envelope.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { installPreparedCompactionPressure } from "../helpers/prepared-compaction-pressure.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

function setup() {
  const provider = mkProvider({ content: "small prompt succeeded" });
  const chat = vi.spyOn(provider, "chatStream");
  installPreparedCompactionPressure(provider, request => 500 + request.messages.reduce((n, m) => {
    const text = typeof m.content === "string" ? m.content : m.content.filter(part => part.type === "text").map(part => part.text).join("");
    // Count the controlled fixture input, ignoring runtime reminder messages.
    return n + (text === "hello" || /^[xy]+$/.test(text) ? text.length : 0);
  }, 0));
  const { session, events } = mkSession({ provider, modelInfo: { contextWindow: 4096, maxOutputTokens: 2048 } });
  const ctx = mkCtx({ modelInfo: { ...mkCtx().modelInfo, contextWindow: 4096, maxOutputTokens: 2048 } });
  const compact = vi.fn(async () => ({ wasCompacted: false, skippedCode: "no_shrink" as const }));
  setAutoCompactImplForTests(compact);
  return { session, events, ctx, chat, compact };
}
afterEach(() => { setAutoCompactImplForTests(null); vi.restoreAllMocks(); });

test("refuses an impossible prompt before persistence and accepts the next small prompt", async () => {
  const { session, events, ctx, chat, compact } = setup();
  const before = structuredClone(session.state.unsafePeek().history);
  await expect(drain(runTurn(session, ctx, "x".repeat(5000)))).rejects.toThrow(/prompt.*5,000.*2,572/is);
  expect(session.state.unsafePeek().history).toEqual(before);
  expect(events.some(e => e.msg.type === "user_message" || e.msg.type === "turn_started" || e.msg.type === "response_item")).toBe(false);
  expect(chat).not.toHaveBeenCalled();
  expect(compact).not.toHaveBeenCalled();
  await drain(runTurn(session, { ...ctx, subId: "next-small" }, "hello"));
  expect(chat).toHaveBeenCalledOnce();
  expect(JSON.stringify(session.state.unsafePeek().history)).not.toContain("x".repeat(5000));
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
});

test("counts expanded pasted text, rather than its short display placeholder", async () => {
  const { session, ctx, chat } = setup();
  await expect(drain(runTurn(session, ctx, [{ type: "text", text: "x".repeat(5000) }], {
    displayUserMessage: "[Pasted text #1 +10000 lines]",
  }))).rejects.toThrow(/Trim|file/);
  expect(chat).not.toHaveBeenCalled();
});

test("admits a large prompt at the available limit, including a lowered output reservation", async () => {
  const { session, ctx, chat, events } = setup();
  await drain(runTurn(session, ctx, "x".repeat(2572)));
  expect(chat, JSON.stringify(events.map(e => e.msg))).toHaveBeenCalledOnce();
});

test("keeps history pressure on the normal compaction path", async () => {
  const { session, ctx, chat, compact } = setup();
  compact.mockImplementation(async () => ({
    wasCompacted: true,
    compactionResult: { message: "summary", replacementHistory: [{ role: "user", content: "summary" }] },
  } as never));
  await drain(runTurn(session, ctx, "hello", { history: [
    { role: "user", content: "y".repeat(5000) },
    { role: "assistant", content: "previous answer" },
  ] }));
  expect(compact).toHaveBeenCalled();
  expect(chat).toHaveBeenCalledOnce();
});

test("refuses a prompt one token past the available limit", async () => {
  const { session, ctx } = setup();
  await expect(drain(runTurn(session, ctx, "x".repeat(2573)))).rejects.toThrow(/2,573.*2,572/);
});

test("keeps oversized inline images on their existing placeholder path", async () => {
  const { session, ctx, chat } = setup();
  installPreparedCompactionPressure(session.services.provider, request =>
    JSON.stringify(request.messages).includes("data:image/") ? 5000 : 500);
  await drain(runTurn(session, ctx, [
    { type: "text", text: "hello" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}` } },
  ]));
  expect(chat).toHaveBeenCalledOnce();
  expect(JSON.stringify(chat.mock.calls[0]?.[0])).not.toContain("data:image/");
});

test("refuses text beyond the accounting byte cap with plain guidance and leaves the session usable", async () => {
  const { session, ctx, chat } = setup();
  await expect(drain(runTurn(session, ctx, "x".repeat(17 * 1024 * 1024)))).rejects.toThrow(/17,825,794 bytes.*16,777,216 bytes.*file/);
  expect(session.state.unsafePeek().history).toHaveLength(0);
  await drain(runTurn(session, { ...ctx, subId: "after-byte-cap" }, "hello"));
  expect(chat).toHaveBeenCalledOnce();
});

test("the daemon preflight uses the session's settings authority and refuses before a user event", async () => {
  const { session, events, chat } = setup();
  await expect(session.assertUserPromptFits("x".repeat(5000))).rejects.toThrow(/prompt.*5,000.*2,572/is);
  expect(events.some(e => e.msg.type === "user_message")).toBe(false);
  await session.assertUserPromptFits("hello");
  expect(chat).not.toHaveBeenCalled();
});


test("sizes a complete invocation seed before committing any channel", async () => {
  const { session, ctx, chat, compact, events } = setup();
  const messages = materializeAgentInvocationMessages(createCsvAgentInvocationEnvelope({
    jobId: "admission-job", itemId: "admission-item", rowIndex: 0,
    rowSha256: `sha256:${"9".repeat(64)}`,
    instruction: "x".repeat(5000), row: { value: "small data channel" },
  }));
  const user = messages.at(-1)!;
  installPreparedCompactionPressure(session.services.provider, request =>
    500 + request.messages.reduce((total, message) => {
      const text = JSON.stringify(message.content);
      return total + (text.includes("x".repeat(5000)) ? 5000 : 0);
    }, 0));
  await expect(drain(runTurn(session, ctx, user.content, {
    history: messages.slice(0, -1), seedUserMessageRuntimeOnly: user.runtimeOnly,
  }))).rejects.toThrow(/prompt.*5,000.*2,572/is);
  expect(session.state.unsafePeek().history).toHaveLength(0);
  expect(events.some(e => e.msg.type === "user_message" || e.msg.type === "turn_started" || e.msg.type === "response_item")).toBe(false);
  expect(chat).not.toHaveBeenCalled();
  expect(compact).not.toHaveBeenCalled();
});

test("rejects an incomplete invocation seed before provider dispatch", async () => {
  const { session, ctx, chat } = setup();
  const messages = materializeAgentInvocationMessages(createCsvAgentInvocationEnvelope({
    jobId: "incomplete-job", itemId: "incomplete-item", rowIndex: 0,
    rowSha256: `sha256:${"8".repeat(64)}`,
    instruction: "small task", row: { value: "small data" },
  }));
  const user = messages.at(-1)!;
  await expect(drain(runTurn(session, ctx, user.content, {
    history: messages.slice(1, -1), seedUserMessageRuntimeOnly: user.runtimeOnly,
  }))).rejects.toThrow(/channel sequence is incomplete/);
  expect(session.state.unsafePeek().history).toHaveLength(0);
  expect(chat).not.toHaveBeenCalled();
});
