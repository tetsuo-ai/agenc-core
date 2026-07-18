import type provider from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import { AdmissionDeniedError } from '../budget/admission-client.js'
import type { QuerySource } from '../constants/querySource.js'

type MessageParam = provider.MessageParam
type TextBlockParam = provider.TextBlockParam
type Tool = provider.Tool
type ToolChoice = provider.ToolChoice
type BetaMessage = provider.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = provider.Beta.Messages.BetaJSONOutputFormat

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /** System prompt for the internal classifier/query. */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks). */
  messages: MessageParam[]
  /** Optional tools (including beta custom tool types). */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional forced tool choice. */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses. */
  output_format?: BetaJSONOutputFormat
  /** Requested output bound. */
  max_tokens?: number
  /** Legacy retry setting retained for call-site type compatibility. */
  maxRetries?: number
  signal?: AbortSignal
  skipSystemPromptPrefix?: boolean
  temperature?: number
  thinking?: number | false
  stop_sequences?: string[]
  querySource: QuerySource
}

/**
 * Legacy side queries called the provider SDK directly and therefore could
 * not reserve/reconcile through the daemon-owned execution-admission kernel.
 * Fail before constructing a provider client. Callers must use an admitted
 * model surface or apply their conservative local fallback.
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  void opts
  throw new AdmissionDeniedError('legacy_side_query_model_path_disabled')
}
