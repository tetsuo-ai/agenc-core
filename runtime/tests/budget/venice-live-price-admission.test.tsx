import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import { createProvider, type ProviderName } from "../../src/llm/provider.js";
import { recordPublishedModelCosts } from "../../src/llm/registry/published-model-costs.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { conservativeModelCost, CostSidecar, DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../src/session/cost.js";
import type { Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import { FullscreenLayout } from "../../src/tui/components/FullscreenLayout.js";
import { FullscreenModeProvider } from "../../src/tui/context/fullscreenModeContext.js";
import { SessionUsageContext } from "../../src/tui/context/sessionUsageContext.js";
import { Text } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { renderToString } from "../../src/utils/staticRender.js";

// Venice's public GET /api/v1/models?type=text answer on 2026-10-15.
const fixture = JSON.parse(readFileSync(new URL("../llm/fixtures/venice-models.json", import.meta.url), "utf8")) as {
  readonly data: readonly { readonly id: string; readonly model_spec: Record<string, unknown> }[];
};
const PER_M = 1 / 1_000_000;
const PROMPT_TOKENS = 18_000;
const COMPLETION_TOKENS = 20;
const SINGLE_SLOT_LIMITS = { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } as const;

/** USD per million tokens as Venice publishes them in the fixture. */
function published(model: string): { readonly input: number; readonly output: number } {
  const pricing = fixture.data.find(entry => entry.id === model)!.model_spec.pricing as Record<string, { usd: number }>;
  return { input: pricing.input!.usd, output: pricing.output!.usd };
}

interface AdmittedVeniceCall {
  readonly reservedUsd: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly chargedUsd: number;
  readonly chargeEstimated: boolean;
  readonly summary: AdmissionUsageSummary;
}

async function admittedVeniceCall(model: string, list: unknown = fixture): Promise<AdmittedVeniceCall> {
  const directory = mkdtempSync(join(tmpdir(), "agenc-venice-price-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "venice-price-admission",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  const client = kernel.bindClient({
    cwd: workspace,
    // No cost cap: a fixed 18,000-token usage report against a one-line
    // prompt would otherwise read as a provider overrun.
    scope: { runId: `venice-${model}`, sessionId: `venice-${model}`, autonomous: false },
  });
  const acquire = vi.spyOn(client, "acquire");
  const reconcile = vi.spyOn(client, "reconcile");
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl_venice_price", object: "chat.completion", model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "pong" } }],
      usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS, total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const provider = createProvider("venice" as ProviderName, {
    apiKey: "fake-venice-price-key",
    baseURL: "http://127.0.0.1:9/api/v1",
    model,
    extra: { fetchImpl, maxRetries: 0 },
  });
  const messages: LLMMessage[] = [{ role: "user", content: "Reply with the single word: pong" }];
  const session = {
    conversationId: `venice-${model}`,
    services: { executionAdmission: client, admissionRequired: true, agentControl: {} },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    await runAdmittedModelCall({
      session, provider, messages, stepId: "venice-turn", model, providerName: "venice",
      options: { maxOutputTokens: 1000, contextWindowTokens: 1_000_000 },
      invoke: (options) => provider.chat(messages, options),
    });
    const request = acquire.mock.calls[0]?.[0];
    const charge = reconcile.mock.calls[0]?.[1];
    if (request === undefined || charge === undefined || typeof charge.costUsd !== "number") {
      throw new Error("the admitted call did not reserve and reconcile a priced turn");
    }
    return {
      reservedUsd: request.maxCostUsd as number,
      reservedInputTokens: request.maxInputTokens,
      reservedOutputTokens: request.maxOutputTokens,
      chargedUsd: charge.costUsd,
      chargeEstimated: charge.costEstimated === true,
      summary: client.getUsageSummary!(),
    };
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The status line's spend label for this usage, as the TUI renders it. */
async function statusLine(summary: AdmissionUsageSummary): Promise<string> {
  return await renderToString(
    <AppStateProvider initialState={getDefaultAppState()}>
      <SessionUsageContext value={summary}>
        <FullscreenModeProvider enabled>
          <FullscreenLayout scrollable={<Text>ready</Text>} bottom={<Text>prompt</Text>} />
        </FullscreenModeProvider>
      </SessionUsageContext>
    </AppStateProvider>,
    { columns: 120, rows: 24 },
  );
}

/** What the session cost sidecar charges for the same call. */
function sidecarCost(model: string): { readonly costUsd: number; readonly unknown: boolean } {
  const sidecar = new CostSidecar();
  sidecar.onEvent({
    id: "usage",
    msg: {
      type: "token_count",
      payload: {
        model,
        provider: "venice",
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        totalTokens: PROMPT_TOKENS + COMPLETION_TOKENS,
      },
    },
  } as Event);
  return { costUsd: sidecar.getTotalCostUsd(), unknown: sidecar.hasUnknownModelCost() };
}

test("a Venice ID never borrows another provider's price for the same name", () => {
  // No list read yet: Venice's deepseek-v4-flash is not DeepSeek's own model.
  recordPublishedModelCosts("venice", new Map());
  expect(resolveModelCostEntry({ model: "deepseek-v4-flash", provider: "deepseek" }, DEFAULT_MODEL_COSTS)).not.toBeNull();
  expect(resolveModelCostEntry({ model: "deepseek-v4-flash", provider: "venice" }, DEFAULT_MODEL_COSTS)).toBeNull();
});

test.each([
  // $0.138 in, $0.275 out per million: 18,000 + 20 tokens is $0.0024895.
  ["deepseek-v4-flash", "$0.0025"],
  // $0.75 in, $4.50 out per million: 18,000 + 20 tokens is $0.01359.
  ["qwen3-5-397b-a17b", "$0.014"],
] as const)("%s is reserved and charged at Venice's published price, and the status line and cost sidecar agree", async (model, label) => {
  const price = published(model);
  const call = await admittedVeniceCall(model);
  const charge = (PROMPT_TOKENS * price.input + COMPLETION_TOKENS * price.output) * PER_M;

  expect(call.reservedUsd).toBeCloseTo(
    (call.reservedInputTokens * price.input + call.reservedOutputTokens * price.output) * PER_M, 12,
  );
  expect(call.chargedUsd).toBeCloseTo(charge, 12);
  expect(call.chargeEstimated).toBe(false);
  // The admission ledger keeps whole nanodollars.
  expect(call.summary).toMatchObject({ costUsd: expect.closeTo(charge, 8), hasUnknownCost: false });
  expect(call.summary.costEstimated).toBeUndefined();

  const sidecar = sidecarCost(model);
  expect(sidecar.costUsd).toBeCloseTo(call.chargedUsd, 12);
  expect(sidecar.unknown).toBe(false);

  const line = await statusLine(call.summary);
  expect(line).toContain(label);
  expect(line).not.toContain("est.");
  expect(line).not.toContain("price unknown");
});

test("a model Venice lists without a price is reserved conservatively and shown as price unknown", async () => {
  const unpriced = {
    ...fixture,
    data: fixture.data.map(entry => entry.id === "qwen3-5-397b-a17b"
      ? { ...entry, model_spec: { ...entry.model_spec, pricing: undefined } }
      : entry),
  };
  const call = await admittedVeniceCall("qwen3-5-397b-a17b", unpriced);
  const ceiling = conservativeModelCost();

  expect(call.reservedUsd).toBeCloseTo(
    (call.reservedInputTokens * ceiling.inputUsdPer1K + call.reservedOutputTokens * ceiling.outputUsdPer1K) / 1000, 12,
  );
  expect(call.chargeEstimated).toBe(true);
  expect(call.summary.costEstimated).toBe(true);
  expect(sidecarCost("qwen3-5-397b-a17b").unknown).toBe(true);

  const line = await statusLine(call.summary);
  expect(line).toContain("price unknown");
  expect(line).not.toContain(`$${call.chargedUsd.toFixed(2)}`);
});
