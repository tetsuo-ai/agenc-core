import { APIError } from '@anthropic-ai/sdk'
import { buildproviderUsageFromRawUsage } from './cacheMetrics.js'
import { compressToolHistory } from './compressToolHistory.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import { stableStringify } from '../../utils/stableStringify.js'
import { isRecord } from '../../utils/record.js'
import type {
  ResolvedProviderCodeCredentials,
  ResolvedProviderRequest,
} from './providerConfig.js'
import { sanitizeSchemaForOpenAiCompat } from '../../utils/schemaSanitizer.js'
import { normalizeToolParamSchema } from '../../utils/toolParamSchema.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from './thinkTagSanitizer.js'

export interface providerUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface providerStreamEvent {
  type: string
  message?: Record<string, unknown>
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: Partial<providerUsage>
}

export interface ShimCreateParams {
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: Array<Record<string, unknown>>
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  tool_choice?: unknown
  metadata?: unknown
  [key: string]: unknown
}

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: ResponsesInputPart[]
    }
  | {
      type: 'function_call'
      id: string
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

type ResponsesTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

type ResponsesSseEvent = {
  event: string
  data: Record<string, unknown>
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key]
  return isRecord(field) ? field : undefined
}

function arrayField(
  value: Record<string, unknown> | undefined,
  key: string,
): readonly unknown[] {
  const field = value?.[key]
  return Array.isArray(field) ? field : []
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function messageField(value: Record<string, unknown> | undefined): string | undefined {
  return stringField(value, 'message')
}

function parseProviderCodeSseChunk(chunk: string): ResponsesSseEvent | undefined {
  const lines = chunk
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined

  const eventLine = lines.find(line => line.startsWith('event: '))
  const dataLines = lines.filter(line => line.startsWith('data: '))
  if (!eventLine || dataLines.length === 0) return undefined

  const event = eventLine.slice(7).trim()
  const rawData = dataLines.map(line => line.slice(6)).join('\n')
  if (rawData === '[DONE]') return undefined

  try {
    const parsed = JSON.parse(rawData) as unknown
    if (!isRecord(parsed)) return undefined
    return { event, data: parsed }
  } catch {
    return undefined
  }
}

function makeUsage(usage?: Record<string, unknown>): providerUsage {
  // Single source of truth for the internal usage shape. Lives in
  // cacheMetrics.ts alongside the raw-shape extractor so any new
  // provider quirk requires a one-file change and the integration test
  // can call the exact same function instead of re-implementing it.
  return buildproviderUsageFromRawUsage(usage)
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function normalizeToolUseId(toolUseId: string | undefined): {
  id: string
  callId: string
} {
  const value = (toolUseId || '').trim()
  if (!value) {
    return {
      id: 'fc_unknown',
      callId: 'call_unknown',
    }
  }
  if (value.startsWith('call_')) {
    return {
      id: `fc_${value.slice('call_'.length)}`,
      callId: value,
    }
  }
  if (value.startsWith('fc_')) {
    return {
      id: value,
      callId: `call_${value.slice('fc_'.length)}`,
    }
  }
  return {
    id: `fc_${value}`,
    callId: value,
  }
}

function convertSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : '',
      )
      .join('\n\n')
  }
  return String(system)
}

function convertToolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')

  const chunks: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text)
      continue
    }

    if (block?.type === 'image') {
      const src = block.source
      if (src?.type === 'url' && src.url) {
        chunks.push(`[Image](${src.url})`)
      }
      continue
    }

    if (typeof block?.text === 'string') {
      chunks.push(block.text)
    }
  }

  return chunks.join('\n')
}

function convertContentBlocksToResponsesParts(
  content: unknown,
  role: 'user' | 'assistant',
): ResponsesInputPart[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') {
    return [{ type: textType, text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: textType, text: String(content ?? '') }]
  }

  const parts: ResponsesInputPart[] = []
  for (const block of content) {
    switch (block?.type) {
      case 'text':
        parts.push({ type: textType, text: block.text ?? '' })
        break
      case 'image': {
        if (role === 'assistant') break
        const source = block.source
        if (source?.type === 'base64') {
          parts.push({
            type: 'input_image',
            image_url: `data:${source.media_type};base64,${source.data}`,
          })
        } else if (source?.type === 'url' && source.url) {
          parts.push({
            type: 'input_image',
            image_url: source.url,
          })
        }
        break
      }
      case 'thinking':
        if (block.thinking) {
          parts.push({
            type: textType,
            text: `<thinking>${block.thinking}</thinking>`,
          })
        }
        break
      case 'tool_use':
      case 'tool_result':
        break
      default:
        if (typeof block?.text === 'string') {
          parts.push({ type: textType, text: block.text })
        }
    }
  }

  return parts
}

