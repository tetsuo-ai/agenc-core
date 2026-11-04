import { afterEach, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { CONTEXT_IMAGE_BUDGET_ENV } from "../../src/session/query-image-budget.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { attachCompactionSession, createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";

afterEach(() => { vi.unstubAllEnvs(); setAutoCompactImplForTests(null); });

test.each(["deepseek", "local-test"])("%s: only a prefix-cache route compacts before evicting a sent image", async modelProviderId => {
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
  try {
    await drain(runTurn(session, ctx, first.content));
    await drain(runTurn(session, ctx, second.content));
    const expectedCompactions = modelProviderId === "deepseek" ? 1 : 0;
    expect(compactions).toBe(expectedCompactions);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]).includes("image omitted:")).toBe(expectedCompactions === 0);
    await drain(runTurn(session, ctx, "Continue without another screenshot."));
    expect(compactions).toBe(expectedCompactions);
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
    await drain(runTurn(session, ctx, [{ type: "image_url", image_url: { url: current } }]));
    expect(requests).toHaveLength(2);
    const afterCompact = JSON.stringify(requests[1]);
    expect(afterCompact).toContain("Compaction removed 1 new image before you could inspect it");
    expect(afterCompact).not.toContain(current);
    await drain(runTurn(session, ctx, "Continue."));
    expect(JSON.stringify(requests[2]!.slice(0, requests[1]!.length))).toBe(afterCompact);
    expect(JSON.stringify(requests[2]).match(/Compaction removed 1 new image/g)).toHaveLength(1);
  } finally { session.mountRolloutStore(null); harness.close(); }
});
