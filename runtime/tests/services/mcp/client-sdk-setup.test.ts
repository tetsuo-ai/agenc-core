import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, test, vi } from 'vitest'

type FakeTransport = {
  serverName: string
  closed?: boolean
  close?: () => Promise<void>
}

type FakeSdkTransport =
  | FakeTransport
  | FakeStdioTransport
  | FakeSseTransport
  | FakeHttpTransport
  | FakeWebSocketTransport

type FakeRequestHandler = {
  schema: unknown
  handler: (request?: unknown) => unknown
}

const fakeClients: FakeClient[] = []
const fakeStdioTransports: FakeStdioTransport[] = []
const fakeSseTransports: FakeSseTransport[] = []
const fakeHttpTransports: FakeHttpTransport[] = []
const fakeWebSocketClients: FakeWebSocketClient[] = []
const fakeWebSocketTransports: FakeWebSocketTransport[] = []
const fakeChromeMcpServers: Array<{
  context: unknown
  connectedTransport?: unknown
  closed: boolean
}> = []
let nextClientOnerror: ((error: Error) => void) | undefined
let nextClientOnclose: (() => void) | undefined
const requestLog: Array<{ serverName: string; method: string }> = []
const fetchLog: Array<{ url: string; method: string; accept?: string | null }> =
  []
const nativeFetchLog: Array<{
  url: string
  headers: Record<string, string>
  dispatcher?: unknown
}> = []
const tempDirs: string[] = []
const originalLargeOutputFiles = process.env.ENABLE_MCP_LARGE_OUTPUT_FILES
const originalMcpTimeout = process.env.MCP_TIMEOUT
const originalShellPrefix = process.env.AGENC_SHELL_PREFIX
const mutableGlobal = globalThis as unknown as {
  Bun?: unknown
  WebSocket?: unknown
  fetch?: typeof fetch
}
const originalBun = mutableGlobal.Bun
const originalWebSocket = mutableGlobal.WebSocket
const originalFetch = mutableGlobal.fetch

function installNativeFetchRecorder(responseText = 'ok'): void {
  mutableGlobal.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const headers = new Headers(init?.headers)
    nativeFetchLog.push({
      url:
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input.url,
      headers: Object.fromEntries(headers.entries()),
      dispatcher: (init as RequestInit & { dispatcher?: unknown })?.dispatcher,
    })
    return new Response(responseText)
  }) as typeof fetch
}

class FakeClient {
  readonly clientInfo: unknown
  private serverName = ''
  closed = false
  onerror?: (error: Error) => void
  onclose?: () => void
  readonly handlers: FakeRequestHandler[] = []

  constructor(clientInfo: unknown) {
    this.clientInfo = clientInfo
    this.onerror = nextClientOnerror
    this.onclose = nextClientOnclose
    nextClientOnerror = undefined
    nextClientOnclose = undefined
    fakeClients.push(this)
  }

  async connect(transport: FakeSdkTransport): Promise<void> {
    this.serverName =
      'serverName' in transport
        ? transport.serverName
        : 'kind' in transport
          ? `${transport.kind}-demo`
          : transport.command === 'broken-server'
            ? 'broken'
            : transport.command === 'hanging-server'
              ? 'hanging'
              : transport.command === 'stderr-server'
                ? 'stderr'
                : transport.command === 'long-instructions-server'
                  ? 'long-instructions'
                  : 'stdio-demo'
    if (this.serverName === 'broken') {
      if ('stderr' in transport) {
        transport.stderr.emit('data', Buffer.from('boot failed'))
      }
      throw new Error('connect failed')
    }
    if (this.serverName === 'hanging') {
      return new Promise(() => {})
    }
    if (this.serverName === 'stderr' && 'stderr' in transport) {
      transport.stderr.emit('data', Buffer.from('startup warning'))
    }
    if ('kind' in transport && String(transport.url).includes('connect-401')) {
      throw Object.assign(new Error('proxy unauthorized'), { code: 401 })
    }
    if ('kind' in transport && String(transport.url).includes('auth')) {
      throw new UnauthorizedError('needs auth')
    }
  }

  getServerCapabilities(): Record<string, unknown> {
    return this.serverName === 'tooling' || this.serverName === 'stdio-demo'
      ? { tools: {}, resources: { subscribe: true } }
      : {}
  }

  getServerVersion(): Record<string, string> {
    return { name: this.serverName, version: '1.0.0' }
  }

  getInstructions(): string {
    if (this.serverName === 'long-instructions') {
      return 'x'.repeat(2100)
    }
    return `instructions for ${this.serverName}`
  }

  setRequestHandler(
    schema: unknown,
    handler: (request?: unknown) => unknown,
  ): void {
    this.handlers.push({ schema, handler })
  }

  async request(request: { method: string }): Promise<unknown> {
    requestLog.push({ serverName: this.serverName, method: request.method })
    if (request.method === 'tools/list') {
      return {
        tools: [{ name: 'inspect', inputSchema: { type: 'object' } }],
      }
    }
    throw new Error(`unexpected request ${request.method}`)
  }

  async notification(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
    this.onclose?.()
  }
}

class FakeStdioTransport {
  readonly stderr = new EventEmitter()
  readonly command: string
  readonly args: string[]
  closed = false
  pid?: number

