import { afterEach, expect, test, vi } from 'vitest'
import { MCPManager } from '../../src/mcp-client/manager.js'

vi.mock('../../src/mcp-client/connection.js', () => ({ createMCPConnection: vi.fn() }))
vi.mock('../../src/budget/admitted-legacy-tool-call.js', () => ({
  runAdmittedSessionBoundToolCall: async (options: { invoke: (input: { signal: AbortSignal }) => Promise<unknown> }) =>
    options.invoke({ signal: new AbortController().signal }),
}))
import { createMCPConnection } from '../../src/mcp-client/connection.js'

afterEach(() => vi.resetAllMocks())

test('plugin companion catalogs, reads, rendered prompts and failures redact on initial connection and reconnect', async () => {
  const secret = 'private-phrase'
  const name = 'plugin:demo:companion'
  const rawUri = `file:///${secret}`
  const rawPrompt = `review-${secret}`
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let fail = false
  const reads = vi.fn()
  const renders = vi.fn()
  const makeClient = () => ({
    listTools: async () => ({ tools: [] }),
    listResources: async () => { if (fail) throw new Error(`catalog ${secret}`); return { resources: [{ uri: rawUri, name: `resource ${secret}`, description: `about ${secret}` }] } },
    readResource: async (request: { uri: string }) => { reads(request.uri); if (fail) throw new Error(`read ${secret}`); return { contents: [{ uri: rawUri, text: `read ${secret}` }] } },
    listPrompts: async () => { if (fail) throw new Error(`catalog ${secret}`); return { prompts: [{ name: rawPrompt, description: `prompt ${secret}`, arguments: [{ name: secret, description: `arg ${secret}` }] }] } },
    getPrompt: async (request: { name: string; arguments?: Record<string, unknown> }) => { renders(request); if (fail) throw new Error(`render ${secret}`); return { messages: [{ role: 'user', content: { type: 'text', text: `render ${secret}` } }] } },
    close: async () => {},
  })
  vi.mocked(createMCPConnection).mockImplementation(async () => makeClient() as never)
  const manager = new MCPManager([{ name, command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }], logger)
  try {
    await manager.start()
    for (let attempt = 0; attempt < 2; attempt++) {
      const resources = await manager.getResources()
      expect(JSON.stringify(resources)).toContain('[REDACTED]')
      expect(JSON.stringify(resources)).not.toContain(secret)
      const read = await manager.readResource(resources[0]!.namespacedName)
      expect(JSON.stringify(read)).toContain('[REDACTED]')
      expect(JSON.stringify(read)).not.toContain(secret)
      expect(reads).toHaveBeenLastCalledWith(rawUri)
      const prompts = await manager.listPrompts()
      expect(JSON.stringify(prompts)).toContain('[REDACTED]')
      expect(JSON.stringify(prompts)).not.toContain(secret)
      const rendered = await manager.renderPrompt(prompts[0]!.namespacedName, { [prompts[0]!.arguments![0]!.name]: 'value' })
      expect(JSON.stringify(rendered)).toContain('[REDACTED]')
      expect(JSON.stringify(rendered)).not.toContain(secret)
      expect(renders).toHaveBeenLastCalledWith({ name: rawPrompt, arguments: { [secret]: 'value' } })
      fail = true
      await expect(manager.getResources()).resolves.toEqual([])
      await expect(manager.listPrompts()).resolves.toEqual([])
      await expect(manager.readResource(resources[0]!.namespacedName)).rejects.toThrow('read [REDACTED]')
      await expect(manager.renderPrompt(prompts[0]!.namespacedName)).rejects.toThrow('render [REDACTED]')
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret)
      fail = false
      if (attempt === 0) await manager.reconnectServer(name)
    }
  } finally { await manager.stop() }
})

test('redacted companion identities stay distinct and route to their original upstream entries', async () => {
  const secrets = ['alpha-private', 'beta-private']
  const name = 'plugin:demo:identities'
  const uris = secrets.map(secret => `file:///${secret}`)
  const promptNames = secrets.map(secret => `review-${secret}`)
  vi.mocked(createMCPConnection).mockResolvedValue({
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: uris.map(uri => ({ uri })) }),
    readResource: async (request: { uri: string }) => ({ contents: [{ uri: request.uri, text: request.uri === uris[0] ? 'first' : 'second' }] }),
    listPrompts: async () => ({ prompts: promptNames.map(prompt => ({ name: prompt })) }),
    getPrompt: async (request: { name: string }) => ({ messages: [{ role: 'user', content: { type: 'text', text: request.name === promptNames[0] ? 'first' : 'second' } }] }),
    close: async () => {},
  } as never)
  const manager = new MCPManager([{ name, command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: secrets }])
  try {
    await manager.start()
    const resources = await manager.getResources()
    expect(new Set(resources.map(resource => resource.namespacedName)).size).toBe(2)
    expect(JSON.stringify(await manager.readResource(resources[0]!.namespacedName))).toContain('first')
    expect(JSON.stringify(await manager.readResource(resources[1]!.namespacedName))).toContain('second')
    const prompts = await manager.listPrompts()
    expect(new Set(prompts.map(prompt => prompt.namespacedName)).size).toBe(2)
    expect(JSON.stringify(await manager.renderPrompt(prompts[0]!.namespacedName))).toContain('first')
    expect(JSON.stringify(await manager.renderPrompt(prompts[1]!.namespacedName))).toContain('second')
  } finally { await manager.stop() }
})

