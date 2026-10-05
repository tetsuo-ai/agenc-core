import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/config/store.js";
import type { LLMChatOptions } from "../../../src/llm/types.js";
import { buildProviderOptions } from "../../../src/phases/stream-model.js";
import {
  compactConversation,
  type CompactConversationOptions,
} from "../../../src/services/compact/compact.js";
import type {
  CompactionResult,
  RuntimeMessage,
} from "../../../src/services/compact/types.js";
import type {
  ReasoningEffort,
  TurnContext,
} from "../../../src/session/turn-context.js";
import {
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../../../src/utils/settings/canonicalAuthority.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

const SESSION_ID = "reasoning-effort-contract";
const GROK_4_5_LEVELS: readonly ReasoningEffort[] = ["low", "medium", "high"];

interface SessionShape {
  /** Lines of the session's config.toml; none keeps every default. */
  readonly config?: readonly string[];
  /** The session's provider and model, when not the harness's grok-4.5. */
  readonly selection?: { readonly provider: string; readonly model: string };
  readonly reasoningEffort?: ReasoningEffort;
  readonly supportedReasoningLevels?: readonly ReasoningEffort[];
}

/**
 * Summary calls sent no reasoning effort, so the provider default applied:
 * high on grok-4.6, while the main loop sends the configured medium. The
 * summarizer could reason more than the agent whose history it compacts.
 * Every summary call now sends the effort the session's main loop sends.
 *
 * Every compaction here runs with no settings authority bound, as the
 * daemon's manual compaction does, so the configured effort has to come
 * from the session's own settings.
 */
describe("compaction summary reasoning effort", () => {
  let harness: CompactionTransactionHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it("sends the session's effort on every summary call", async () => {
    const source = createSource(40);
    harness = createCompactionTransactionHarness(source, {
      sessionId: SESSION_ID,
      contextWindowTokens: 24_000,
    });
    await shapeSession(harness, { reasoningEffort: "low" });

    await compactOutsideTurn(source, harness, { keepCount: 0 });

    const sent = sentEfforts(harness);
    // Map calls and at least one reduction.
    expect(sent.length).toBeGreaterThan(2);
    expect(sent).toEqual(sent.map(() => "low"));
  });

  it("sends the effort the session has when the compaction runs", async () => {
    const source = createSource(12);
    harness = createCompactionTransactionHarness(source, {
      sessionId: SESSION_ID,
    });
    await shapeSession(harness, { reasoningEffort: "low" });
    harness.provider.chat.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(compactOutsideTurn(source, harness)).rejects.toThrow();

    // The user changes the effort before the retry.
    setSessionEffort(harness, "high");
    const result = await compactOutsideTurn(source, harness);

    expect(result.transaction).toBeDefined();
    expect(sentEfforts(harness)).toEqual(["low", "high"]);
  });

  it.each<[string, SessionShape, ReasoningEffort | undefined]>([
    [
      "clamps an effort the model does not offer",
      { reasoningEffort: "xhigh", supportedReasoningLevels: GROK_4_5_LEVELS },
      "high",
    ],
    [
      "sends the configured effort when the session has none",
      { config: ['reasoning_effort = "low"'] },
      "low",
    ],
    [
      // The canonical config drops the default effort for Gemini, so a
      // default Gemini session has no configured effort and no provenance.
      "sends no effort for a default Gemini session",
      {
        config: [
          'model_provider = "gemini"',
          'model = "gemini-3.1-pro-preview"',
        ],
        selection: { provider: "gemini", model: "gemini-3.1-pro-preview" },
      },
      undefined,
    ],
    [
      "sends no effort when the session opts out with none",
      { reasoningEffort: "none" },
      undefined,
    ],
  ])("%s, as the main loop does", async (_name, shape, expected) => {
    const source = createSource(12);
    harness = createCompactionTransactionHarness(source, {
      sessionId: SESSION_ID,
    });
    await shapeSession(harness, shape);

    await compactOutsideTurn(source, harness);

    expect(sentEfforts(harness)).toEqual([expected]);
    expect(mainLoopEffort(harness)).toBe(expected);
  });
});

function createSource(count: number): RuntimeMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `source-${index}:${"x".repeat(3_000)}`,
  }));
}

/**
 * Stands in for a live daemon session: its own settings from config.toml,
 * its provider and model, and its model info with the model's levels.
 */
async function shapeSession(
  harness: CompactionTransactionHarness,
  shape: SessionShape,
): Promise<void> {
  const home = process.env.AGENC_HOME;
  if (home === undefined) throw new Error("the harness did not set AGENC_HOME");
  writeFileSync(
    join(home, "config.toml"),
    ["config_version = 2", ...(shape.config ?? []), ""].join("\n"),
    { mode: 0o600 },
  );
  const cwd = harness.store.store.cwd;
  const configStore = new ConfigStore({
    home,
    cwd,
    projectRoot: cwd,
    projectTrusted: false,
    env: { AGENC_HOME: home, HOME: home },
    managedConfigPath: join(home, "managed.toml"),
    managedDropInDir: join(home, "managed.d"),
  });
  await configStore.reload();
  const session = harness.session;
  Object.assign(session.services, { configStore });
  Object.assign(session, {
    modelInfo: {
      ...session.modelInfo,
      supportedReasoningLevels: shape.supportedReasoningLevels,
    },
  });
  if (shape.selection !== undefined) {
    // Only the effort resolution reads these; the summary calls still go
    // to the harness provider.
    Object.assign(session.services, {
      provider: { ...harness.provider, name: shape.selection.provider },
    });
    Object.assign(session, { config: { model: shape.selection.model } });
  }
  setSessionEffort(harness, shape.reasoningEffort);
}

/** The daemon replaces the configuration when the user changes the effort. */
function setSessionEffort(
  harness: CompactionTransactionHarness,
  reasoningEffort: ReasoningEffort | undefined,
): void {
  Object.assign(harness.session, {
    sessionConfiguration: {
      collaborationMode: {
        model: harness.session.modelInfo.slug,
        reasoningEffort,
      },
    },
  });
}

/** Compacts with no settings authority bound, as the daemon's RPC runs it. */
function compactOutsideTurn(
  source: readonly RuntimeMessage[],
  harness: CompactionTransactionHarness,
  options?: CompactConversationOptions,
): Promise<CompactionResult> {
  resetCanonicalSettingsAuthorityForTesting();
  return compactConversation(source, harness.context, "", options);
}

function sentEfforts(
  harness: CompactionTransactionHarness,
): Array<LLMChatOptions["reasoningEffort"]> {
  return (harness.provider.chat.mock.calls as unknown as [unknown, LLMChatOptions][])
    .map(([, options]) => options.reasoningEffort);
}

/**
 * The effort a main-loop request of the session's next turn sends, under
 * the session's settings authority as Session.runTurn binds it.
 */
function mainLoopEffort(
  harness: CompactionTransactionHarness,
): LLMChatOptions["reasoningEffort"] {
  const session = harness.session;
  const configStore = session.services.configStore;
  if (configStore === undefined) throw new Error("the session has no settings");
  const turn = {
    reasoningEffort: session.sessionConfiguration.collaborationMode.reasoningEffort,
    modelInfo: session.modelInfo,
    permissionMode: "default",
  } as TurnContext;
  return runWithCanonicalSettingsAuthority(configStore, () =>
    buildProviderOptions(
      { input: [], tools: [], parallelToolCalls: false, baseInstructions: "" },
      turn,
      new AbortController().signal,
      session,
    ).reasoningEffort,
  );
}
