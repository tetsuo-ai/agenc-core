import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import { createProvider, type ProviderName } from "../../src/llm/provider.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../src/llm/registry/published-model-costs.js";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  conservativeModelCost,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
} from "../../src/session/cost.js";
import type { Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import { FullscreenLayout } from "../../src/tui/components/FullscreenLayout.js";
import { FullscreenModeProvider } from "../../src/tui/context/fullscreenModeContext.js";
import { SessionUsageContext } from "../../src/tui/context/sessionUsageContext.js";
import { Text } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { renderToString } from "../../src/utils/staticRender.js";

const fixture = JSON.parse(
  readFileSync(new URL("../llm/fixtures/trustedrouter-models.json", import.meta.url), "utf8"),
) as {
  readonly data: readonly {
    readonly id: string;
    readonly pricing?: { readonly prompt?: string; readonly completion?: string };
    readonly trustedrouter?: { readonly aliases?: readonly string[] };
  }[];
};

const PROMPT_TOKENS = 18_000;
const COMPLETION_TOKENS = 200;
const SINGLE_SLOT_LIMITS = {
  global: 1,
  workspace: 1,
  session: 1,
  parent: 1,
  provider: 1,
} as const;

afterEach(() => {
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("trustedrouter", new Map());
});

/** USD per token as TrustedRouter publishes them in the fixture. */
function published(model: string): { readonly inputPerToken: number; readonly outputPerToken: number } {
  const row = fixture.data.find(
    (entry) => entry.id === model || entry.trustedrouter?.aliases?.includes(model),
  )!;
  return {
    inputPerToken: Number(row.pricing!.prompt!),
    outputPerToken: Number(row.pricing!.completion!),
  };
}

interface AdmittedTrustedRouterCall {
  readonly reservedUsd: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly chargedUsd: number;
  readonly chargeEstimated: boolean;
  readonly summary: AdmissionUsageSummary;
}

async function admittedTrustedRouterCall(
  model: string,
  list: unknown = fixture,
): Promise<AdmittedTrustedRouterCall> {
  const directory = mkdtempSync(join(tmpdir(), "agenc-trustedrouter-price-admission-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: join(directory, "home"),
    ownerId: "trustedrouter-price-admission",
    ownerPid: process.pid,
    limits: SINGLE_SLOT_LIMITS,
  });
  const client = kernel.bindClient({
    cwd: workspace,
    scope: {
      runId: `trustedrouter-${model}`,
      sessionId: `trustedrouter-${model}`,
      autonomous: false,
    },
  });
  const acquire = vi.spyOn(client, "acquire");
  const reconcile = vi.spyOn(client, "reconcile");
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_tr_price",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "pong" },
          },
        ],
        usage: {
          prompt_tokens: PROMPT_TOKENS,
          completion_tokens: COMPLETION_TOKENS,
          total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const provider = createProvider("trustedrouter" as ProviderName, {
    apiKey: "fake-trustedrouter-price-key",
    baseURL: "http://127.0.0.1:9/v1",
    model,
    extra: { fetchImpl, maxRetries: 0 },
  });
  const messages: LLMMessage[] = [
    { role: "user", content: "Reply with the single word: pong" },
  ];
  const session = {
    conversationId: `trustedrouter-${model}`,
    services: {
      executionAdmission: client,
      admissionRequired: true,
      agentControl: {},
    },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  try {
    await runAdmittedModelCall({
      session,
      provider,
      messages,
      stepId: "trustedrouter-turn",
      model,
      providerName: "trustedrouter",
      options: { maxOutputTokens: 1000, contextWindowTokens: 1_000_000 },
      invoke: (options) => provider.chat(messages, options),
    });
    const request = acquire.mock.calls[0]?.[0];
    const charge = reconcile.mock.calls[0]?.[1];
    if (
      request === undefined ||
      charge === undefined ||
      typeof charge.costUsd !== "number"
    ) {
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

async function statusLine(summary: AdmissionUsageSummary): Promise<string> {
  return await renderToString(
    <AppStateProvider initialState={getDefaultAppState()}>
      <SessionUsageContext value={summary}>
        <FullscreenModeProvider enabled>
          <FullscreenLayout
            scrollable={<Text>ready</Text>}
            bottom={<Text>prompt</Text>}
          />
        </FullscreenModeProvider>
      </SessionUsageContext>
    </AppStateProvider>,
    { columns: 120, rows: 24 },
  );
}

function sidecarCost(model: string): {
  readonly costUsd: number;
  readonly unknown: boolean;
} {
  const sidecar = new CostSidecar();
  sidecar.onEvent({
    id: "usage",
    msg: {
      type: "token_count",
      payload: {
        model,
        provider: "trustedrouter",
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        totalTokens: PROMPT_TOKENS + COMPLETION_TOKENS,
      },
    },
  } as Event);
  return {
    costUsd: sidecar.getTotalCostUsd(),
    unknown: sidecar.hasUnknownModelCost(),
  };
}

test("a TrustedRouter ID never borrows another provider's price for the same name", () => {
  recordPublishedModelCosts("trustedrouter", new Map());
  expect(
    resolveModelCostEntry(
      { model: "deepseek-v4-flash", provider: "deepseek" },
      DEFAULT_MODEL_COSTS,
    ),
  ).not.toBeNull();
  expect(
    resolveModelCostEntry(
      { model: "deepseek-v4-flash", provider: "trustedrouter" },
      DEFAULT_MODEL_COSTS,
    ),
  ).toBeNull();
});

test.each([
  ["anthropic/claude-opus-4.5", "$0.100"],
  ["deepseek/deepseek-v4.1-flash", "$0.0002"],
  ["nyte/zdr", "$0.0006"],
] as const)(
  "%s is reserved and charged at TrustedRouter's published price, and status line and sidecar agree",
  async (model, label) => {
    const price = published(model);
    const call = await admittedTrustedRouterCall(model);
    const charge =
      PROMPT_TOKENS * price.inputPerToken +
      COMPLETION_TOKENS * price.outputPerToken;

    expect(call.reservedUsd).toBeCloseTo(
      call.reservedInputTokens * price.inputPerToken +
        call.reservedOutputTokens * price.outputPerToken,
      10,
    );
    expect(call.chargedUsd).toBeCloseTo(charge, 10);
    expect(call.chargeEstimated).toBe(false);
    expect(call.summary).toMatchObject({
      costUsd: expect.closeTo(charge, 8),
      hasUnknownCost: false,
    });
    expect(call.summary.costEstimated).toBeUndefined();

    const sidecar = sidecarCost(model);
    expect(sidecar.costUsd).toBeCloseTo(call.chargedUsd, 10);
    expect(sidecar.unknown).toBe(false);

    const line = await statusLine(call.summary);
    expect(line).toContain(label);
    expect(line).not.toContain("price unknown");
  },
);

test("a model TrustedRouter lists without a price is reserved conservatively and shown as price unknown", async () => {
  const unpriced = {
    ...fixture,
    data: fixture.data.map((entry) =>
      entry.id === "anthropic/claude-opus-4.5"
        ? { ...entry, pricing: undefined }
        : entry,
    ),
  };
  const call = await admittedTrustedRouterCall("anthropic/claude-opus-4.5", unpriced);
  const ceiling = conservativeModelCost();

  expect(call.reservedUsd).toBeCloseTo(
    (call.reservedInputTokens * ceiling.inputUsdPer1K +
      call.reservedOutputTokens * ceiling.outputUsdPer1K) /
      1000,
    12,
  );
  expect(call.chargeEstimated).toBe(true);
  expect(call.summary.costEstimated).toBe(true);
  expect(sidecarCost("anthropic/claude-opus-4.5").unknown).toBe(true);

  const line = await statusLine(call.summary);
  expect(line).toContain("price unknown");
});
