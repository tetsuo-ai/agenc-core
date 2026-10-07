/** NVIDIA hosted contracts checked 2026-09-29. Native vendor limits do not
 * apply to NIM. Sources: docs.api.nvidia.com/nim/reference/<slug>{,-infer}.
 */
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";
import type { ReasoningEffort } from "../../session/turn-context.js";

interface NimModel {
  readonly model: string;
  readonly label: string;
  readonly context: number;
  readonly output: number;
  readonly ceiling: number;
  readonly vision: boolean;
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort;
}
const MODELS: readonly NimModel[] = [
  { model: "moonshotai/kimi-k3", label: "Kimi K3", context: 1_048_576, output: 16_384, ceiling: 65_536, vision: true, efforts: ["low", "high", "max"], defaultEffort: "max" },
  { model: "moonshotai/kimi-k2.6", label: "Kimi K2.6", context: 262_144, output: 16_384, ceiling: 65_536, vision: true, efforts: [] },
  { model: "meta/muse-glimmer-30b", label: "Muse Glimmer 30B", context: 131_072, output: 2_048, ceiling: 131_072, vision: true, efforts: ["none", "minimal", "low", "medium", "high", "max"], defaultEffort: "high" },
  { model: "openai/gpt-oss-20b", label: "GPT OSS 20B", context: 128_000, output: 4_096, ceiling: 4_096, vision: false, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

export const NVIDIA_CURRENT_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze(MODELS.map((entry, index) => Object.freeze({
    provider: "nvidia-nim",
    model: entry.model,
    displayName: entry.label,
    contextWindow: entry.context,
    maxContextWindow: entry.context,
    maxOutputTokens: entry.output,
    maxOutputTokensUpperLimit: entry.ceiling,
    maxOutputTokensCappedDefault: true,
    inputModalities: entry.vision ? ["text", "image"] as const : ["text"] as const,
    supportsToolUse: true,
    supportsParallelToolCalls: false,
    // Hosted schemas do not expose response_format, even where the base
    // model card advertises JSON training or native-vendor structured output.
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none" as const,
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none" as const,
    supportedReasoningLevels: entry.efforts,
    additionalSpeedTiers: [],
    priority: 200 + index,
    visibility: "list" as const,
  })));
export function resolveNvidiaCurrentModel(model: string | undefined): NimModel | undefined {
  return MODELS.find((entry) => entry.model === model?.trim().toLowerCase());
}
