/** NVIDIA NIM hosted contracts checked 2026-11-20 against each model's hosted
 * API schema and model card: docs.api.nvidia.com/nim/reference/<org>-<model>-infer
 * (max_tokens default and maximum, the reasoning_effort enum, tools and
 * tool_choice, image content parts) and docs.api.nvidia.com/nim/reference/<org>-<model>
 * (context length, inputs). Native vendor limits do not apply to NIM.
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
  /** The hosted schema takes `tools`. */
  readonly tools: boolean;
  /** The hosted schema takes `tools` but has no `tool_choice`. */
  readonly toolChoice?: false;
  /**
   * The day NVIDIA ended the model on its hosted API. The row stays for old
   * sessions, hidden from pickers; choosing it on hosted NIM is refused with
   * this date (model-retirement.ts).
   */
  readonly retiresOn?: string;
}

// The default (BUILT_IN_PROVIDER_DEFINITIONS["nvidia-nim"]) leads.
const MODELS: readonly NimModel[] = [
  // Card: up to 1M tokens, text, images and video in, but no hosted limit, so
  // the window is the 256K hosted default Nemotron 3 Ultra's card gives.
  // Schema: reasoning_effort none|low|high (default high), tools and
  // tool_choice, max_tokens 16,384 by default, at most 131,072.
  { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", label: "Nemotron 3.5 Super VL", context: 262_144, output: 16_384, ceiling: 131_072, vision: true, efforts: ["none", "low", "high"], defaultEffort: "high", tools: true },
  // Card: the hosted context defaults to 256K, text only. Schema: reasoning_effort
  // none|medium|high (default high), no tools, max_tokens at most 32,768.
  { model: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", context: 262_144, output: 16_384, ceiling: 32_768, vision: false, efforts: ["none", "medium", "high"], defaultEffort: "high", tools: false },
  // Card: 1,048,576 tokens, image and video in. Schema: reasoning_effort
  // low|medium|high|max (default low), tools without tool_choice, max_tokens at most 65,536.
  { model: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro", context: 1_048_576, output: 16_384, ceiling: 65_536, vision: true, efforts: ["low", "medium", "high", "max"], defaultEffort: "low", tools: true, toolChoice: false },
  // Card: 1M tokens, text and images in. Schema: reasoning_effort none|high, served
  // as none when the field is left out; tools and tool_choice; max_tokens at most 262,144.
  { model: "mistralai/mistral-large-4-1t-a52b", label: "Mistral Large 4", context: 1_000_000, output: 4_096, ceiling: 262_144, vision: true, efforts: ["none", "high"], defaultEffort: "none", tools: true },
  // Card: up to 1M tokens, image input. Schema: thinking always on (no effort),
  // tools and tool_choice, max_tokens at most 1,048,576.
  { model: "stepfun-ai/step-5-preview", label: "Step 5 Preview", context: 1_048_576, output: 4_096, ceiling: 1_048_576, vision: true, efforts: [], tools: true },
  { model: "meta/muse-glimmer-30b", label: "Muse Glimmer 30B", context: 131_072, output: 2_048, ceiling: 131_072, vision: true, efforts: ["none", "minimal", "low", "medium", "high", "max"], defaultEffort: "high", tools: true },
  // Card: 256K, text, image and video in. Schema: thinking is a template switch
  // (enable_thinking), no tools, max_tokens at most 32,768.
  { model: "google/gemma-4-31b-it", label: "Gemma 4 31B", context: 262_144, output: 16_384, ceiling: 32_768, vision: true, efforts: [], tools: false },
  // Card: up to 256K tokens, image, video and audio in. Schema: a reasoning
  // budget only, no tools, max_tokens at most 65,536.
  { model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "Nemotron 3 Nano Omni", context: 262_144, output: 65_536, ceiling: 65_536, vision: true, efforts: [], tools: false },
  // Card: up to 64K tokens on this endpoint, text only. Schema: thinking is a
  // template switch, tools and tool_choice, max_tokens 1,024 by default, at most 65,536.
  { model: "nvidia/nemotron-3.5-bolt-e4b", label: "Nemotron 3.5 Bolt E4B", context: 65_536, output: 1_024, ceiling: 65_536, vision: false, efforts: [], tools: true },
  // Ended: a chat call answers HTTP 410, "The model '<id>' has reached its end
  // of life on <date>T08:00:00Z and is no longer available." The wire contracts
  // stay for old sessions.
  { model: "moonshotai/kimi-k3", label: "Kimi K3", context: 1_048_576, output: 16_384, ceiling: 65_536, vision: true, efforts: ["low", "high", "max"], defaultEffort: "max", tools: true, toolChoice: false, retiresOn: "2026-10-15" },
  { model: "moonshotai/kimi-k2.6", label: "Kimi K2.6", context: 262_144, output: 16_384, ceiling: 65_536, vision: true, efforts: [], tools: true, retiresOn: "2026-11-15" },
  { model: "openai/gpt-oss-20b", label: "GPT OSS 20B", context: 128_000, output: 4_096, ceiling: 4_096, vision: false, efforts: ["low", "medium", "high"], defaultEffort: "medium", tools: true, retiresOn: "2026-11-18" },
];

/**
 * Ids NVIDIA's hosted API offered that it has ended, without a contract row:
 * the day each ended. A chat call answered HTTP 410 with the date (checked
 * without a key on 2026-11-20), or, where it answers HTTP 404 and gives no
 * date, 2026-10-17: the day Core found the id gone (HTTP 410 or 404) and hid
 * it. Hidden rows only, so a saved or typed choice is refused on hosted NIM
 * with a plain message instead of being sent. A self-hosted NIM endpoint is
 * not bound by them (model-catalog-selection.ts).
 */
const ENDED: readonly (readonly [model: string, retiresOn: string])[] = [
  ["meta/codellama-70b", "2026-11-15"],
  ["mistralai/codestral-22b-instruct-v0.1", "2026-11-15"],
  ["deepseek-ai/deepseek-coder-6.7b-instruct", "2026-11-15"],
  ["google/codegemma-7b", "2026-11-15"],
  ["google/codegemma-1.1-7b", "2026-11-15"],
  ["ibm/granite-34b-code-instruct", "2026-11-15"],
  ["ibm/granite-8b-code-instruct", "2026-11-15"],
  ["nvidia/llama-3.1-nemotron-70b-instruct", "2026-11-15"],
  ["nvidia/llama-3.1-nemotron-51b-instruct", "2026-11-15"],
  ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "2026-11-15"],
  ["nvidia/nemotron-4-340b-instruct", "2026-11-15"],
  ["nvidia/nemotron-3-super-120b-a12b", "2026-10-03"],
  ["nvidia/llama3-chatqa-1.5-70b", "2026-11-15"],
  ["meta/llama-3.2-90b-vision-instruct", "2026-11-16"],
  ["meta/llama-3.2-11b-vision-instruct", "2026-11-05"],
  ["mistralai/mistral-large-2-instruct", "2026-11-15"],
  ["mistralai/mistral-large", "2026-11-15"],
  ["mistralai/mistral-7b-instruct-v0.3", "2026-11-15"],
  ["ibm/granite-3.0-8b-instruct", "2026-11-15"],
  ["ibm/granite-3.0-3b-a800m-instruct", "2026-11-15"],
  ["databricks/dbrx-instruct", "2026-11-15"],
  ["01-ai/yi-large", "2026-11-15"],
  ["ai21labs/jamba-1.5-large-instruct", "2026-11-15"],
  ["writer/palmyra-creative-122b", "2026-11-15"],
  ["writer/palmyra-fin-70b-32k", "2026-11-15"],
  ["writer/palmyra-med-70b", "2026-11-15"],
  ["writer/palmyra-med-70b-32k", "2026-11-15"],
  ["openai/gpt-oss-120b", "2026-09-03"],
  ["microsoft/phi-4-mini-flash-reasoning", "2026-10-17"],
  ["qwen/qwen3-next-80b-a3b-thinking", "2026-05-21"],
  ["deepseek-ai/deepseek-r1-distill-qwen-32b", "2026-10-17"],
  ["deepseek-ai/deepseek-r1-distill-qwen-14b", "2026-10-17"],
  ["deepseek-ai/deepseek-r1-distill-qwen-7b", "2026-10-17"],
  ["deepseek-ai/deepseek-r1-distill-llama-8b", "2026-10-17"],
  ["qwen/qwq-32b", "2026-10-17"],
  ["bigcode/starcoder2-7b", "2026-10-17"],
  ["mistralai/mamba-codestral-7b-v0.1", "2026-10-17"],
  ["qwen/qwen2.5-coder-32b-instruct", "2026-05-12"],
  ["qwen/qwen2.5-coder-7b-instruct", "2026-10-17"],
  ["qwen/qwen3-coder-480b-a35b-instruct", "2026-06-11"],
  ["nvidia/llama-3.3-nemotron-super-49b-v1", "2026-08-26"],
  ["nvidia/llama-3.3-nemotron-super-49b-v1.5", "2026-08-26"],
  ["nvidia/nemotron-3-nano-30b-a3b", "2026-09-01"],
  ["nvidia/nemotron-mini-4b-instruct", "2026-08-26"],
  ["nvidia/llama-3.1-nemotron-nano-8b-v1", "2026-08-26"],
  ["nvidia/llama-3.1-nemotron-nano-4b-v1.1", "2026-10-17"],
  ["nvidia/llama3-chatqa-1.5-8b", "2026-10-17"],
  ["meta/llama-3.1-405b-instruct", "2026-10-17"],
  ["meta/llama-3.1-70b-instruct", "2026-08-26"],
  ["meta/llama-3.1-8b-instruct", "2026-08-26"],
  ["meta/llama-3.2-3b-instruct", "2026-08-26"],
  ["meta/llama-3.2-1b-instruct", "2026-08-26"],
  ["meta/llama-3.3-70b-instruct", "2026-08-26"],
  ["meta/llama-4-maverick-17b-128e-instruct", "2026-07-27"],
  ["meta/llama-4-scout-17b-16e-instruct", "2026-10-17"],
  ["google/gemma-3-27b-it", "2026-05-12"],
  ["google/gemma-3-1b-it", "2026-10-17"],
  ["google/gemma-3n-e4b-it", "2026-07-27"],
  ["google/gemma-3n-e2b-it", "2026-07-27"],
  ["google/gemma-2-27b-it", "2026-10-17"],
  ["google/gemma-2-9b-it", "2026-10-17"],
  ["google/gemma-2-2b-it", "2026-07-27"],
  ["mistralai/mistral-large-3-675b-instruct-2512", "2026-07-23"],
  ["mistralai/mistral-medium-3-instruct", "2026-10-17"],
  ["mistralai/mistral-small-4-119b-2603", "2026-07-27"],
  ["mistralai/mistral-small-3.1-24b-instruct-2503", "2026-10-17"],
  ["mistralai/mistral-small-24b-instruct", "2026-10-17"],
  ["mistralai/mistral-7b-instruct-v0.2", "2026-10-17"],
  ["mistralai/mixtral-8x22b-instruct-v0.1", "2026-05-21"],
  ["mistralai/mixtral-8x7b-instruct-v0.1", "2026-07-27"],
  ["mistralai/mistral-nemotron", "2026-09-28"],
  ["mistralai/ministral-14b-instruct-2512", "2026-07-27"],
  ["mistralai/devstral-2-123b-instruct-2512", "2026-10-17"],
  ["mistralai/magistral-small-2506", "2026-10-17"],
  ["mistralai/mathstral-7b-v0.1", "2026-10-17"],
  ["microsoft/phi-4-multimodal-instruct", "2026-07-15"],
  ["microsoft/phi-4-mini-instruct", "2026-07-15"],
  ["microsoft/phi-3.5-mini-instruct", "2026-10-17"],
  ["microsoft/phi-3-small-128k-instruct", "2026-10-17"],
  ["microsoft/phi-3-small-8k-instruct", "2026-10-17"],
  ["microsoft/phi-3-medium-128k-instruct", "2026-10-17"],
  ["microsoft/phi-3-medium-4k-instruct", "2026-10-17"],
  ["microsoft/phi-3-mini-128k-instruct", "2026-10-17"],
  ["microsoft/phi-3-mini-4k-instruct", "2026-10-17"],
  ["qwen/qwen3.5-397b-a17b", "2026-07-27"],
  ["qwen/qwen3.5-122b-a10b", "2026-07-20"],
  ["qwen/qwen3-next-80b-a3b-instruct", "2026-07-27"],
  ["qwen/qwen2.5-7b-instruct", "2026-10-17"],
  ["qwen/qwen2-7b-instruct", "2026-10-17"],
  ["qwen/qwen3-32b", "2026-10-17"],
  ["qwen/qwen3-8b", "2026-10-17"],
  ["deepseek-ai/deepseek-r1", "2026-10-17"],
  ["deepseek-ai/deepseek-v3", "2026-10-17"],
  ["deepseek-ai/deepseek-v3.2", "2026-10-17"],
  ["deepseek-ai/deepseek-v3.1-terminus", "2026-10-17"],
  ["deepseek-ai/deepseek-v3.1", "2026-10-17"],
  ["ibm/granite-3.3-8b-instruct", "2026-10-17"],
  ["ai21labs/jamba-1.5-mini-instruct", "2026-10-17"],
  ["z-ai/glm5", "2026-05-18"],
  ["z-ai/glm4.7", "2026-05-14"],
  ["minimaxai/minimax-m2.5", "2026-05-12"],
  ["moonshotai/kimi-k2.5", "2026-10-17"],
  ["moonshotai/kimi-k2-instruct", "2026-05-12"],
  ["moonshotai/kimi-k2-thinking", "2026-05-12"],
  ["moonshotai/kimi-k2.5-thinking", "2026-10-17"],
  ["moonshotai/kimi-k2-instruct-0905", "2026-10-17"],
];

export const NVIDIA_CURRENT_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze(
    MODELS.map((entry, index) => Object.freeze({
      provider: "nvidia-nim",
      model: entry.model,
      displayName: entry.label,
      contextWindow: entry.context,
      maxContextWindow: entry.context,
      maxOutputTokens: entry.output,
      maxOutputTokensUpperLimit: entry.ceiling,
      maxOutputTokensCappedDefault: true,
      inputModalities: entry.vision ? ["text", "image"] as const : ["text"] as const,
      supportsToolUse: entry.tools,
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
      // No default level: a request without reasoning_effort gets NVIDIA's
      // own default (defaultEffort above records it).
      additionalSpeedTiers: [],
      priority: 200 + index,
      visibility: entry.retiresOn === undefined ? "list" as const : "none" as const,
      ...(entry.retiresOn === undefined ? {} : { retiresOn: entry.retiresOn }),
    })),
  );

/**
 * Date-only rows for ENDED: found by the exact-id retirement lookup
 * (findBundledModelCatalogEntry), never by capability lookups, so a
 * self-hosted NIM that still runs one of these models keeps what it had.
 */
export const NVIDIA_ENDED_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze(
    ENDED.map(([model, retiresOn], index) => Object.freeze({
      provider: "nvidia-nim",
      model,
      displayName: model,
      inputModalities: ["text"] as const,
      supportsToolUse: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsStructuredOutputWithTools: false,
      supportsSearchTool: false,
      supportsVerbosity: false,
      webSearchToolType: "none" as const,
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none" as const,
      supportedReasoningLevels: [],
      additionalSpeedTiers: [],
      priority: 400 + index,
      visibility: "none" as const,
      retiresOn,
    })),
  );

export function resolveNvidiaCurrentModel(model: string | undefined): NimModel | undefined {
  return MODELS.find((entry) => entry.model === model?.trim().toLowerCase());
}
