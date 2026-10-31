/**
 * A skill turn whose model does not take the session's reasoning effort runs
 * at that model's own default: its requests carry no level, even when the
 * configured `reasoning_effort` would otherwise refill an empty one. The next
 * turn sends the session's level again. Checked on the request body the
 * OpenAI provider sends.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import type { LLMTool } from "../../src/llm/types.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import {
  deepSeekSkillTurnSession,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

afterEach(() => {
  removeSkillTurnHomes();
});

function completedResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      model: "gpt-6-astra",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function request(): Parameters<typeof buildProviderOptions>[0] {
  return {
    input: [{ role: "user", content: "hi" }],
    tools: [] as LLMTool[],
    parallelToolCalls: false,
    baseInstructions: "",
  } as unknown as Parameters<typeof buildProviderOptions>[0];
}

/** A GPT-5 session at `minimal`, the level its config.toml also names. */
async function gpt5Session(): Promise<{
  readonly session: Session;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completedResponse());
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

async function wireBody(
  session: Session,
  turn: TurnContext,
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
): Promise<Record<string, unknown>> {
  const store = session.services.configStore!;
  await runWithCanonicalSettingsAuthority(store, async () => {
    const options = buildProviderOptions(
      request(),
      turn,
      new AbortController().signal,
      session,
    );
    await session.services.provider.chat([{ role: "user", content: "hi" }], options);
  });
  return JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
}

describe("skill turn effort on the wire", () => {
  test("a model-only skill whose model rejects the session's level sends no level; the next turn sends the session's", async () => {
    const { session, fetchImpl } = await gpt5Session();
    const store = session.services.configStore!;
    const admitted = await runWithCanonicalSettingsAuthority(store, () =>
      admitSkillInvocation(session, store, { name: "astra-review", model: "gpt-6-astra" }),
    );

    const skillBody = await wireBody(
      session,
      session.newSkillInvocationTurn(admitted.overrides),
      fetchImpl,
    );
    expect(skillBody.model).toBe("gpt-6-astra");
    expect((skillBody.reasoning as { effort?: unknown } | undefined)?.effort).toBeUndefined();

    const nextBody = await wireBody(session, session.newDefaultTurn(), fetchImpl);
    expect(nextBody.model).toBe("gpt-5");
    expect((nextBody.reasoning as { effort?: unknown } | undefined)?.effort).toBe("minimal");

    // The skill turn carries the marker; the session's own level is unchanged.
    expect(admitted.overrides.invocation).toMatchObject({
      model: "gpt-6-astra",
      effort: "model_default",
    });
    expect(session.sessionConfiguration.collaborationMode.reasoningEffort).toBe("minimal");
  });

  test("a skill effort the skill's model accepts goes on the wire as set", async () => {
    const { session, fetchImpl } = await gpt5Session();
    const store = session.services.configStore!;
    const admitted = await runWithCanonicalSettingsAuthority(store, () =>
      admitSkillInvocation(session, store, {
        name: "astra-review",
        model: "gpt-6-astra",
        effort: "high",
      }),
    );
    const body = await wireBody(
      session,
      session.newSkillInvocationTurn(admitted.overrides),
      fetchImpl,
    );
    expect(body.model).toBe("gpt-6-astra");
    expect((body.reasoning as { effort?: unknown } | undefined)?.effort).toBe("high");
  });
});