  constructor(options: { command: string; args?: string[] }) {
	    this.command = options.command
	    this.args = options.args ?? []
	    if (options.command === 'pid-server') {
	      this.pid = 4242
	    }
	    if (options.command === 'throw-pid-server') {
	      Object.defineProperty(this, 'pid', {
	        get: () => {
	          throw new Error('pid unavailable')
	        },
	      })
	    }
	    fakeStdioTransports.push(this)
	  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeSseTransport {
  readonly kind = 'sse'
  readonly url: URL
  readonly options: unknown
  closed = false

  constructor(url: URL, options?: unknown) {
    this.url = url
    this.options = options
    fakeSseTransports.push(this)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeHttpTransport {
  readonly kind = 'http'
  readonly url: URL
  readonly options: unknown
  closed = false

  constructor(url: URL, options?: unknown) {
    this.url = url
    this.options = options
    fakeHttpTransports.push(this)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeWebSocketClient {
  readonly url: string
  readonly options: unknown
  readonly protocols: unknown

  constructor(url: string, protocolsOrOptions?: unknown, options?: unknown) {
    this.url = url
    this.protocols = options === undefined ? undefined : protocolsOrOptions
    this.options = options ?? protocolsOrOptions
    fakeWebSocketClients.push(this)
  }
}

class FakeWebSocketTransport {
  readonly kind = 'ws'
  readonly client: FakeWebSocketClient
  closed = false

  constructor(client: FakeWebSocketClient) {
    this.client = client
    fakeWebSocketTransports.push(this)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

afterEach(async () => {
  fakeClients.length = 0
  fakeStdioTransports.length = 0
  fakeSseTransports.length = 0
  fakeHttpTransports.length = 0
  fakeWebSocketClients.length = 0
  fakeWebSocketTransports.length = 0
  fakeChromeMcpServers.length = 0
  nextClientOnerror = undefined
  nextClientOnclose = undefined
  requestLog.length = 0
  fetchLog.length = 0
  nativeFetchLog.length = 0
  if (originalLargeOutputFiles === undefined) {
    delete process.env.ENABLE_MCP_LARGE_OUTPUT_FILES
  } else {
    process.env.ENABLE_MCP_LARGE_OUTPUT_FILES = originalLargeOutputFiles
  }
  if (originalMcpTimeout === undefined) {
    delete process.env.MCP_TIMEOUT
  } else {
    process.env.MCP_TIMEOUT = originalMcpTimeout
  }
  if (originalShellPrefix === undefined) {
    delete process.env.AGENC_SHELL_PREFIX
  } else {
    process.env.AGENC_SHELL_PREFIX = originalShellPrefix
  }
  if (originalBun === undefined) {
    delete mutableGlobal.Bun
  } else {
    mutableGlobal.Bun = originalBun
  }
  if (originalWebSocket === undefined) {
    delete mutableGlobal.WebSocket
  } else {
    mutableGlobal.WebSocket = originalWebSocket
  }
  if (originalFetch === undefined) {
    delete mutableGlobal.fetch
  } else {
    mutableGlobal.fetch = originalFetch
  }
  vi.doUnmock('@modelcontextprotocol/sdk/client/index.js')
  vi.doUnmock('@modelcontextprotocol/sdk/client/sse.js')
  vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js')
  vi.doUnmock('@modelcontextprotocol/sdk/client/streamableHttp.js')
  vi.doUnmock('@modelcontextprotocol/sdk/shared/transport.js')
  vi.doUnmock('ws')
  vi.doUnmock('bun:bundle')
  vi.doUnmock('@ant/agenc-for-chrome-mcp')
  vi.doUnmock('../../../src/bootstrap/state.js')
  vi.doUnmock('../../../src/constants/oauth.js')
  vi.doUnmock('../../../src/services/mcp/config.js')
  vi.doUnmock('../../../src/services/mcp/elicitationHandler.js')
  vi.doUnmock('../../../src/services/mcp/InProcessTransport.js')
  vi.doUnmock('../../../src/services/mcp/agencai.js')
  vi.doUnmock('../../../src/skills/mcpSkills.js')
  vi.doUnmock('../../../src/utils/agencInChrome/common.js')
  vi.doUnmock('../../../src/utils/agencInChrome/mcpServer.js')
  vi.doUnmock('../../../src/utils/agencInChrome/toolRendering.js')
  vi.doUnmock('../../../src/utils/agencInChrome/toolRendering.tsx')
  vi.doUnmock('../../../src/utils/auth.js')
  vi.doUnmock('../../../src/utils/proxy.js')
  vi.doUnmock('../../../src/utils/envUtils.js')
  vi.doUnmock('../../../src/utils/ide.js')
	  vi.doUnmock('../../../src/utils/mcpNodeWsClient.js')
	  vi.doUnmock('../../../src/utils/mcpWebSocketTransport.js')
	  vi.doUnmock('../../../src/utils/mcpValidation.js')
	  vi.doUnmock('../../../src/utils/secureStorage/macOsKeychainHelpers.js')
	  vi.doUnmock('../../../src/utils/sleep.js')
	  vi.doUnmock('../../../src/utils/toolResultStorage.js')
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
  await Promise.all(
    tempDirs
      .splice(0)
      .map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})),
  )
})

test('setupSdkMcpClients connects SDK clients, fetches tools, and reports failed servers', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))

  const { setupSdkMcpClients } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await setupSdkMcpClients(
    {
      tooling: { type: 'sdk', name: 'tooling' },
      passive: { type: 'sdk', name: 'passive' },
      broken: { type: 'sdk', name: 'broken' },
    },
    async (_serverName, message) => message,
  )

  assert.deepEqual(
    result.clients.map(client => `${client.name}:${client.type}`),
    ['tooling:connected', 'passive:connected', 'broken:failed'],
  )
  assert.deepEqual(
    result.tools.map(tool => tool.name),
    ['mcp__tooling__inspect'],
  )
  assert.deepEqual(requestLog, [
    { serverName: 'tooling', method: 'tools/list' },
  ])

  const connected = result.clients.find(client => client.name === 'tooling')
  assert.equal(connected?.type, 'connected')
  if (connected?.type === 'connected') {
    await connected.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)
})

test('prefetchAllMcpResources includes MCP skill commands when feature enabled', async () => {
  vi.resetModules()
  const skillCalls: string[] = []
  const deletedSkillCacheKeys: string[] = []
  const fetchMcpSkillsForClient = Object.assign(
    async (client: { name: string }) => {
      skillCalls.push(client.name)
      return [
        {
          type: 'prompt',
          name: `mcp__${client.name}__skill`,
          description: 'Skill command',
          hasUserSpecifiedDescription: false,
          contentLength: 0,
          isEnabled: () => true,
          isHidden: false,
          isMcp: true,
          progressMessage: 'running',
          userFacingName: () => `${client.name}:skill (MCP)`,
          argNames: [],
          source: 'mcp',
          getPromptForCommand: async () => [],
        },
      ]
    },
    {
      cache: {
        delete: (name: string) => {
          deletedSkillCacheKeys.push(name)
        },
      },
    },
  )
  vi.doMock('bun:bundle', () => ({
    feature: (name: string) => name === 'MCP_SKILLS',
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))
  vi.doMock('../../../src/skills/mcpSkills.js', () => ({
    fetchMcpSkillsForClient,
  }))

  const { prefetchAllMcpResources } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const config = {
    type: 'stdio',
    command: 'demo-server',
    args: [],
    scope: 'local',
  } as const

  const first = await prefetchAllMcpResources({ 'stdio-demo': config })
  const second = await prefetchAllMcpResources({ 'stdio-demo': config })

  assert.deepEqual(
    first.commands.map(command => command.name),
    ['mcp__stdio-demo__skill'],
  )
  assert.deepEqual(
    second.commands.map(command => command.name),
    ['mcp__stdio-demo__skill'],
  )
  assert.deepEqual(skillCalls, ['stdio-demo', 'stdio-demo'])
  const connected = second.clients[0]
  assert.equal(connected?.type, 'connected')
  if (connected?.type === 'connected') {
    await connected.cleanup()
  }
  assert.deepEqual(deletedSkillCacheKeys, ['stdio-demo'])
})

test('prefetchAllMcpResources reports disabled servers before connecting', async () => {
  vi.resetModules()
  const disabledChecks = new Map<string, number>()
  vi.doMock('../../../src/services/mcp/config.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/services/mcp/config.js')>()),
    isMcpServerDisabled: (name: string) => {
      const count = disabledChecks.get(name) ?? 0
      disabledChecks.set(name, count + 1)
      return name === 'early-disabled' || (name === 'late-disabled' && count > 0)
    },
  }))

  const { prefetchAllMcpResources } = await import('./client.js')

  const result = await prefetchAllMcpResources({
    'early-disabled': {
      type: 'http',
      url: 'https://example.test/early',
      scope: 'local',
    },
    'late-disabled': {
      type: 'stdio',
      command: 'should-not-spawn',
      args: [],
      scope: 'local',
    },
  })

  assert.deepEqual(
    result.clients.map(client => `${client.name}:${client.type}`),
    ['early-disabled:disabled', 'late-disabled:disabled'],
  )
  assert.deepEqual(result.tools, [])
  assert.deepEqual(result.commands, [])
  assert.deepEqual(Object.fromEntries(disabledChecks), {
    'early-disabled': 1,
    'late-disabled': 2,
  })
  assert.equal(fakeClients.length, 0)
  assert.equal(fakeStdioTransports.length, 0)
})

test('prefetchAllMcpResources reports a failed client when a server disable check throws during processing', async () => {
  vi.resetModules()
  const disabledChecks = new Map<string, number>()
  vi.doMock('../../../src/services/mcp/config.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/services/mcp/config.js')>()),
    isMcpServerDisabled: (name: string) => {
      const count = disabledChecks.get(name) ?? 0
      disabledChecks.set(name, count + 1)
      if (name === 'throw-late' && count > 0) {
        throw new Error('disabled check failed')
      }
      return false
    },
  }))

  const { prefetchAllMcpResources } = await import('./client.js')
  const result = await prefetchAllMcpResources({
    'throw-late': {
      type: 'stdio',
      command: 'demo-server',
      args: [],
      scope: 'local',
    },
  })

  assert.deepEqual(
    result.clients.map(client => `${client.name}:${client.type}`),
    ['throw-late:failed'],
  )
  assert.deepEqual(result.tools, [])
  assert.deepEqual(result.commands, [])
  assert.deepEqual(Object.fromEntries(disabledChecks), { 'throw-late': 2 })
})

test('prefetchAllMcpResources resolves empty results when batch setup throws', async () => {
  vi.resetModules()
  vi.doMock('../../../src/services/mcp/config.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/services/mcp/config.js')>()),
    isMcpServerDisabled: () => {
      throw new Error('partition failed')
    },
  }))

  const { prefetchAllMcpResources } = await import('./client.js')
  const result = await prefetchAllMcpResources({
    'throw-early': {
      type: 'stdio',
      command: 'demo-server',
      args: [],
      scope: 'local',
    },
  })

  assert.deepEqual(result, {
    clients: [],
    tools: [],
    commands: [],
  })
})