export function convertproviderMessagesToResponsesInput(
  messages: Array<{ role?: string; message?: { role?: string; content?: unknown }; content?: unknown }>,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  // Pair function_call ↔ function_call_output on the normalized call_id, exactly
  // like the chat-completions path (openaiShim.ts convertMessages). The Responses
  // API (store:false, full replay) 400s on a function_call_output with no matching
  // function_call — and an ESC-interrupt yields a synthetic tool_result with no
  // recorded tool_use. Pre-scan the results so an assistant tool_use is only
  // emitted when a result exists later (or it is the trailing/pending prefill),
  // and a tool_result is only emitted when its call was actually emitted.
  const resultCallIds = new Set<string>()
  for (const message of messages) {
    const inner = message.message ?? message
    const content = (inner as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const block of content) {
        if ((block as { type?: string }).type === 'tool_result') {
          resultCallIds.add(
            normalizeToolUseId((block as { tool_use_id?: string }).tool_use_id).callId,
          )
        }
      }
    }
  }
  const emittedCallIds = new Set<string>()

  messages.forEach((message, index) => {
    const isLast = index === messages.length - 1
    const inner = message.message ?? message
    const role = (inner as { role?: string }).role ?? message.role
    const content = (inner as { content?: unknown }).content

    if (role === 'user') {
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (block: { type?: string }) => block.type === 'tool_result',
        )
        const otherContent = content.filter(
          (block: { type?: string }) => block.type !== 'tool_result',
        )

        for (const toolResult of toolResults) {
          const { callId } = normalizeToolUseId(toolResult.tool_use_id)
          // Drop an orphan output whose call was never emitted (e.g. a synthetic
          // ESC-interrupt result) — emitting it would 400 the request.
          if (!emittedCallIds.has(callId)) {
            continue
          }
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output: (() => {
              const out = convertToolResultToText(toolResult.content)
              return toolResult.is_error ? `Error: ${out}` : out
            })(),
          })
        }

        const parts = convertContentBlocksToResponsesParts(otherContent, 'user')
        if (parts.length > 0) {
          items.push({
            type: 'message',
            role: 'user',
            content: parts,
          })
        }
        return
      }

      items.push({
        type: 'message',
        role: 'user',
        content: convertContentBlocksToResponsesParts(content, 'user'),
      })
      return
    }

    if (role === 'assistant') {
      const textBlocks = Array.isArray(content)
        ? content.filter((block: { type?: string }) =>
            block.type !== 'tool_use' && block.type !== 'thinking')
        : content
      const parts = convertContentBlocksToResponsesParts(textBlocks, 'assistant')
      if (parts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: parts,
        })
      }

      if (Array.isArray(content)) {
        for (const toolUse of content.filter(
          (block: { type?: string }) => block.type === 'tool_use',
        )) {
          const normalized = normalizeToolUseId(toolUse.id)
          // Keep the call only if a matching result exists later in history, or
          // this is the trailing message (a pending call awaiting execution).
          // A non-trailing orphan tool_use would leave a function_call with no
          // output and 400 the request.
          if (!resultCallIds.has(normalized.callId) && !isLast) {
            continue
          }
          emittedCallIds.add(normalized.callId)
          items.push({
            type: 'function_call',
            id: normalized.id,
            call_id: normalized.callId,
            name: toolUse.name ?? 'tool',
            arguments:
              typeof toolUse.input === 'string'
                ? toolUse.input
                : JSON.stringify(toolUse.input ?? {}),
          })
        }
      }
    }
  })

  return items.filter(item =>
    item.type !== 'message' || item.content.length > 0,
  )
}

/**
 * Recursively enforces strict response API constraints on a JSON schema:
 * - Every `object` type gets `additionalProperties: false`
 * - All property keys are listed in `required`
 * - Nested schemas (properties, items, anyOf/oneOf/allOf) are processed too
 */
