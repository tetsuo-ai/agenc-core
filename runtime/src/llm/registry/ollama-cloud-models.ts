/** Ollama Cloud catalog snapshot, verified with /api/tags, /api/show and
 * https://ollama.com/pricing on 2026-10-20.
 * https://docs.ollama.com/cloud
 * https://docs.ollama.com/capabilities/thinking
 * https://docs.ollama.com/api/openai-compatibility (reasoning_effort takes the
 * model-defined names /api/show lists; `none` turns thinking off)
 * IDs belong to the direct Cloud API; do not append the local proxy :cloud suffix.
 * Output budgets below are AgenC defaults, not advertised model output limits.
 *
 * The live list (`GET /api/tags`, public) and each model's details
 * (`POST /api/show`, public) replace these rows at runtime through
 * published-model-catalog; this snapshot is the offline fallback.
 */
import type { ReasoningEffort } from "../../session/turn-context.js";
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";
import { asRecord } from "../../utils/record.js";

export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
export const OLLAMA_CLOUD_ORIGIN = "https://ollama.com";
export const OLLAMA_CLOUD_API_KEY_ENV = "OLLAMA_API_KEY";
export const OLLAMA_CLOUD_DEFAULT_MODEL = "deepseek-v4.1-flash";
/**
 * Retired by Ollama: POST /api/show answers 410 "retired on September 25,
 * 2026" for each (checked 2026-10-20), and they are gone from /api/tags and
 * the price list. They stay hidden from the picker so a saved Desktop goal or
 * config still resolves; a request gets Ollama's own 410 explanation.
 */
export const OLLAMA_CLOUD_UNLISTED_MODELS: ReadonlySet<string> = new Set([
  "deepseek-v4-flash:0731", "glm-5.1", "qwen3.5:397b",
]);

export interface OllamaCloudModelRow {
  readonly model: string;
  readonly label: string;
  readonly contextWindow?: number;
  readonly vision: boolean;
  readonly thinking: boolean;
  readonly tools: boolean;
  /** AgenC effort names the model accepts as `reasoning_effort`; empty when thinking is not controllable. */
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort;
  readonly effortNote?: string;
}

const ON_OFF_NOTE = "Thinking off or on; this model does not expose graded effort levels.";

function row(
  model: string,
  label: string,
  contextWindow: number,
  caps: { readonly vision: boolean; readonly thinking: boolean },
  efforts: readonly ReasoningEffort[],
  defaultEffort?: ReasoningEffort,
): OllamaCloudModelRow {
  const onOff = efforts.length === 2 && efforts[0] === "none" && efforts[1] === "high";
  return Object.freeze({
    model, label, contextWindow, vision: caps.vision, thinking: caps.thinking, tools: true,
    efforts: Object.freeze([...efforts]),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(onOff ? { effortNote: ON_OFF_NOTE } : {}),
  });
}

const V = Object.freeze({ vision: true, thinking: true });
const T = Object.freeze({ vision: false, thinking: true });

/**
 * Efforts follow /api/show `thinking.values` (false -> none, true -> high)
 * and defaults follow `thinking.default`: the level the model thinks at when
 * a request carries no reasoning_effort, which is what "Default" in /effort
 * and the status line report and what the session sends. DeepSeek models run
 * at DeepSeek's own high instead (model-family.ts). minimax-m3 lists no
 * thinking values but honors none/high and thinks when none is sent (probed
 * 2026-10-20, jobs/pv/probes/ollama-thinking-control.json); minimax-m3.1-flash
 * and mistral-large-4 list none and do not follow them, so no effort is sent.
 */
