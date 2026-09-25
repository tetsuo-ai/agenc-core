// Under a hard USD cap the reservation has to bound what OpenAI can bill for
// the call: Fast mode doubles every GPT-6 Sol rate, a prompt over 272K input
// tokens moves the whole request to the long-context rates, and cache writes
// cost 1.25x input (developers.openai.com/api/docs/pricing and the fast-mode
// and prompt-caching guides, read 2026-09-23). Reconciliation then charges
// the tier the response reports it was served at.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;

interface ServedUsage {
  readonly input: number;
  readonly output: number;
  readonly cached?: number;
  readonly cacheWrite?: number;
}

function responsesBody(model: string, servedTier: string, usage: ServedUsage): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      model,
      service_tier: servedTier,
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        input_tokens_details: {
          cached_tokens: usage.cached ?? 0,
          cache_write_tokens: usage.cacheWrite ?? 0,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface AdmittedResult {
  readonly reservedUsd: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly chargedUsd: number | undefined;
  readonly requestBody: Record<string, unknown> | undefined;
}

async function admittedCall(params: {
  readonly model?: string;
  readonly serviceTier?: "priority";
  readonly servedTier: string;
  readonly served: ServedUsage;
  readonly prompt?: string;
  readonly maxOutputTokens?: number;
}): Promise<AdmittedResult> {
  const directory = mkdtempSync(join(tmpdir(), "agenc-openai-tier-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "openai-tier-admission",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: { runId: "openai-tier", sessionId: "openai-tier", autonomous: false, maxCostUsd: 100 },
  });
  const acquire = vi.spyOn(client, "acquire");
  const reconcile = vi.spyOn(client, "reconcile");
  const model = params.model ?? "gpt-6-sol";
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    responsesBody(model, params.servedTier, params.served));
  const messages: LLMMessage[] = [
    { role: "user", content: params.prompt ?? "synthetic probe" },
  ];
  const provider = new OpenAIProvider({ apiKey: "sk-test", model, fetchImpl });
  const session = {
    conversationId: "openai-tier",
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    await runAdmittedModelCall({
      session, provider, messages, stepId: "tier", model, providerName: "openai",
      options: {
        maxOutputTokens: params.maxOutputTokens ?? 1000,
        contextWindowTokens: 1_050_000,
        ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
      },
      invoke: (options) => provider.chat(messages, options),
    });
    const request = acquire.mock.calls[0]?.[0];
    const init = fetchImpl.mock.calls[0]?.[1];
    return {
      reservedUsd: request?.maxCostUsd as number,
      reservedInputTokens: request?.maxInputTokens as number,
      reservedOutputTokens: request?.maxOutputTokens as number,
      chargedUsd: reconcile.mock.calls[0]?.[1].costUsd,
      requestBody: init?.body === undefined
        ? undefined
        : JSON.parse(String(init.body)) as Record<string, unknown>,
    };
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function deniedCall(params: Parameters<typeof admittedCall>[0]): Promise<unknown> {
  try {
    await admittedCall(params);
  } catch (error) {
    return error;
  }
  return undefined;
}

// Rates per token for GPT-6 Sol: the reservation charges every input token at
// the dearest input rate (cache writes) and every output token at output.
const PER_M = 1 / 1_000_000;

test("a GPT-6 Sol call in Fast mode under a hard cap reserves and is charged at Fast rates", async () => {
  const standard = await admittedCall({
    servedTier: "default",
    served: { input: 1000, output: 100 },
  });
  const fast = await admittedCall({
    serviceTier: "priority",
    servedTier: "fast",
    served: { input: 1000, output: 100 },
  });
  // Standard $2 / $10 and Fast $4 / $20 per 1M.
  expect(standard.chargedUsd).toBeCloseTo(1000 * 2 * PER_M + 100 * 10 * PER_M, 12);
  expect(fast.chargedUsd).toBeCloseTo(1000 * 4 * PER_M + 100 * 20 * PER_M, 12);
  // Short context: worst input rate is the cache write ($2.50, Fast $5).
  expect(standard.reservedUsd).toBeCloseTo(
    standard.reservedInputTokens * 2.5 * PER_M + standard.reservedOutputTokens * 10 * PER_M,
    12,
  );
  expect(fast.reservedUsd).toBeCloseTo(
    fast.reservedInputTokens * 5 * PER_M + fast.reservedOutputTokens * 20 * PER_M,
    12,
  );
  expect(fast.chargedUsd).toBeLessThanOrEqual(fast.reservedUsd);
  expect(fast.requestBody?.service_tier).toBe("priority");
});

test("a Fast request that OpenAI serves at the default tier is charged Standard", async () => {
  const downgraded = await admittedCall({
    serviceTier: "priority",
    servedTier: "default",
    served: { input: 1000, output: 100 },
  });
  expect(downgraded.chargedUsd).toBeCloseTo(1000 * 2 * PER_M + 100 * 10 * PER_M, 12);
});

test("a hard-capped call without Fast pins the Standard tier on the wire", async () => {
  // A project whose default tier is Fast would otherwise bill the omitted
  // service_tier at Fast rates against a Standard reservation.
  const call = await admittedCall({
    servedTier: "default",
    served: { input: 1000, output: 100 },
  });
  expect(call.requestBody?.service_tier).toBe("default");
});

test("cache writes reported on the Responses path are charged at 1.25x input", async () => {
  const call = await admittedCall({
    servedTier: "default",
    served: { input: 1000, output: 100, cached: 200, cacheWrite: 300 },
  });
  // 500 ordinary * $2 + 200 cached * $0.20 + 300 writes * $2.50 + 100 out * $10.
  expect(call.chargedUsd).toBeCloseTo(
    (500 * 2 + 200 * 0.2 + 300 * 2.5 + 100 * 10) * PER_M,
    12,
  );
});

test("a reservation that can reach past 272K input tokens is priced at the long-context rates", async () => {
  const call = await admittedCall({
    servedTier: "default",
    served: { input: 300_000, output: 100 },
    maxOutputTokens: 128_000,
    prompt: "word ".repeat(200_000),
  });
  expect(call.reservedInputTokens + call.reservedOutputTokens).toBeGreaterThan(272_000);
  // Long context: cache writes $5, output $15 per 1M.
  expect(call.reservedUsd).toBeCloseTo(
    call.reservedInputTokens * 5 * PER_M + call.reservedOutputTokens * 15 * PER_M,
    9,
  );
  // The served 300K-token prompt is charged at $4 / $15.
  expect(call.chargedUsd).toBeCloseTo(300_000 * 4 * PER_M + 100 * 15 * PER_M, 12);
});

test("a Fast request on a model with no documented Fast rate is refused under a hard cap", async () => {
  const error = await deniedCall({
    model: "gpt-5.4-pro",
    serviceTier: "priority",
    servedTier: "priority",
    served: { input: 1000, output: 100 },
  });
  expect(error).toMatchObject({ reason: "unpriced_service_tier_under_hard_cap" });
});

test("a Fast request that could reach GPT-5.5's unpriced Fast long context is refused", async () => {
  const error = await deniedCall({
    model: "gpt-5.5",
    serviceTier: "priority",
    servedTier: "priority",
    served: { input: 1000, output: 100 },
    maxOutputTokens: 128_000,
    prompt: "word ".repeat(200_000),
  });
  expect(error).toMatchObject({ reason: "unpriced_service_tier_under_hard_cap" });
});