test('prompt bridge redacts embedded resource text and URI and omits secret-bearing blobs', async () => {
  const secret = 'AAAA'
  vi.mocked(createMCPConnection).mockResolvedValue({
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [{ name: 'embedded-resource' }] }),
    getPrompt: async () => ({ messages: [
      { role: 'user', content: { type: 'resource', resource: { uri: `test://${secret}`, text: `text ${secret}`, mimeType: 'text/plain' } } },
      { role: 'assistant', content: { type: 'resource', resource: { uri: `test://${secret}`, blob: 'AAAAAAAA', mimeType: 'application/octet-stream' } } },
      { role: 'user', content: { type: 'resource', resource: { uri: 'test://decoded', blob: Buffer.from(secret).toString('base64'), mimeType: 'application/octet-stream' } } },
    ] }),
    close: async () => {},
  } as never)
  const manager = new MCPManager([{ name: 'plugin:demo:prompt-resource', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }])
  try {
    await manager.start()
    const prompt = (await manager.listPrompts())[0]!
    const rendered = await manager.renderPrompt(prompt.namespacedName)
    const text = rendered.messages[1]!.rawContent as { type: string; resource: { uri: string; text: string; mimeType: string } }
    const binary = rendered.messages[2]!.rawContent as { type: string; resource: { uri: string; blob: string; mimeType: string; omitted?: boolean } }
    const decodedBinary = rendered.messages[3]!.rawContent as { type: string; resource: { uri: string; blob: string; mimeType: string; omitted?: boolean } }
    expect(text).toEqual({ type: 'resource', resource: { uri: 'test://[REDACTED]', text: 'text [REDACTED]', mimeType: 'text/plain' } })
    expect(binary).toEqual({ type: 'resource', resource: { uri: 'test://[REDACTED]', blob: '', mimeType: 'application/octet-stream', omitted: true } })
    expect(decodedBinary).toEqual({ type: 'resource', resource: { uri: 'test://decoded', blob: '', mimeType: 'application/octet-stream', omitted: true } })
    expect(JSON.stringify(rendered)).not.toContain(secret)
  } finally { await manager.stop() }
})

test('embedded prompt resource metadata keys and resource read metadata cannot expose saved secrets', async () => {
  const secret = 'private-phrase'
  const uri = 'test://metadata'
  const metadata = { downloadStatus: { [`https://example.test/?token=${secret}`]: `expired ${secret}` } }
  vi.mocked(createMCPConnection).mockResolvedValue({
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [{ uri }] }),
    readResource: async () => ({ contents: [{ uri, text: 'resource body', _meta: metadata }] }),
    listPrompts: async () => ({ prompts: [{ name: 'embedded-resource' }] }),
    getPrompt: async () => ({ messages: [{ role: 'user', content: {
      type: 'resource', resource: { uri, text: 'prompt body', mimeType: 'text/plain', _meta: metadata },
    } }] }),
    close: async () => {},
  } as never)
  const manager = new MCPManager([{ name: 'plugin:demo:resource-meta', command: 'node', origin: { scope: 'plugin' }, pluginSecretValues: [secret] }])
  try {
    await manager.start()
    const prompt = (await manager.listPrompts())[0]!
    const rendered = await manager.renderPrompt(prompt.namespacedName)
    const rawContent = rendered.messages[1]!.rawContent as {
      resource: { _meta: { downloadStatus: Record<string, string> } }
    }
    expect(rawContent.resource._meta.downloadStatus).toEqual({
      'https://example.test/?token=[REDACTED]': 'expired [REDACTED]',
    })
    expect(JSON.stringify(rendered)).not.toContain(secret)
    const resource = (await manager.getResources())[0]!
    const read = await manager.readResource(resource.namespacedName)
    expect(JSON.stringify(read)).not.toContain(secret)
    expect(read.contents[0]).not.toHaveProperty('_meta')
  } finally { await manager.stop() }
})
