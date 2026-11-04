import { afterEach, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { CONTEXT_IMAGE_BUDGET_ENV } from "../../src/session/query-image-budget.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { attachCompactionSession, createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";

afterEach(() => { vi.unstubAllEnvs(); setAutoCompactImplForTests(null); });

test("evicting a sent image crosses one explicit compaction boundary, then reuses the new prefix", async () => {
  vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "180");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const first: LLMMessage = { role: "user", content: [{ type: "text", text: "First screenshot" }, { type: "image_url", image_url: { url: png } }] };
  const second: LLMMessage = { role: "user", content: [{ type: "text", text: "Current screenshot" }, { type: "image_url", image_url: { url: png } }] };
  const requests: LLMMessage[][] = [];
  const provider = mkProvider({ content: "checked" }, { onChatStream: messages => requests.push(messages) });
  const harness = createCompactionTransactionHarness([]);
  const { session } = mkSession({ provider });
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
    await drain(runTurn(session, mkCtx(), first.content));
    await drain(runTurn(session, mkCtx(), second.content));
    expect(compactions).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).not.toContain("image omitted:");
    await drain(runTurn(session, mkCtx(), "Continue without another screenshot."));
    expect(compactions).toBe(1);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.slice(0, requests[1]!.length))).toBe(JSON.stringify(requests[1]));
  } finally { session.mountRolloutStore(null); harness.close(); }
});
