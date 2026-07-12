/**
 * Minimal ACP (Agent Client Protocol) client for the Grok Build CLI.
 *
 * xAI serves Grok composer models ONLY through ACP — spawning
 * `grok agent stdio` and speaking JSON-RPC 2.0 over newline-delimited JSON
 * on the child's stdio — never through direct inference endpoints. This is
 * xAI's explicit integration requirement (t3code's GrokAcpSupport is the
 * reference implementation).
 *
 * Protocol surface used here (agentclientprotocol.com, protocolVersion 1):
 *   client → agent : initialize, authenticate, session/new,
 *                    session/set_model (unstable), session/prompt,
 *                    session/cancel (notification)
 *   agent → client : session/update (notification),
 *                    session/request_permission (request)
 *
 * The spawn env carries `GROK_OAUTH2_REFERRER=agenc` so xAI can attribute
 * OAuth logins performed by the CLI on our behalf.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

import { asRecord } from '../../utils/record.js'

export const GROK_ACP_REFERRER_ENV = 'GROK_OAUTH2_REFERRER'
export const GROK_ACP_REFERRER = 'agenc'
export const GROK_ACP_DEFAULT_COMMAND = 'grok'
export const GROK_ACP_ARGS = ['agent', 'stdio'] as const
export const GROK_ACP_AUTH_METHOD_API_KEY = 'xai.api_key'
export const GROK_ACP_AUTH_METHOD_CACHED_TOKEN = 'cached_token'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PROMPT_TIMEOUT_MS = 20 * 60 * 1000
const STDERR_TAIL_LIMIT = 4_096

export type XaiAcpErrorCode =
  | 'spawn_failed'
  | 'closed'
  | 'timeout'
  | 'protocol'
  | 'agent_error'

export class XaiAcpError extends Error {
  readonly code: XaiAcpErrorCode
  /** JSON-RPC error code when the agent returned a structured error. */
  readonly rpcCode?: number

  constructor(code: XaiAcpErrorCode, message: string, rpcCode?: number) {
    super(message)
    this.name = 'XaiAcpError'
    this.code = code
    if (rpcCode !== undefined) this.rpcCode = rpcCode
  }
}

export type XaiAcpPermissionOption = {
  optionId: string
  name?: string
  kind?: string
}

export type XaiAcpPermissionRequest = {
  sessionId?: string
  options: readonly XaiAcpPermissionOption[]
  /** Raw request params for logging/diagnostics. */
  raw: Record<string, unknown>
}

export type XaiAcpPermissionDecision =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export type XaiAcpModelInfo = {
  modelId: string
  name?: string
}

export type XaiAcpSessionInfo = {
  sessionId: string
  currentModelId?: string
  availableModels: readonly XaiAcpModelInfo[]
}

export type XaiAcpPromptResult = {
  stopReason: string
  text: string
}

export interface XaiAcpClientOptions {
  command?: string
  args?: readonly string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  clientInfo?: { name: string; version: string }
  /**
   * Decides agent-initiated `session/request_permission` requests. The
   * default rejects (composer stays a text generator; agenc's own tool
   * loop keeps authority over the workspace).
   */
  onPermissionRequest?: (
    request: XaiAcpPermissionRequest,
  ) => Promise<XaiAcpPermissionDecision> | XaiAcpPermissionDecision
  requestTimeoutMs?: number
  promptTimeoutMs?: number
}

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: XaiAcpError) => void
  timer: NodeJS.Timeout | undefined
}

type PromptCollector = {
  sessionId: string
  onText: (text: string) => void
}

/**
 * Pick the rejecting option from a permission request, preferring
 * `reject_once` over `reject_always`; falls back to `cancelled` when the
 * agent offered no reject option.
 */
export function rejectPermissionDecision(
  request: XaiAcpPermissionRequest,
): XaiAcpPermissionDecision {
  const reject =
    request.options.find(option => option.kind === 'reject_once') ??
    request.options.find(option => option.kind === 'reject_always')
  return reject !== undefined
    ? { outcome: 'selected', optionId: reject.optionId }
    : { outcome: 'cancelled' }
}