function enforceStrictSchema(schema: unknown): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAiCompat(schema)

  // The response endpoint rejects JSON Schema's standard `uri` string format.
  // Keep URL validation in the tool layer and send a plain string here.
  if (record.format === 'uri') {
    delete record.format
  }

  if (record.type === 'object') {
    // Structured outputs completely forbid dynamic additionalProperties.
    // They must be set to false unconditionally.
    record.additionalProperties = false

    if (
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
    ) {
      const props = record.properties as Record<string, unknown>

      const enforcedProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(props)) {
        const strictValue = enforceStrictSchema(value)
        // If the resulting schema is an empty object (no properties), structured outputs will likely
        // strip it silently and then complain about a 'required' mismatch if it remains in the required list.
        // E.g. z.record() objects (like AskUserQuestion.answers) lose their schema due to additionalProperties 
        // restrictions. We can safely drop these from the schema sent to the LLM.
        if (
          strictValue &&
          typeof strictValue === 'object' &&
          strictValue.type === 'object' &&
          strictValue.additionalProperties === false &&
          (!strictValue.properties || Object.keys(strictValue.properties).length === 0)
        ) {
          continue
        }
        enforcedProps[key] = strictValue
      }
      record.properties = enforcedProps
      record.required = Object.keys(enforcedProps)
    } else {
      // No properties — empty required array
      record.required = []
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(item => enforceStrictSchema(item))
    } else {
      record.items = enforceStrictSchema(record.items)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(item => enforceStrictSchema(item))
    }
  }

  return record
}

export function convertToolsToResponsesTools(
  tools: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>,
): ResponsesTool[] {
  return tools
    .filter(tool => tool.name && tool.name !== 'ToolSearchTool')
    .map(tool => {
      const rawParameters = tool.input_schema ?? { type: 'object', properties: {} }
      // Guarantee an object root before strict enforcement. Strict
      // OpenAI-compatible providers reject a root-level anyOf/oneOf union with
      // "tool parameter root must be an object type". A union/non-object root
      // is rewritten into a permissive object and sent with strict: false,
      // since its fields are conditional and cannot all be required.
      const { schema: objectRootSchema, strictEligible } =
        normalizeToolParamSchema(rawParameters)

      if (!strictEligible) {
        return {
          type: 'function',
          name: tool.name ?? 'tool',
          description: tool.description ?? '',
          parameters: sanitizeSchemaForOpenAiCompat(objectRootSchema),
          strict: false,
        }
      }

      // Strict response schemas require all properties to be required.
      const parameters = enforceStrictSchema(objectRootSchema)

      return {
        type: 'function',
        name: tool.name ?? 'tool',
        description: tool.description ?? '',
        parameters,
        strict: true,
      }
    })
}

function convertToolChoice(toolChoice: unknown): unknown {
  const choice = toolChoice as { type?: string; name?: string } | undefined
  if (!choice?.type) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) {
    return {
      type: 'function',
      name: choice.name,
    }
  }
  return undefined
}

export async function performProviderCodeRequest(options: {
  request: ResolvedProviderRequest
  credentials: ResolvedProviderCodeCredentials
  params: ShimCreateParams
  defaultHeaders: Record<string, string>
  signal?: AbortSignal
}): Promise<Response> {
  const compressedMessages = compressToolHistory(
    options.params.messages as Array<{
      role?: string
      message?: { role?: string; content?: unknown }
      content?: unknown
    }>,
    options.request.resolvedModel,
  )
  const input = convertproviderMessagesToResponsesInput(compressedMessages)
  const body: Record<string, unknown> = {
    model: options.request.resolvedModel,
    input: input.length > 0
      ? input
      : [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        ],
    store: false,
    stream: true,
  }

  const instructions = convertSystemPrompt(options.params.system)
  if (instructions) {
    body.instructions = instructions
  }

  const toolChoice = convertToolChoice(options.params.tool_choice)
  if (toolChoice) {
    body.tool_choice = toolChoice
  }

  if (options.params.tools && options.params.tools.length > 0) {
    const convertedTools = convertToolsToResponsesTools(
      options.params.tools as Array<{
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
      }>,
    )
    if (convertedTools.length > 0) {
      body.tools = convertedTools
      body.parallel_tool_calls = true
      body.tool_choice ??= 'auto'
    }
  }

  if (options.request.reasoning) {
    body.reasoning = options.request.reasoning
  }

  const isTargetModel =
    options.request.resolvedModel?.toLowerCase().includes('gpt') ||
    options.request.resolvedModel?.toLowerCase().includes('providerCode') // branding-scan: allow real model family id

  // Only pass temperature and top_p if the target model accepts them.
  if (!isTargetModel) {
    if (options.params.temperature !== undefined) {
      body.temperature = options.params.temperature
    }
    if (options.params.top_p !== undefined) {
      body.top_p = options.params.top_p
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
    Authorization: `Bearer ${options.credentials.apiKey}`,
  }
  if (options.credentials.accountId) {
    headers['chatgpt-account-id'] = options.credentials.accountId
  }
  headers.originator ??= 'agenc'

  const response = await fetchWithProxyRetry(
    `${options.request.baseUrl}/responses`,
    {
      method: 'POST',
      headers,
      // WHY: byte-identity required for implicit prefix caching on
      // Responses API. See src/utils/stableStringify.ts.
      body: stableStringify(body),
      signal: options.signal,
    },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown error')
    let errorResponse: object | undefined
    try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
    throw APIError.generate(
      response.status, errorResponse,
      `Responses API error ${response.status}: ${errorBody}`,
      response.headers as unknown as Headers,
    )
  }

  return response
}

async function* readSseEvents(response: Response, _signal?: AbortSignal): AsyncGenerator<ResponsesSseEvent> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    // A silent stream is not proof of failure: a reasoning response or a large
    // function-call payload can take hours before producing its next byte.
    // Cancellation is owned by the caller's signal, not an implicit timer.
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const parsed = parseProviderCodeSseChunk(chunk)
      if (parsed) yield parsed
    }
  }

  buffer += decoder.decode()
  const trailing = parseProviderCodeSseChunk(buffer)
  if (trailing) yield trailing
}

