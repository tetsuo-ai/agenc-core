/**
 * Compresses old tool_result content for stateless OpenAI-compatible providers
 * (Copilot, Mistral, Ollama). Preserves all conversation structure — tool_use,
 * tool_result pairing, text, thinking, and is_error all survive intact. Only
 * the BULK text of older tool_results is shrunk to delay context saturation.
 *
 * Tier sizes scale with the model's effective context window via
 * getEffectiveContextWindowSize() — same calculation used by auto-compact, so
 * the two systems stay aligned.
 *
 * Complements (does not replace) microCompact.ts:
 * - microCompact: time/cache-based, runs from query.ts, binary clear/keep,
 *   limited to AgenC (cache editing) or idle gaps (time-based).
 * - compressToolHistory: size-based, runs at the shim layer, tiered
 *   compression, covers the gap for active sessions on non-AgenC providers.
 *
 * Reuses isCompactableTool from microCompact to avoid touching tools the
 * project already classifies as unsafe to compress (e.g. Task, Agent).
 * Skips blocks already cleared by microCompact (TOOL_RESULT_CLEARED_MESSAGE).
 *
 * Anthropic native bypasses both shims, so it is unaffected by this module.
 */
const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

// Mid-tier truncation budget. 2k chars ≈ 500 tokens, enough to preserve the
// shape of most tool outputs (file headers, command stderr, top grep hits)
// without ballooning context. Bump too high and the tier loses its purpose.
const MID_MAX_CHARS = 2_000

// Stub args budget. JSON.stringify of a typical tool input fits in 200 chars
// (file paths, short commands, small queries). Long inputs are rare and clamping
// here keeps the stub size bounded even when callers pass oversized arguments.
const STUB_ARGS_MAX_CHARS = 200
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000
const MCP_TOOL_PREFIX = 'mcp__'

const COMPACTABLE_TOOLS = new Set<string>([
  'Read',
  'Bash',
  'PowerShell',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Edit',
  'Write',
])

type AnyMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

type Tiers = { recent: number; mid: number }

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function positiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function contextWindowForModel(model: string): number {
  const envWindow = positiveIntegerEnv(process.env.AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW)
  if (envWindow !== undefined) return envWindow

  const name = model.toLowerCase()
  if (name.includes('[1m]')) return 1_000_000
  if (name.includes('gpt-4.1') || name.includes('gpt-5')) return 1_000_000
  if (name.includes('gemini-1.5-pro') || name.includes('gemini-2.5')) return 1_000_000
  if (name.includes('claude') && name.includes('sonnet-4')) return 200_000
  if (name.includes('gpt-4o') || name.includes('gpt-4')) return 128_000
  if (name.includes('mistral') || name.includes('mixtral')) return 128_000
  return DEFAULT_CONTEXT_WINDOW
}

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    positiveIntegerEnv(process.env.AGENC_MAX_OUTPUT_TOKENS) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const contextWindow = contextWindowForModel(model)
  const effectiveContext = contextWindow - reservedTokensForSummary
  return Math.max(
    effectiveContext,
    reservedTokensForSummary + AUTOCOMPACT_BUFFER_TOKENS,
  )
}

function isCompactableTool(name: string): boolean {
  return COMPACTABLE_TOOLS.has(name) || name.startsWith(MCP_TOOL_PREFIX)
}

// Tier sizes scale with effective window. Targets roughly:
// - recent tier stays under ~25% of available window (full fidelity kept)
// - recent + mid tier stays under ~50% of available window (bounded bulk)
// - everything older collapses to ~15-token stubs
// Values assume ~5KB avg tool_result, which matches the Copilot default case
// (parallel_tool_calls=true means multiple Read/Bash outputs per turn). For
// ≥ 500k models the tiers are so generous that compression is effectively
// inert for any realistic session — see compressToolHistory.test.ts.
export function getTiers(effectiveWindow: number): Tiers {
  if (effectiveWindow < 16_000) return { recent: 2, mid: 3 }
  if (effectiveWindow < 32_000) return { recent: 3, mid: 5 }
  if (effectiveWindow < 64_000) return { recent: 4, mid: 8 }
  if (effectiveWindow < 128_000) return { recent: 5, mid: 10 }
  if (effectiveWindow < 256_000) return { recent: 8, mid: 15 }
  if (effectiveWindow < 500_000) return { recent: 12, mid: 25 }
  return { recent: 25, mid: 50 }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: { type?: string; text?: string }) =>
          b?.type === 'text' && typeof b.text === 'string',
      )
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n')
  }
  return ''
}

// Old-tier compression strategy. Replaces content entirely with a one-line
// metadata marker ~10× more token-efficient than a 500-char truncation AND
// unambiguous — partial truncations can look authoritative to the model. The
// stub format encodes tool name + args so the model can re-invoke the same
// tool if it needs the omitted output back.
function buildStub(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
): ToolResultBlock {
  const original = extractText(block.content)
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  const name = toolUse?.name ?? 'tool'
  const args = toolUse?.input
    ? JSON.stringify(toolUse.input).slice(0, STUB_ARGS_MAX_CHARS)
    : '{}'
  return {
    ...block,
    content: [
      {
        type: 'text',
        text: `[${name} args=${args} → ${original.length} chars omitted]`,
      },
    ],
  }
}

