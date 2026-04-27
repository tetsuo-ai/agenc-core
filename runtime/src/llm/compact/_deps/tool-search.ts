/**
 * Tool-search helpers consumed by compact for two related invariants:
 *
 *   1. extractDiscoveredToolNames — preserve the set of dynamically
 *      discovered tool names across a compaction boundary so the
 *      post-compact model still knows what was loaded.
 *   2. isToolSearchEnabled / isToolSearchEnabledOptimistic — decide
 *      whether the post-compact tools list should include
 *      `ToolSearchTool` + MCP tools with deferred-loading semantics.
 *
 * Compared to the upstream AgenC / claude-code helpers, the gut
 * runtime is in a different state:
 *
 *   - The gut runtime DOES have a `tool_search` subsystem (see
 *     `src/tools/router.ts`, `src/tools/context.ts` — variant kind
 *     `tool_search` / `tool_search_output`) but that path produces
 *     opaque `tools[]` payloads on the runtime ToolOutput layer, NOT
 *     Anthropic-style `tool_reference` content blocks inside
 *     `tool_result` blocks. The compact subsystem operates on the
 *     AgenC `Message` shape (Anthropic content-block arrays),
 *     where `tool_reference` is the canonical discovery marker.
 *
 *   - The gut runtime's LLM providers do NOT understand the Anthropic
 *     `defer_loading: true` tool flag or the `tool_reference` content
 *     block. Returning `true` from isToolSearchEnabled inside compact
 *     would simply inflate the tools list sent to providers without
 *     any deferral happening server-side.
 *
 * What that means concretely:
 *
 *   - `extractDiscoveredToolNames` is a real implementation that
 *     mirrors upstream: it reads the carry-forward set off
 *     `compact_boundary` markers AND scans `tool_result` blocks for
 *     embedded `tool_reference` items. The carry-forward path is the
 *     one that matters today — it preserves the discovered set across
 *     repeated compactions. The `tool_reference` scan stays in place
 *     so any future emission of those blocks (e.g. when a real
 *     deferred-loading subsystem lands) is picked up automatically.
 *
 *   - `isToolSearchEnabled` and `isToolSearchEnabledOptimistic` honor
 *     the upstream env-var contract (`ENABLE_TOOL_SEARCH`,
 *     `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) and the model-support
 *     check (haiku models do not support `tool_reference`). They also
 *     check that `ToolSearchTool` is actually present in the tools
 *     list (matching upstream's `isToolSearchToolAvailable` gate).
 *     Because the gut runtime does not yet have the underlying
 *     deferred-loading infrastructure end to end, the env default is
 *     OFF (upstream defaults to ON). Operators can opt in by setting
 *     `ENABLE_TOOL_SEARCH=true` if they have wired a provider that
 *     understands the upstream defer/tool_reference contract.
 */

interface MessageLike {
  readonly type?: string;
  readonly subtype?: string;
  readonly compactMetadata?: {
    readonly preCompactDiscoveredTools?: ReadonlyArray<string>;
  };
  readonly message?: { readonly content?: unknown };
  readonly content?: unknown;
}

interface ToolLike {
  readonly name: string;
}

const TOOL_SEARCH_TOOL_NAME = "ToolSearch";
const DEFAULT_UNSUPPORTED_MODEL_PATTERNS = ["haiku"] as const;

/**
 * Match upstream `isEnvTruthy` exactly (claude utils/envUtils.ts):
 * accepts `1`, `true`, `yes`, `on` (case-insensitive) as truthy.
 */
function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * Match upstream `isEnvDefinedFalsy` (claude utils/envUtils.ts): only
 * fires when the env var is set to a recognized falsy value, NOT when
 * it is unset.
 */
function isEnvDefinedFalsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase().trim();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

/**
 * Mirror upstream `modelSupportsToolReference` — negative test against a
 * known list of model patterns that do not support tool_reference. New
 * models are assumed to support it.
 */
function modelSupportsToolReference(model: string): boolean {
  const normalized = model.toLowerCase();
  for (const pattern of DEFAULT_UNSUPPORTED_MODEL_PATTERNS) {
    if (normalized.includes(pattern)) return false;
  }
  return true;
}

/**
 * Mirror upstream `isToolSearchToolAvailable`: tool search cannot
 * function without the ToolSearchTool actually being in the tools
 * list.
 */
function isToolSearchToolAvailable(
  tools: ReadonlyArray<ToolLike> | undefined,
): boolean {
  if (!tools) return false;
  return tools.some((tool) => tool?.name === TOOL_SEARCH_TOOL_NAME);
}

