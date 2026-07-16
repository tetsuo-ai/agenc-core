/**
 * Source-aligned with `src/services/toolUseSummary/toolUseSummaryGenerator.ts`
 * at donor commit 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC accepts an explicit `LLMProvider` instead of importing a global
 *     provider helper.
 *   - Error logging is injected as a callback so SDK/daemon callers can route
 *     structured failures through their own event surfaces.
 */

import type { LLMProvider } from "../../llm/types.js";
import { safeStringify } from "../../tools/types.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../../tools/untrusted-tool-result-framing.js";

export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344;

export const TOOL_USE_SUMMARY_DEFAULT_MODEL =
  "claude-haiku-4-5"; // branding-scan: allow documented Anthropic API model identifier

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`;

const TOOL_SUMMARY_JSON_LIMIT = 300;
const LAST_ASSISTANT_TEXT_LIMIT = 200;
const TOOL_USE_SUMMARY_MAX_OUTPUT_TOKENS = 64;
const TOOL_USE_SUMMARY_QUERY_SOURCE = "tool_use_summary_generation";

export type ToolUseSummaryToolInfo = {
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
};

export type ToolUseSummaryErrorRecord = {
  readonly errorId: typeof E_TOOL_USE_SUMMARY_GENERATION_FAILED;
  readonly error: Error;
};

export type ToolUseSummaryErrorLogger = (
  record: ToolUseSummaryErrorRecord,
) => void;

export type GenerateToolUseSummaryParams = {
  readonly tools: readonly ToolUseSummaryToolInfo[];
  readonly signal: AbortSignal;
  readonly isNonInteractiveSession: boolean;
  readonly provider: Pick<LLMProvider, "chat">;
  readonly lastAssistantText?: string;
  readonly model?: string;
  readonly logError?: ToolUseSummaryErrorLogger;
};

export function truncateToolUseSummaryJson(
  value: unknown,
  maxLength = TOOL_SUMMARY_JSON_LIMIT,
): string {
  try {
    const serialized = safeStringify(value) ?? String(value);
    if (serialized.length <= maxLength) {
      return serialized;
    }
    return `${serialized.slice(0, Math.max(0, maxLength - 3))}...`;
  } catch {
    return "[unable to serialize]";
  }
}

export function buildToolUseSummaryPrompt(
  tools: readonly ToolUseSummaryToolInfo[],
  lastAssistantText?: string,
): string {
  const toolSummaries = tools
    .map((tool) => {
      const input = truncateToolUseSummaryJson(tool.input);
      const output = truncateToolUseSummaryJson(tool.output);
      const framedOutput = frameUntrustedToolResultContent(
        tool.name,
        output,
        classifyUntrustedToolResult(tool.name),
      );
      if (typeof framedOutput !== "string") {
        throw new Error("tool-use summary text framing returned non-text content");
      }
      return `Tool: ${tool.name}\nInput: ${input}\nOutput:\n${framedOutput}`;
    })
    .join("\n\n");

  const intent = lastAssistantText
    ? `User's intent (from assistant's last message): ${lastAssistantText.slice(
        0,
        LAST_ASSISTANT_TEXT_LIMIT,
      )}\n\n`
    : "";

  return `${intent}Tools completed:\n\n${toolSummaries}\n\nLabel:`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function logGenerationFailure(
  error: unknown,
  logError: ToolUseSummaryErrorLogger | undefined,
): void {
  const err = toError(error) as Error & { cause?: unknown };
  err.cause = { errorId: E_TOOL_USE_SUMMARY_GENERATION_FAILED };
  const record: ToolUseSummaryErrorRecord = {
    errorId: E_TOOL_USE_SUMMARY_GENERATION_FAILED,
    error: err,
  };
  if (logError) {
    logError(record);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(record);
}

export async function generateToolUseSummary({
  tools,
  signal,
  isNonInteractiveSession,
  provider,
  lastAssistantText,
  model = TOOL_USE_SUMMARY_DEFAULT_MODEL,
  logError,
}: GenerateToolUseSummaryParams): Promise<string | null> {
  if (tools.length === 0) {
    return null;
  }

  try {
    const response = await provider.chat(
      [
        {
          role: "user",
          content: buildToolUseSummaryPrompt(tools, lastAssistantText),
        },
      ],
      {
        model,
        systemPrompt: TOOL_USE_SUMMARY_SYSTEM_PROMPT,
        signal,
        maxOutputTokens: TOOL_USE_SUMMARY_MAX_OUTPUT_TOKENS,
        promptCacheKey: isNonInteractiveSession
          ? `${TOOL_USE_SUMMARY_QUERY_SOURCE}:non_interactive`
          : TOOL_USE_SUMMARY_QUERY_SOURCE,
        tools: [],
        toolChoice: "none",
        parallelToolCalls: false,
      },
    );

    const summary = response.content.trim();
    return summary.length > 0 ? summary : null;
  } catch (error) {
    logGenerationFailure(error, logError);
    return null;
  }
}
