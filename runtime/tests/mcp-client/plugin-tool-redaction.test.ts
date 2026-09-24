import { afterEach, expect, test, vi } from 'vitest'
import { MCPManager } from '../../src/mcp-client/manager.js'

vi.mock('../../src/mcp-client/connection.js', () => ({ createMCPConnection: vi.fn() }))
vi.mock('../../src/mcp-client/resources.js', () => ({ createResourceBridge: vi.fn(async () => ({ dispose: async () => {}, listResources: async () => [] })) }))
vi.mock('../../src/mcp-client/prompts.js', () => ({ createPromptBridge: vi.fn(async () => ({ dispose: async () => {}, listPrompts: async () => [] })) }))

import { createMCPConnection } from '../../src/mcp-client/connection.js'

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

function client(secret: string, call: (options?: { onprogress?: (event: unknown) => void }) => Promise<unknown>) {
  return {
    listTools: async () => ({ tools: [{ name: 'echo', description: `description 1 info ${secret}`, inputSchema: { type: 'object', properties: { note: { description: `1 info ${secret}` } } } }] }),
    callTool: async (_request: unknown, _schema: unknown, options?: { onprogress?: (event: unknown) => void }) => call(options),
    close: async () => {},
  }
}

test('plugin outputs pass through the real bridge redactor before normalization and observer events', async () => {
  const secret = 'private-phrase'
  const observer = { onBegin: vi.fn(), onEnd: vi.fn() }
  const progress = vi.fn()
  let fail = false
  vi.mocked(createMCPConnection).mockResolvedValue(client(secret, async options => {
    options?.onprogress?.({ message: `progress 1 info ${secret}` })
    if (fail) throw new Error(`Invalid credential 1 info ${secret}`)
    return { content: [{ type: 'text', text: `result 1 info ${secret}` }] }
  }) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:echo', command: 'node', origin: { scope: 'plugin' }, env: { DEBUG: '1', LOG_LEVEL: 'info', TOKEN: secret }, pluginSecretValues: [secret] }])
  manager.setCallObserver(observer)
  try {
    await manager.start()
    const tool = manager.getTools()[0]!
    const catalog = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema })
    expect(catalog).toContain('1 info')
    expect(catalog).not.toContain(secret)
    const args: Record<string, unknown> = {}
    Object.defineProperty(args, '__onProgress', { value: progress })
    const result = JSON.stringify(await tool.execute(args))
    expect(result).toContain('1 info')
    expect(result).not.toContain(secret)
    expect(JSON.stringify(progress.mock.calls)).toContain('1 info')
    expect(JSON.stringify(progress.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(observer.onEnd.mock.calls)).toContain('1 info')
    expect(JSON.stringify(observer.onEnd.mock.calls)).not.toContain(secret)
    fail = true
    const error = JSON.stringify(await tool.execute({}))
    expect(error).toContain('1 info')
    expect(error).not.toContain(secret)
    expect(JSON.stringify(observer.onEnd.mock.calls)).not.toContain(secret)
  } finally { await manager.stop() }
})

