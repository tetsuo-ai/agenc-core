/**
 * Local enforcement of AgenC toolChoice against Ollama's native chat API.
 *
 * `/api/chat` accepts a tools list but has no tool_choice field and no
 * versioned capability that would let AgenC treat required as a checked
 * contract. Constraints we can honor locally are applied here; the rest
 * fail before the request.
 *
 * @module
 */

import type { LLMTool, LLMToolCall, LLMToolChoice } from "../../types.js";
import { LLMInvalidResponseError, LLMProviderError } from "../../errors.js";
import {
  createOllamaToolNameProjection,
  type OllamaToolNameProjection,
} from "./tool-naming.js";

export type OllamaRequestedToolChoice =
  | "auto"
  | "required"
  | "none"
  | `function:${string}`;

export type OllamaEffectiveToolChoice = "auto" | "none" | `function:${string}`;

export interface OllamaToolChoiceResolution {
  readonly requested: OllamaRequestedToolChoice;
  readonly effective: OllamaEffectiveToolChoice;
  readonly advertisedWireTools: readonly LLMTool[];
  readonly advertisedNames: OllamaToolNameProjection;
  readonly toolSuppressionReason?: "tool_choice_none";
}

function ollamaToolChoiceKind(
  toolChoice: LLMToolChoice | undefined,
): "auto" | "none" | "required" | "function" {
  if (toolChoice === undefined || toolChoice === "auto") {
    return "auto";
  }

  if (toolChoice === "none") {
    return "none";
  }

  if (toolChoice === "required") {
    return "required";
  }

  // The remaining LLMToolChoice variant is the named function choice.
  // TypeScript 6 does not narrow that object union to `never` here.
  return "function";
}

export function summarizeOllamaRequestedToolChoice(
  toolChoice: LLMToolChoice | undefined,
): OllamaRequestedToolChoice {
  const kind = ollamaToolChoiceKind(toolChoice);
  switch (kind) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "function":
      return `function:${(toolChoice as { name: string }).name}`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function emptyAdvertisedNames(): OllamaToolNameProjection {
  return createOllamaToolNameProjection([]);
}

function advertisedSubset(
  names: OllamaToolNameProjection,
  canonicalName: string,
): OllamaToolNameProjection {
  const index = names.canonicalTools.findIndex(
    (tool) => tool.function.name === canonicalName,
  );
  if (index < 0) {
    throw new LLMProviderError(
      "ollama",
      `toolChoice references unavailable tool: ${canonicalName}`,
    );
  }
  const canonical = names.canonicalTools[index];
  if (canonical === undefined) {
    throw new LLMProviderError(
      "ollama",
      `toolChoice references unavailable tool: ${canonicalName}`,
    );
  }
  return createOllamaToolNameProjection([canonical]);
}

/**
 * Resolve the caller's toolChoice into the tools Ollama may see and the
 * catalog used to validate the response. `required` is rejected: native
 * Ollama chat has no checked tool-choice contract.
 */
export function resolveOllamaToolChoice(
  toolChoice: LLMToolChoice | undefined,
  names: OllamaToolNameProjection,
): OllamaToolChoiceResolution {
  const kind = ollamaToolChoiceKind(toolChoice);
  switch (kind) {
    case "auto":
      return {
        requested: "auto",
        effective: "auto",
        advertisedWireTools: names.wireTools,
        advertisedNames: names,
      };
    case "none":
      return {
        requested: "none",
        effective: "none",
        advertisedWireTools: [],
        advertisedNames: emptyAdvertisedNames(),
        toolSuppressionReason: "tool_choice_none",
      };
    case "required":
      throw new LLMProviderError(
        "ollama",
        "unsupported provider capability: native chat API does not expose tool_choice, so toolChoice=required cannot be enforced. Use auto, none, or a specific function.",
      );
    case "function": {
      const canonicalName = (toolChoice as { name: string }).name.trim();
      if (canonicalName.length === 0) {
        throw new LLMProviderError(
          "ollama",
          "toolChoice references unavailable tool: (empty name)",
        );
      }
      const advertisedNames = advertisedSubset(names, canonicalName);
      return {
        requested: `function:${canonicalName}`,
        effective: `function:${canonicalName}`,
        advertisedWireTools: advertisedNames.wireTools,
        advertisedNames,
      };
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Honor constraints after the provider returns. `none` must not yield tool
 * calls. A specific function must appear in the (already catalog-constrained)
 * response.
 */
export function assertOllamaToolChoiceResponse(
  resolution: OllamaToolChoiceResolution,
  toolCalls: readonly LLMToolCall[],
): void {
  const effective = resolution.effective;
  if (effective === "auto") {
    return;
  }
  if (effective === "none") {
    if (toolCalls.length > 0) {
      throw new LLMInvalidResponseError(
        "ollama",
        "toolChoice=none forbids tool calls, but the response contained one or more",
      );
    }
    return;
  }
  const expected = effective.slice("function:".length);
  if (!toolCalls.some((call) => call.name === expected)) {
    throw new LLMInvalidResponseError(
      "ollama",
      `toolChoice required function ${expected}, but the response did not call it`,
    );
  }
}
