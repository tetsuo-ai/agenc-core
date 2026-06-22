/**
 * Ports upstream `src/services/tokenEstimation.ts` rough-estimation helpers
 * onto AgenC's provider-neutral runtime.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC keeps live API token counting out of this module. The exported
 *     helpers are deterministic local estimates that can be used by tools,
 *     compaction, prompt budgeting, and provider routing.
 *   - Provider/model ratios are resolved from explicit hints instead of
 *     process-global provider configuration.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Provider SDK count-token calls, VCR plumbing, and cloud-specific
 *     fallback requests.
 */

import { isRecord } from "../utils/record.js";

export interface ModelTokenizerConfig {
  readonly modelFamily: string;
  readonly providerNames: readonly string[];
  readonly modelMatchers: readonly RegExp[];
  readonly bytesPerToken: number;
  readonly supportsJson: boolean;
  readonly supportsCode: boolean;
}

export interface TokenizerProviderHint {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly bytesPerToken?: number | null;
}

export interface TokenEstimateBounds {
  readonly estimate: number;
  readonly min: number;
  readonly max: number;
}

export type ContentType =
  | "json"
  | "code"
  | "prose"
  | "technical"
  | "list"
  | "table"
  | "mixed";

export type TokenEstimationContent =
  | string
  | readonly unknown[]
  | Record<string, unknown>
  | boolean
  | number
  | null
  | undefined;

export interface TokenEstimationMessage {
  readonly type?: string;
  readonly role?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
  readonly content?: unknown;
  readonly attachment?: unknown;
}

export const DEFAULT_BYTES_PER_TOKEN = 4;

// branding-scan: allow Anthropic model family identifier
const ANTHROPIC_MODEL_RE = /\bclaude[-_]/i;

export const MODEL_TOKENIZER_CONFIGS: readonly ModelTokenizerConfig[] = [
  {
    modelFamily: "anthropic",
    providerNames: ["anthropic"],
    modelMatchers: [ANTHROPIC_MODEL_RE],
    bytesPerToken: 3.5,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "gpt-4",
    providerNames: ["openai"],
    modelMatchers: [/gpt-4/i, /^o[134](?:-|$)/i],
    bytesPerToken: 4,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "gpt-3.5",
    providerNames: ["openai"],
    modelMatchers: [/gpt-3\.5/i],
    bytesPerToken: 4,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "grok",
    providerNames: ["grok", "xai"],
    modelMatchers: [/grok/i],
    bytesPerToken: 4,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "gemini",
    providerNames: ["google", "gemini"],
    modelMatchers: [/gemini/i],
    bytesPerToken: 3.5,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "llama",
    providerNames: ["ollama", "groq", "lmstudio"],
    modelMatchers: [/llama/i, /mixtral/i, /mistral/i, /qwen/i],
    bytesPerToken: 3.8,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "deepseek",
    providerNames: ["deepseek"],
    modelMatchers: [/deepseek/i],
    bytesPerToken: 3.5,
    supportsJson: true,
    supportsCode: true,
  },
  {
    modelFamily: "minimax",
    providerNames: ["minimax"],
    modelMatchers: [/minimax/i],
    bytesPerToken: 3.2,
    supportsJson: true,
    supportsCode: true,
  },
];

export const UNKNOWN_TOKENIZER_CONFIG: ModelTokenizerConfig = {
  modelFamily: "unknown",
  providerNames: [],
  modelMatchers: [],
  bytesPerToken: DEFAULT_BYTES_PER_TOKEN,
  supportsJson: true,
  supportsCode: true,
};

export const COMPRESSION_RATIOS: Record<
  ContentType,
  { readonly min: number; readonly max: number; readonly typical: number }
> = {
  json: { min: 1.5, max: 2.5, typical: 2 },
  code: { min: 3, max: 4.5, typical: 3.5 },
  prose: { min: 3.5, max: 4.5, typical: 4 },
  technical: { min: 2.5, max: 3.5, typical: 3 },
  list: { min: 2, max: 3, typical: 2.5 },
  table: { min: 1.8, max: 2.8, typical: 2.2 },
  mixed: { min: 3, max: 4, typical: 3.5 },
};

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken = DEFAULT_BYTES_PER_TOKEN,
): number {
  const ratio =
    Number.isFinite(bytesPerToken) && bytesPerToken > 0
      ? bytesPerToken
      : DEFAULT_BYTES_PER_TOKEN;
  return Math.round(content.length / ratio);
}

export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (normalizeFileExtension(fileExtension)) {
    case "json":
    case "jsonl":
    case "jsonc":
      return 2;
    default:
      return DEFAULT_BYTES_PER_TOKEN;
  }
}

export function getTokenizerConfig(model: string): ModelTokenizerConfig {
  return getTokenizerConfigForProvider({ model });
}

export function getTokenizerConfigForProvider(
  hint: TokenizerProviderHint,
): ModelTokenizerConfig {
  const model = hint.model?.trim() ?? "";
  const provider = hint.provider?.trim().toLowerCase() ?? "";
  if (model.length > 0) {
    for (const config of MODEL_TOKENIZER_CONFIGS) {
      if (matchesModel(config, model)) return config;
    }
  }
  if (provider.length > 0) {
    for (const config of MODEL_TOKENIZER_CONFIGS) {
      if (config.providerNames.includes(provider)) return config;
    }
  }
  return UNKNOWN_TOKENIZER_CONFIG;
}