test('automatic reconnect retains plugin output redaction in the rebuilt real bridge', async () => {
  vi.useFakeTimers()
  const secret = 'connected'
  const observer = { onBegin: vi.fn(), onEnd: vi.fn() }
  const progress = vi.fn()
  vi.mocked(createMCPConnection)
    .mockResolvedValueOnce(client(secret, async () => { throw new Error('not connected') }) as never)
    .mockResolvedValueOnce(client(secret, async options => {
      options?.onprogress?.({ message: `progress 1 info ${secret}` })
      return { content: [{ type: 'text', text: `result 1 info ${secret}` }] }
    }) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:echo', command: 'node', origin: { scope: 'plugin' }, env: { DEBUG: '1', LOG_LEVEL: 'info', TOKEN: secret }, pluginSecretValues: [secret] }])
  manager.setCallObserver(observer)
  try {
    await manager.start()
    const first = await manager.getTools()[0]!.execute({})
    expect(first.content).toContain('reconnecting')
    expect(first.content).not.toContain(secret)
    await vi.advanceTimersByTimeAsync(1_000)
    const tool = manager.getTools()[0]!
    expect(tool.description).toContain('1 info')
    expect(tool.description).not.toContain(secret)
    const args: Record<string, unknown> = {}
    Object.defineProperty(args, '__onProgress', { value: progress })
    const result = JSON.stringify(await tool.execute(args))
    expect(result).toContain('1 info')
    expect(result).not.toContain(secret)
    expect(JSON.stringify(progress.mock.calls)).toContain('1 info')
    expect(JSON.stringify(progress.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(observer.onEnd.mock.calls)).not.toContain(secret)
  } finally { await manager.stop() }
})

test.each(['message', 'progress'])('progress notification still renders when %s is a saved secret', async secret => {
  const progress = vi.fn()
  vi.mocked(createMCPConnection).mockResolvedValue(client(secret, async options => {
    options?.onprogress?.({ message: 'Working', progress: 2, total: 5 })
    return { content: [{ type: 'text', text: 'done' }] }
  }) as never)
  const manager = new MCPManager([{ name: `plugin:demo:${secret}`, command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }])
  try {
    await manager.start()
    const args: Record<string, unknown> = {}
    Object.defineProperty(args, '__onProgress', { value: progress })
    await manager.getTools()[0]!.execute(args)
    expect(progress).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(progress.mock.calls)).toContain('Working')
    expect(JSON.stringify(progress.mock.calls)).toContain('2/5')
    expect(JSON.stringify(progress.mock.calls)).not.toContain(secret)
  } finally { await manager.stop() }
})

test('plugin values without sensitive template substitutions remain visible in tool output', async () => {
  vi.mocked(createMCPConnection).mockResolvedValue(client('manifest-value', async () => ({
    content: [{ type: 'text', text: 'result 1 info manifest-value host-value' }],
  })) as never)
  const name = 'plugin:demo:ordinary'
  const manager = new MCPManager([{
    name, command: 'node', origin: { scope: 'plugin' },
    env: { DEBUG: '1', LOG_LEVEL: 'info', MANIFEST_VALUE: 'manifest-value', HOST_VALUE: 'host-value' },
  }])
  try {
    await manager.start()
    expect(manager.getTools()[0]!.description).toContain('1 info manifest-value')
    expect(JSON.stringify(await manager.getTools()[0]!.execute({}))).toContain('1 info manifest-value host-value')
    expect(JSON.stringify(manager.getConnectedConnection(name)?.config)).not.toContain('manifest-value')
  } finally { await manager.stop() }
})

test('typed plugin secrets are redacted before normalization and observer publication', async () => {
  const observer = { onBegin: vi.fn(), onEnd: vi.fn() }
  vi.mocked(createMCPConnection).mockResolvedValue(client('ordinary', async () => ({
    structuredContent: { pin: 918273, flag: true, ordinary: 42 },
    content: [{ type: 'text', text: 'usable' }],
  })) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:typed', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: ['918273', 'true'] }])
  manager.setCallObserver(observer)
  try {
    await manager.start()
    const result = await manager.getTools()[0]!.execute({})
    expect(JSON.stringify(result)).toContain('usable')
    expect(JSON.stringify(result)).toContain('42')
    expect(JSON.stringify(result)).not.toContain('918273')
    expect(JSON.stringify(result)).not.toContain('"flag":true')
    expect(JSON.stringify(observer.onEnd.mock.calls)).not.toContain('918273')
    expect(JSON.stringify(observer.onEnd.mock.calls)).not.toContain('"flag":true')
  } finally { await manager.stop() }
})

test.each(['t', '1'])('short saved value %s leaves a valid multi-block tool result usable', async secret => {
  vi.mocked(createMCPConnection).mockResolvedValue(client('ordinary', async () => ({
    content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
  })) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:short', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }])
  try {
    await manager.start()
    const result = JSON.stringify(await manager.getTools()[0]!.execute({}))
    expect(result).toContain('first')
    expect(result).toContain('second')
    expect(result).not.toContain('completed with no output')
  } finally { await manager.stop() }
})

test.each(['text', 'content'])('a saved value matching protocol spelling %s preserves tool structure', async secret => {
  vi.mocked(createMCPConnection).mockResolvedValue(client('ordinary', async () => ({
    content: [{ type: 'text', text: 'hello' }],
  })) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:shape', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }])
  try {
    await manager.start()
    const result = await manager.getTools()[0]!.execute({})
    expect(JSON.stringify(result)).toContain('hello')
    expect(JSON.stringify(result)).not.toContain('completed with no output')
  } finally { await manager.stop() }
})

test('structured payload fields named like discriminators still redact their values', async () => {
  vi.mocked(createMCPConnection).mockResolvedValue(client('ordinary', async () => ({
    content: [{ type: 'text', text: 'usable' }],
    structuredContent: { type: 'text', role: 'user', required: true },
  })) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:payload', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: ['text', 'user', 'true'] }])
  try {
    await manager.start()
    const result = JSON.stringify(await manager.getTools()[0]!.execute({}))
    expect(result).toContain('usable')
    expect(result).toContain('"type":"[REDACTED]"')
    expect(result).toContain('"role":"[REDACTED]"')
    expect(result).toContain('"required":"[REDACTED]"')
  } finally { await manager.stop() }
})

test('input schema control fields remain valid while descriptions are redacted', async () => {
  vi.mocked(createMCPConnection).mockResolvedValue({
    listTools: async () => ({ tools: [{ name: 'echo', description: 'ordinary', inputSchema: {
      type: 'object', properties: { true: { type: 'string', description: 'private-phrase' } },
      required: ['true'], additionalProperties: true,
    } }] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'usable' }] }),
    close: async () => {},
  } as never)
  const manager = new MCPManager([{ name: 'plugin:demo:schema', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: ['true', 'private-phrase'] }])
  try {
    await manager.start()
    const schema = manager.getTools()[0]!.inputSchema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['true'])
    expect(schema.additionalProperties).toBe(true)
    expect(JSON.stringify(schema)).not.toContain('private-phrase')
    expect(JSON.stringify(await manager.getTools()[0]!.execute({}))).toContain('usable')
  } finally { await manager.stop() }
})

test('a resource blob containing literal secret bytes is omitted before binary persistence', async () => {
  const secret = 'private-phrase'
  vi.mocked(createMCPConnection).mockResolvedValue(client('ordinary', async () => ({
    content: [{ type: 'resource', resource: { uri: 'file:///safe', blob: Buffer.from(`payload ${secret}`).toString('base64'), mimeType: 'text/plain' } }],
  })) as never)
  const manager = new MCPManager([{ name: 'plugin:demo:binary', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }])
  try {
    await manager.start()
    const result = await manager.getTools()[0]!.execute({})
    expect(JSON.stringify(result)).toContain('omitted')
    expect((result as { metadata?: { mcp?: { binaryArtifacts?: unknown[] } } }).metadata?.mcp?.binaryArtifacts).toEqual([])
  } finally { await manager.stop() }
})