export function determineStopReason(
  response: Record<string, unknown> | undefined,
  sawToolUse: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  // A response truncated by the output-token limit must report 'max_tokens' even
  // when a (partial) function_call is present. Checking tool_use first — its old
  // position — made the runtime EXECUTE a tool call assembled from truncated /
  // JSON-repaired arguments. The chat-completions path guards the same case; this
  // mirrors it by testing max_output_tokens before the tool_use signal.
  const incompleteReason = stringField(
    recordField(response, 'incomplete_details'),
    'reason',
  )
  if (
    typeof incompleteReason === 'string' &&
    incompleteReason.includes('max_output_tokens')
  ) {
    return 'max_tokens'
  }

  const output = arrayField(response, 'output')
  if (
    sawToolUse ||
    output.some(item => isRecord(item) && item.type === 'function_call')
  ) {
    return 'tool_use'
  }

  return 'end_turn'
}

export async function collectProviderCodeCompletedResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let completedResponse: Record<string, unknown> | undefined

  for await (const event of readSseEvents(response, signal)) {
    if (event.event === 'response.failed') {
      const responseRecord = recordField(event.data, 'response')
      const msg = messageField(recordField(responseRecord, 'error')) ??
        messageField(recordField(event.data, 'error')) ??
        'Responses response failed'
      throw APIError.generate(500, undefined, msg, new Headers())
    }

    if (
      event.event === 'response.completed' ||
      event.event === 'response.incomplete'
    ) {
      completedResponse = recordField(event.data, 'response')
      break
    }
  }

  if (!completedResponse) {
    throw APIError.generate(
      500, undefined, 'Responses response ended without a completed payload',
      new Headers(),
    )
  }

  return completedResponse
}

