/**
 * Automatic compaction inside a skill turn summarizes on the turn's model at
 * the turn's effort. A model-only GPT-6 Astra skill in a GPT-5 session at
 * `minimal` runs Astra at its own default level, so the summary requests carry
 * no level either, not the session's `minimal`, which Astra does not accept.
 * Every other compaction, a model downshift's on the previous, larger model
 * included, selects the session's level as before; a level the summaries'
 * model does not take becomes `low`. Checked on the requests the OpenAI and
 * Gemini providers send.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import * as autoCompact from "../../src/services/compact/autoCompact.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import type { CompactContext, RuntimeMessage } from "../../src/services/compact/types.js";
import { maybeRunPreviousModelInlineCompact } from "../../src/session/run-turn-compaction.js";
import type { Session } from "../../src/session/session.js";
import type { ReasoningEffort, TurnContext } from "../../src/session/turn-context.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";
import {
  deepSeekSkillTurnSession,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

let harness: CompactionTransactionHarness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
  removeSkillTurnHomes();
});

function summaryResponse(): Response {
  const summary = JSON.stringify({
    narrative: "Bounded summary.",
    facts: [],
    open_actions: [],
  });
  return new Response(
    JSON.stringify({
      status: "completed",
      model: "gpt-6-astra",
      output: [{ type: "message", content: [{ type: "output_text", text: summary }] }],
      usage: { input_tokens: 128, output_tokens: 128, total_tokens: 256 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A GPT-5 session at `minimal`, the level its config.toml also names. */
async function gpt5Session(): Promise<{
  readonly session: Session;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => summaryResponse());
  const provider = new OpenAIProvider({ apiKey: "sk-test", model: "gpt-5", fetchImpl });
  const session = deepSeekSkillTurnSession({
    route: {
      provider,
      model: "gpt-5",
      reasoningEffort: "minimal",
      supportedReasoningLevels: ["minimal", "low", "medium", "high"],
      contextWindow: 400_000,
      providerEnvironment: { OPENAI_API_KEY: "sk-test" },
    },
    configLines: ['reasoning_effort = "minimal"'],
  });
  await session.services.configStore!.reload();
  return { session, fetchImpl };
}

/** A GPT-6 Astra session at `high`. */
async function astraSession(): Promise<{
  readonly session: Session;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => summaryResponse());
  const provider = new OpenAIProvider({ apiKey: "sk-test", model: "gpt-6-astra", fetchImpl });
  const session = deepSeekSkillTurnSession({
    route: {
      provider,
      model: "gpt-6-astra",
      reasoningEffort: "high",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 1_000_000,
      providerEnvironment: { OPENAI_API_KEY: "sk-test" },
    },
  });
  await session.services.configStore!.reload();
  return { session, fetchImpl };
}

/**
 * The compaction context a model downshift builds before `turn`: the
 * session's previous turn ran on `previous`, whose window is larger than the
 * turn's model's, and the history no longer fits the turn's model.
 */
async function downshiftCompactContext(
  session: Session,
  turn: TurnContext,
  previous: { readonly model: string; readonly contextWindow: number } = {
    model: "gpt-6-astra",
    contextWindow: 4_000_000,
  },
): Promise<CompactContext> {
  Object.assign(
    (session.state as unknown as { unsafePeek(): object }).unsafePeek(),
    { previousTurnSettings: previous },
  );
  const compact = vi.spyOn(autoCompact, "autoCompactIfNeeded")
    .mockResolvedValue({ wasCompacted: false });
  try {
    const state = buildInitialTurnState(turn, { role: "user", content: "continue" });
    await maybeRunPreviousModelInlineCompact(session, turn, 100_000_000, state);
    const context = compact.mock.calls[0]?.[1] as CompactContext | undefined;
    if (context === undefined) throw new Error("the model downshift did not compact");
    return context;
  } finally {
    compact.mockRestore();
  }
}

/** A Gemma 4 session on Gemini at `minimal`, one of the two levels Gemma takes. */
function gemmaSession(): Promise<{
  readonly session: Session;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  return geminiSession({
    model: "gemma-4-31b-it",
    reasoningEffort: "minimal",
    supportedReasoningLevels: ["minimal", "high"],
    contextWindow: 262_144,
  });
}

