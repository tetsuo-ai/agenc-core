import type { ReasoningEffort } from "../../session/turn-context.js";

/** Official Groq catalog and tool contracts reviewed 2026-09-29.
 * https://console.groq.com/docs/models
 * https://console.groq.com/docs/tool-use/overview
 * https://console.groq.com/docs/api-reference
 * https://console.groq.com/docs/vision
 * MiniMax is enterprise preview and intentionally unpriced.
 */
interface GroqModel {
  readonly model: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly vision: boolean;
  readonly parallel: boolean;
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort;
}
export const GROQ_MODELS: readonly GroqModel[] = Object.freeze([
  { model: "openai/gpt-oss-120b", label: "GPT OSS 120B", contextWindow: 131_072,
    maxOutputTokens: 65_536, vision: false, parallel: false,
    efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { model: "openai/gpt-oss-20b", label: "GPT OSS 20B", contextWindow: 131_072,
    maxOutputTokens: 65_536, vision: false, parallel: false,
    efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { model: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B (Preview)", contextWindow: 131_072,
    maxOutputTokens: 16_384, vision: true, parallel: true,
    efforts: ["none", "low", "medium", "high"], defaultEffort: "none" },
  { model: "minimaxai/minimax-m2.7", label: "MiniMax M2.7 (Enterprise preview)",
    contextWindow: 196_608, maxOutputTokens: 131_072, vision: false, parallel: true,
    efforts: [] },
]);
