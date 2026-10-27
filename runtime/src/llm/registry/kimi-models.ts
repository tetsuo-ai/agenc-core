/**
 * Moonshot global /v1/models, checked 2026-10-23. K3.1 Pro and Highspeed
 * advertise the K3 context, modalities, thinking-only mode and effort enum.
 * Output defaults and wire controls follow the K3 family contract:
 * https://platform.kimi.ai/docs/api/models-overview
 * Published native prices live in session/cost.ts, independently of gateway rates.
 */
interface KimiChatModelSpec {
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensUpperLimit?: number;
  readonly supportsReasoningEffort: boolean;
  // Live combined-contract probe on 2026-10-23: K3/K3.1 and K2.7 Highspeed
  // skip the tool, K2.6 fences the JSON, and K2.7 Code completes both steps.
  // Keep schema-only support separate from schema-plus-tools support.
  // https://platform.kimi.ai/docs/guide/response_format
  // Reproducer: runtime/eval/kimi-native/contracts.mjs
  readonly supportsStructuredOutputWithTools: boolean;
  readonly priority: number;
}

export const KIMI_CHAT_MODEL_SPECS: readonly KimiChatModelSpec[] = Object.freeze([
  {
    model: "kimi-k3",
    displayName: "Kimi K3",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    maxOutputTokensUpperLimit: 1_048_576,
    supportsReasoningEffort: true,
    supportsStructuredOutputWithTools: false,
    priority: 0,
  },
  {
    model: "kimi-k3.1-pro",
    displayName: "Kimi K3.1 Pro",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    maxOutputTokensUpperLimit: 1_048_576,
    supportsReasoningEffort: true,
    supportsStructuredOutputWithTools: false,
    priority: 1,
  },
  {
    model: "kimi-k3.1-pro-highspeed",
    displayName: "Kimi K3.1 Pro Highspeed",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    maxOutputTokensUpperLimit: 1_048_576,
    supportsReasoningEffort: true,
    supportsStructuredOutputWithTools: false,
    priority: 2,
  },
  {
    model: "kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    contextWindow: 262_144,
    supportsReasoningEffort: false,
    supportsStructuredOutputWithTools: true,
    priority: 3,
  },
  {
    model: "kimi-k2.7-code-highspeed",
    displayName: "Kimi K2.7 Code Highspeed",
    contextWindow: 262_144,
    supportsReasoningEffort: false,
    supportsStructuredOutputWithTools: false,
    priority: 4,
  },
  {
    model: "kimi-k2.6",
    displayName: "Kimi K2.6",
    contextWindow: 262_144,
    supportsReasoningEffort: false,
    supportsStructuredOutputWithTools: false,
    priority: 5,
  },
] as const);

export const KIMI_CHAT_MODELS: readonly string[] = Object.freeze(
  KIMI_CHAT_MODEL_SPECS.map((entry) => entry.model),
);

export function isKimiK3Model(model: string | undefined): boolean {
  return /^kimi-k3(?:\.1-pro(?:-highspeed)?)?$/u.test(model?.trim().toLowerCase() ?? "");
}

export function isKimiChatModel(model: string): boolean {
  return KIMI_CHAT_MODELS.includes(model.trim().toLowerCase());
}