/** A session on the Gemini provider whose summary calls answer with a summary. */
async function geminiSession(route: {
  readonly model: string;
  readonly reasoningEffort: "minimal" | "low" | "medium" | "high";
  readonly supportedReasoningLevels: readonly ("minimal" | "low" | "medium" | "high")[];
  readonly contextWindow: number;
}): Promise<{
  readonly session: Session;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const summary = JSON.stringify({ narrative: "Bounded summary.", facts: [], open_actions: [] });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    candidates: [{ content: { parts: [{ text: summary }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 128, candidatesTokenCount: 128, totalTokenCount: 256 },
  }));
  const provider = new GeminiProvider({
    credentialPlan: { kind: "api-key", credential: "gemini-test", source: "factory" },
    endpointPlan: createGeminiEndpointPlan(),
    model: route.model,
    fetchImpl,
  });
  const session = deepSeekSkillTurnSession({
    route: {
      provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      supportedReasoningLevels: [...route.supportedReasoningLevels],
      contextWindow: route.contextWindow,
      providerEnvironment: { GEMINI_API_KEY: "gemini-test" },
    },
  });
  await session.services.configStore!.reload();
  return { session, fetchImpl };
}

async function skillTurn(
  session: Session,
  skill: { readonly name: string; readonly model?: string; readonly effort?: string },
): Promise<TurnContext> {
  const store = session.services.configStore!;
  const admitted = await runWithCanonicalSettingsAuthority(store, () =>
    admitSkillInvocation(session, store, skill),
  );
  return session.newSkillInvocationTurn(admitted.overrides);
}

/**
 * Compacts a durable history inside `turn`, the way the turn's automatic
 * compaction does: the transaction harness owns the rollout and admission,
 * its session reads the live session's settings, and the summary calls go
 * through the live session's OpenAI provider.
 */
async function compactInTurn(
  session: Session,
  turn: TurnContext,
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
  mainLoopModel: string = turn.modelInfo.slug,
): Promise<Array<Record<string, unknown>>> {
  // Enough history that an automatic compaction frees room.
  const source: RuntimeMessage[] = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `source-${index}:${"x".repeat(3_000)}`,
  }));
  harness = createCompactionTransactionHarness(source, {
    contextWindowTokens: 65_536,
    maxOutputTokens: 32_768,
    compactionMode: "automatic",
    chat: (messages, options) => session.services.provider.chat(messages, options),
  });
  Object.assign(harness.session.services, {
    configStore: session.services.configStore,
    provider: { ...harness.provider, name: session.services.provider.name },
  });
  Object.assign(harness.session, {
    config: session.config,
    modelInfo: session.modelInfo,
    sessionConfiguration: session.sessionConfiguration,
    providerBinding: session.providerBinding,
  });
  const before = fetchImpl.mock.calls.length;
  const result = await compactConversation(source, {
    ...harness.context,
    options: { ...harness.context.options, mainLoopModel },
    turn,
  }, "");
  expect(result.transaction).toBeDefined();
  const bodies = fetchImpl.mock.calls.slice(before).map((call) =>
    JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
  expect(bodies.length).toBeGreaterThan(0);
  return bodies;
}

function effortOf(body: Record<string, unknown>): unknown {
  return (body.reasoning as { effort?: unknown } | undefined)?.effort;
}

describe("automatic compaction in a skill turn, on the wire", () => {
  test("a model-only skill whose model rejects the session's level summarizes at that model's default", async () => {
    const { session, fetchImpl } = await gpt5Session();
    const turn = await skillTurn(session, { name: "astra-review", model: "gpt-6-astra" });
    expect(turn.skillInvocation?.effort).toBe("model_default");

    const bodies = await compactInTurn(session, turn, fetchImpl);

    for (const body of bodies) {
      expect(body.model).toBe("gpt-6-astra");
      expect(effortOf(body)).toBeUndefined();
    }
  });

  test("a skill's own level is bounded to a level the skill's model accepts", async () => {
    const { session, fetchImpl } = await gpt5Session();
    const turn = await skillTurn(session, {
      name: "astra-review",
      model: "gpt-6-astra",
      effort: "high",
    });

    const bodies = await compactInTurn(session, turn, fetchImpl);

    for (const body of bodies) {
      expect(body.model).toBe("gpt-6-astra");
      expect(effortOf(body)).toBe("low");
    }
  });

  test("a turn without a skill sends exactly what it sent before: the session's model at its level", async () => {
    const { session, fetchImpl } = await gpt5Session();

    const bodies = await compactInTurn(session, session.newDefaultTurn(), fetchImpl);

    for (const body of bodies) {
      expect(body.model).toBe("gpt-5");
      expect(effortOf(body)).toBe("minimal");
    }
  });
});