test('reconnectMcpServerImpl handles MCP skills being disabled during lazy lookup', async () => {
  vi.resetModules()
  let mcpSkillFeatureCalls = 0
  vi.doMock('bun:bundle', () => ({
    feature: (name: string) => {
      if (name !== 'MCP_SKILLS') return false
      mcpSkillFeatureCalls += 1
      return mcpSkillFeatureCalls === 3
    },
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { clearServerCache, reconnectMcpServerImpl } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const config = {
    type: 'stdio',
    command: 'demo-server',
    args: [],
    scope: 'local',
  } as const

  await clearServerCache('stdio-demo', config)
  const result = await reconnectMcpServerImpl('stdio-demo', config)

  assert.equal(result.client.type, 'connected')
  assert.deepEqual(result.commands, [])
  assert.equal(mcpSkillFeatureCalls >= 4, true)
  if (result.client.type === 'connected') {
    await result.client.cleanup()
  }
})

test('prefetchAllMcpResources skips lazy MCP skills when feature disables before import', async () => {
  vi.resetModules()
  let mcpSkillFeatureCalls = 0
  vi.doMock('bun:bundle', () => ({
    feature: (name: string) => {
      if (name !== 'MCP_SKILLS') return false
      mcpSkillFeatureCalls += 1
      return mcpSkillFeatureCalls === 1
    },
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { prefetchAllMcpResources } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const result = await prefetchAllMcpResources({
    'stdio-demo': {
      type: 'stdio',
      command: 'demo-server',
      args: [],
      scope: 'local',
    },
  })

  assert.equal(result.clients[0]?.type, 'connected')
  assert.deepEqual(result.commands, [])
  assert.equal(mcpSkillFeatureCalls >= 2, true)
  const connected = result.clients[0]
  if (connected?.type === 'connected') {
    await connected.cleanup()
  }
})

test('clearServerCache clears pending lazy MCP skills cache after import resolves', async () => {
  vi.resetModules()
  let resolveSkillsModule:
    | ((module: { fetchMcpSkillsForClient: unknown }) => void)
    | undefined
  const deletedSkillCacheKeys: string[] = []
  const fetchMcpSkillsForClient = Object.assign(
    async () => [],
    {
      cache: {
        delete: (name: string) => {
          deletedSkillCacheKeys.push(name)
        },
      },
    },
  )
  vi.doMock('bun:bundle', () => ({
    feature: (name: string) => name === 'MCP_SKILLS',
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))
  vi.doMock('../../../src/skills/mcpSkills.js', async () => {
    return await new Promise(resolve => {
      resolveSkillsModule = resolve
    })
  })

  const { clearServerCache, prefetchAllMcpResources } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const config = {
    type: 'stdio',
    command: 'demo-server',
    args: [],
    scope: 'local',
  } as const

  const prefetchPromise = prefetchAllMcpResources({ 'stdio-demo': config })
  for (let attempt = 0; attempt < 50 && !resolveSkillsModule; attempt++) {
    await Promise.resolve()
  }
  assert.ok(resolveSkillsModule)
  await clearServerCache('stdio-demo', config)
  resolveSkillsModule({ fetchMcpSkillsForClient })
  const result = await prefetchPromise

  assert.equal(result.clients[0]?.type, 'connected')
  assert.equal(deletedSkillCacheKeys.length >= 1, true)
  assert.equal(deletedSkillCacheKeys.every(name => name === 'stdio-demo'), true)
})

test('connectToServer creates stdio clients with lifecycle handlers and cleanup', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const config = {
    type: 'stdio',
    command: 'demo-server',
    args: ['--flag'],
    env: { DEMO: '1' },
    scope: 'local',
  } as const

  const result = await connectToServer('stdio-demo', config)

  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
  assert.equal(fakeStdioTransports[0]?.command, 'demo-server')
  assert.deepEqual(fakeStdioTransports[0]?.args, ['--flag'])
  assert.deepEqual(result.capabilities, {
    tools: {},
    resources: { subscribe: true },
  })
  assert.deepEqual(result.serverInfo, {
    name: 'stdio-demo',
    version: '1.0.0',
  })
  assert.equal(result.instructions, 'instructions for stdio-demo')
  assert.equal(fakeClients[0]?.handlers.length, 3)
  assert.deepEqual(await fakeClients[0]!.handlers[0]!.handler(), {
    roots: [{ uri: `file://${process.cwd()}` }],
  })
  assert.deepEqual(await fakeClients[0]!.handlers[1]!.handler({}), {
    role: 'assistant',
    model: 'agenc-host',
    stopReason: 'endTurn',
    content: {
      type: 'text',
      text:
        'MCP sampling is not available for this AgenC connection. Ask the user to run the request directly in the main conversation.',
    },
  })
  assert.deepEqual(await fakeClients[0]!.handlers[2]!.handler({}), {
    action: 'cancel',
  })
  for (const message of [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'EHOSTUNREACH',
    'ESRCH',
    'spawn missing',
    'other failure',
  ]) {
    fakeClients[0]?.onerror?.(new Error(message))
  }

  await result.cleanup()

  assert.equal(fakeClients[0]?.closed, true)

  const reconnected = await connectToServer('stdio-demo', config)
  assert.equal(reconnected.type, 'connected')
  assert.equal(fakeClients.length, 2)
  if (reconnected.type === 'connected') {
    await reconnected.cleanup()
  }
  assert.equal(fakeClients[1]?.closed, true)
})

test('connectToServer quotes stdio argv when a shell prefix is configured', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  process.env.AGENC_SHELL_PREFIX = 'bash -lc'
  const { connectToServer, formatMcpShellPrefixCommand } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const config = {
    type: 'stdio',
    command: 'demo-server',
    args: [
      '--path',
      'space dir',
      '$(touch /tmp/agenc-mcp-pwned)',
      '; echo pwned',
    ],
    scope: 'local',
  } as const

  const result = await connectToServer('stdio-demo', config)

  assert.equal(result.type, 'connected')
  assert.equal(fakeStdioTransports[0]?.command, 'bash -lc')
  assert.deepEqual(fakeStdioTransports[0]?.args, [
    formatMcpShellPrefixCommand(config.command, config.args),
  ])
  assert.notEqual(
    fakeStdioTransports[0]?.args[0],
    [config.command, ...config.args].join(' '),
  )
  const shellCommand = fakeStdioTransports[0]?.args[0] ?? ''
  assert.equal(shellCommand.includes("'$(touch /tmp/agenc-mcp-pwned)'"), true)
  assert.equal(shellCommand.includes("'; echo pwned'"), true)

  if (result.type === 'connected') {
    await result.cleanup()
  }
})

test('connectToServer logs successful stdio startup stderr before cleanup', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('stderr-stdio', {
    type: 'stdio',
    command: 'stderr-server',
    args: [],
    scope: 'local',
  })

  assert.equal(result.type, 'connected')
  if (result.type === 'connected') {
    await result.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup escalates stdio child process termination signals', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('pid-stdio', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })

  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  const cleanupPromise = result.cleanup()
  await vi.advanceTimersByTimeAsync(700)
  await cleanupPromise

  assert.equal(fakeClients[0]?.closed, true)
  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGINT'),
    true,
  )
  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGTERM'),
    true,
  )
  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGKILL'),
    true,
  )
  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 0),
    true,
  )
})

test('connectToServer cleanup handles stdio signal and client close failures', async () => {
  vi.resetModules()
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      if (signal === 'SIGINT') {
        throw new Error('sigint denied')
      }
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('pid-stdio-sigint-fail', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
  fakeClients[0]!.close = async () => {
    throw new Error('client close denied')
  }

  await result.cleanup()

  assert.deepEqual(killCalls, [{ pid: 4242, signal: 'SIGINT' }])
})

test('connectToServer cleanup logs stdio client close failures without a child process', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('stdio-close-fail', {
    type: 'stdio',
    command: 'demo-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
  fakeClients[0]!.close = async () => {
    throw new Error('stdio client close denied')
  }

  await result.cleanup()
})

test('connectToServer cleanup resolves when stdio process exits during monitoring', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      if (signal === 0) {
        throw new Error('process exited')
      }
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('pid-stdio-exits', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  const cleanupPromise = result.cleanup()
  await vi.advanceTimersByTimeAsync(100)
  await cleanupPromise

  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 0),
    true,
  )
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup resolves when stdio SIGTERM fails', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      if (signal === 'SIGTERM') {
        throw new Error('sigterm denied')
      }
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('pid-stdio-sigterm-fail', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  const cleanupPromise = result.cleanup()
  await vi.advanceTimersByTimeAsync(150)
  await cleanupPromise

  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGTERM'),
    true,
  )
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup logs stdio SIGKILL failures without rejecting', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      if (signal === 'SIGKILL') {
        throw new Error('sigkill denied')
      }
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('pid-stdio-sigkill-fail', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  const cleanupPromise = result.cleanup()
  await vi.advanceTimersByTimeAsync(700)
  await cleanupPromise

  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGKILL'),
    true,
  )
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup resolves when stdio process exits after SIGINT grace period', async () => {
  vi.resetModules()
  vi.doMock('../../../src/utils/sleep.js', () => ({
    sleep: async () => {},
  }))
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      if (signal === 0) {
        throw new Error('process exited after sigint')
      }
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const result = await connectToServer('pid-stdio-exits-after-sigint', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  await result.cleanup()

  assert.deepEqual(killCalls, [
    { pid: 4242, signal: 'SIGINT' },
    { pid: 4242, signal: 0 },
  ])
})

