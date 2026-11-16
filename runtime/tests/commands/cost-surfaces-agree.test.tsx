import { PassThrough } from "node:stream";
import { createElement } from "react";
import { expect, it, test, vi } from "vitest";

import { awaitDaemonOneShotRun } from "../../src/bin/daemon-one-shot-cli.js";
import type { CostReport } from "../../src/commands/cost.js";
import { sessionSpendLabel } from "../../src/session/usage-display.js";
import { statusUsageScope } from "../../src/tui/components/FullscreenLayout.js";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

// The numbers of a real session (job coste2e37): a GPT-6.1 Sol lead on ChatGPT sign-in with three DeepSeek
// sub-agents during DeepSeek's off-peak hours. 0.021604 at peak rates, 0.010802 billed.
const swarm = {
  costUsd: 0.021604, billedEstimateUsd: 0.010802, hasOffPeakDiscount: true, hasUnknownCost: false,
  planCalls: 15, meteredCalls: 23, apiEquivalentUsd: 0.075352, includesSubagents: true,
  inputTokens: 342_200, outputTokens: 16_121, totalTokens: 358_321, cachedInputTokens: 308_864, cacheInputTokens: 342_200,
};
const report: CostReport = {
  totalCostUsd: swarm.costUsd, billedEstimateUsd: swarm.billedEstimateUsd, planCalls: 15, apiEquivalentUsd: swarm.apiEquivalentUsd,
  inputTokens: swarm.inputTokens, outputTokens: swarm.outputTokens, hasUnknownCost: false, models: [], agents: [],
};

it("heads the /cost modal with the billed figure of the status line and keeps the peak total apart", async () => {
  expect(sessionSpendLabel(swarm)).toBe("$0.011 billed off-peak · plan · swarm");
  const modal = await renderToString(createElement(CostUsageModal, { report, onDone: () => {}, active: false }),
    { columns: 120, rows: 40 });
  expect(modal).toMatch(/SESSION\s+\$0\.011 billed/);
  expect(modal).toContain("session $0.011 billed");
  expect(modal).not.toContain("session $0.022");
  expect(modal).toMatch(/at peak rates\s+\$0\.022/);
  // Both token counts stay readable: the old value column cut the output count ("342.2K in · 16.…").
  expect(modal).toContain("342.2K in");
  expect(modal).toContain("16.1K out");
  expect(modal).not.toContain("—");
});

it("keeps the accounting headline when no billed estimate exists", async () => {
  const modal = await renderToString(createElement(CostUsageModal, {
    report: { ...report, billedEstimateUsd: undefined }, onDone: () => {}, active: false }), { columns: 120, rows: 40 });
  expect(modal).toMatch(/SESSION\s+\$0\.022/);
  expect(modal).toContain("session $0.022");
  expect(modal).not.toContain("billed estimate");
});

test("the status line names the lead as soon as sub-agents run, before their first usage arrives", () => {
  const leadOnly = { costUsd: 0, hasUnknownCost: false, planCalls: 3, meteredCalls: 0, cachedInputTokens: 0, cacheInputTokens: 5409 };
  expect(statusUsageScope(leadOnly, 0)).toEqual({ swarm: false, cache: "lead" });
  expect(statusUsageScope(leadOnly, 3)).toEqual({ swarm: true, cache: "lead" });
  expect(statusUsageScope(swarm, 0)).toEqual({ swarm: true, cache: "swarm" });
  expect(statusUsageScope({ ...swarm, cacheUnreportedCalls: 1 }, 0)).toEqual({ swarm: true, cache: "known" });
  expect(statusUsageScope({ costUsd: 1, hasUnknownCost: false }, 3)).toBeUndefined();
  expect(statusUsageScope(undefined, 3)).toBeUndefined();
});

async function resultLineFor(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  let send: ((event: unknown) => void) | undefined;
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  const client = {
    subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => { send = callback; return () => { send = undefined; }; },
    request: async () => ({}),
  } as unknown as Parameters<typeof awaitDaemonOneShotRun>[0]["daemonClient"];
  const pending = awaitDaemonOneShotRun({ daemonClient: client, sessionId: "session-1", agentId: "agent",
    outputFormat: "json", signal: new AbortController().signal,
    io: { stdin: new PassThrough() as NodeJS.ReadStream, stdout: stdout as NodeJS.WriteStream,
      stderr: new PassThrough() as NodeJS.WriteStream } });
  send!({ jsonrpc: "2.0", method: "event.session_event",
    params: { sessionId: "session-1", agentId: "agent", event: { type: "session_usage", payload } } });
  send!({ method: "event.agent_status", params: { sessionId: "session-1", status: "idle", runStatus: "completed" } });
  await pending;
  return JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

it("print results carry the billed estimate, plan calls and API-equivalent next to the accounting cost", async () => {
  expect((await resultLineFor(swarm)).tokenUsage).toEqual({
    inputTokens: 342_200, outputTokens: 16_121, totalTokens: 358_321, costUsd: 0.021604, costKnown: true,
    billedEstimateUsd: 0.010802, planCalls: 15, apiEquivalentUsd: 0.075352,
  });
  // A summary without those ledger details keeps the old shape; a malformed detail is left out.
  expect((await resultLineFor({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.5, hasUnknownCost: false,
    billedEstimateUsd: Number.NaN, planCalls: -1, apiEquivalentUsd: "0.1" })).tokenUsage)
    .toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.5, costKnown: true });
  expect((await resultLineFor({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0, hasUnknownCost: false,
    planCalls: 2, apiEquivalentUnknown: true })).tokenUsage)
    .toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0, costKnown: true, planCalls: 2, apiEquivalentUnknown: true });
});
