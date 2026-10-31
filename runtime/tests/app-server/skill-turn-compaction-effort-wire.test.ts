/**
 * Automatic compaction inside a skill turn summarizes on the turn's model at
 * the turn's effort. A model-only GPT-6 Astra skill in a GPT-5 session at
 * `minimal` runs Astra at its own default level, so the summary requests carry
 * no level either, not the session's `minimal`, which Astra does not accept.
 * Checked on the request bodies the OpenAI provider sends.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
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

async function skillTurn(
  session: Session,
  skill: { readonly name: string; readonly model: string; readonly effort?: string },
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
    options: { ...harness.context.options, mainLoopModel: turn.modelInfo.slug },
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

  test("a turn without a skill still summarizes on the session's model at its level", async () => {
    const { session, fetchImpl } = await gpt5Session();

    const bodies = await compactInTurn(session, session.newDefaultTurn(), fetchImpl);

    for (const body of bodies) {
      expect(body.model).toBe("gpt-5");
      expect(effortOf(body)).toBe("minimal");
    }
  });
});
