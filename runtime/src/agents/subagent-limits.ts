import type { AgentsConfig, SubagentEffort, SubagentLimit, SubagentSpeed } from "../config/schema.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import type { ResponseItem } from "../session/rollout-item.js";
import { isUserTurnBoundary } from "../session/rollout-reconstruction.js";
import type { Session } from "../session/session.js";
import { responseItemText } from "../session/trajectory-curate.js";
import type { ModelInfo, ReasoningEffort } from "../session/turn-context.js";

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

/** What a user may type for a provider besides its name and display name. */
const PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  grok: ["xai", "x.ai"],
  openai: ["gpt", "chatgpt", "codex"],
  anthropic: ["claude", "sonnet", "opus", "haiku"],
  meta: ["llama"],
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
  github: ["copilot"],
  mistral: ["codestral", "devstral"],
};

function mentions(text: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** The text of every message the user typed in `session`, without injected context. */
function userMessageTexts(session: Session): string[] {
  const history = (session.state?.unsafePeek?.().history ?? []) as ReadonlyArray<ResponseItem>;
  const texts: string[] = [];
  for (const item of history) {
    if (item.role !== "user" || !isUserTurnBoundary(item)) continue;
    const text = responseItemText(item.content).toLowerCase();
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

/**
 * Whether the user named `provider` or `model` in a message of `session`:
 * the provider's name, its display name, a common alias such as GPT or
 * Claude, or the model's name. Context the runtime injects does not count.
 */
export function userNamedProvider(session: Session, provider: string, model: string): boolean {
  const displayName = resolveBuiltInProviderInfo(provider)?.name;
  const terms = [provider, model, ...(PROVIDER_ALIASES[provider] ?? []), ...(displayName !== undefined ? [displayName] : [])]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
  return userMessageTexts(session).some((text) => terms.some((term) => mentions(text, term)));
}

/** The limits the user set, in words, for the spawn tool's description. */
export function describeSubagentLimits(policy: AgentsConfig): string {
  const set = Object.entries(policy.subagent_limits ?? {})
    .map(([provider, limit]) => `${provider} effort ${limit.effort ?? "lowest"}, speed ${limit.speed ?? "standard"}`);
  return set.length === 0
    ? "Every provider is at its lowest effort and standard speed."
    : `Set by the user: ${set.join("; ")}. Every other provider is at its lowest effort and standard speed.`;
}