test('connectToServer cleanup resolves when stdio process exits before SIGKILL', async () => {
  vi.resetModules()
  vi.doMock('../../../src/utils/sleep.js', () => ({
    sleep: async () => {},
  }))
  let zeroChecks = 0
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = []
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal })
      if (signal === 0) {
        zeroChecks += 1
        if (zeroChecks >= 2) {
          throw new Error('process exited before sigkill')
        }
      }
      return true
    }) as typeof process.kill,
  )
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const result = await connectToServer('pid-stdio-exits-before-sigkill', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  await result.cleanup()

  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGTERM'),
    true,
  )
  assert.equal(
    killCalls.some(call => call.pid === 4242 && call.signal === 'SIGKILL'),
    false,
  )
})

test('connectToServer cleanup resolves when stdio escalation sleep throws', async () => {
  vi.resetModules()
  vi.doMock('../../../src/utils/sleep.js', () => ({
    sleep: async () => {
      throw new Error('sleep failed')
    },
  }))
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const result = await connectToServer('pid-stdio-sleep-fail', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  await result.cleanup()
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup uses failsafe when stdio escalation never settles', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.doMock('../../../src/utils/sleep.js', () => ({
    sleep: async () => await new Promise(() => {}),
  }))
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const result = await connectToServer('pid-stdio-failsafe', {
    type: 'stdio',
    command: 'pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  const cleanupPromise = result.cleanup()
  await vi.advanceTimersByTimeAsync(650)
  await cleanupPromise

  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup logs stdio pid access failures without rejecting', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const result = await connectToServer('pid-stdio-throws-pid', {
    type: 'stdio',
    command: 'throw-pid-server',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  await result.cleanup()
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer preserves original lifecycle handlers during remote close retries', async () => {
  vi.resetModules()
  const originalErrors: string[] = []
  let originalCloseCount = 0
  nextClientOnerror = error => originalErrors.push(error.message)
  nextClientOnclose = () => {
    originalCloseCount += 1
  }
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: FakeSseTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('sse-lifecycle', {
    type: 'sse',
    url: 'https://example.test/lifecycle',
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
	  const client = fakeClients[0]!
	  client.close = async () => {
	    client.closed = true
	    client.onclose?.()
	    throw new Error('close failed')
	  }

	  client.onerror?.(new Error('temporary blip'))
	  client.onerror?.(new Error('Maximum reconnection attempts reached'))
	  client.onerror?.(new Error('Maximum reconnection attempts reached'))
	  await Promise.resolve()
  await Promise.resolve()

	  assert.equal(client.closed, true)
	  assert.deepEqual(originalErrors, [
	    'temporary blip',
	    'Maximum reconnection attempts reached',
	    'Maximum reconnection attempts reached',
	  ])
  assert.equal(originalCloseCount, 1)
})

test('connectToServer forwards HTTP session expiry to the original error handler', async () => {
  vi.resetModules()
  const originalErrors: string[] = []
  nextClientOnerror = error => originalErrors.push(error.message)
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: FakeHttpTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('http-session-expired', {
    type: 'http',
    url: 'https://example.test/session-expired',
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }

  fakeClients[0]?.onerror?.(
    Object.assign(
      new Error('{"error":{"code":-32001,"message":"Session not found"}}'),
      { code: 404 },
    ),
  )
  await Promise.resolve()

  assert.deepEqual(originalErrors, [
    '{"error":{"code":-32001,"message":"Session not found"}}',
  ])
  assert.equal(fakeClients[0]?.closed, true)
})

test('callMCPToolWithUrlElicitationRetry returns hook-declined URL elicitations', async () => {
  vi.resetModules()
  vi.doMock('../../../src/services/mcp/elicitationHandler.js', () => ({
    runElicitationHooks: async () => ({ action: 'decline' }),
    runElicitationResultHooks: async (
      _serverName: string,
      result: { action: string },
    ) => result,
  }))

  const { callMCPToolWithUrlElicitationRetry } = await import('./client.js')
  const result = await callMCPToolWithUrlElicitationRetry({
    client: {
      name: 'browser',
      type: 'connected',
      capabilities: {},
      config: { type: 'stdio', command: 'browser', scope: 'local' },
      cleanup: async () => {},
      client: {},
    } as never,
    clientConnection: {
      name: 'browser',
      type: 'connected',
      capabilities: {},
      config: { type: 'stdio', command: 'browser', scope: 'local' },
      cleanup: async () => {},
      client: {},
    } as never,
    tool: 'open-url',
    args: {},
    signal: new AbortController().signal,
    setAppState: () => {
      throw new Error('hook-declined URL elicitation should not queue')
    },
    callToolFn: async () => {
      throw new McpError(ErrorCode.UrlElicitationRequired, 'needs url', {
        elicitations: [
          {
            mode: 'url',
            url: 'https://example.test/hook-decline',
            elicitationId: 'hook-decline',
            message: 'Open hook decline URL',
          },
        ],
      })
    },
  })

  assert.equal(
    result.content,
    'URL elicitation was declined by a hook. The tool "open-url" could not complete because it requires the user to open a URL.',
  )
})

test('callMCPToolWithUrlElicitationRetry retries hook-accepted URL elicitations without queueing', async () => {
  vi.resetModules()
  vi.doMock('../../../src/services/mcp/elicitationHandler.js', () => ({
    runElicitationHooks: async () => ({ action: 'accept' }),
    runElicitationResultHooks: async (
      _serverName: string,
      result: { action: string },
    ) => result,
  }))

  const { callMCPToolWithUrlElicitationRetry } = await import('./client.js')
  let calls = 0
  const result = await callMCPToolWithUrlElicitationRetry({
    client: {
      name: 'browser',
      type: 'connected',
      capabilities: {},
      config: { type: 'stdio', command: 'browser', scope: 'local' },
      cleanup: async () => {},
      client: {},
    } as never,
    clientConnection: {
      name: 'browser',
      type: 'connected',
      capabilities: {},
      config: { type: 'stdio', command: 'browser', scope: 'local' },
      cleanup: async () => {},
      client: {},
    } as never,
    tool: 'open-url',
    args: {},
    signal: new AbortController().signal,
    setAppState: () => {
      throw new Error('hook-accepted URL elicitation should not queue')
    },
    callToolFn: async () => {
      calls += 1
      if (calls === 1) {
        throw new McpError(ErrorCode.UrlElicitationRequired, 'needs url', {
          elicitations: [
            {
              mode: 'url',
              url: 'https://example.test/hook-accept',
              elicitationId: 'hook-accept',
              message: 'Open hook accept URL',
            },
          ],
        })
      }
      return { content: 'opened by hook' }
    },
  })

  assert.deepEqual(result, { content: 'opened by hook' })
  assert.equal(calls, 2)
})

test('reconnectMcpServerImpl rebuilds connected clients with tools and resource tools', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { reconnectMcpServerImpl } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }
  const config = {
    type: 'stdio',
    command: 'demo-server',
    args: [],
    scope: 'local',
  } as const

  const result = await reconnectMcpServerImpl('stdio-demo', config)

  assert.equal(result.client.type, 'connected')
  assert.deepEqual(
    result.tools.map(tool => tool.name),
    ['mcp__stdio-demo__inspect', 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
  )
  assert.deepEqual(result.commands, [])
  assert.equal(fakeClients.length, 2)
  assert.equal(fakeClients[0]?.closed, true)
  if (result.client.type === 'connected') {
    await result.client.cleanup()
  }
  assert.equal(fakeClients[1]?.closed, true)
})

test('connectToServer creates in-process Chrome MCP clients without spawning stdio', async () => {
  vi.resetModules()
  const linkedClientTransport: FakeTransport = {
    serverName: 'chrome-in-process',
    closed: false,
    close: async () => {
      linkedClientTransport.closed = true
    },
  }
  const linkedServerTransport: FakeTransport = {
    serverName: 'chrome-server',
    closed: false,
    close: async () => {
      linkedServerTransport.closed = true
    },
  }
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))
  vi.doMock('../../../src/utils/agencInChrome/common.js', () => ({
    isAgenCInChromeMCPServer: (name: string) => name === 'chrome-in-process',
  }))
  const chromeToolRenderingMock = {
    getAgenCInChromeMCPToolOverrides: (toolName: string) => ({
      userFacingName: () => `chrome override ${toolName}`,
      renderToolUseMessage: () => 'rendered chrome tool',
    }),
  }
  vi.doMock(
    '../../../src/utils/agencInChrome/toolRendering.js',
    () => chromeToolRenderingMock,
  )
  vi.doMock(
    '../../../src/utils/agencInChrome/toolRendering.tsx',
    () => chromeToolRenderingMock,
  )
  vi.doMock('../../../src/utils/agencInChrome/mcpServer.js', () => ({
    createChromeContext: (env?: Record<string, string>) => ({ env }),
  }))
  vi.doMock('@ant/agenc-for-chrome-mcp', () => ({
    createAgenCForChromeMcpServer: (context: unknown) => {
      const server = {
        context,
        connectedTransport: undefined as unknown,
        closed: false,
      }
      fakeChromeMcpServers.push(server)
      return {
        connect: async (transport: unknown) => {
          server.connectedTransport = transport
        },
        close: async () => {
          server.closed = true
        },
      }
    },
  }))
  vi.doMock('../../../src/services/mcp/InProcessTransport.js', () => ({
    createLinkedTransportPair: () => [
      linkedClientTransport,
      linkedServerTransport,
    ],
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('chrome-in-process', {
    type: 'stdio',
    command: 'should-not-spawn',
    args: ['--unused'],
    env: { PROFILE: 'default' },
    scope: 'local',
  })

  assert.equal(result.type, 'connected')
  assert.equal(fakeStdioTransports.length, 0)
  assert.deepEqual(fakeChromeMcpServers[0]?.context, {
    env: { PROFILE: 'default' },
  })
  assert.equal(fakeChromeMcpServers[0]?.connectedTransport, linkedServerTransport)
  assert.equal(fakeClients[0]?.handlers.length, 3)

  if (result.type === 'connected') {
    await result.cleanup()
  }
  assert.equal(fakeChromeMcpServers[0]?.closed, true)
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer cleanup logs in-process server and client close failures', async () => {
  vi.resetModules()
  const linkedClientTransport: FakeTransport = {
    serverName: 'chrome-in-process',
    close: async () => {},
  }
  const linkedServerTransport: FakeTransport = {
    serverName: 'chrome-server',
    close: async () => {},
  }
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))
  vi.doMock('../../../src/utils/agencInChrome/common.js', () => ({
    isAgenCInChromeMCPServer: (name: string) => name === 'chrome-in-process',
  }))
  vi.doMock('../../../src/utils/agencInChrome/mcpServer.js', () => ({
    createChromeContext: () => ({}),
  }))
  vi.doMock('@ant/agenc-for-chrome-mcp', () => ({
    createAgenCForChromeMcpServer: () => ({
      connect: async () => {},
      close: async () => {
        throw new Error('in-process close denied')
      },
    }),
  }))
  vi.doMock('../../../src/services/mcp/InProcessTransport.js', () => ({
    createLinkedTransportPair: () => [
      linkedClientTransport,
      linkedServerTransport,
    ],
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('chrome-in-process', {
    type: 'stdio',
    command: 'should-not-spawn',
    args: [],
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
  fakeClients[0]!.close = async () => {
    throw new Error('in-process client close denied')
  }

  await result.cleanup()
})

test('connectToServer times out hanging in-process Chrome connections and cleans up', async () => {
  vi.resetModules()
  process.env.MCP_TIMEOUT = '5'
  vi.useFakeTimers()
  const linkedClientTransport: FakeTransport = {
    serverName: 'hanging',
    close: async () => {
      throw new Error('client transport close denied')
    },
  }
  const linkedServerTransport: FakeTransport = {
    serverName: 'chrome-server',
    close: async () => {},
  }
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))
  vi.doMock('../../../src/utils/agencInChrome/common.js', () => ({
    isAgenCInChromeMCPServer: (name: string) => name === 'chrome-in-process',
  }))
  vi.doMock('../../../src/utils/agencInChrome/mcpServer.js', () => ({
    createChromeContext: () => ({}),
  }))
  vi.doMock('@ant/agenc-for-chrome-mcp', () => ({
    createAgenCForChromeMcpServer: () => ({
      connect: async () => {},
      close: async () => {
        throw new Error('in-process timeout close denied')
      },
    }),
  }))
  vi.doMock('../../../src/services/mcp/InProcessTransport.js', () => ({
    createLinkedTransportPair: () => [
      linkedClientTransport,
      linkedServerTransport,
    ],
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  try {
    const resultPromise = connectToServer('chrome-in-process', {
      type: 'stdio',
      command: 'should-not-spawn',
      args: [],
      scope: 'local',
    })
    await vi.advanceTimersByTimeAsync(5)
    const result = await resultPromise
    assert.equal(result.type, 'failed')
    if (result.type === 'failed') {
      assert.match(result.error, /connection timed out after 5ms/)
    }
  } finally {
    vi.useRealTimers()
  }
})

test('connectToServer returns failed stdio clients after connect errors and closes transport', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('broken-stdio', {
    type: 'stdio',
    command: 'broken-server',
    args: [],
    scope: 'local',
  })

  assert.deepEqual(result, {
    name: 'broken-stdio',
    type: 'failed',
    config: {
      type: 'stdio',
      command: 'broken-server',
      args: [],
      scope: 'local',
    },
    error: 'connect failed',
  })
  assert.equal(fakeStdioTransports[0]?.closed, true)
})

test('connectToServer returns failed stdio clients after connection timeout', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  process.env.MCP_TIMEOUT = '5'
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const resultPromise = connectToServer('hanging-stdio', {
    type: 'stdio',
    command: 'hanging-server',
    args: [],
    scope: 'local',
  })
  await vi.advanceTimersByTimeAsync(5)
  const result = await resultPromise

  assert.equal(result.type, 'failed')
  if (result.type === 'failed') {
    assert.equal(
      result.error,
      'MCP server "hanging-stdio" connection timed out after 5ms',
    )
  }
  assert.equal(fakeStdioTransports[0]?.closed, true)
})

test('connectToServer creates remote SSE, SSE-IDE, and HTTP transports without real network IO', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: FakeSseTransport,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: FakeHttpTransport,
  }))
  vi.doMock('@modelcontextprotocol/sdk/shared/transport.js', async importOriginal => ({
    ...(await importOriginal<
      typeof import('@modelcontextprotocol/sdk/shared/transport.js')
    >()),
    createFetchWithInit: () =>
      async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers)
        fetchLog.push({
          url: String(url),
          method: init?.method ?? 'GET',
          accept: headers.get('accept'),
        })
        if (String(url).includes('parent-abort')) {
          return await new Promise<Response>(resolve => {
            init?.signal?.addEventListener(
              'abort',
              () => resolve(new Response(String(init.signal?.reason))),
              { once: true },
            )
          })
        }
        if (String(url).includes('fail')) {
          throw new Error('fetch failed')
        }
        return new Response('ok')
      },
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const sse = await connectToServer('sse-demo', {
    type: 'sse',
    url: 'https://example.test/sse',
    headers: { 'X-Test': 'yes' },
    scope: 'local',
  })
  assert.equal(sse.type, 'connected')
  assert.equal(fakeSseTransports[0]?.url.href, 'https://example.test/sse')
  assert.equal(
    (
      fakeSseTransports[0]?.options as {
        requestInit?: { headers?: Record<string, string> }
      }
    )?.requestInit?.headers?.['X-Test'],
    'yes',
  )
  const sseOptions = fakeSseTransports[0]?.options as {
    authProvider?: { tokens: () => Promise<{ access_token: string } | undefined> }
    eventSourceInit?: { fetch?: typeof fetch }
  }
  assert.equal(typeof sseOptions.eventSourceInit?.fetch, 'function')
  sseOptions.authProvider!.tokens = async () => ({
    access_token: 'sse-token',
  })
  installNativeFetchRecorder()
  const eventStreamResponse = await sseOptions.eventSourceInit!.fetch!(
    'https://example.test/events',
    { headers: { 'X-Event': 'yes' } },
  )
  assert.equal(await eventStreamResponse.text(), 'ok')
  assert.equal(nativeFetchLog[0]?.url, 'https://example.test/events')
  assert.equal(nativeFetchLog[0]?.headers.authorization, 'Bearer sse-token')
  assert.equal(nativeFetchLog[0]?.headers['x-event'], 'yes')
  assert.equal(nativeFetchLog[0]?.headers['x-test'], 'yes')
  assert.equal(nativeFetchLog[0]?.headers.accept, 'text/event-stream')
  if (sse.type === 'connected') {
    await sse.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)

  const sseIde = await connectToServer('ide', {
    type: 'sse-ide',
    url: 'https://example.test/ide-sse',
    ideName: 'Test IDE',
    scope: 'local',
  })
  assert.equal(sseIde.type, 'connected')
  assert.equal(fakeSseTransports[1]?.url.href, 'https://example.test/ide-sse')
  if (sseIde.type === 'connected') {
    await sseIde.cleanup()
  }
  assert.equal(fakeClients[1]?.closed, true)

  const http = await connectToServer('http-demo', {
    type: 'http',
    url: 'https://example.test/mcp',
    headers: { 'X-Http': 'yes' },
    scope: 'local',
  })
  assert.equal(http.type, 'connected')
  assert.equal(fakeHttpTransports[0]?.url.href, 'https://example.test/mcp')
  assert.equal(
    (
      fakeHttpTransports[0]?.options as {
        requestInit?: { headers?: Record<string, string> }
      }
    )?.requestInit?.headers?.['X-Http'],
    'yes',
  )
  if (http.type === 'connected') {
    const httpFetch = (
      fakeHttpTransports[0]?.options as {
        fetch?: (url: string, init?: RequestInit) => Promise<Response>
      }
    )?.fetch
    assert.ok(httpFetch)
    await httpFetch('https://example.test/stream', { method: 'GET' })
    await httpFetch('https://example.test/post', { method: 'POST' })
    const abortController = new AbortController()
    abortController.abort('already stopped')
    await httpFetch('https://example.test/aborted', {
      method: 'POST',
      signal: abortController.signal,
    })
    const laterAbortController = new AbortController()
    const laterAbortResponse = httpFetch('https://example.test/parent-abort', {
      method: 'POST',
      signal: laterAbortController.signal,
    })
    laterAbortController.abort('stopped later')
    assert.equal(await (await laterAbortResponse).text(), 'stopped later')
    await assert.rejects(
      httpFetch('https://example.test/fail', { method: 'POST' }),
      /fetch failed/,
    )
    assert.deepEqual(fetchLog, [
      { url: 'https://example.test/stream', method: 'GET', accept: null },
      {
        url: 'https://example.test/post',
        method: 'POST',
        accept: 'application/json, text/event-stream',
      },
      {
        url: 'https://example.test/aborted',
        method: 'POST',
        accept: 'application/json, text/event-stream',
      },
      {
        url: 'https://example.test/parent-abort',
        method: 'POST',
        accept: 'application/json, text/event-stream',
      },
      {
        url: 'https://example.test/fail',
        method: 'POST',
        accept: 'application/json, text/event-stream',
      },
    ])
    fakeClients[2]?.onerror?.(new Error('temporary blip'))
    fakeClients[2]?.onerror?.(
      Object.assign(
        new Error('{"error":{"code":-32001,"message":"Session not found"}}'),
        { code: 404 },
      ),
    )
    await Promise.resolve()
    assert.equal(fakeClients[2]?.closed, true)
    await http.cleanup()
  }
  assert.equal(fakeClients[2]?.closed, true)

  const reconnectingSse = await connectToServer('sse-reconnect', {
    type: 'sse',
    url: 'https://example.test/reconnect',
    scope: 'local',
  })
  assert.equal(reconnectingSse.type, 'connected')
  const reconnectingClient = fakeClients[3]!
  reconnectingClient.onerror?.(new Error('ECONNRESET'))
  reconnectingClient.onerror?.(new Error('ECONNRESET'))
  reconnectingClient.onerror?.(new Error('ECONNRESET'))
  await Promise.resolve()
  assert.equal(reconnectingClient.closed, true)

  const exhaustedSse = await connectToServer('sse-exhausted', {
    type: 'sse',
    url: 'https://example.test/exhausted',
    scope: 'local',
  })
  assert.equal(exhaustedSse.type, 'connected')
  const exhaustedClient = fakeClients[4]!
  exhaustedClient.onerror?.(new Error('Maximum reconnection attempts reached'))
  await Promise.resolve()
  assert.equal(exhaustedClient.closed, true)

  const loopbackHttp = await connectToServer('http-loopback', {
    type: 'http',
    url: 'http://localhost:3333/mcp',
    scope: 'local',
  })
  assert.equal(loopbackHttp.type, 'connected')
  if (loopbackHttp.type === 'connected') {
    await loopbackHttp.cleanup()
  }
  assert.equal(fakeClients[5]?.closed, true)
})

test('connectToServer HTTP fetch wrapper aborts long POST requests on timeout', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: FakeHttpTransport,
  }))
  vi.doMock('@modelcontextprotocol/sdk/shared/transport.js', async importOriginal => ({
    ...(await importOriginal<
      typeof import('@modelcontextprotocol/sdk/shared/transport.js')
    >()),
    createFetchWithInit: () =>
      async (_url: string | URL, init?: RequestInit): Promise<Response> => {
        return await new Promise<Response>(resolve => {
          init?.signal?.addEventListener(
            'abort',
            () => resolve(new Response((init.signal?.reason as Error).name)),
            { once: true },
          )
        })
      },
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('http-timeout', {
    type: 'http',
    url: 'https://example.test/timeout',
    scope: 'local',
  })
  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
  const httpFetch = (
    fakeHttpTransports[0]?.options as {
      fetch?: (url: string, init?: RequestInit) => Promise<Response>
    }
  )?.fetch
  assert.ok(httpFetch)

  vi.useFakeTimers()
  try {
    const responsePromise = httpFetch('https://example.test/slow-post', {
      method: 'POST',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(await (await responsePromise).text(), 'TimeoutError')
  } finally {
    vi.useRealTimers()
  }
  await result.cleanup()
})

test('connectToServer wires proxy fetch options into SSE IDE event streams', async () => {
  vi.resetModules()
  const fakeDispatcher = { name: 'proxy-dispatcher' }
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: FakeSseTransport,
  }))
  vi.doMock('../../../src/utils/proxy.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/utils/proxy.js')>()),
    getProxyFetchOptions: () => ({ dispatcher: fakeDispatcher }),
  }))
  installNativeFetchRecorder('proxied')

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('ide', {
    type: 'sse-ide',
    url: 'https://example.test/ide-sse-proxy',
    ideName: 'Proxy IDE',
    scope: 'local',
  })

  assert.equal(result.type, 'connected')
  const options = fakeSseTransports[0]?.options as {
    eventSourceInit?: { fetch?: typeof fetch }
  }
  assert.equal(typeof options.eventSourceInit?.fetch, 'function')
  const response = await options.eventSourceInit!.fetch!(
    'https://example.test/proxy-events',
    { headers: { 'X-Init': '1' } },
  )
  assert.equal(await response.text(), 'proxied')
  assert.equal(nativeFetchLog[0]?.dispatcher, fakeDispatcher)
  assert.equal(nativeFetchLog[0]?.headers['x-init'], '1')
  assert.ok(nativeFetchLog[0]?.headers['user-agent'])
  if (result.type === 'connected') {
    await result.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer tolerates IDE connected notification failures', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: FakeSseTransport,
  }))
  vi.doMock('../../../src/utils/ide.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/utils/ide.js')>()),
    maybeNotifyIDEConnected: () => {
      throw new Error('notify failed')
    },
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('ide', {
    type: 'sse-ide',
    url: 'https://example.test/notify-failure',
    ideName: 'Failing IDE',
    scope: 'local',
  })

  assert.equal(result.type, 'connected')
  if (result.type === 'connected') {
    await result.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)
})