/**
 * Type guard for `tool_result` blocks with array content. Matches the
 * shape upstream extracts from when ToolSearchTool returns multiple
 * `tool_reference` items.
 */
function isToolResultBlockWithArrayContent(
  obj: unknown,
): obj is { type: "tool_result"; content: unknown[] } {
  if (typeof obj !== "object" || obj === null) return false;
  const candidate = obj as { type?: unknown; content?: unknown };
  return (
    candidate.type === "tool_result" && Array.isArray(candidate.content)
  );
}

/**
 * Type guard for a `tool_reference` block carrying a `tool_name`
 * string.
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: "tool_reference"; tool_name: string } {
  if (typeof obj !== "object" || obj === null) return false;
  const candidate = obj as { type?: unknown; tool_name?: unknown };
  return (
    candidate.type === "tool_reference" &&
    typeof candidate.tool_name === "string"
  );
}

/**
 * Walk message history and collect the set of dynamically discovered
 * tool names so the post-compact context still knows what was loaded.
 *
 * Two sources are merged:
 *
 *   1. `compact_boundary` markers carry `compactMetadata.preCompactDiscoveredTools`.
 *      This is the load-bearing path for repeated compactions: every
 *      compact snapshots the current set into the boundary it creates,
 *      and a later compact reads it back from prior boundaries to
 *      preserve continuity even though the underlying messages have
 *      been summarized away.
 *
 *   2. `tool_result` blocks whose array content includes `tool_reference`
 *      items. This is the upstream emission shape when ToolSearchTool
 *      returns discovered tools. The gut runtime does not currently
 *      emit these blocks itself, but supporting the shape keeps this
 *      helper forward-compatible with any future discovery emission
 *      and with upstream-formatted message histories.
 */
export function extractDiscoveredToolNames(
  messages: ReadonlyArray<MessageLike>,
): Set<string> {
  const discovered = new Set<string>();

  for (const msg of messages) {
    // Source 1: carry-forward from prior compact boundaries.
    if (msg?.type === "system" && msg.subtype === "compact_boundary") {
      const carried = msg.compactMetadata?.preCompactDiscoveredTools;
      if (carried) {
        for (const name of carried) discovered.add(name);
      }
      continue;
    }

    // Source 2: tool_reference items inside tool_result blocks. Only
    // user messages can contain tool_result blocks (they are responses
    // to assistant tool_use blocks).
    if (msg?.type !== "user") continue;

    const content = msg.message?.content ?? msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isToolResultBlockWithArrayContent(block)) continue;
      for (const item of block.content) {
        if (isToolReferenceWithName(item)) {
          discovered.add(item.tool_name);
        }
      }
    }
  }

  return discovered;
}

/**
 * Decide whether the upstream tool-search mode is engaged. Returns
 * false unless the operator has explicitly opted in via env var.
 *
 * Default OFF rationale: the gut runtime providers do not implement
 * the Anthropic deferred-loading + `tool_reference` contract, so
 * advertising tools as deferred would simply send the full schema
 * inline (no deferral happens). Until the gut providers grow the
 * upstream defer/tool_reference handling, the safe answer is "no".
 *
 * Operators can set `ENABLE_TOOL_SEARCH=true` to opt in if they have
 * wired a provider that understands the upstream contract end to
 * end. The kill switch `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true`
 * always wins.
 */
export async function isToolSearchEnabled(
  model?: string,
  tools?: ReadonlyArray<ToolLike>,
  ..._rest: unknown[]
): Promise<boolean> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return false;
  }

  const enableValue = process.env.ENABLE_TOOL_SEARCH;
  if (isEnvDefinedFalsy(enableValue)) return false;
  if (!isEnvTruthy(enableValue)) {
    // Gut default: tool search is off unless explicitly enabled.
    return false;
  }

  if (model && !modelSupportsToolReference(model)) return false;
  if (tools && !isToolSearchToolAvailable(tools)) return false;

  return true;
}

/**
 * Synchronous optimistic gate. Used at sites that want to know "could
 * tool search be on?" before the full async check. Mirrors the
 * upstream env-only fast path.
 */
export function isToolSearchEnabledOptimistic(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return false;
  }
  const enableValue = process.env.ENABLE_TOOL_SEARCH;
  if (isEnvDefinedFalsy(enableValue)) return false;
  return isEnvTruthy(enableValue);
}
