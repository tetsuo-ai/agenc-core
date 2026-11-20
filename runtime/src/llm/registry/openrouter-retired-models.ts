/**
 * Models the bundled OpenRouter list offered until OpenRouter stopped listing
 * them: GET https://openrouter.ai/api/v1/models on 2026-11-20 has none of
 * these. The date is OpenRouter's own `expiration_date` where the earlier
 * snapshot carried one, else 2026-11-20, the day the list was read without
 * the model. The rows are hidden from every picker; a saved or typed choice of
 * one is refused with its date before any request is sent
 * (model-retirement.ts), unless OpenRouter's own list held in this process,
 * read on or after that date, has the model again.
 */
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";

const RETIRED: readonly (readonly [model: string, label: string, retiredOn: string])[] = [
  ["minimax/minimax-m3.1-flash:free", "MiniMax: MiniMax M3.1 Flash (free)", "2026-11-20"],
  ["xingchen-agi/xing4.0-29b-a4b:free", "XingChen: Xing4.0 29B A4B (free)", "2026-11-20"],
  ["inception/mercury-3", "Inception: Mercury 3", "2026-11-20"],
  ["inception/mercury-2.5", "Inception: Mercury 2.5", "2026-11-20"],
  ["bytedance-seed/seed-2.0-code", "ByteDance Seed: Seed-2.0-Code", "2026-11-11"],
  ["liquid/lfm-2.5-2.6b:free", "LiquidAI: LFM2.5-2.6B (free)", "2026-11-20"],
  ["thinkingmachines/inkling-small:free", "Thinking Machines: Inkling Small (free)", "2026-11-20"],
  ["poolside/laguna-s-2.1", "Poolside: Laguna S 2.1", "2026-10-31"],
  ["poolside/laguna-s-2.1:free", "Poolside: Laguna S 2.1 (free)", "2026-10-31"],
  ["thinkingmachines/inkling:free", "Thinking Machines: Inkling (free)", "2026-11-20"],
  ["poolside/laguna-xs-2.1", "Poolside: Laguna XS 2.1", "2026-10-31"],
  ["poolside/laguna-xs-2.1:free", "Poolside: Laguna XS 2.1 (free)", "2026-10-31"],
  ["x-ai/grok-build-0.1", "SpaceXAI: Grok Build 0.1", "2026-11-20"],
  ["arcee-ai/trinity-large-thinking", "Arcee AI: Trinity Large Thinking", "2026-11-20"],
  ["nvidia/nemotron-3-super-120b-a12b:free", "NVIDIA: Nemotron 3 Super (free)", "2026-11-20"],
  ["inception/mercury-2", "Inception: Mercury 2", "2026-11-20"],
  ["stepfun/step-3.5-flash", "StepFun: Step 3.5 Flash", "2026-11-20"],
  ["upstage/solar-pro-3", "Upstage: Solar Pro 3", "2026-11-20"],
  ["bytedance-seed/seed-1.6-flash", "ByteDance Seed: Seed 1.6 Flash", "2026-11-11"],
  ["bytedance-seed/seed-1.6", "ByteDance Seed: Seed 1.6", "2026-11-11"],
  ["minimax/minimax-m2.1", "MiniMax: MiniMax M2.1", "2026-11-20"],
  ["minimax/minimax-m2", "MiniMax: MiniMax M2", "2026-11-20"],
  ["qwen/qwen3-vl-30b-a3b-thinking", "Qwen: Qwen3 VL 30B A3B Thinking", "2026-11-20"],
  ["qwen/qwen3-next-80b-a3b-thinking", "Qwen: Qwen3 Next 80B A3B Thinking", "2026-11-20"],
  ["minimax/minimax-m1", "MiniMax: MiniMax M1", "2026-11-20"],
  ["openai/o4-mini-high", "OpenAI: o4 Mini High", "2026-11-20"],
  ["openai/o4-mini", "OpenAI: o4 Mini", "2026-11-20"],
  ["openai/o3-mini-high", "OpenAI: o3 Mini High", "2026-11-20"],
  ["openai/o3-mini", "OpenAI: o3 Mini", "2026-11-20"],
  ["openai/o1", "OpenAI: o1", "2026-11-20"],
  ["qwen/qwen-2.5-7b-instruct", "Qwen: Qwen2.5 7B Instruct", "2026-11-20"],
  ["openai/gpt-4-turbo", "OpenAI: GPT-4 Turbo", "2026-11-20"],
  ["openai/gpt-3.5-turbo", "OpenAI: GPT-3.5 Turbo", "2026-11-20"],
];

export const OPENROUTER_RETIRED_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] = Object.freeze(
  RETIRED.map(([model, displayName, retiresOn], index) => Object.freeze({
    provider: "openrouter",
    model,
    displayName,
    inputModalities: Object.freeze(["text"] as const),
    supportsToolUse: true,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none" as const,
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none" as const,
    supportedReasoningLevels: Object.freeze([]),
    additionalSpeedTiers: Object.freeze([]),
    priority: 10_000 + index,
    visibility: "none" as const,
    retiresOn,
  })),
);