test('connectToServer returns failed connections for unsupported direct paths', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const sdk = await connectToServer('sdk-wrong-path', {
    type: 'sdk',
    name: 'sdk-wrong-path',
    scope: 'local',
  })
  assert.equal(sdk.type, 'failed')
  if (sdk.type === 'failed') {
    assert.equal(sdk.error, 'SDK servers should be handled in print.ts')
  }

  const proxy = await connectToServer('proxy-no-token', {
    type: 'agencai-proxy',
    url: 'https://example.test/proxy',
    id: 'server-1',
    scope: 'agencai',
  } as never)
  assert.equal(proxy.type, 'failed')
  if (proxy.type === 'failed') {
    assert.equal(proxy.error, 'No agenc.tech OAuth token found')
  }

  const unsupported = await connectToServer('unsupported', {
    type: 'unsupported',
    scope: 'local',
  } as never)
  assert.equal(unsupported.type, 'failed')
  if (unsupported.type === 'failed') {
    assert.equal(unsupported.error, 'Unsupported server type: unsupported')
  }
})

test('connectToServer returns needs-auth for unauthorized SSE and HTTP connections', async () => {
  vi.resetModules()
  const configDir = await mkdtemp(join(tmpdir(), 'agenc-mcp-auth-cache-'))
  tempDirs.push(configDir)
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: FakeSseTransport,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: FakeHttpTransport,
  }))
  vi.doMock('../../../src/utils/envUtils.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/utils/envUtils.js')>()),
    getAgenCConfigHomeDir: () => configDir,
  }))

  const { clearMcpAuthCache, connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const sse = await connectToServer('sse-auth', {
    type: 'sse',
    url: 'https://example.test/auth-sse',
    scope: 'local',
  })
  assert.equal(sse.type, 'needs-auth')

  const http = await connectToServer('http-auth', {
    type: 'http',
    url: 'https://example.test/auth-http',
    scope: 'local',
  })
  assert.equal(http.type, 'needs-auth')

  await new Promise(resolve => setTimeout(resolve, 0))
  clearMcpAuthCache()
})