export function getBytesPerTokenForModel(model: string): number {
  return getTokenizerConfig(model).bytesPerToken;
}

export function getBytesPerTokenForProvider(
  hint: TokenizerProviderHint,
): number {
  const explicit = hint.bytesPerToken;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return getTokenizerConfigForProvider(hint).bytesPerToken;
}

export function roughTokenCountEstimationForProvider(
  content: string,
  hint: TokenizerProviderHint,
): number {
  return roughTokenCountEstimation(
    content,
    getBytesPerTokenForProvider(hint),
  );
}

export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  );
}

export function detectContentType(content: string): ContentType {
  const trimmed = content.trim();

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not JSON; continue through the lighter heuristics below.
    }
  }

  const lines = trimmed.split("\n");
  if (lines.length > 2) {
    const firstLine = lines[0] ?? "";
    const hasTabs = firstLine.includes("\t");
    const hasCommas = firstLine.includes(",");
    if (hasTabs || hasCommas) {
      const consistent = lines.slice(1).every((line) =>
        line.includes("\t") || line.includes(","),
      );
      if (consistent) return "table";
    }
  }

  if (/^[\d\-*\u2022]/u.test(trimmed) || /^[\d\-*\u2022]/u.test(lines[0] ?? "")) {
    return "list";
  }

  if (content.length > 0) {
    const codeChars = content.match(/[{}()[\];=]/g)?.length ?? 0;
    if (codeChars / content.length > 0.05) return "code";
  }

  if (/\d+\s*(px|em|rem|%|ms|s|kb|mb|gb)/i.test(content)) {
    return "technical";
  }

  return "prose";
}

export function getCompressionRatio(
  content: string,
  type?: ContentType,
): { readonly ratio: number; readonly min: number; readonly max: number } {
  const detectedType = type ?? detectContentType(content);
  const { min, max, typical } = COMPRESSION_RATIOS[detectedType];
  const lengthBonus = content.length < 100 ? 0.5 : 0;
  return {
    ratio: typical,
    min: min + lengthBonus,
    max: max + lengthBonus,
  };
}

export function estimateWithBounds(
  content: string,
  type?: ContentType,
): TokenEstimateBounds {
  const { ratio, min: minRatio, max: maxRatio } = getCompressionRatio(
    content,
    type,
  );
  return {
    estimate: roughTokenCountEstimation(content, ratio),
    min: roughTokenCountEstimation(content, maxRatio),
    max: roughTokenCountEstimation(content, minRatio),
  };
}

export function roughTokenCountEstimationForMessages(
  messages: readonly TokenEstimationMessage[],
  hint: TokenizerProviderHint = {},
): number {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message, hint);
  }
  return totalTokens;
}

export function roughTokenCountEstimationForMessage(
  message: TokenEstimationMessage,
  hint: TokenizerProviderHint = {},
): number {
  const kind = message.type ?? message.role ?? message.message?.role ?? "";
  if (kind === "attachment" && message.attachment !== undefined) {
    return roughTokenCountEstimationForBlock(message.attachment, hint);
  }
  const content = message.message?.content ?? message.content;
  if (content !== undefined && content !== null) {
    return roughTokenCountEstimationForContent(
      content as TokenEstimationContent,
      hint,
    );
  }
  return 0;
}

export function roughTokenCountEstimationForContent(
  content: TokenEstimationContent,
  hint: TokenizerProviderHint = {},
): number {
  if (content === undefined || content === null) return 0;
  if (typeof content === "string") {
    return roughTokenCountEstimationForProvider(content, hint);
  }
  if (!Array.isArray(content)) {
    return roughTokenCountEstimationForBlock(content, hint);
  }
  let totalTokens = 0;
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block, hint);
  }
  return totalTokens;
}

function roughTokenCountEstimationForBlock(
  block: unknown,
  hint: TokenizerProviderHint,
): number {
  if (typeof block === "string") {
    return roughTokenCountEstimationForProvider(block, hint);
  }
  if (!isRecord(block)) {
    return roughTokenCountEstimationForProvider(safeJsonStringify(block), hint);
  }
  const type = typeof block.type === "string" ? block.type : "";
  switch (type) {
    case "text":
      return roughTokenCountEstimationForProvider(
        typeof block.text === "string" ? block.text : "",
        hint,
      );
    case "image":
    case "image_url":
    case "input_image":
    case "document":
      return 2000;
    case "tool_result":
      return roughTokenCountEstimationForContent(
        block.content as TokenEstimationContent,
        hint,
      );
    case "tool_use":
      return roughTokenCountEstimationForProvider(
        `${typeof block.name === "string" ? block.name : ""}${safeJsonStringify(
          block.input ?? {},
        )}`,
        hint,
      );
    case "thinking":
      return roughTokenCountEstimationForProvider(
        typeof block.thinking === "string" ? block.thinking : "",
        hint,
      );
    case "redacted_thinking":
      return roughTokenCountEstimationForProvider(
        typeof block.data === "string" ? block.data : "",
        hint,
      );
    default:
      return roughTokenCountEstimationForProvider(
        safeJsonStringify(block),
        hint,
      );
  }
}

function matchesModel(config: ModelTokenizerConfig, model: string): boolean {
  const lower = model.toLowerCase();
  if (lower.includes(config.modelFamily)) return true;
  return config.modelMatchers.some((matcher) => matcher.test(model));
}

function normalizeFileExtension(fileExtension: string): string {
  return fileExtension.trim().toLowerCase().replace(/^\./, "");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