export async function* providerCodeStreamToprovider( // branding-scan: allow existing exported conversion name
  response: Response,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<providerStreamEvent> {
  const messageId = makeMessageId()
  const toolBlocksByItemId = new Map<
    string,
    { index: number; toolUseId: string }
  >()
  let activeTextBlockIndex: number | null = null
  const thinkFilter = createThinkTagFilter()
  let nextContentBlockIndex = 0
  let sawToolUse = false
  let finalResponse: Record<string, unknown> | undefined

  const closeActiveTextBlock = async function* () {
    if (activeTextBlockIndex === null) return
    const tail = thinkFilter.flush()
    if (tail) {
      yield {
        type: 'content_block_delta',
        index: activeTextBlockIndex,
        delta: {
          type: 'text_delta',
          text: tail,
        },
      }
    }
    yield {
      type: 'content_block_stop',
      index: activeTextBlockIndex,
    }
    activeTextBlockIndex = null
  }

  const startTextBlockIfNeeded = async function* () {
    if (activeTextBlockIndex !== null) return
    activeTextBlockIndex = nextContentBlockIndex++
    yield {
      type: 'content_block_start',
      index: activeTextBlockIndex,
      content_block: { type: 'text', text: '' },
    }
  }

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: makeUsage(),
    },
  }

  for await (const event of readSseEvents(response, signal)) {
    const payload = event.data

    if (event.event === 'response.output_item.added') {
      const item = recordField(payload, 'item')
      if (item?.type === 'function_call') {
        yield* closeActiveTextBlock()
        const blockIndex = nextContentBlockIndex++
        const itemId = stringField(item, 'id')
        const toolUseId =
          stringField(item, 'call_id') ?? itemId ?? `call_${blockIndex}`
        toolBlocksByItemId.set(itemId ?? toolUseId, {
          index: blockIndex,
          toolUseId,
        })
        sawToolUse = true

        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: stringField(item, 'name') ?? 'tool',
            input: {},
          },
        }

        const argumentsDelta = stringField(item, 'arguments')
        if (argumentsDelta) {
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argumentsDelta,
            },
          }
        }
      }
      continue
    }

    if (event.event === 'response.content_part.added') {
      if (recordField(payload, 'part')?.type === 'output_text') {
        yield* startTextBlockIfNeeded()
      }
      continue
    }

    if (event.event === 'response.output_text.delta') {
      yield* startTextBlockIfNeeded()
      if (activeTextBlockIndex !== null) {
        const visible = thinkFilter.feed(stringField(payload, 'delta') ?? '')
        if (visible) {
          yield {
            type: 'content_block_delta',
            index: activeTextBlockIndex,
            delta: {
              type: 'text_delta',
              text: visible,
            },
          }
        }
      }
      continue
    }

    if (event.event === 'response.function_call_arguments.delta') {
      const toolBlock = toolBlocksByItemId.get(stringField(payload, 'item_id') ?? '')
      if (toolBlock) {
        yield {
          type: 'content_block_delta',
          index: toolBlock.index,
          delta: {
            type: 'input_json_delta',
            partial_json: stringField(payload, 'delta') ?? '',
          },
        }
      }
      continue
    }

    if (event.event === 'response.output_item.done') {
      const item = recordField(payload, 'item')
      if (item?.type === 'function_call') {
        const itemId = stringField(item, 'id') ?? ''
        const toolBlock = toolBlocksByItemId.get(itemId)
        if (toolBlock) {
          yield {
            type: 'content_block_stop',
            index: toolBlock.index,
          }
          toolBlocksByItemId.delete(itemId)
        }
      } else if (item?.type === 'message') {
        yield* closeActiveTextBlock()
      }
      continue
    }

    if (
      event.event === 'response.completed' ||
      event.event === 'response.incomplete'
    ) {
      finalResponse = recordField(payload, 'response')
      break
    }

    if (event.event === 'response.failed') {
      const responseRecord = recordField(payload, 'response')
      const msg = messageField(recordField(responseRecord, 'error')) ??
        messageField(recordField(payload, 'error')) ??
        'Responses response failed'
      throw APIError.generate(500, undefined, msg, new Headers())
    }
  }

  yield* closeActiveTextBlock()
  for (const toolBlock of toolBlocksByItemId.values()) {
    yield {
      type: 'content_block_stop',
      index: toolBlock.index,
    }
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: determineStopReason(finalResponse, sawToolUse),
      stop_sequence: null,
    },
    // Delegate to the shared normalizer so the streaming message_delta
    // path uses the same raw usage conversion as makeUsage() above
    // and the non-streaming response converter below. Previously this
    // block had its own inline subtraction that missed Kimi / DeepSeek
    // / Gemini raw shapes that the shared helper handles.
    usage: makeUsage(recordField(finalResponse, 'usage')),
  }
  yield { type: 'message_stop' }
}

export function convertProviderCodeResponseToproviderMessage( // branding-scan: allow existing exported conversion name
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  const output = arrayField(data, 'output')

  for (const item of output) {
    if (!isRecord(item)) continue
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part)) continue
        const text = stringField(part, 'text')
        if (part?.type === 'output_text' && text !== undefined) {
          content.push({
            type: 'text',
            text: stripThinkTags(text),
          })
        }
      }
      continue
    }

    if (item.type === 'function_call') {
      const argumentsJson = stringField(item, 'arguments') ?? '{}'
      let input: unknown
      try {
        input = JSON.parse(argumentsJson)
      } catch {
        input = { raw: argumentsJson }
      }
      content.push({
        type: 'tool_use',
        id:
          stringField(item, 'call_id') ??
          stringField(item, 'id') ??
          makeMessageId(),
        name: stringField(item, 'name') ?? 'tool',
        input,
      })
    }
  }
  return {
    id: stringField(data, 'id') ?? makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: stringField(data, 'model') ?? model,
    stop_reason: determineStopReason(data, content.some(item => item.type === 'tool_use')),
    stop_sequence: null,
    usage: makeUsage(recordField(data, 'usage')),
  }
}