test('connectToServer creates WebSocket and WebSocket IDE transports without real sockets', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('../../../src/utils/mcpWebSocketTransport.js', () => ({
    WebSocketTransport: FakeWebSocketTransport,
  }))
  mutableGlobal.Bun = {}
  mutableGlobal.WebSocket = FakeWebSocketClient

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const ws = await connectToServer('ws-demo', {
    type: 'ws',
    url: 'wss://example.test/socket',
    headers: { 'X-Ws': 'yes' },
    scope: 'local',
  })
  assert.equal(ws.type, 'connected')
  assert.equal(fakeWebSocketClients[0]?.url, 'wss://example.test/socket')
  assert.equal(
    (
      fakeWebSocketClients[0]?.options as {
        headers?: Record<string, string>
      }
    )?.headers?.['X-Ws'],
    'yes',
  )
  assert.equal(fakeWebSocketTransports[0]?.client, fakeWebSocketClients[0])
  if (ws.type === 'connected') {
    await ws.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)

  const wsIde = await connectToServer('ide', {
    type: 'ws-ide',
    url: 'ws://127.0.0.1:1234/mcp',
    ideName: 'Test IDE',
    authToken: 'secret-token',
    scope: 'local',
  })
  assert.equal(wsIde.type, 'connected')
  assert.equal(fakeWebSocketClients[1]?.url, 'ws://127.0.0.1:1234/mcp')
  assert.equal(
    (
      fakeWebSocketClients[1]?.options as {
        headers?: Record<string, string>
      }
    )?.headers?.['X-AgenC-Code-Ide-Authorization'],
    'secret-token',
  )
  if (wsIde.type === 'connected') {
    await wsIde.cleanup()
  }
  assert.equal(fakeClients[1]?.closed, true)
})

