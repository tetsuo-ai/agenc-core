import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENC_DAEMON_METHODS, AGENC_DAEMON_PROTOCOL_VERSION, JSON_RPC_VERSION } from '../../src/app-server/protocol/index.js'
import { AgenCDaemonJsonRpcDispatcher } from '../../src/app-server/daemon-dispatcher.js'
import { AGENC_SDK_DAEMON_METHODS } from '../../../packages/agenc-sdk/src/protocol.js'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SecureStorageData } from '../../src/utils/secureStorage/index.js'
import { NativeSecureStorageError, NativeSecureStorageUnavailableError } from '../../src/utils/secureStorage/native.js'
import { validateUserConfig } from '../../src/utils/plugins/mcpbHandler.js'

const secureStore = vi.hoisted(() => new Map<string, SecureStorageData>())
const nativeUnavailable = vi.hoisted(() => ({ value: false }))
const nativeUnreadable = vi.hoisted(() => ({ value: false }))
const discoveryPause = vi.hoisted(() => ({ wait: null as null | (() => Promise<void>) }))
const validationPause = vi.hoisted(() => ({ wait: null as null | (() => Promise<void>) }))
const staleNativeRead = vi.hoisted(() => ({ value: null as SecureStorageData | null }))
const freshReadHook = vi.hoisted(() => ({ run: null as null | (() => void) }))
vi.mock('../../src/utils/plugins/mcpbHandler.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/plugins/mcpbHandler.js')>()
  return { ...actual, validateUserConfig: async (...args: Parameters<typeof actual.validateUserConfig>) => {
    if (validationPause.wait) await validationPause.wait()
    return actual.validateUserConfig(...args)
  } }
})
vi.mock('../../src/plugins/loader.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/plugins/loader.js')>()
  return { ...actual, loadPlugins: async (...args: Parameters<typeof actual.loadPlugins>) => {
    if (discoveryPause.wait) await discoveryPause.wait()
    return actual.loadPlugins(...args)
  } }
})
vi.mock('../utils/secureStorage/native.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/secureStorage/native.js')>()
  return {
    ...actual,
    readNativeSecureStorage: (home: { path: string }) => {
      if (nativeUnreadable.value) throw new actual.NativeSecureStorageError('Existing secure storage record cannot be read')
      return structuredClone(staleNativeRead.value ?? secureStore.get(home.path) ?? {})
    },
    readNativeSecureStorageFresh: (home: { path: string }) => {
      if (nativeUnreadable.value) throw new actual.NativeSecureStorageError('Existing secure storage record cannot be read')
      if (nativeUnavailable.value) throw new actual.NativeSecureStorageUnavailableError('Secret Service is unavailable')
      const snapshot = structuredClone(secureStore.get(home.path) ?? {})
      freshReadHook.run?.()
      return snapshot
    },
    updateNativeSecureStorage: (home: { path: string }, update: (value: SecureStorageData) => SecureStorageData) => {
      if (nativeUnavailable.value) throw new actual.NativeSecureStorageUnavailableError('Secret Service is unavailable')
      if (nativeUnreadable.value) throw new actual.NativeSecureStorageError('Existing secure storage record cannot be read')
      const previous = structuredClone(secureStore.get(home.path) ?? {})
      const written = structuredClone(update(previous))
      secureStore.set(home.path, written)
      return { previous, written }
    },
    rollbackNativeSecureStorage: (home: { path: string }, transaction: { previous: SecureStorageData } | null) => {
      if (transaction) secureStore.set(home.path, transaction.previous)
    },
  }
})

import { PluginSettingsService } from '../../src/plugins/settings-service.js'
import { listInstalledPlugins } from '../../src/plugins/cli/pluginOperations.js'
import { pluginSignaturePayloadBytes } from '../../src/plugins/resolution.js'
import { ConfigStore } from '../../src/config/store.js'
import { loadPlugins } from '../../src/plugins/loader.js'
import { loadPluginMcpServers } from '../../src/plugins/registration/mcp-plugin-integration.js'
import { runWithCanonicalSettingsAuthority } from '../../src/utils/settings/canonicalAuthority.js'
import { resolveSessionMcpPlan } from '../../src/session/mcp-startup.js'
import { projectMcpManagerToConnections } from '../../src/mcp-client/tui-connections.js'
import { createSavedPluginSecretRedactor, redactSavedPluginSecrets } from '../../src/plugins/secret-redaction.js'
import { decodeStoredPluginSecret } from '../../src/utils/plugins/plugin-secret-codec.js'
import { resolveSchemaOwnedPluginConfig } from '../../src/utils/plugins/pluginConfigAuthority.js'
import { resolvePluginServerTemplate } from '../../src/plugins/registration/common.js'
import { MCPManager } from '../../src/mcp-client/manager.js'
import { createMCPConnection } from '../../src/mcp-client/connection.js'