export const OLLAMA_CLOUD_MODELS: readonly OllamaCloudModelRow[] = Object.freeze([
  row("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1048576, V, ["none", "low", "high", "max"], "high"),
  row("deepseek-v4.1-flash:1017", "DeepSeek V4.1 Flash 1017", 1048576, V, ["none", "low", "high", "max"], "high"),
  row("deepseek-v4-flash:0731", "DeepSeek V4 Flash 0731", 1048576, T, ["low", "high", "max"], "low"),
  row("deepseek-v4-pro:0813", "DeepSeek V4 Pro 0813", 1048576, T, ["none", "low", "high", "max"], "low"),
  row("beam", "Beam", 1048576, T, ["low", "medium", "high", "xhigh", "max"], "max"),
  row("gemma4:31b", "Gemma 4 31B", 262144, V, ["none", "high"], "none"),
  row("glm-5.1", "GLM 5.1", 202752, T, ["none", "high"], "none"),
  row("glm-5.2", "GLM 5.2", 1048576, T, ["none", "high", "max"], "high"),
  row("glm-5.3", "GLM 5.3", 1048576, T, ["low", "high", "max"], "max"),
  row("glm-5.3-flash", "GLM 5.3 flash", 1048576, V, ["low", "high", "max"], "max"),
  row("gpt-oss:120b", "GPT OSS 120B", 131072, T, ["low", "medium", "high"], "medium"),
  row("gpt-oss:20b", "GPT OSS 20B", 131072, T, ["low", "medium", "high"], "medium"),
  row("kimi-k2.6", "Kimi K2.6", 262144, V, ["none", "high"], "high"),
  row("kimi-k2.7-code", "Kimi K2.7 code", 262144, V, ["none", "high"], "high"),
  row("kimi-k3", "Kimi K3", 1048576, V, ["none", "low", "high", "max"], "max"),
  row("minimax-m2.7", "MiniMax m2.7", 196608, T, []),
  row("minimax-m3", "MiniMax m3", 512000, V, ["none", "high"], "high"),
  row("minimax-m3.1-flash", "MiniMax m3.1 flash", 1000000, V, []),
  row("mistral-large-3:675b", "Mistral Large 3 675B", 262144, { vision: true, thinking: false }, []),
  row("mistral-large-4", "Mistral Large 4", 1048576, V, []),
  row("muse-spark-open", "Muse Spark Open", 1048576, V, ["none", "low", "medium", "high", "max"], "high"),
  row("nemotron-3-nano:30b", "Nemotron 3 Nano 30B", 262144, T, ["none", "high"], "high"),
  row("nemotron-3-super", "Nemotron 3 super", 262144, T, ["none", "high"], "high"),
  row("nemotron-3-ultra", "Nemotron 3 ultra", 262144, T, ["none", "high"], "high"),
  row("qwen3.5:397b", "Qwen 3.5 397B", 262144, V, ["none", "high"], "none"),
]);

export function ollamaCloudModel(model: string | undefined): OllamaCloudModelRow | undefined {
  const id = model?.trim().toLowerCase();
  return OLLAMA_CLOUD_MODELS.find(entry => entry.model === id);
}

const EFFORT_NAMES: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `/api/show` `thinking.values` as AgenC effort names; undefined when absent. */
export function ollamaThinkingEfforts(values: unknown): readonly ReasoningEffort[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const efforts: ReasoningEffort[] = [];
  for (const value of values) {
    const effort = value === false ? "none" : value === true ? "high" : value;
    if (typeof effort === "string" && EFFORT_NAMES.has(effort) && !efforts.includes(effort as ReasoningEffort)) {
      efforts.push(effort as ReasoningEffort);
    }
  }
  // A model whose only value is `true` always thinks: there is nothing to choose.
  return values.length === 1 && values[0] === true ? [] : efforts;
}

/**
 * `/api/show` `thinking.default` as an AgenC effort name: the level the model
 * thinks at when a request carries no reasoning_effort. Undefined when Ollama
 * publishes none or it is not one of the model's levels.
 */
function ollamaThinkingDefault(
  value: unknown,
  efforts: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const effort = value === false ? "none" : value === true ? "high" : value;
  return typeof effort === "string" && efforts.includes(effort as ReasoningEffort) ? effort as ReasoningEffort : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Chat models from `GET /api/tags`. A model without the `completion`
 * capability (Clef and the other decision models, embedding models) is not a
 * chat model and is left out. Rows the bundled snapshot knows keep its
 * label, context and AgenC default; the capability tags are the live ones.
 */
export function parseOllamaCloudTags(payload: unknown): readonly OllamaCloudModelRow[] {
  const models = asRecord(payload)?.models;
  if (!Array.isArray(models)) return [];
  const rows: OllamaCloudModelRow[] = [];
  for (const value of models) {
    const record = asRecord(value);
    const id = typeof record?.model === "string" ? record.model : typeof record?.name === "string" ? record.name : undefined;
    if (id === undefined || id.trim().length === 0) continue;
    const capabilities = stringList(record?.capabilities);
    if (!capabilities.includes("completion")) continue;
    const known = ollamaCloudModel(id);
    const thinking = capabilities.includes("thinking");
    rows.push(Object.freeze({
      model: id,
      label: known?.label ?? id,
      ...(known?.contextWindow === undefined ? {} : { contextWindow: known.contextWindow }),
      vision: capabilities.includes("vision"),
      thinking,
      tools: capabilities.includes("tools"),
      efforts: thinking ? (known?.efforts ?? []) : Object.freeze([]),
      ...(thinking && known?.defaultEffort !== undefined ? { defaultEffort: known.defaultEffort } : {}),
      ...(known?.effortNote === undefined ? {} : { effortNote: known.effortNote }),
    }));
  }
  return Object.freeze(rows);
}

/**
 * One model's details from `POST /api/show`: its capabilities, its context
 * length (`<architecture>.context_length`) and its thinking levels. Returns
 * undefined for a model that is not a chat model.
 */
export function parseOllamaCloudShow(model: string, payload: unknown): OllamaCloudModelRow | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const capabilities = stringList(record.capabilities);
  if (!capabilities.includes("completion")) return undefined;
  const info = asRecord(record.model_info);
  let contextWindow: number | undefined;
  for (const [field, value] of Object.entries(info ?? {})) {
    if (field.endsWith(".context_length")) contextWindow = positiveInteger(value) ?? contextWindow;
  }
  const known = ollamaCloudModel(model);
  const thinking = capabilities.includes("thinking");
  const thinkingInfo = asRecord(record.thinking);
  const listed = ollamaThinkingEfforts(thinkingInfo?.values);
  // No listed levels: keep a probed bundled control (minimax-m3), else send none.
  const efforts = !thinking ? [] : listed ?? known?.efforts ?? [];
  // The published default; a bundled one only when Ollama publishes no levels.
  const defaultEffort = ollamaThinkingDefault(thinkingInfo?.default, efforts) ??
    (listed === undefined && known?.defaultEffort !== undefined && efforts.includes(known.defaultEffort)
      ? known.defaultEffort
      : undefined);
  const onOff = efforts.length === 2 && efforts[0] === "none" && efforts[1] === "high";
  return Object.freeze({
    model,
    label: known?.label ?? model,
    ...((contextWindow ?? known?.contextWindow) === undefined ? {} : { contextWindow: contextWindow ?? known?.contextWindow }),
    vision: capabilities.includes("vision"),
    thinking,
    tools: capabilities.includes("tools"),
    efforts: Object.freeze([...efforts]),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(onOff ? { effortNote: ON_OFF_NOTE } : {}),
  });
}

const TEXT_IMAGE: readonly ("text" | "image")[] = Object.freeze(["text", "image"]);
const TEXT_ONLY: readonly ("text" | "image")[] = Object.freeze(["text"]);

/** One Ollama Cloud row as a registered catalog entry (bundled or published). */
export function ollamaCloudCatalogEntry(
  entry: OllamaCloudModelRow,
  priority: number,
  visibility: RegisteredModelCatalogEntry["visibility"] = OLLAMA_CLOUD_UNLISTED_MODELS.has(entry.model) ? "none" : "list",
): RegisteredModelCatalogEntry {
  return Object.freeze({
    provider: OLLAMA_CLOUD_PROVIDER_ID,
    model: entry.model,
    displayName: entry.label,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow, maxContextWindow: entry.contextWindow }),
    maxOutputTokens: 16_384,
    maxOutputTokensUpperLimit: 32_768,
    maxOutputTokensCappedDefault: true,
    inputModalities: entry.vision ? TEXT_IMAGE : TEXT_ONLY,
    supportsToolUse: entry.tools,
    supportsThinking: entry.thinking,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none",
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none",
    supportedReasoningLevels: entry.efforts,
    ...(entry.defaultEffort === undefined ? {} : { defaultReasoningLevel: entry.defaultEffort }),
    additionalSpeedTiers: Object.freeze([]),
    priority,
    visibility,
  });
}