/** Pick the allowing option, preferring `allow_once`. */
export function allowPermissionDecision(
  request: XaiAcpPermissionRequest,
): XaiAcpPermissionDecision {
  const allow =
    request.options.find(option => option.kind === 'allow_once') ??
    request.options.find(option => option.kind === 'allow_always')
  return allow !== undefined
    ? { outcome: 'selected', optionId: allow.optionId }
    : rejectPermissionDecision(request)
}

export class XaiAcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly reader: Interface
  private readonly options: XaiAcpClientOptions
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closed = false
  private closeReason: string | undefined
  private stderrTail = ''
  private promptCollector: PromptCollector | null = null

  constructor(options: XaiAcpClientOptions) {
    this.options = options
    const command = options.command ?? GROK_ACP_DEFAULT_COMMAND
    const args = options.args ?? GROK_ACP_ARGS
    try {
      this.child = spawn(command, [...args], {
        cwd: options.cwd,
        env: {
          ...(options.env ?? process.env),
          [GROK_ACP_REFERRER_ENV]: GROK_ACP_REFERRER,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new XaiAcpError(
        'spawn_failed',
        `Failed to spawn ${command}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'ENOENT'
          ? `Grok CLI not found (${command}). Install it and sign in once ` +
            '(`grok`) before using composer models, or set XAI_API_KEY.'
          : `Grok CLI failed: ${error.message}`
      this.failAll(new XaiAcpError('spawn_failed', message))
    })
    this.child.on('exit', (exitCode, signal) => {
      const detail = this.stderrTail.trim()
      this.failAll(
        new XaiAcpError(
          'closed',
          `Grok CLI exited (code=${exitCode ?? 'null'}, signal=${signal ?? 'null'})` +
            (detail ? `: ${detail}` : ''),
        ),
      )
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(
        -STDERR_TAIL_LIMIT,
      )
    })

    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', line => {
      this.handleLine(line)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  async initialize(): Promise<{ authMethods: readonly string[] }> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        // agenc keeps workspace authority: the composer session gets no
        // client-side fs or terminal access.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.options.clientInfo ?? { name: 'agenc', version: '0' },
    })
    const methods = Array.isArray(result.authMethods)
      ? result.authMethods
          .map(entry => asRecord(entry)?.id)
          .filter((id): id is string => typeof id === 'string')
      : []
    return { authMethods: methods }
  }

  async authenticate(methodId: string): Promise<void> {
    await this.request('authenticate', { methodId })
  }

  async newSession(cwd?: string): Promise<XaiAcpSessionInfo> {
    const result = await this.request('session/new', {
      cwd: cwd ?? this.options.cwd,
      mcpServers: [],
    })
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new XaiAcpError('protocol', 'session/new returned no sessionId')
    }
    const models = asRecord(result.models)
    const availableModels: XaiAcpModelInfo[] = []
    if (Array.isArray(models?.availableModels)) {
      for (const entry of models.availableModels) {
        const record = asRecord(entry)
        if (typeof record?.modelId === 'string') {
          availableModels.push({
            modelId: record.modelId,
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
          })
        }
      }
    }
    return {
      sessionId,
      ...(typeof models?.currentModelId === 'string' && models.currentModelId
        ? { currentModelId: models.currentModelId }
        : {}),
      availableModels,
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId, modelId })
  }

  /**
   * Send a prompt and collect streamed `agent_message_chunk` text until the
   * agent responds with a stop reason.
   */
  async prompt(params: {
    sessionId: string
    text: string
    onTextChunk?: (text: string) => void
    signal?: AbortSignal
  }): Promise<XaiAcpPromptResult> {
    if (this.promptCollector !== null) {
      throw new XaiAcpError('protocol', 'a prompt is already in flight on this client')
    }
    let text = ''
    this.promptCollector = {
      sessionId: params.sessionId,
      onText: chunk => {
        text += chunk
        params.onTextChunk?.(chunk)
      },
    }
    const onAbort = () => {
      this.notify('session/cancel', { sessionId: params.sessionId })
    }
    params.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.request(
        'session/prompt',
        {
          sessionId: params.sessionId,
          prompt: [{ type: 'text', text: params.text }],
        },
        this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      )
      const stopReason =
        typeof result.stopReason === 'string' ? result.stopReason : 'unknown'
      return { stopReason, text }
    } finally {
      params.signal?.removeEventListener('abort', onAbort)
      this.promptCollector = null
    }
  }

  dispose(): void {
    if (!this.closed) {
      this.closed = true
      this.closeReason = 'disposed'
    }
    this.reader.close()
    this.child.kill()
    this.failAll(new XaiAcpError('closed', 'ACP client disposed'))
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(
        new XaiAcpError('closed', this.closeReason ?? 'ACP connection is closed'),
      )
    }
    const id = this.nextId
    this.nextId += 1
    const effectiveTimeout =
      timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        Number.isFinite(effectiveTimeout) && effectiveTimeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(
                new XaiAcpError('timeout', `${method} timed out after ${effectiveTimeout}ms`),
              )
            }, effectiveTimeout)
          : undefined
      this.pending.set(id, {
        resolve: value => {
          if (timer !== undefined) clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          if (timer !== undefined) clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch {
      // exit/error handlers surface the failure to pending requests.
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: Record<string, unknown> | undefined
    try {
      message = asRecord(JSON.parse(trimmed)) ?? undefined
    } catch {
      return
    }
    if (message === undefined) return

    const { id, method } = message
    if (typeof method === 'string') {
      if (id !== undefined && (typeof id === 'number' || typeof id === 'string')) {
        void this.handleAgentRequest(id, method, asRecord(message.params) ?? {})
      } else {
        this.handleNotification(method, asRecord(message.params) ?? {})
      }
      return
    }
    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      const error = asRecord(message.error)
      if (error !== undefined && error !== null) {
        const rpcCode = typeof error.code === 'number' ? error.code : undefined
        pending.reject(
          new XaiAcpError(
            'agent_error',
            `Grok agent error: ${typeof error.message === 'string' ? error.message : 'unknown'}`,
            rpcCode,
          ),
        )
        return
      }
      pending.resolve(asRecord(message.result) ?? {})
    }
  }

  private async handleAgentRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === 'session/request_permission') {
      const options: XaiAcpPermissionOption[] = []
      if (Array.isArray(params.options)) {
        for (const entry of params.options) {
          const record = asRecord(entry)
          if (typeof record?.optionId === 'string') {
            options.push({
              optionId: record.optionId,
              ...(typeof record.name === 'string' ? { name: record.name } : {}),
              ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
            })
          }
        }
      }
      const request: XaiAcpPermissionRequest = {
        ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
        options,
        raw: params,
      }
      let decision: XaiAcpPermissionDecision
      try {
        decision = this.options.onPermissionRequest !== undefined
          ? await this.options.onPermissionRequest(request)
          : rejectPermissionDecision(request)
      } catch {
        decision = rejectPermissionDecision(request)
      }
      this.send({
        jsonrpc: '2.0',
        id,
        result: { outcome: decision },
      })
      return
    }
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not supported by agenc ACP client: ${method}` },
    })
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method !== 'session/update') return
    const collector = this.promptCollector
    if (collector === null) return
    if (
      typeof params.sessionId === 'string' &&
      params.sessionId !== collector.sessionId
    ) {
      return
    }
    const update = asRecord(params.update)
    if (update?.sessionUpdate !== 'agent_message_chunk') return
    const content = asRecord(update.content)
    if (content?.type === 'text' && typeof content.text === 'string') {
      collector.onText(content.text)
    }
  }

  private failAll(error: XaiAcpError): void {
    if (!this.closed) {
      this.closed = true
      this.closeReason = error.message
    }
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters) {
      waiter.reject(error)
    }
  }
}