test('connectToServer creates Node WebSocket transports without real sockets', async () => {
  vi.resetModules()
  delete mutableGlobal.Bun
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('../../../src/utils/mcpWebSocketTransport.js', () => ({
    WebSocketTransport: FakeWebSocketTransport,
  }))
  vi.doMock('ws', () => ({
    default: FakeWebSocketClient,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const wsIde = await connectToServer('ide', {
    type: 'ws-ide',
    url: 'ws://127.0.0.1:4321/mcp',
    ideName: 'Node IDE',
    authToken: 'node-secret',
    scope: 'local',
  })
  assert.equal(wsIde.type, 'connected')
  assert.equal(fakeWebSocketClients[0]?.url, 'ws://127.0.0.1:4321/mcp')
  assert.deepEqual(fakeWebSocketClients[0]?.protocols, ['mcp'])
  assert.equal(
    (
      fakeWebSocketClients[0]?.options as {
        headers?: Record<string, string>
      }
    )?.headers?.['X-AgenC-Code-Ide-Authorization'],
    'node-secret',
  )
  if (wsIde.type === 'connected') {
    await wsIde.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)

  const ws = await connectToServer('node-ws-demo', {
    type: 'ws',
    url: 'wss://example.test/node-socket',
    headers: { 'X-Node-Ws': 'yes' },
    scope: 'local',
  })
  assert.equal(ws.type, 'connected')
  assert.equal(fakeWebSocketClients[1]?.url, 'wss://example.test/node-socket')
  assert.deepEqual(fakeWebSocketClients[1]?.protocols, ['mcp'])
  assert.equal(
    (
      fakeWebSocketClients[1]?.options as {
        headers?: Record<string, string>
      }
    )?.headers?.['X-Node-Ws'],
    'yes',
  )
  if (ws.type === 'connected') {
    await ws.cleanup()
  }
  assert.equal(fakeClients[1]?.closed, true)
})

test('connectToServer creates agenc.tech proxy transports and retries bearer fetch 401s', async () => {
  vi.resetModules()
  const configDir = await mkdtemp(join(tmpdir(), 'agenc-mcp-proxy-auth-cache-'))
  tempDirs.push(configDir)
  let oauthTokens: { accessToken: string } | null = {
    accessToken: 'first-token',
  }
  let refreshCalls = 0
  const handledTokens: string[] = []
  let handleMode:
    | 'refresh'
    | 'unchanged'
    | 'changed-without-signal'
    | 'throw' = 'refresh'
  const statuses: number[] = [200, 401, 200]
  const fetchFailures: boolean[] = []
  const markedProxyConnections: string[] = []
  mutableGlobal.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const headers = new Headers(init?.headers)
    nativeFetchLog.push({
      url:
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input.url,
      headers: Object.fromEntries(headers.entries()),
      dispatcher: (init as RequestInit & { dispatcher?: unknown })?.dispatcher,
    })
    if (fetchFailures.shift()) {
      throw new Error('retry network down')
    }
    const status = statuses.shift() ?? 200
    return new Response(`status-${status}`, { status })
  }) as typeof fetch
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: FakeHttpTransport,
  }))
  vi.doMock('../../../src/utils/auth.js', () => ({
    checkAndRefreshOAuthTokenIfNeeded: async () => {
      refreshCalls += 1
    },
    getAgenCAIOAuthTokens: () => oauthTokens,
    handleOAuth401Error: async (sentToken: string) => {
      handledTokens.push(sentToken)
      if (handleMode === 'throw') {
        throw new Error('refresh failed')
      }
      if (handleMode === 'refresh') {
        oauthTokens = { accessToken: 'second-token' }
        return true
      }
      if (handleMode === 'changed-without-signal') {
        oauthTokens = { accessToken: 'background-token' }
      }
      return false
    },
  }))
  vi.doMock('../../../src/constants/oauth.js', () => ({
    getOauthConfig: () => ({
      MCP_PROXY_URL: 'https://proxy.example.test',
      MCP_PROXY_PATH: '/mcp/{server_id}',
    }),
  }))
  vi.doMock('../../../src/bootstrap/state.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/bootstrap/state.js')>()),
    getSessionId: () => 'session-123',
  }))
  vi.doMock('../../../src/services/mcp/agencai.js', () => ({
    markAgenCAiMcpConnected: (name: string) => {
      markedProxyConnections.push(name)
    },
  }))
  vi.doMock('../../../src/utils/envUtils.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../src/utils/envUtils.js')>()),
    getAgenCConfigHomeDir: () => configDir,
  }))

  const { connectToServer, prefetchAllMcpResources, reconnectMcpServerImpl } =
    await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('proxy-demo', {
    type: 'agencai-proxy',
    id: 'server-42',
    url: 'https://unused.example.test',
    scope: 'agencai',
  } as never)

  assert.equal(result.type, 'connected')
  assert.equal(
    fakeHttpTransports[0]?.url.href,
    'https://proxy.example.test/mcp/server-42',
  )
  assert.equal(
    (
      fakeHttpTransports[0]?.options as {
        requestInit?: { headers?: Record<string, string> }
      }
    )?.requestInit?.headers?.['X-Mcp-Client-Session-Id'],
    'session-123',
  )
  const proxyFetch = (
    fakeHttpTransports[0]?.options as {
      fetch?: (url: string, init?: RequestInit) => Promise<Response>
    }
  )?.fetch
  assert.equal(typeof proxyFetch, 'function')

  const firstResponse = await proxyFetch!('https://proxy.example.test/rpc', {
    method: 'POST',
  })
  assert.equal(firstResponse.status, 200)
  assert.equal(nativeFetchLog[0]?.headers.authorization, 'Bearer first-token')

  const retryResponse = await proxyFetch!('https://proxy.example.test/rpc', {
    method: 'POST',
  })
  assert.equal(await retryResponse.text(), 'status-200')
  assert.deepEqual(handledTokens, ['first-token'])
  assert.equal(nativeFetchLog[1]?.headers.authorization, 'Bearer first-token')
  assert.equal(nativeFetchLog[2]?.headers.authorization, 'Bearer second-token')
  assert.equal(refreshCalls, 3)

  oauthTokens = null
  await assert.rejects(
    proxyFetch!('https://proxy.example.test/rpc', { method: 'POST' }),
    /No agenc\.tech OAuth token available/,
  )

  oauthTokens = { accessToken: 'same-token' }
  handleMode = 'unchanged'
  statuses.push(401)
  const unchangedResponse = await proxyFetch!('https://proxy.example.test/rpc', {
    method: 'POST',
  })
  assert.equal(unchangedResponse.status, 401)

  oauthTokens = { accessToken: 'throw-token' }
  handleMode = 'throw'
  statuses.push(401)
  const thrownHandlerResponse = await proxyFetch!(
    'https://proxy.example.test/rpc',
    { method: 'POST' },
  )
  assert.equal(thrownHandlerResponse.status, 401)

  oauthTokens = { accessToken: 'stale-token' }
  handleMode = 'changed-without-signal'
  statuses.push(401)
  fetchFailures.push(false, true)
  const failedRetryResponse = await proxyFetch!(
    'https://proxy.example.test/rpc',
    { method: 'POST' },
  )
  assert.equal(failedRetryResponse.status, 401)
  assert.deepEqual(handledTokens, [
    'first-token',
    'same-token',
    'throw-token',
    'stale-token',
  ])

  oauthTokens = { accessToken: 'connect-token' }
  const needsAuth = await connectToServer('proxy-connect-401', {
    type: 'agencai-proxy',
    id: 'connect-401',
    url: 'https://unused.example.test',
    scope: 'agencai',
  } as never)
  assert.equal(needsAuth.type, 'needs-auth')

  oauthTokens = { accessToken: 'reconnect-token' }
  const reconnectResult = await reconnectMcpServerImpl('proxy-reconnect', {
    type: 'agencai-proxy',
    id: 'reconnect-42',
    url: 'https://unused.example.test',
    scope: 'agencai',
  } as never)
  assert.equal(reconnectResult.client.type, 'connected')
  if (reconnectResult.client.type === 'connected') {
    await reconnectResult.client.cleanup()
  }

  oauthTokens = { accessToken: 'prefetch-token' }
  const prefetchResult = await prefetchAllMcpResources({
    'proxy-prefetch': {
      type: 'agencai-proxy',
      id: 'prefetch-42',
      url: 'https://unused.example.test',
      scope: 'agencai',
    } as never,
  })
  assert.equal(prefetchResult.clients[0]?.type, 'connected')
  const prefetchClient = prefetchResult.clients[0]
  if (prefetchClient?.type === 'connected') {
    await prefetchClient.cleanup()
  }
  assert.deepEqual(markedProxyConnections, [
    'proxy-reconnect',
    'proxy-prefetch',
  ])

  if (result.type === 'connected') {
    await result.cleanup()
  }
  assert.equal(fakeClients[0]?.closed, true)
})

