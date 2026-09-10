import type { LLMMessage, LLMTool, LLMToolCall } from "../../types.js";
import {
  createProviderToolNameWireLookup,
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "../../wire/mcp-tool-naming.js";

export interface OllamaToolNameProjection {
  /** Original schemas, before any provider-only grammar normalization. */
  readonly canonicalTools: readonly LLMTool[];
  /** Only names differ; parameter schemas retain their original contract. */
  readonly wireTools: LLMTool[];
  /** Exact canonical names plus their explicit MCP wire aliases for validation. */
  readonly salvageTools: LLMTool[];
  readonly toCanonicalName: (wireName: string) => string | undefined;
  readonly canonicalizeToolCall: (call: LLMToolCall) => LLMToolCall | null;
}

/**
 * Capture precisely the tools selected for one request. Accept only exact
 * canonical names or their explicit MCP aliases. Reversible syntax alone is
 * not execution authority. Ollama permits non-MCP names such as system.searchTools.
 */
export function createOllamaToolNameProjection(
  selectedTools: readonly LLMTool[],
): OllamaToolNameProjection {
  const canonicalTools = [...selectedTools];
  const canonicalNames = canonicalTools.map((tool) => tool.function.name);
  const mcpNames = canonicalNames.filter((name) => name.startsWith("mcp."));
  if (new Set(canonicalNames).size !== canonicalNames.length) {
    throw new Error("Ollama request has duplicate canonical tool names");
  }
  const wireLookup = ollamaWireLookup(canonicalNames);
  const lookup = new Map(wireLookup);
  for (const name of canonicalNames) addName(lookup, name, name);
  const wireTools = canonicalTools.map((tool): LLMTool => ({
    ...tool,
    function: { ...tool.function, name: ollamaWireName(tool.function.name) },
  }));
  const salvageTools = [
    ...canonicalTools,
    ...wireTools.filter((tool) => !canonicalNames.includes(tool.function.name)),
  ];
  const toCanonicalName = (wireName: string): string | undefined => {
    const canonicalName = lookup.get(wireName);
    if (canonicalName === undefined) return undefined;
    // A registry tool can itself have a reserved-looking, wire-safe name.
    // The exact request lookup, not syntactic decoding, owns that identity.
    if (canonicalName === wireName) return canonicalName;
    return decodeMcpToolNameFromWire(wireName, mcpNames) === canonicalName
      ? canonicalName
      : undefined;
  };
  return {
    canonicalTools,
    wireTools,
    salvageTools,
    toCanonicalName,
    canonicalizeToolCall(call) {
      const name = toCanonicalName(call.name);
      return name === undefined ? null : { ...call, name };
    },
  };
}

function ollamaWireName(name: string): string {
  return name.startsWith("mcp.") ? encodeMcpToolNameForWire(name) : name;
}

function addName(lookup: Map<string, string>, alias: string, canonical: string): void {
  if (alias.length === 0) throw new Error("Ollama tool name must not be empty");
  const prior = lookup.get(alias);
  if (prior !== undefined && prior !== canonical) {
    throw new Error("Ollama request has a provider tool-name collision");
  }
  lookup.set(alias, canonical);
}

function ollamaWireLookup(canonicalNames: readonly string[]): ReadonlyMap<string, string> {
  // Shared validation owns MCP encoding, including long hashed names. Do not
  // apply strict-provider escaping to Ollama's ordinary dotted builtin names.
  const mcpLookup = createProviderToolNameWireLookup(canonicalNames.filter(name => name.startsWith("mcp.")));
  const lookup = new Map<string, string>(mcpLookup);
  for (const name of canonicalNames) addName(lookup, ollamaWireName(name), name);
  return lookup;
}

/** Historical calls keep their identities/arguments in a provider-only projection. */
export function projectOllamaHistoryToolNames(
  messages: readonly LLMMessage[],
): LLMMessage[] {
  const names = messages.flatMap((message) => [
    ...(message.toolCalls ?? []).map((call) => call.name),
    ...(message.toolName === undefined ? [] : [message.toolName]),
  ]);
  ollamaWireLookup(names);
  return messages.flatMap((message): LLMMessage[] => {
    const projected: LLMMessage = {
      ...message,
      ...(message.toolCalls === undefined ? {} : {
        toolCalls: message.toolCalls.map((call) => ({
          ...call, name: ollamaWireName(call.name),
        })),
      }),
      ...(message.toolName === undefined ? {} : {
        toolName: ollamaWireName(message.toolName),
      }),
    };
    // Some native templates render Content ELSE ToolCalls, silently losing
    // mixed-message calls. Keep prose before an empty-content call message so
    // both survive; the shared accounting/wire projection owns this split.
    // Runtime metadata stays on the original call carrier, not a second copy.
    if (projected.role === "assistant" && (projected.toolCalls?.length ?? 0) > 0) {
      const callMessage = { ...projected, content: "" };
      return projected.content.length > 0
        ? [{ role: "assistant", content: projected.content }, callMessage]
        : [callMessage];
    }
    return [projected];
  });
}
