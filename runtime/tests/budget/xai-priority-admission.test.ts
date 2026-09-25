// xAI priority processing bills 2x every token rate, and only when the
// response reports service_tier "priority" (docs.x.ai pricing and
// priority-processing pages, read 2026-09-24). Under a hard cost cap the
// reservation must cover a priority turn, reconciliation charges the tier
// the response reports, and a request that never carries the tier (the xAI
// sign-in route, or a model without a Fast tier) is reserved at standard.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;
const PER_M = 1 / 1_000_000;

function completedResponse(model: string, servedTier: string): Record<string, unknown> {
  return {
    id: "resp_priority_admission",
    status: "completed",
    incomplete_details: null,
    model,
    service_tier: servedTier,
    output_text: "ok",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
    usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
  };
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
  readonly authMode?: "oauth";
}): Promise<AdmittedResult> {
  const directory = mkdtempSync(join(tmpdir(), "agenc-xai-priority-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "xai-priority-admission",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: { runId: "xai-priority", sessionId: "xai-priority", autonomous: false, maxCostUsd: 10 },
  });
  const acquire = vi.spyOn(client, "acquire");
  const reconcile = vi.spyOn(client, "reconcile");
  const model = params.model ?? "grok-4.7";
  const provider = new GrokProvider({
    apiKey: "xai-test",
    model,
    ...(params.authMode !== undefined ? { authMode: params.authMode } : {}),
  });
  const bodies: Record<string, unknown>[] = [];
  (provider as unknown as { client: unknown }).client = {
    responses: {
      create: vi.fn((body: Record<string, unknown>) => {
        bodies.push(body);
        const data = completedResponse(model, params.servedTier);
        return {
          withResponse: async () => ({
            data,
            response: new Response("{}", { status: 200 }),
            request_id: null,
          }),
        };
      }),
    },
  };
  const messages: LLMMessage[] = [{ role: "user", content: "synthetic probe" }];
  const session = {
    conversationId: "xai-priority",
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    await runAdmittedModelCall({
      session, provider, messages, stepId: "priority", model, providerName: "grok",
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

// Grok 4.7: $2 input / $6 output per 1M, priority $4 / $12.
const STANDARD_CHARGE = 1000 * 2 * PER_M + 100 * 6 * PER_M;

test("a priority Grok 4.7 turn under a hard cap reserves and is charged at 2x", async () => {
  const standard = await admittedCall({ servedTier: "default" });
  const priority = await admittedCall({ serviceTier: "priority", servedTier: "priority" });
  expect(standard.chargedUsd).toBeCloseTo(STANDARD_CHARGE, 12);
  expect(priority.chargedUsd).toBeCloseTo(2 * STANDARD_CHARGE, 12);
  expect(standard.reservedUsd).toBeCloseTo(
    standard.reservedInputTokens * 2 * PER_M + standard.reservedOutputTokens * 6 * PER_M,
    12,
  );
  expect(priority.reservedUsd).toBeCloseTo(
    priority.reservedInputTokens * 4 * PER_M + priority.reservedOutputTokens * 12 * PER_M,
    12,
  );
  expect(priority.chargedUsd).toBeLessThanOrEqual(priority.reservedUsd);
  expect(priority.requestBody?.service_tier).toBe("priority");
  // xAI's default tier is the omitted field; nothing is pinned without Fast.
  expect(standard.requestBody).not.toHaveProperty("service_tier");
});

test("a priority request that xAI serves at the default tier is charged standard", async () => {
  const downgraded = await admittedCall({ serviceTier: "priority", servedTier: "default" });
  expect(downgraded.chargedUsd).toBeCloseTo(STANDARD_CHARGE, 12);
  // The reservation still covered the priority rates the request asked for.
  expect(downgraded.reservedUsd).toBeCloseTo(
    downgraded.reservedInputTokens * 4 * PER_M + downgraded.reservedOutputTokens * 12 * PER_M,
    12,
  );
});

test.each([
  ["on the xAI sign-in route", { authMode: "oauth" as const }],
  ["for a model without a Fast tier", { model: "grok-4.5" }],
])("a priority request %s sends no tier and is reserved at standard rates", async (_label, extra) => {
  const call = await admittedCall({ serviceTier: "priority", servedTier: "default", ...extra });
  expect(call.requestBody).not.toHaveProperty("service_tier");
  expect(call.chargedUsd).toBeCloseTo(STANDARD_CHARGE, 12);
  expect(call.reservedUsd).toBeCloseTo(
    call.reservedInputTokens * 2 * PER_M + call.reservedOutputTokens * 6 * PER_M,
    12,
  );
});