test('reconnectMcpServerImpl returns a failed client when cache invalidation throws', async () => {
  vi.resetModules()
  vi.doMock('../../../src/utils/secureStorage/macOsKeychainHelpers.js', () => ({
    clearKeychainCache: () => {
      throw new Error('keychain unavailable')
    },
  }))

  const { reconnectMcpServerImpl } = await import('./client.js')
  const result = await reconnectMcpServerImpl('keychain-fail', {
    type: 'stdio',
    command: 'unused',
    args: [],
    scope: 'local',
  })

  assert.equal(result.client.type, 'failed')
  assert.deepEqual(result.tools, [])
  assert.deepEqual(result.commands, [])
})

test('connectToServer truncates oversized server instructions', async () => {
  vi.resetModules()
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: FakeClient,
  }))
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: FakeStdioTransport,
  }))

  const { connectToServer } = await import('./client.js')
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??=
    { VERSION: 'test' }

  const result = await connectToServer('long-instructions', {
    type: 'stdio',
    command: 'long-instructions-server',
    args: [],
    scope: 'local',
  })

  assert.equal(result.type, 'connected')
  if (result.type !== 'connected') {
    assert.fail(result.error)
  }
  assert.equal(result.instructions?.length, 2061)
  assert.equal(result.instructions?.endsWith('… [truncated]'), true)

  await result.cleanup()
})

test('MCP tool calls persist large non-image output and fall back when disabled', async () => {
  vi.resetModules()
  delete process.env.ENABLE_MCP_LARGE_OUTPUT_FILES
  const persisted: Array<{ content: unknown; id: string }> = []
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
  vi.doMock('../../../src/utils/mcpValidation.js', () => ({
    mcpContentNeedsTruncation: async () => true,
    truncateMcpContentIfNeeded: async () => 'truncated fallback',
  }))
  vi.doMock('../../../src/utils/toolResultStorage.js', () => ({
    isPersistError: (value: unknown) =>
      !!value && typeof value === 'object' && 'error' in value,
    persistToolResult: async (content: unknown, id: string) => {
      persisted.push({ content, id })
      if (id.includes('fail-persist')) {
        return { error: 'disk full' }
      }
      return {
        filepath: '/tmp/agenc-large-output.json',
        originalSize: String(content).length,
        isJson: true,
        preview: '',
        hasMore: false,
      }
    },
  }))

  const { fetchToolsForClient } = await import('./client.js')
  const client = {
    name: 'large-output',
    type: 'connected',
    capabilities: { tools: {} },
    config: { type: 'sdk', name: 'large-output', scope: 'local' },
    cleanup: async () => {},
    client: {
      request: async () => ({
	        tools: [
	          { name: 'dump', inputSchema: { type: 'object' } },
	          { name: 'plain', inputSchema: { type: 'object' } },
	          { name: 'empty', inputSchema: { type: 'object' } },
	          { name: 'image', inputSchema: { type: 'object' } },
	          { name: 'fail-persist', inputSchema: { type: 'object' } },
	        ],
	      }),
	      callTool: async (request: { name: string }) => {
	        if (request.name === 'plain') {
	          return { toolResult: 'huge result' }
	        }
	        if (request.name === 'empty') {
	          return { toolResult: '' }
	        }
	        if (request.name === 'image') {
	          return {
	            content: [
              {
                type: 'image',
                data: pngBase64,
                mimeType: 'image/png',
              },
            ],
          }
        }
        return {
          content: [{ type: 'text', text: 'huge result' }],
        }
      },
    },
  } as never

  const tools = await fetchToolsForClient(client)
  const toolByName = new Map(tools.map(tool => [tool.mcpInfo?.toolName, tool]))
  const persistedResult = await toolByName.get('dump')!.call(
    {},
    {
      abortController: new AbortController(),
      setAppState: value => value({ elicitation: { queue: [] } } as never),
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
  )

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0]?.id.startsWith('mcp-large-output-dump-'), true)
  assert.equal(
    (persistedResult.data as string).includes(
      'Output has been saved to /tmp/agenc-large-output.json',
    ),
    true,
  )
  assert.equal((persistedResult.data as string).includes('Format: JSON array'), true)

  const plainResult = await toolByName.get('plain')!.call(
    {},
    {
      abortController: new AbortController(),
      setAppState: value => value({ elicitation: { queue: [] } } as never),
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
  )
  assert.equal(persisted[1]?.id.startsWith('mcp-large-output-plain-'), true)
  assert.equal((plainResult.data as string).includes('Format: Plain text'), true)

  const emptyResult = await toolByName.get('empty')!.call(
    {},
    {
      abortController: new AbortController(),
      setAppState: value => value({ elicitation: { queue: [] } } as never),
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
  )
  assert.deepEqual(emptyResult, { data: '' })

  const imageResult = await toolByName.get('image')!.call(
    {},
    {
      abortController: new AbortController(),
      setAppState: value => value({ elicitation: { queue: [] } } as never),
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
  )
  assert.deepEqual(imageResult, { data: 'truncated fallback' })

  const persistErrorResult = await toolByName.get('fail-persist')!.call(
    {},
    {
      abortController: new AbortController(),
      setAppState: value => value({ elicitation: { queue: [] } } as never),
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
  )
  assert.match(
    persistErrorResult.data as string,
    /^Error: result \(\d+ characters\) exceeds maximum allowed tokens\. Failed to save output to file: disk full\./,
  )

  process.env.ENABLE_MCP_LARGE_OUTPUT_FILES = '0'
  fetchToolsForClient.cache.clear()
  const fallbackTools = await fetchToolsForClient(client)
  const fallbackTool = fallbackTools.find(tool => tool.mcpInfo?.toolName === 'dump')
  const fallbackResult = await fallbackTool!.call(
    {},
    {
      abortController: new AbortController(),
      setAppState: value => value({ elicitation: { queue: [] } } as never),
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
  )

  assert.deepEqual(fallbackResult, { data: 'truncated fallback' })
})