describe("model-downshift compaction before a skill turn, on the wire", () => {
  test.each([
    [
      "an Astra session at high, a GPT-5 skill at minimal",
      "astra",
      { name: "gpt5-review", model: "gpt-5", effort: "minimal" },
      ["minimal", "low", "medium", "high"],
    ],
    [
      "an Astra session at high, a GPT-5.1 skill at none",
      "astra",
      { name: "gpt51-review", model: "gpt-5.1", effort: "none" },
      ["none", "low", "medium", "high"],
    ],
    [
      "a GPT-5 session at minimal, a GPT-5 skill at minimal",
      "gpt-5",
      { name: "gpt5-review", model: "gpt-5", effort: "minimal" },
      ["minimal", "low", "medium", "high"],
    ],
    [
      "a GPT-5 session at minimal, a GPT-5.1 skill at none",
      "gpt-5",
      { name: "gpt51-review", model: "gpt-5.1", effort: "none" },
      ["none", "low", "medium", "high"],
    ],
  ] as const)(
    "after an Astra turn, %s summarizes on Astra at low",
    async (_label, sessionModel, skill, skillModelLevels) => {
      const { session, fetchImpl } = sessionModel === "astra"
        ? await astraSession()
        : await gpt5Session();
      const admittedTurn = await skillTurn(session, skill);
      expect(admittedTurn.modelInfo.slug).toBe(skill.model);
      expect(admittedTurn.reasoningEffort).toBe(skill.effort);
      // This session has no models manager, so a skill model's metadata
      // lacks the 400k window and the levels a live session reads for it.
      const turn = {
        ...admittedTurn,
        modelInfo: {
          ...admittedTurn.modelInfo,
          contextWindow: 400_000,
          supportedReasoningLevels: [...skillModelLevels],
        },
      };

      const context = await downshiftCompactContext(session, turn);
      expect(context.options?.mainLoopModel).toBe("gpt-6-astra");
      const bodies = await compactInTurn(session, context.turn!, fetchImpl, "gpt-6-astra");

      for (const body of bodies) {
        expect(body.model).toBe("gpt-6-astra");
        expect(effortOf(body)).toBe("low");
      }
    },
  );

  test("after a Gemini Pro skill turn, a Gemma skill at high in a Gemma session at minimal summarizes on Gemini Pro at a level it takes", async () => {
    // Gemini Pro takes low, medium and high, not the session's minimal, and
    // Gemini refuses a request naming a level the model lacks.
    const { session, fetchImpl } = await gemmaSession();
    const turn = await skillTurn(session, { name: "gemma-deep", effort: "high" });
    expect(turn.modelInfo.slug).toBe("gemma-4-31b-it");
    expect(turn.reasoningEffort).toBe("high");

    const context = await downshiftCompactContext(session, turn, {
      model: "gemini-3.1-pro-preview",
      contextWindow: 1_048_576,
    });
    expect(context.options?.mainLoopModel).toBe("gemini-3.1-pro-preview");
    const before = fetchImpl.mock.calls.length;
    const bodies = await compactInTurn(session, context.turn!, fetchImpl, "gemini-3.1-pro-preview");

    for (const call of fetchImpl.mock.calls.slice(before)) {
      expect(String(call[0])).toContain("gemini-3.1-pro-preview");
    }
    for (const body of bodies) {
      expect((body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig)
        .toEqual({ thinkingLevel: "low" });
    }
  });

  test("after a Gemini 2.5 Pro turn, a model-only Gemma skill in a Gemini 3.1 Pro session at low summarizes on Gemini 2.5 Pro with no level", async () => {
    // Gemini 2.5 Pro thinks by budget and names no levels, so it takes none.
    const { session, fetchImpl } = await geminiSession({
      model: "gemini-3.1-pro-preview",
      reasoningEffort: "low",
      supportedReasoningLevels: ["low", "medium", "high"],
      contextWindow: 1_048_576,
    });
    const admittedTurn = await skillTurn(session, { name: "gemma-review", model: "gemma-4-31b-it" });
    expect(admittedTurn.modelInfo.slug).toBe("gemma-4-31b-it");
    // This session has no models manager, so the skill model's metadata
    // lacks the window and the levels a live session reads for it.
    const turn = {
      ...admittedTurn,
      modelInfo: {
        ...admittedTurn.modelInfo,
        contextWindow: 262_144,
        supportedReasoningLevels: ["minimal", "high"] as ReasoningEffort[],
      },
    };

    const context = await downshiftCompactContext(session, turn, {
      model: "gemini-2.5-pro",
      contextWindow: 1_048_576,
    });
    expect(context.options?.mainLoopModel).toBe("gemini-2.5-pro");
    const before = fetchImpl.mock.calls.length;
    const bodies = await compactInTurn(session, context.turn!, fetchImpl, "gemini-2.5-pro");

    for (const call of fetchImpl.mock.calls.slice(before)) {
      expect(String(call[0])).toContain("gemini-2.5-pro");
    }
    for (const body of bodies) {
      expect((body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig)
        .toBeUndefined();
    }
  });
});