// Mid-tier compression. The trailing marker is load-bearing: without it, the
// model can't distinguish "tool returned 2000 chars" from "tool returned 20k
// chars that we cut to 2000". Distinguishing those matters for the model's
// decision to re-invoke the tool.
function truncateBlock(
  block: ToolResultBlock,
  maxChars: number,
): ToolResultBlock {
  const text = extractText(block.content)
  if (text.length <= maxChars) return block
  const omitted = text.length - maxChars
  return {
    ...block,
    content: [
      {
        type: 'text',
        text: `${text.slice(0, maxChars)}\n[…truncated ${omitted} chars from tool history]`,
      },
    ],
  }
}

function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return (msg.message ?? msg) as { role?: string; content?: unknown }
}

function indexToolUses(messages: AnyMessage[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>()
  for (const msg of messages) {
    const content = getInner(msg).content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string; id?: string }>) {
      if (b?.type === 'tool_use' && b.id) {
        map.set(b.id, b as ToolUseBlock)
      }
    }
  }
  return map
}

function indexToolResultMessages(messages: AnyMessage[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const inner = getInner(messages[i])
    const role = inner.role ?? messages[i].role
    const content = inner.content
    if (
      role === 'user' &&
      Array.isArray(content) &&
      content.some((b: { type?: string }) => b?.type === 'tool_result')
    ) {
      indices.push(i)
    }
  }
  return indices
}

function rewriteMessage<T extends AnyMessage>(
  msg: T,
  newContent: unknown[],
): T {
  if (msg.message) {
    return { ...msg, message: { ...msg.message, content: newContent } }
  }
  return { ...msg, content: newContent }
}

// microCompact.maybeTimeBasedMicrocompact may have already replaced old
// tool_result content with TOOL_RESULT_CLEARED_MESSAGE before we see it.
// Re-compressing produces a stub over a marker (e.g. `[Read args={} → 40
// chars omitted]`), wasteful and less informative than the canonical marker.
function isAlreadyCleared(block: ToolResultBlock): boolean {
  const text = extractText(block.content)
  return text === TOOL_RESULT_CLEARED_MESSAGE
}

function shouldCompressBlock(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
): boolean {
  if (isAlreadyCleared(block)) return false
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  // Unknown tool name (orphan tool_result with no matching tool_use) falls
  // through to compression with a generic "tool" stub. Safer default: the
  // original tool_use vanished so there's no downstream use for the output.
  if (!toolUse?.name) return true
  // Respect microCompact's curated safe-to-compress set (Read/Bash/Grep/…/
  // mcp__*) so user-facing flow tools (Task, Agent, custom) stay intact.
  return isCompactableTool(toolUse.name)
}

export function compressToolHistory<T extends AnyMessage>(
  messages: T[],
  model: string,
): T[] {
  // Master kill-switch. Returns the original reference so callers skip a
  // defensive copy when the feature is disabled.
  if (
    isTruthyEnv(process.env.DISABLE_TOOL_HISTORY_COMPRESSION) ||
    isTruthyEnv(process.env.AGENC_DISABLE_TOOL_HISTORY_COMPRESSION)
  ) {
    return messages
  }

  const tiers = getTiers(getEffectiveContextWindowSize(model))

  const toolResultIndices = indexToolResultMessages(messages)
  const total = toolResultIndices.length
  // If every tool-result fits in the recent tier, no boundary crosses; return
  // the same reference for the same copy-elision reason.
  if (total <= tiers.recent) return messages

  // O(1) lookup: messageIndex → tool-result position (0 = oldest). Replaces
  // the naive Array.indexOf(i) that was O(n²) across the .map below.
  const positionByIndex = new Map<number, number>()
  for (let pos = 0; pos < toolResultIndices.length; pos++) {
    positionByIndex.set(toolResultIndices[pos], pos)
  }

  const toolUsesById = indexToolUses(messages)

  return messages.map((msg, i) => {
    const pos = positionByIndex.get(i)
    if (pos === undefined) return msg

    const fromEnd = total - 1 - pos
    if (fromEnd < tiers.recent) return msg

    const inMidWindow = fromEnd < tiers.recent + tiers.mid
    const content = getInner(msg).content as unknown[]
    const newContent = content.map(block => {
      const b = block as { type?: string }
      if (b?.type !== 'tool_result') return block
      const tr = block as ToolResultBlock
      if (!shouldCompressBlock(tr, toolUsesById)) return block
      return inMidWindow
        ? truncateBlock(tr, MID_MAX_CHARS)
        : buildStub(tr, toolUsesById)
    })

    return rewriteMessage(msg, newContent)
  })
}
