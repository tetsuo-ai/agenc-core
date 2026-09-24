import type { AgentsConfig, SubagentEffort, SubagentLimit, SubagentSpeed } from "../config/schema.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import type { Session } from "../session/session.js";
import type { ModelInfo, ReasoningEffort } from "../session/turn-context.js";
import { childModelInfo, childProviderPolicy } from "./cross-provider.js";

/** Every effort spelling, lowest first. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function effortRank(effort: ReasoningEffort): number {
  return EFFORT_ORDER.indexOf(effort);
}

/** The limit the user set for sub-agents on `provider`; empty means the lowest. */
export function subagentLimit(policy: AgentsConfig, provider: string): SubagentLimit {
  return policy.subagent_limits?.[provider] ?? {};
}

/**
 * The effort a sub-agent on `modelInfo` runs at. It is `requested` when that
 * is below the limit, and the limit otherwise, as the model's nearest level at
 * or below it. Without a limit, it is the model's lowest level other than
 * none. None applies only when asked for and offered. A model without levels
 * gets no effort.
 */
export function limitedReasoningEffort(
  modelInfo: ModelInfo | undefined,
  requested: ReasoningEffort | undefined,
  limit: SubagentEffort | undefined,
): ReasoningEffort | undefined {
  const levels = [...(modelInfo?.supportedReasoningLevels ?? [])].sort((a, b) => effortRank(a) - effortRank(b));
  const thinking = levels.filter((level) => level !== "none");
  if (levels.length === 0) return undefined;
  const lowest = thinking[0] ?? levels[0]!;
  const ceiling = limit ?? lowest;
  const target = requested !== undefined && effortRank(requested) < effortRank(ceiling) ? requested : ceiling;
  if (target === "none" && levels.includes("none")) return "none";
  return thinking.filter((level) => effortRank(level) <= effortRank(target)).at(-1) ?? lowest;
}

/**
 * The service tier a sub-agent on `modelInfo` uses. Flex costs less than
 * standard, so a model may always ask for it where offered. Priority (fast)
 * applies only under a fast limit, where it is also the default. Anything
 * else is standard, which sends no tier.
 */
export function limitedServiceTier(
  modelInfo: ModelInfo | undefined,
  requested: string | undefined,
  limit: SubagentSpeed | undefined,
): string | undefined {
  const offered = new Set((modelInfo?.serviceTiers ?? []).map((tier) => tier.id));
  if (requested === "flex") return offered.has("flex") ? "flex" : undefined;
  if (limit !== "fast" || !offered.has("priority")) return undefined;
  return requested === undefined || requested === "priority" ? "priority" : undefined;
}

/**
 * The effort and service tier of a child. A service tier of null is standard:
 * the child sends no tier, and takes neither its parent's nor its role's.
 */
export interface SubagentModelSettings {
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string | null;
}

/**
 * The effort and service tier a new child without an execution plan runs at
 * on its parent's provider, for what its caller left out: the provider's
 * limits applied to what the child's role asks for. What the caller gave is
 * kept; spawn_agent applies the limits itself. Every path that creates a
 * child through `delegate` gets them this way, spawn_agents_on_csv workers
 * and workflow agents included. A fork of the full conversation does not
 * come here: it keeps its parent's effort and tier.
 */
export async function subagentModelSettings(parent: Session, request: {
  readonly model?: string;
  readonly modelInfo?: ModelInfo;
  readonly role?: {
    readonly config: {
      readonly model?: string;
      readonly reasoningEffort?: ReasoningEffort;
      readonly serviceTier?: string;
    };
  };
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string | null;
}): Promise<SubagentModelSettings> {
  const given: SubagentModelSettings = {
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.serviceTier !== undefined ? { serviceTier: request.serviceTier } : {}),
  };
  const binding = parent.services?.providerService?.current?.();
  if (binding === undefined || (request.reasoningEffort !== undefined && request.serviceTier !== undefined)) {
    return given;
  }
  const model = request.model ?? request.role?.config.model ?? binding.model;
  const modelInfo = request.modelInfo ?? await sameProviderModelInfo(parent, binding.provider, model);
  const limit = subagentLimit(childProviderPolicy(parent), binding.provider);
  const reasoningEffort = request.reasoningEffort ??
    limitedReasoningEffort(modelInfo, request.role?.config.reasoningEffort, limit.effort);
  return {
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    serviceTier: request.serviceTier !== undefined ? request.serviceTier
      : limitedServiceTier(modelInfo, request.role?.config.serviceTier, limit.speed) ?? null,
  };
}

