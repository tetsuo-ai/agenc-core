/**
 * The reasoning effort a session's model calls send. The main loop sends it
 * on every sampling request, and compaction summary calls send the same
 * effort, so a provider default cannot make a summary reason more than the
 * agent.
 *
 * @module
 */

import { resolveReasoningEffort } from "../llm/reasoning-effort.js";
import { resolveGeminiReasoningEffort } from "../llm/registry/gemini-thinking-models.js";
import type { LLMChatOptions } from "../llm/types.js";
import { getInitialEffortSetting } from "../utils/effort.js";
import { isHaiku55, anthropicSupportsBetweenToolsThinking } from "../utils/model/anthropicThinkingControl.js";
import type { Session } from "./session.js";
import type { ReasoningEffort, TurnContext } from "./turn-context.js";

type WireReasoningEffort = NonNullable<LLMChatOptions["reasoningEffort"]>;

export { supportsThinkingOffRecovery } from "./reasoning-recovery-capability.js";

function resolveGeminiSessionReasoningEffort(
  turnEffort: ReasoningEffort | undefined,
  model: string,
  effortSource: string | undefined,
): WireReasoningEffort | undefined {
  if (turnEffort !== undefined) return resolveGeminiReasoningEffort(model, turnEffort);
  const configuredEffort = effortSource === "default"
    ? undefined
    : getInitialEffortSetting();
  return resolveGeminiReasoningEffort(model, configuredEffort);
}

/**
 * Sessions created without an explicit reasoning effort — every
 * daemon-spawned interactive session today — must still honor the
 * persisted `reasoning_effort` from canonical config. Without this fallback the
 * provider default applies and grok-4.5 burns ~16k hidden reasoning
 * tokens per trivial reply at xAI's HIGH default (measured: ~2m30s for
 * a 150-word answer, matching the user's "grok is fucking slow").
 * An explicit per-session "none" stays respected as an opt-out.
 *
 * Persistence historically spells Grok's deepest `xhigh` tier as `max`, while
 * providers such as Z.AI use `max` as the literal wire value and do not accept
 * `xhigh`. Resolve that alias against the selected model's catalog: prefer the
 * requested top-tier spelling when supported, translate to the other top-tier
 * spelling when that is the model's only form, and otherwise clamp to `high`.
 *
 * Exported for unit tests; runtime callers use resolveMainLoopReasoningEffort.
 */
export function resolveSessionReasoningEffort(
  turnEffort: ReasoningEffort | undefined,
  supportedReasoningLevels?: ReadonlyArray<ReasoningEffort>,
  selection?: {
    readonly provider: string;
    readonly model: string;
    readonly effortSource?: string;
    /** The session cleared its level on purpose: no configured fallback. */
    readonly followsModelDefault?: boolean;
  },
): WireReasoningEffort | undefined {
  if (turnEffort === undefined && selection?.followsModelDefault === true) {
    return undefined;
  }
  if (selection?.provider === "gemini") {
    return resolveGeminiSessionReasoningEffort(
      turnEffort,
      selection.model,
      selection.effortSource,
    );
  }
  const requested = turnEffort ?? getInitialEffortSetting();
  if (requested === undefined) return undefined;
  // Hosted providers can expose an effort contract absent from ModelInfo.
  // Preserve accepted literal tiers before applying legacy max/xhigh aliases.
  const contract = selection === undefined ? undefined : resolveReasoningEffort(selection);
  if (requested === "none") {
    if (selection?.provider === "anthropic" && (anthropicSupportsBetweenToolsThinking(selection.model) || isHaiku55(selection.model))) {
      return "none";
    }
    // OpenAI models that document `none` (GPT-6 Sol and Luna) run a
    // reasoning default when the field is omitted, so the opt-out has to be
    // sent literally. Elsewhere `none` still means "send no effort".
    return selection?.provider === "openai" &&
      (supportedReasoningLevels?.includes("none") === true ||
        contract?.levels.includes("none") === true)
      ? "none"
      : undefined;
  }
  if (selection?.provider === "anthropic" && contract !== undefined && !contract.levels.includes("xhigh")) {
    // Settings fallback is legacy configuration, not a literal session choice.
    // Configured max is seeded as xhigh for these older models; an explicit
    // applyConfig max remains max and must be forwarded exactly as accepted.
    if (turnEffort === undefined && !contract.levels.includes("xhigh") &&
        (requested === "max" || requested === "xhigh")) return "high";
    if (contract.levels.includes(requested)) return requested;
    if (requested === "max" || requested === "xhigh") return "high";
  }
  if (contract?.registered === false && contract.levels.includes(requested)) {
    return requested;
  }
  if (requested === "max" || requested === "xhigh") {
    if (supportedReasoningLevels === undefined) {
      return requested === "max" ? "xhigh" : requested;
    }
    if (supportedReasoningLevels.includes(requested)) return requested;
    const topTierAlias = requested === "max" ? "xhigh" : "max";
    if (supportedReasoningLevels.includes(topTierAlias)) return topTierAlias;
    return "high";
  }
  return requested;
}

/**
 * The effort the main loop sends on a turn of `session`: the turn's effort,
 * or the configured one when it has none, resolved for the session's
 * provider and model. A session that cleared its level on purpose sends none.
 * When a model fallback switched the model inside the running turn, the turn's
 * effort was frozen for the old model; the session's own effort, which the
 * switch judged against the new model, applies instead.
 */
export function resolveMainLoopReasoningEffort(
  session: Session,
  turn: Pick<TurnContext, "reasoningEffort" | "modelInfo" | "providerBinding">,
): WireReasoningEffort | undefined {
  const configuration = (
    session as Session & {
      readonly sessionConfiguration?: Session["sessionConfiguration"];
    }
  ).sessionConfiguration;
  const liveRevision = (
    session as Session & { readonly providerBinding?: { readonly revision: number } }
  ).providerBinding?.revision;
  const switchedInTurn =
    configuration !== undefined &&
    turn.providerBinding !== undefined &&
    liveRevision !== undefined &&
    turn.providerBinding.revision !== liveRevision;
  return resolveSessionReasoningEffort(
    switchedInTurn
      ? configuration.collaborationMode.reasoningEffort
      : turn.reasoningEffort,
    turn.modelInfo.supportedReasoningLevels,
    {
      provider: session.services.provider.name,
      model: session.config?.model ?? turn.modelInfo.slug,
      effortSource: session.services.configStore
        ?.provenance?.("reasoning_effort")?.scope,
      followsModelDefault: configuration?.reasoningEffortCleared === true,
    },
  );
}