vi.mock('../../src/mcp-client/connection.js', () => ({ createMCPConnection: vi.fn() }))

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-settings-'))
  roots.push(root)
  const home = join(root, 'home')
  const plugins = join(home, 'plugins')
  const plugin = join(plugins, 'demo')
  const workspace = join(root, 'workspace')
  mkdirSync(join(plugin, '.agenc-plugin'), { recursive: true })
  mkdirSync(workspace)
  writeFileSync(join(home, 'config.toml'), 'config_version = 2\n')
  writeFileSync(join(plugin, '.agenc-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo',
    userConfig: {
      contact: { type: 'string', title: 'EDGAR contact', description: 'SEC requester', required: true, pattern: '.+@.+' },
      token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true },
      secretCount: { type: 'number', title: 'Secret count', description: 'Secret number', sensitive: true },
      count: { type: 'number', title: 'Count', description: 'Count', min: 1 },
      active: { type: 'boolean', title: 'Active', description: 'Active', default: false },
    },
    mcpServers: { edgar: { command: 'node', args: ['server.js'], env: { STONKS_EDGAR_USER_AGENT: '${user_config.contact}' } } },
  }))
  const service = new PluginSettingsService({ home, pluginStorageRoot: plugins, workspaceRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
  return { root, home, plugins, workspace, service }
}
function files(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}
afterEach(() => { vi.mocked(createMCPConnection).mockReset(); secureStore.clear(); nativeUnavailable.value = false; nativeUnreadable.value = false; staleNativeRead.value = null; freshReadHook.run = null; discoveryPause.wait = null; validationPause.wait = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('plugin settings API', () => {
  test('reads, writes, and resets settings over the local daemon protocol', async () => {
    const { service } = fixture()
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      initializeAuthenticator: params => params.authCookie === 'cookie',
      pluginSettings: service,
    })
    const connection = dispatcher.createConnection()
    const request = (method: string, params: Record<string, unknown>) => connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id: method, method, params })
    expect((await request('initialize', { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, authCookie: 'cookie' }) as { result?: unknown }).result).toBeDefined()
    expect((await request('plugin.settings.get', { pluginId: 'demo' }) as { result?: { needsSetup: string[] } }).result?.needsSetup).toEqual(['contact'])
    const written = await request('plugin.settings.set', { pluginId: 'demo', values: { contact: 'owner@example.test', token: 'hidden' } }) as { result?: { values: Record<string, unknown>; sensitiveSet: Record<string, boolean> } }
    expect(written.result?.values.contact).toBe('owner@example.test')
    expect(written.result?.sensitiveSet.token).toBe(true)
    expect(JSON.stringify(written)).not.toContain('hidden')
    expect((await request('plugin.settings.reset', { pluginId: 'demo' }) as { result?: { needsSetup: string[] } }).result?.needsSetup).toEqual(['contact'])
  })
  test('publishes all settings methods in protocol schema and SDK', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../src/app-server/protocol/schema.json'), 'utf8')) as { 'x-agenc-methods': string[]; definitions: Record<string, { properties?: { method?: { const?: string } } }> }
    for (const method of ['plugin.settings.get', 'plugin.settings.set', 'plugin.settings.reset']) {
      expect(AGENC_DAEMON_METHODS).toContain(method)
      expect(AGENC_SDK_DAEMON_METHODS).toContain(method)
      expect(schema['x-agenc-methods']).toContain(method)
      expect(Object.values(schema.definitions).some(definition => definition.properties?.method?.const === method)).toBe(true)
    }
  })
  test('reads declared schema and missing required keys', async () => {
    const { service, home, plugins, workspace, root } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { userConfig: { token: Record<string, unknown> } }
    manifest.userConfig.token.default = 'manifest-secret'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const read = await service.get({ pluginId: 'demo' })
    expect(read.schema.contact).toMatchObject({ title: 'EDGAR contact', required: true })
    expect(read.schema.token?.default).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain('manifest-secret')
    expect(read.values.active).toBe(false)
    expect(read.needsSetup).toEqual(['contact'])
    const inventory = await listInstalledPlugins({ agencHome: home, pluginStorageRoot: plugins, sessionTempRoot: home, workspaceRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    expect(inventory.plugins[0]?.needsSetup).toEqual(['contact'])
  })
  test('retains signed provenance and commands when secure storage cannot be read', async () => {
    const { home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const pluginRoot = join(plugins, 'demo')
    const manifestPath = join(pluginRoot, '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = '1.0.0'
    manifest.commands = { hello: { source: './commands/hello.md' } }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    mkdirSync(join(pluginRoot, 'commands'))
    const command = '# Hello\n'
    writeFileSync(join(pluginRoot, 'commands', 'hello.md'), command)
    writeFileSync(manifestPath, manifestBytes)
    const files = { 'commands/hello.md': `sha256:${createHash('sha256').update(command).digest('hex')}` }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(join(home, 'plugin-publishers.json'), JSON.stringify({ publishers: {
      team: { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
    } }))
    writeFileSync(join(pluginRoot, '.agenc-plugin', 'signature.json'), JSON.stringify({
      publisher: 'team', files,
      signature: sign(null, pluginSignaturePayloadBytes(manifestBytes, files), privateKey).toString('base64'),
    }))
    writeFileSync(join(pluginRoot, '.agenc-plugin', 'agenc-install.json'), JSON.stringify({
      source: pluginRoot, resolutionKind: 'local', signatureRequired: true,
    }))
    nativeUnreadable.value = true
    const inventory = await listInstalledPlugins({ agencHome: home, pluginStorageRoot: plugins,
      sessionTempRoot: join(home, 'temp'), workspaceRoot: workspace,
      env: { AGENC_HOME: home, HOME: root } })
    expect(inventory.plugins[0]).toMatchObject({
      id: 'demo', version: '1.0.0', verificationState: 'verified',
      publisherKeyId: 'team', commands: [{ name: 'demo:hello' }],
    })
    expect(inventory.plugins[0]?.payloadDigest).toMatch(/^sha256:/u)
    expect(inventory.plugins[0]?.needsSetup).toBeUndefined()
    expect(inventory.errors).toContain('demo: plugin settings could not be read')
    expect(JSON.stringify(inventory)).not.toContain('Existing secure storage record cannot be read')
  })
  test('reports metadata and settings failures for the same plugin', async () => {
    const { home, plugins, workspace, root } = fixture()
    writeFileSync(join(plugins, 'demo', '.agenc-plugin', 'agenc-install.json'), '{')
    nativeUnreadable.value = true
    const inventory = await listInstalledPlugins({ agencHome: home, pluginStorageRoot: plugins,
      sessionTempRoot: join(home, 'temp'), workspaceRoot: workspace,
      env: { AGENC_HOME: home, HOME: root } })
    expect(inventory.plugins[0]).toMatchObject({ id: 'demo', verificationState: 'failed' })
    expect(inventory.errors).toContain('demo: invalid .agenc-plugin/agenc-install.json')
    expect(inventory.errors).toContain('demo: plugin settings could not be read')
  })
  test('writes ordinary and sensitive values, with secrets absent from home and reads', async () => {
    const { service, home } = fixture()
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'private-phrase', secretCount: 7 } })
    const read = await service.get({ pluginId: 'demo' })
    expect(read.values.contact).toBe('owner@example.test')
    expect(read.sensitiveSet.token).toBe(true)
    expect(read.sensitiveSet.secretCount).toBe(true)
    expect(JSON.stringify(read)).not.toContain('private-phrase')
    expect(files(home).map(path => readFileSync(path, 'utf8')).join('\n')).not.toContain('private-phrase')
    expect(secureStore.get(home)?.pluginSecrets?.demo?.token).toContain('private-phrase')
    expect(secureStore.get(home)?.pluginSecrets?.demo?.secretCount).toContain('7')
    expect(read.needsSetup).toEqual([])
  })
  test('validates types and required fields, then resets both stores', async () => {
    const { service } = fixture()
    await expect(service.set({ pluginId: 'demo', values: { count: 0 } })).rejects.toThrow(/Count must be at least 1/u)
    await expect(service.set({ pluginId: 'demo', values: { count: Number.NaN } })).rejects.toThrow(/Count must be a number/u)
    await expect(service.set({ pluginId: 'demo', values: { contact: 4 } })).rejects.toThrow(/EDGAR contact must be a string/u)
    await expect(service.set({ pluginId: 'demo', values: { contact: 'not-an-email' } })).rejects.toThrow(/required pattern/u)
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'secret' } })
    await service.reset({ pluginId: 'demo' })
    expect((await service.get({ pluginId: 'demo' })).needsSetup).toEqual(['contact'])
    expect((await service.get({ pluginId: 'demo' })).sensitiveSet.token).toBe(false)
  })
  test('rejects control characters in saved env and header values without echoing them', async () => {
    const { service, plugins } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.token.required = true
    writeFileSync(manifestPath, JSON.stringify(manifest))
    for (const value of ['private\u0000phrase', 'private\nphrase']) {
      let error: unknown
      try { await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: value } }) }
      catch (caught) { error = caught }
      expect(error).toBeDefined()
      expect(String(error)).not.toContain('private')
    }
  })
  test('keeps live session stores untouched while reconnect resolution reads saved settings', async () => {
    const { home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const otherStore = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await otherStore.reload()
    const service = new PluginSettingsService({ home, pluginStorageRoot: plugins, workspaceRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    const published = vi.fn()
    const otherPublished = vi.fn()
    store.subscribe(published)
    otherStore.subscribe(otherPublished)
    await service.set({ pluginId: 'demo', values: { contact: 'first@example.test' } })
    const server = async () => (await resolveSessionMcpPlan(store, {}, {}, new Map(), { pluginStorageRoot: plugins })).configs.find(config => config.name === 'plugin:demo:edgar')
    expect(await server()).toMatchObject({ env: { STONKS_EDGAR_USER_AGENT: 'first@example.test' } })
    await service.set({ pluginId: 'demo', values: { contact: 'second@example.test' } })
    expect(await server()).toMatchObject({ env: { STONKS_EDGAR_USER_AGENT: 'second@example.test' } })
    await service.set({ pluginId: 'demo', values: { token: 'secret-only' } })
    expect(otherStore.current().pluginConfigs?.demo?.options?.contact).toBeUndefined()
    await service.reset({ pluginId: 'demo' })
    expect(await server()).toBeUndefined()
    expect(published).not.toHaveBeenCalled()
    expect(otherPublished).not.toHaveBeenCalled()
  })

  test.each(['cwd', 'command'] as const)('rejects a sensitive setting in MCP %s without exposing its value', async field => {
    const { service, home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.mcpServers.edgar[field] = '${user_config.token}'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: '/private-phrase' } })
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const loaded = await loadPlugins({ pluginStorageRoot: plugins, workspaceRoot: workspace, config: store.current() })
    const errors: unknown[] = []
    const servers = await runWithCanonicalSettingsAuthority(store, () => loadPluginMcpServers({ pluginStorageRoot: plugins, plugins: loaded.enabled, errors: errors as never }))
    expect(servers['plugin:demo:edgar']).toBeUndefined()
    expect(JSON.stringify([...loaded.errors, ...errors])).toContain('token')
    expect(JSON.stringify([...loaded.errors, ...errors])).not.toContain('/private-phrase')
    const projected = projectMcpManagerToConnections({
      getConfiguredServers: () => [{ name: 'plugin:demo:edgar', command: '/private-phrase' }],
      isConnected: () => false,
      getConnectionState: () => ({ type: 'failed', error: 'Could not start /private-phrase' }),
    } as never, value => redactSavedPluginSecrets(value, store.homeContext))
    expect(JSON.stringify(projected)).not.toContain('/private-phrase')
    expect(JSON.stringify(projected)).toContain('[REDACTED]')
  })

  test('keeps saved secret placeholders literal in MCP registration and diagnostics', async () => {
    const { service, home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.mcpServers.edgar.env.TOKEN = '${user_config.token}'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'prefix-${private-phrase}-suffix' } })
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const loaded = await loadPlugins({ pluginStorageRoot: plugins, workspaceRoot: workspace, config: { ...store.current(), plugins: { ...store.current().plugins, enabled: true } } })
    const errors: unknown[] = []
    const servers = await runWithCanonicalSettingsAuthority(store, () => loadPluginMcpServers({ cwd: workspace, pluginStorageRoot: plugins, plugins: loaded.enabled, env: { HOST_TOKEN: 'host-value' }, errors: errors as never }))
    expect(servers['plugin:demo:edgar']?.env?.TOKEN).toBe('prefix-${private-phrase}-suffix')
    expect(JSON.stringify(errors)).not.toContain('private-phrase')
    await service.set({ pluginId: 'demo', values: { token: '${HOST_TOKEN}' } })
    const next = await runWithCanonicalSettingsAuthority(store, () => loadPluginMcpServers({ cwd: workspace, pluginStorageRoot: plugins, plugins: loaded.enabled, env: { HOST_TOKEN: 'host-value' } }))
    expect(next['plugin:demo:edgar']?.env?.TOKEN).toBe('${HOST_TOKEN}')
  })

  test('retains decoded sensitive substitutions after storage rotation and reset', async () => {
    const { service, home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.scopes = { type: 'string', title: 'Scopes', description: 'Scopes', sensitive: true, multiple: true }
    manifest.mcpServers.edgar.env.OPTIONS = 'prefix-${user_config.token}-suffix'
    manifest.mcpServers.edgar.headers = { Authorization: 'Bearer ${user_config.scopes}' }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'old-private-phrase', scopes: ['array-secret-one', 'array-secret-two'] } })
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const plan = await resolveSessionMcpPlan(store, {}, {}, new Map(), { pluginStorageRoot: plugins })
    const config = plan.configs.find(item => item.name === 'plugin:demo:edgar')!
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    vi.mocked(createMCPConnection).mockResolvedValue({
      listTools: async () => ({ tools: [] }),
      listResources: async () => ({ resources: [] }),
      listPrompts: async () => ({ prompts: [] }),
      close: async () => {},
    } as never)
    const manager = new MCPManager([config], logger)
    await manager.start()
    expect(manager.getConnectionState(config.name)?.type).toBe('connected')
    for (const secret of ['old-private-phrase', 'array-secret-one', 'array-secret-two']) {
      expect(manager.redactPluginSecrets(`Authentication failed: ${secret}`)).not.toContain(secret)
    }
    await service.set({ pluginId: 'demo', values: { token: 'new-private-phrase' } })
    await service.reset({ pluginId: 'demo' })
    expect(manager.redactPluginSecrets('Authentication failed: old-private-phrase')).not.toContain('old-private-phrase')
    expect(manager.redactPluginSecrets('Authentication failed: array-secret-two')).not.toContain('array-secret-two')
    vi.mocked(createMCPConnection).mockImplementationOnce(async (_config, connectionLogger) => {
      connectionLogger.error('stderr: old-private-phrase')
      throw new Error('Authentication failed: old-private-phrase')
    })
    const failed = await manager.reconnectServer(config.name)
    expect(JSON.stringify(failed)).not.toContain('old-private-phrase')
    expect(JSON.stringify(manager.getConnectionState(config.name))).not.toContain('old-private-phrase')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('old-private-phrase')
    await manager.stopStrict()
  })
  test('keeps an inherited top-level secret sensitive when a channel declares the same ordinary key', async () => {
    const { service, home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.channels = [{ server: 'edgar', userConfig: {
      token: { type: 'string', title: 'Public channel token', description: 'Optional ordinary override' },
    } }]
    manifest.mcpServers.edgar.env.TOKEN = '${user_config.token}'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const secret = 'inherited-private-credential'
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: secret } })
    expect(files(home).map(path => readFileSync(path, 'utf8')).join('\n')).not.toContain(secret)
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const plan = await resolveSessionMcpPlan(store, {}, {}, new Map(), { pluginStorageRoot: plugins })
    const config = plan.configs.find(item => item.name === 'plugin:demo:edgar')!
    expect(config.env?.TOKEN).toBe(secret)
    expect(config.pluginSecretValues).toContain(secret)
    expect(files(home).map(path => readFileSync(path, 'utf8')).join('\n')).not.toContain(secret)
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    vi.mocked(createMCPConnection).mockImplementationOnce(async (_config, connectionLogger) => {
      connectionLogger.error(`Authentication failed: ${secret}`)
      throw new Error(`Authentication failed: ${secret}`)
    })
    const manager = new MCPManager([config], logger)
    await manager.start()
    expect(JSON.stringify(logger.error.mock.calls)).toContain('Authentication failed')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(manager.getConnectionState(config.name))).not.toContain(secret)
    await manager.stopStrict()
  })
  test.each(['env', 'headers'] as const)('rejects substituted MCP %s control values without echoing them', async field => {
    const { home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.mcpServers.edgar[field] = { [field === 'env' ? 'TOKEN' : 'Authorization']: '${HOST_TOKEN}' }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const loaded = await loadPlugins({ pluginStorageRoot: plugins, workspaceRoot: workspace, config: store.current() })
    const errors: unknown[] = []
    const servers = await runWithCanonicalSettingsAuthority(store, () => loadPluginMcpServers({ pluginStorageRoot: plugins, plugins: loaded.enabled, env: { HOST_TOKEN: 'private\u0000phrase' }, errors: errors as never }))
    expect(servers['plugin:demo:edgar']).toBeUndefined()
    expect(JSON.stringify(errors)).toContain(`Invalid MCP ${field} value`)
    expect(JSON.stringify(errors)).not.toContain('private')
  })

  test('replaces legacy plaintext secrets and reports affected keys without values', async () => {
    const { service, home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[pluginConfigs.demo.options]\ncontact = "owner@example.test"\ntoken = "legacy-secret"\n')
    const read = await service.get({ pluginId: 'demo' })
    expect(read.needsSetup).toContain('token')
    expect(JSON.stringify(read)).not.toContain('legacy-secret')
    const inventory = await listInstalledPlugins({ agencHome: home, pluginStorageRoot: plugins, sessionTempRoot: home, workspaceRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    expect(inventory.plugins[0]?.needsSetup).toContain('token')
    await service.set({ pluginId: 'demo', values: { token: 'replacement-secret' } })
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('legacy-secret')
    expect((await service.get({ pluginId: 'demo' })).sensitiveSet.token).toBe(true)
  })

  test('round trips patterned sensitive string arrays and permits later ordinary updates', async () => {
    const { service, plugins, home } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.scopes = { type: 'string', title: 'Scopes', description: 'Scopes', sensitive: true, multiple: true, pattern: '^[a-z]+$' }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', scopes: ['first', 'second'] } })
    expect(result.needsSetup).toEqual([])
    expect(secureStore.get(home)?.pluginSecrets?.demo?.scopes).toBe('first,second')
    expect(secureStore.get(home)?.pluginSecretFormats?.demo?.scopes).toBe('typed-v2:["first","second"]')
    const projection = createSavedPluginSecretRedactor({ path: home } as never)
    expect(projection('first second')).toBe('[REDACTED] [REDACTED]')
    await expect(service.set({ pluginId: 'demo', values: { scopes: ['BADVALUE'] } })).rejects.toThrow('scopes does not match the required pattern')
    await expect(service.set({ pluginId: 'demo', values: { count: 2 } })).resolves.toMatchObject({ needsSetup: [] })
  })

  test('preserves commas in new secret arrays and keeps unmarked comma-separated values literal', async () => {
    const { service, plugins, home } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.scopes = { type: 'string', title: 'Scopes', description: 'Scopes', sensitive: true, multiple: true }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', scopes: ['first,part', 'second'] } })
    const store = new ConfigStore({ home, cwd: join(home, '..', 'workspace'), projectRoot: join(home, '..', 'workspace'), env: { AGENC_HOME: home } })
    await store.reload()
    const { loadPluginOptions } = await import('../../src/utils/plugins/pluginOptionsStorage.js')
    expect(runWithCanonicalSettingsAuthority(store, () => loadPluginOptions('demo', manifest.userConfig).scopes)).toEqual(['first,part', 'second'])
    secureStore.get(home)!.pluginSecrets!.demo!.scopes = 'first,second'
    delete secureStore.get(home)!.pluginSecretFormats?.demo?.scopes
    expect(runWithCanonicalSettingsAuthority(store, () => loadPluginOptions('demo', manifest.userConfig).scopes)).toBe('first,second')
  })

  test('base reader and substitution receive credential payloads for multiple fields', async () => {
    const { service, plugins, home } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.scopes = { type: 'string', title: 'Scopes', description: 'Scopes', sensitive: true, multiple: true }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    for (const [input, baseCredential] of [
      [['first', 'second'], 'first,second'],
      ['first,second', 'first,second'],
    ] as const) {
      await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', scopes: input } })
      const payload = secureStore.get(home)!.pluginSecrets!.demo!.scopes!
      // This resolver and String substitution are the base build's read path.
      const baseValues = resolveSchemaOwnedPluginConfig('pluginConfigs.demo.options', manifest.userConfig, undefined, { scopes: payload })
      expect(String(baseValues.scopes)).toBe(baseCredential)
      expect(`Bearer ${String(baseValues.scopes)}`).toBe(`Bearer ${baseCredential}`)
    }
  })

  test('redacts the union of saved secret matches that start at different positions', () => {
    const { home } = fixture()
    secureStore.set(home, { pluginSecrets: { demo: { first: 'abcdef', second: 'defghi-secret' } } })
    expect(createSavedPluginSecretRedactor({ path: home } as never)('abcdefghi-secret')).toBe('[REDACTED]')
  })

  test('round trips a new comma-containing scalar in a multiple secret field', async () => {
    const { service, plugins, home } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.scopes = { type: 'string', title: 'Scopes', description: 'Scopes', sensitive: true, multiple: true, pattern: '^first,second$' }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const saved = await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', scopes: 'first,second' } })
    expect(saved.needsSetup).toEqual([])
    expect(secureStore.get(home)?.pluginSecrets?.demo?.scopes).toBe('first,second')
    expect(secureStore.get(home)?.pluginSecretFormats?.demo?.scopes).toBe('typed-v2:"first,second"')
    const projection = createSavedPluginSecretRedactor({ path: home } as never)
    expect(projection('first,second')).toBe('[REDACTED]')
    expect(projection('first and second remain ordinary')).toBe('first and second remain ordinary')
    await expect(service.set({ pluginId: 'demo', values: { count: 2 } })).resolves.toMatchObject({ needsSetup: [] })
  })

  test('reads an existing envelope-looking literal without decoding it', async () => {
    const { service, home } = fixture()
    secureStore.set(home, { pluginSecrets: { demo: { token: 'agenc:secret:v2:"literal-secret"' } } })
    const store = new ConfigStore({ home, cwd: home, projectRoot: home, env: { AGENC_HOME: home } })
    await store.reload()
    const { loadPluginOptions } = await import('../../src/utils/plugins/pluginOptionsStorage.js')
    expect(runWithCanonicalSettingsAuthority(store, () => loadPluginOptions('demo', { token: { type: 'string', sensitive: true } }).token)).toBe('agenc:secret:v2:"literal-secret"')
    expect((await service.get({ pluginId: 'demo' })).sensitiveSet.token).toBe(true)
  })

  test.each([
    ['token', 'agenc:scalar:v1:"first,second"', false],
    ['scopes', 'agenc:scalar:v1:"first,second"', true],
    ['scopes', 'agenc:array:v1:["first"]', true],
  ] as const)('unmarked legacy %s credential %s stays literal through base and current reads', async (key, literal, multiple) => {
    const { home } = fixture()
    const schema = { [key]: { type: 'string', sensitive: true, multiple, pattern: '^first(?:,second)?$' } } as const
    secureStore.set(home, { pluginSecrets: { demo: { [key]: literal } } })
    const baseValues = resolveSchemaOwnedPluginConfig('pluginConfigs.demo.options', schema, undefined, { [key]: literal })
    expect(baseValues[key]).toBe(literal)
    const store = new ConfigStore({ home, cwd: home, projectRoot: home, env: { AGENC_HOME: home } })
    await store.reload()
    const { loadPluginOptions, substituteUserConfigVariables } = await import('../../src/utils/plugins/pluginOptionsStorage.js')
    const currentValues = runWithCanonicalSettingsAuthority(store, () => loadPluginOptions('demo', schema))
    expect(currentValues[key]).toBe(literal)
    expect(substituteUserConfigVariables('Bearer ${user_config.' + key + '}', currentValues)).toBe(`Bearer ${literal}`)
    const validation = await validateUserConfig(currentValues, schema)
    expect(validation.valid).toBe(false)
    expect(validation.invalidKeys).toContain(key)
    expect(validation.errors).toContain(`${key} does not match the required pattern`)
  })

  test('explicit typed-v1 metadata permits decoding a stored array envelope', async () => {
    const { home } = fixture()
    secureStore.set(home, {
      pluginSecrets: { demo: { scopes: 'agenc:array:v1:["first"]' } },
      pluginSecretFormats: { demo: { scopes: 'typed-v1' } },
    })
    const store = new ConfigStore({ home, cwd: home, projectRoot: home, env: { AGENC_HOME: home } })
    await store.reload()
    const { loadPluginOptions } = await import('../../src/utils/plugins/pluginOptionsStorage.js')
    expect(runWithCanonicalSettingsAuthority(store, () => loadPluginOptions('demo', { scopes: { type: 'string', sensitive: true, multiple: true } }).scopes)).toEqual(['first'])
  })

  test('new scalar writes remain literal credentials for older builds', async () => {
    const { service, home } = fixture()
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'private-phrase' } })
    expect(secureStore.get(home)?.pluginSecrets?.demo?.token).toBe('private-phrase')
  })

  test('keeps a scalar number typed when a secret field declares multiple', async () => {
    const { service, plugins, home } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.secretCount.multiple = true
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const saved = await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', secretCount: 7 } })
    expect(saved.needsSetup).toEqual([])
    expect(secureStore.get(home)?.pluginSecrets?.demo?.secretCount).toBe('7')
    expect(secureStore.get(home)?.pluginSecretFormats?.demo?.secretCount).toBe('typed-v2:7')
    await expect(service.set({ pluginId: 'demo', values: { count: 2 } })).resolves.toMatchObject({ needsSetup: [] })
  })

  test('redacts decoded numeric and boolean secrets in projections', async () => {
    const { service, plugins, home, workspace, root } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.secretCount.multiple = true
    manifest.userConfig.secretFlag = { type: 'boolean', title: 'Secret flag', description: 'Secret', sensitive: true, multiple: true }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', secretCount: 918273, secretFlag: true } })
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const projected = projectMcpManagerToConnections({
      getConfiguredServers: () => [{ name: 'plugin:demo:edgar', command: 'node', env: { PIN: '918273', FLAG: 'true' } }],
      isConnected: () => false,
      getConnectionState: () => ({ type: 'failed', error: 'PIN=918273; FLAG=true' }),
    } as never, createSavedPluginSecretRedactor(store.homeContext))
    expect(JSON.stringify(projected)).not.toContain('918273')
    expect(JSON.stringify(projected)).not.toContain('true')
  })

  test('fresh settings reads bypass a stale native cache', async () => {
    const { service, home, plugins, workspace, root } = fixture()
    writeFileSync(join(home, 'config.toml'), 'config_version = 2\n[plugins]\nenabled = true\n')
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.mcpServers.edgar.env.TOKEN = '${user_config.token}'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'replacement' } })
    staleNativeRead.value = { pluginSecrets: { demo: {} } }
    expect((await service.get({ pluginId: 'demo' })).sensitiveSet.token).toBe(true)
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const plan = await resolveSessionMcpPlan(store, {}, {}, new Map(), { pluginStorageRoot: plugins })
    expect(plan.configs.find(config => config.name === 'plugin:demo:edgar')?.env?.TOKEN).toBe('replacement')
  })

  test('revalidates after an ordinary writer changes the validated snapshot', async () => {
    const { service, home } = fixture()
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test' } })
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    validationPause.wait = () => { validationPause.wait = null; entered(); return blocked }
    const saving = service.set({ pluginId: 'demo', values: { count: 2 } })
    await reached
    const { applyCanonicalConfigPatchSync } = await import('../../src/config/update-sync.js')
    applyCanonicalConfigPatchSync(join(home, 'config.toml'), { pluginConfigs: { demo: { options: { contact: 'not-an-email' } } } }, 'user')
    release()
    await expect(saving).rejects.toThrow(/required pattern/u)
  })

  test('revalidates after a secure writer changes the validated snapshot', async () => {
    const { service, home, plugins } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.token.required = true
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'first-secret' } })
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    validationPause.wait = () => { validationPause.wait = null; entered(); return blocked }
    const saving = service.set({ pluginId: 'demo', values: { count: 2 } })
    await reached
    delete secureStore.get(home)?.pluginSecrets?.demo?.token
    release()
    await expect(saving).rejects.toThrow(/token is required/u)
  })

  test('validates the captured A snapshots through an A to B to A interleaving', async () => {
    const { service, home } = fixture()
    const { applyCanonicalConfigPatchSync } = await import('../../src/config/update-sync.js')
    const configPath = join(home, 'config.toml')
    applyCanonicalConfigPatchSync(configPath, { pluginConfigs: { demo: { options: { contact: 'not-an-email' } } } }, 'user')
    let reads = 0
    freshReadHook.run = () => {
      if (++reads !== 1) return
      applyCanonicalConfigPatchSync(configPath, { pluginConfigs: { demo: { options: { contact: 'valid@example.test' } } } }, 'user')
    }
    validationPause.wait = async () => {
      validationPause.wait = null
      applyCanonicalConfigPatchSync(configPath, { pluginConfigs: { demo: { options: { contact: 'not-an-email' } } } }, 'user')
    }
    await expect(service.set({ pluginId: 'demo', values: { count: 2 } })).rejects.toThrow(/required pattern/u)
  })

  test('validates the captured secure snapshot through an A to B to A interleaving', async () => {
    const { service, home, plugins } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.token.required = true
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'temporary-valid-token' } })
    delete secureStore.get(home)?.pluginSecrets?.demo?.token
    let reads = 0
    freshReadHook.run = () => {
      if (++reads !== 1) return
      secureStore.get(home)!.pluginSecrets!.demo!.token = 'temporary-valid-token'
    }
    validationPause.wait = async () => {
      validationPause.wait = null
      delete secureStore.get(home)?.pluginSecrets?.demo?.token
    }
    await expect(service.set({ pluginId: 'demo', values: { count: 2 } })).rejects.toThrow(/token is required/u)
  })

  test.each([
    'agenc:array:v1:["one"]',
    'agenc:scalar:v1:"one"',
    'agenc:value:v1:918273',
    'agenc:secret:v2:"one"',
  ])('round-trips literal scalar secret %s', async token => {
    const { service, home } = fixture()
    const saved = await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token } })
    expect(saved.needsSetup).toEqual([])
    expect(decodeStoredPluginSecret(secureStore.get(home)?.pluginSecrets?.demo?.token ?? '', { type: 'string' })).toBe(token)
    const projection = createSavedPluginSecretRedactor({ path: home } as never)
    expect(projection(token)).toBe('[REDACTED]')
    expect(projection('one and 918273 remain ordinary')).toBe('one and 918273 remain ordinary')
    const store = new ConfigStore({ home, cwd: home, projectRoot: home, env: { AGENC_HOME: home } })
    await store.reload()
    const { loadPluginOptions } = await import('../../src/utils/plugins/pluginOptionsStorage.js')
    expect(await runWithCanonicalSettingsAuthority(store, () => loadPluginOptions('demo', { token: { type: 'string', sensitive: true } }))).toMatchObject({ token })
  })

  test('a comma-containing scalar secret never registers its fragments for projections', async () => {
    const { service, home } = fixture()
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'hello,1' } })
    const projection = createSavedPluginSecretRedactor({ path: home } as never)
    expect(projection('hello,1')).toBe('[REDACTED]')
    expect(projection('hello and tool1 remain ordinary')).toBe('hello and tool1 remain ordinary')
  })

  test('a saved secret shorter than four characters leaves projections usable', async () => {
    const { service, home } = fixture()
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 't' } })
    const projection = createSavedPluginSecretRedactor({ path: home } as never)
    expect(projection('text and tool')).toBe('text and tool')
  })

  test('server placeholders resolve once even when a built-in path contains a sensitive placeholder', () => {
    const plugin = {
      id: 'demo', root: '/plugins/${user_config.token}/demo',
      manifest: { userConfig: { token: { type: 'string', sensitive: true } } },
    } as never
    const result = resolvePluginServerTemplate('${AGENC_PLUGIN_ROOT}/server.js', plugin, {
      schemaOwnedValues: { token: 'private-phrase' },
      schema: { token: { type: 'string', sensitive: true } },
    })
    expect(result.value).toBe('/plugins/${user_config.token}/demo/server.js')
    expect(result.value).not.toContain('private-phrase')
  })

  test('reset removes an ordinary option added by another config writer after store load', async () => {
    const { service, home, workspace, root } = fixture()
    const store = new ConfigStore({ home, cwd: workspace, projectRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    await store.reload()
    const { applyCanonicalConfigPatchSync } = await import('../../src/config/update-sync.js')
    const { resetPluginOptions } = await import('../../src/utils/plugins/pluginOptionsStorage.js')
    applyCanonicalConfigPatchSync(join(home, 'config.toml'), { pluginConfigs: { demo: { options: { contact: 'writer@example.test' } } } }, 'user')
    await runWithCanonicalSettingsAuthority(store, () => resetPluginOptions('demo', ['contact', 'token']))
    const reset = await service.get({ pluginId: 'demo' })
    expect(reset.needsSetup).toContain('contact')
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('writer@example.test')
  })

  test('fails reset while native storage is unavailable and retains the saved credential', async () => {
    const { service } = fixture()
    await service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'private-phrase' } })
    nativeUnavailable.value = true
    await expect(service.reset({ pluginId: 'demo' })).rejects.toThrow(NativeSecureStorageUnavailableError)
    nativeUnavailable.value = false
    expect((await service.get({ pluginId: 'demo' })).sensitiveSet.token).toBe(true)
  })

  test('rejects empty numeric and boolean values without saving them', async () => {
    const { service, home } = fixture()
    await expect(service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', count: '', active: '' } })).rejects.toThrow()
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('count =')
  })

  test('keeps ordinary operations fail-closed for an unreadable existing secure store', async () => {
    const { service } = fixture()
    nativeUnreadable.value = true
    await expect(service.set({ pluginId: 'demo', values: { contact: 'owner@example.test' } })).rejects.toThrow(NativeSecureStorageError)
    await expect(service.reset({ pluginId: 'demo' })).rejects.toThrow(NativeSecureStorageError)
  })

  test('serializes reset with a save that starts during plugin discovery', async () => {
    const { service } = fixture()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    discoveryPause.wait = () => { discoveryPause.wait = null; enter(); return blocked }
    const resetting = service.reset({ pluginId: 'demo' })
    await entered
    const saving = service.set({ pluginId: 'demo', values: { contact: 'owner@example.test', token: 'secret' } })
    await Promise.race([saving, new Promise(resolve => setTimeout(resolve, 100))])
    release()
    await Promise.all([resetting, saving])
    const result = await service.get({ pluginId: 'demo' })
    expect([result.values.contact, result.sensitiveSet.token]).toEqual(
      result.values.contact === undefined ? [undefined, false] : ['owner@example.test', true],
    )
  })

  test('bounds validation of a malicious default pattern', async () => {
    const { service, plugins } = fixture()
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.userConfig.danger = { type: 'string', title: 'Danger', description: 'Danger', pattern: '^(a+)+$', default: `${'a'.repeat(26)}!` }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const started = performance.now()
    const read = await service.get({ pluginId: 'demo' })
    expect(read.needsSetup).toContain('danger')
    expect(performance.now() - started).toBeLessThan(250)
    expect((await validateUserConfig({ danger: 'safe' }, { danger: manifest.userConfig.danger })).valid).toBe(false)
  })

  test('bounds one validation pass with twenty malicious defaults', async () => {
    const { service, plugins, home, workspace, root } = fixture()
    const schema = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`danger${index}`, { type: 'string', title: `Danger ${index}`, description: 'Danger', pattern: '^(a+)+$', default: `${'a'.repeat(32)}!` }]))
    const values = Object.fromEntries(Object.entries(schema).map(([key, field]) => [key, field.default]))
    const started = performance.now()
    let eventLoopResponsive = false
    const timer = setTimeout(() => { eventLoopResponsive = true }, 0)
    const result = await validateUserConfig(values, schema as never)
    clearTimeout(timer)
    expect(eventLoopResponsive).toBe(true)
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(20)
    expect(performance.now() - started).toBeLessThan(250)
    const manifestPath = join(plugins, 'demo', '.agenc-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    Object.assign(manifest.userConfig, schema)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const readStart = performance.now()
    expect((await service.get({ pluginId: 'demo' })).needsSetup.filter(key => key.startsWith('danger'))).toHaveLength(20)
    expect(performance.now() - readStart).toBeLessThan(250)
    const inventoryStart = performance.now()
    const inventory = await listInstalledPlugins({ agencHome: home, pluginStorageRoot: plugins, sessionTempRoot: home, workspaceRoot: workspace, env: { AGENC_HOME: home, HOME: root } })
    expect(inventory.plugins[0]?.needsSetup?.filter(key => key.startsWith('danger'))).toHaveLength(20)
    expect(performance.now() - inventoryStart).toBeLessThan(250)
  })
})