/**
 * The metadata of `model` on the parent's provider. When it cannot be read,
 * the parent's metadata under the model's name, which is what the child
 * session itself is given in that case.
 */
async function sameProviderModelInfo(parent: Session, provider: string, model: string): Promise<ModelInfo | undefined> {
  const parentInfo = parent.modelInfo as ModelInfo | undefined;
  if (parentInfo === undefined || model === parentInfo.slug) return parentInfo;
  try {
    return await childModelInfo(parent, { provider, model });
  } catch {
    const { modelMessages: _parentMessages, ...info } = parentInfo;
    return { ...info, slug: model };
  }
}

/** A cross-provider spawn the user did not ask for while automatic choice is off. */
export class ProviderNotRequestedError extends Error {
  readonly code = "not_requested";

  constructor(readonly provider: string) {
    super(`The user's message for this turn does not name ${provider}, and choosing other providers automatically is off in settings.`);
    this.name = "ProviderNotRequestedError";
  }
}

/** What a user may type for a provider besides its name and display name. */
const PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  grok: ["xai", "x.ai"],
  openai: ["gpt", "chatgpt", "codex"],
  anthropic: ["claude", "sonnet", "opus", "haiku"],
  meta: ["llama", "meta ai"],
  zai: ["glm", "zhipu", "z.ai"],
  "zai-coding-plan": ["glm", "zhipu", "z.ai"],
  qwen: ["qwen"],
  "qwen-token-plan": ["qwen"],
  kimi: ["moonshot"],
  ollama: ["ollama"],
  "ollama-cloud": ["ollama"],
  lmstudio: ["lm studio"],
  "nvidia-nim": ["nvidia", "nim"],
  "amazon-bedrock": ["bedrock"],
  github: ["copilot", "github copilot"],
  mistral: ["codestral", "devstral"],
};

/**
 * Providers whose name or display name is an ordinary word in a message:
 * "push the branch to github", "update the meta tags", and AgenC, this
 * product's own name. Only their aliases and model names count. A managed
 * AgenC child is checked by the provider it resolves to.
 */
const NAMED_ONLY_BY_ALIAS: ReadonlySet<string> = new Set(["github", "meta", "agenc"]);

/** "an openai-compatible endpoint" names a kind of API, not OpenAI. */
const OPENAI_COMPATIBLE = /openai[-\s]+compatible/gu;

function mentions(text: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * Whether the message that started the current turn of `rootSession`, the
 * root conversation, names `provider` or `model`: the provider's name, its
 * display name, a common alias such as GPT or Claude, or the model's name.
 * History is not read: only a turn a person started carries that message
 * (`currentRootHumanTurn`). Turns that cron, child follow-ups, goals or a
 * resumed run start name nothing, and so does a root with no turn in
 * progress. So the user names the provider in the message that asks for the
 * work, and a later message that does not name it cannot start new
 * sub-agents there.
 */
export function userNamedProvider(rootSession: Session, provider: string, model: string): boolean {
  const message = rootSession.currentRootHumanTurn?.()?.text;
  if (message === undefined || message.trim().length === 0) return false;
  const lowered = message.toLowerCase();
  const text = provider === "openai-compatible" ? lowered : lowered.replace(OPENAI_COMPATIBLE, " ");
  const displayName = resolveBuiltInProviderInfo(provider)?.name;
  const ownNames = [provider, ...(displayName !== undefined ? [displayName] : [])]
    .map((term) => term.trim().toLowerCase());
  // A model named after its provider ("agenc") is that name too.
  const ordinaryWords = NAMED_ONLY_BY_ALIAS.has(provider) ? new Set(ownNames) : new Set<string>();
  const terms = [...ownNames, model, ...(PROVIDER_ALIASES[provider] ?? [])]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0 && !ordinaryWords.has(term));
  return terms.some((term) => mentions(text, term));
}

/** The limits sentence of the spawn tool's description; the user's limits only when they set some. */
export function describeSubagentLimits(policy: AgentsConfig): string {
  const set = Object.entries(policy.subagent_limits ?? {}).flatMap(([provider, limit]) => {
    const parts = [
      ...(limit.effort !== undefined && limit.effort !== "minimal" ? [`effort ${limit.effort}`] : []),
      ...(limit.speed === "fast" ? ["fast"] : []),
    ];
    return parts.length === 0 ? [] : [`${provider} ${parts.join(", ")}`];
  });
  const except = set.length === 0 ? "" : ` except as the user set (${set.join("; ")})`;
  return `Sub-agents run at the lowest effort and standard speed${except}; reasoning_effort and service_tier can only lower that.`;
}
