import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { MiniMaxProvider } from "../../src/llm/providers/minimax/index.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;
const PER_M = 1 / 1_000_000;

function completedResponse(model: string, servedTier: string): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl_minimax_priority", object: "chat.completion", model,
    service_tier: servedTier,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

interface AdmittedResult {
  readonly reservedUsd: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly chargedUsd: number;
  readonly requestBody: Record<string, unknown> | undefined;
}

async function admittedCall(params: {
  readonly model?: string;
  readonly serviceTier?: "priority";
  readonly servedTier: string;
}): Promise<AdmittedResult> {
  const directory = mkdtempSync(join(tmpdir(), "agenc-minimax-priority-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "minimax-priority-admission",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: { runId: "minimax-priority", sessionId: "minimax-priority", autonomous: false, maxCostUsd: 10 },
  });
  const acquire = vi.spyOn(client, "acquire");
  const reconcile = vi.spyOn(client, "reconcile");
  const model = params.model ?? "MiniMax-M3";
  const bodies: Record<string, unknown>[] = [];
  const provider = new MiniMaxProvider({
    apiKey: "minimax-test", model,
    fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completedResponse(model, params.servedTier);
    }),
  });
  const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
  const session = {
    conversationId: "minimax-priority",
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    await runAdmittedModelCall({
      session, provider, messages, stepId: "priority", model, providerName: "minimax",
      options: {
        maxOutputTokens: 1000,
        contextWindowTokens: 500_000,
        ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
      },
      invoke: (options) => provider.chat(messages, options),
    });
    const request = acquire.mock.calls[0]?.[0];
    const chargedUsd = reconcile.mock.calls[0]?.[1].costUsd;
    if (request === undefined || typeof chargedUsd !== "number") {
      throw new Error("the admitted call did not reserve and reconcile a priced turn");
    }
    return {
      reservedUsd: request.maxCostUsd as number,
      reservedInputTokens: request.maxInputTokens as number,
      reservedOutputTokens: request.maxOutputTokens as number,
      chargedUsd,
      requestBody: bodies[0],
    };
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// Official standard $0.30/$1.20 per M; priority is 1.5 times each rate.
const STANDARD_CHARGE = (1000 * 0.3 + 100 * 1.2) * PER_M;

test("MiniMax priority is sent, reserved at 1.5x and charged from the served tier", async () => {
  const standard = await admittedCall({ servedTier: "standard" });
  const priority = await admittedCall({ serviceTier: "priority", servedTier: "priority" });
  expect(standard.chargedUsd).toBeCloseTo(STANDARD_CHARGE, 12);
  expect(priority.chargedUsd).toBeCloseTo(1.5 * STANDARD_CHARGE, 12);
  expect(priority.reservedUsd).toBeCloseTo(
    (priority.reservedInputTokens * 0.45 + priority.reservedOutputTokens * 1.8) * PER_M, 12,
  );
  expect(priority.requestBody?.service_tier).toBe("priority");
  expect(standard.requestBody).not.toHaveProperty("service_tier");
  const downgraded = await admittedCall({ serviceTier: "priority", servedTier: "standard" });
  expect(downgraded.chargedUsd).toBeCloseTo(STANDARD_CHARGE, 12);
});

test("MiniMax M2 never inherits the M3 priority contract", async () => {
  const standard = await admittedCall({ model: "MiniMax-M2.7", servedTier: "standard" });
  const call = await admittedCall({ model: "MiniMax-M2.7", serviceTier: "priority", servedTier: "standard" });
  expect(call.requestBody).not.toHaveProperty("service_tier");
  expect(call.chargedUsd).toBeCloseTo(standard.chargedUsd, 12);
  // M2.7's $0.375/M cache-write rate exceeds its $0.30/M input rate.
  // Admission covers that standard-tier worst case, not M3 priority prices.
  expect(call.reservedUsd).toBeCloseTo(
    (call.reservedInputTokens * 0.375 + call.reservedOutputTokens * 1.2) * PER_M, 12,
  );
});
