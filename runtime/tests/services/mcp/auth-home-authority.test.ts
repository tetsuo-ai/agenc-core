import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { vi } from 'vitest'
import type { SecureStorageData } from '../../../src/utils/secureStorage/index.js'

const secureStorageRecords = vi.hoisted(
  () => new Map<string, SecureStorageData>(),
)

vi.mock('../../utils/secureStorage/native.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../src/utils/secureStorage/native.js')>()
  return {
    ...actual,
    readNativeSecureStorage: (home: { path: string }) =>
      structuredClone(secureStorageRecords.get(home.path) ?? {}),
    readNativeSecureStorageAsync: async (home: { path: string }) =>
      structuredClone(secureStorageRecords.get(home.path) ?? {}),
    updateNativeSecureStorage: (
      home: { path: string },
      updater: (current: SecureStorageData) => SecureStorageData,
    ) => {
      const previous = structuredClone(secureStorageRecords.get(home.path) ?? {})
      const written = structuredClone(updater(previous))
      if (JSON.stringify(previous) === JSON.stringify(written)) return null
      secureStorageRecords.set(home.path, written)
      return { previous, written }
    },
    rollbackNativeSecureStorage: (
      home: { path: string },
      transaction: { previous: SecureStorageData; written: SecureStorageData } | null,
      updater: (
        current: SecureStorageData,
        transaction: { previous: SecureStorageData; written: SecureStorageData },
      ) => SecureStorageData,
    ) => {
      if (transaction === null) return
      const current = structuredClone(secureStorageRecords.get(home.path) ?? {})
      secureStorageRecords.set(home.path, structuredClone(updater(current, transaction)))
    },
  }
})

import { resolveHomeContext, type HomeContext } from '../../../src/config/home.js'
import {
  AgenCAuthProvider,
  clearMcpClientConfig,
  clearServerTokensFromSecureStorage,
  getServerKey,
  saveMcpClientSecret,
} from '../../../src/services/mcp/auth.js'
import type { McpSSEServerConfig } from '../../../src/services/mcp/types.js'
import {
  clearIdpClientSecret,
  getIdpClientSecret,
  saveIdpClientSecret,
} from '../../../src/services/mcp/xaaIdpLogin.js'

const temporaryDirectories: string[] = []

function home(name: string): HomeContext {
  const root = mkdtempSync(join(tmpdir(), `agenc-mcp-${name}-`))
  temporaryDirectories.push(root)
  const path = join(root, 'home')
  mkdirSync(path, { recursive: true })
  return resolveHomeContext(
    { AGENC_HOME: path, HOME: root },
    { platformHome: root },
  )
}

function server(url: string): McpSSEServerConfig {
  return { type: 'sse', url, scope: 'user' }
}

afterEach(() => {
  secureStorageRecords.clear()
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('MCP native credential authority', () => {
  test('isolates OAuth and XAA credentials by explicit HomeContext', async () => {
    const first = home('first')
    const second = home('second')
    const config = server('https://mcp.example.test/sse')

    saveMcpClientSecret(first, 'demo', config, 'first-client-secret')
    saveMcpClientSecret(second, 'demo', config, 'second-client-secret')
    saveIdpClientSecret('https://idp.example.test', 'first-idp-secret', first)
    saveIdpClientSecret('https://idp.example.test', 'second-idp-secret', second)

    await new AgenCAuthProvider(first, 'demo', config).saveTokens({
      access_token: 'first-access-token',
      token_type: 'Bearer',
    })
    await new AgenCAuthProvider(second, 'demo', config).saveTokens({
      access_token: 'second-access-token',
      token_type: 'Bearer',
    })

    const key = getServerKey('demo', config)
    expect(secureStorageRecords.get(first.path)?.mcpOAuth?.[key]?.accessToken).toBe(
      'first-access-token',
    )
    expect(secureStorageRecords.get(second.path)?.mcpOAuth?.[key]?.accessToken).toBe(
      'second-access-token',
    )
    expect(getIdpClientSecret('https://idp.example.test', first)).toBe(
      'first-idp-secret',
    )
    expect(getIdpClientSecret('https://idp.example.test', second)).toBe(
      'second-idp-secret',
    )
  })

  test('serialized namespace updates preserve unrelated credentials', async () => {
    const authority = home('preservation')
    const alpha = server('https://alpha.example.test/sse')
    const beta = server('https://beta.example.test/sse')
    secureStorageRecords.set(authority.path, {
      primaryApiKey: 'unrelated-primary-key',
      pluginSecrets: { 'unrelated@local': { token: 'plugin-secret' } },
    })

    saveMcpClientSecret(authority, 'alpha', alpha, 'alpha-client-secret')
    saveMcpClientSecret(authority, 'beta', beta, 'beta-client-secret')
    await new AgenCAuthProvider(authority, 'alpha', alpha).saveTokens({
      access_token: 'alpha-access-token',
      token_type: 'Bearer',
    })
    await new AgenCAuthProvider(authority, 'beta', beta).saveTokens({
      access_token: 'beta-access-token',
      token_type: 'Bearer',
    })

    clearServerTokensFromSecureStorage(authority, 'alpha', alpha)
    clearMcpClientConfig(authority, 'alpha', alpha)
    clearIdpClientSecret('https://missing.example.test', authority)

    const stored = secureStorageRecords.get(authority.path)
    expect(stored?.primaryApiKey).toBe('unrelated-primary-key')
    expect(stored?.pluginSecrets).toEqual({
      'unrelated@local': { token: 'plugin-secret' },
    })
    expect(stored?.mcpOAuth?.[getServerKey('alpha', alpha)]).toBeUndefined()
    expect(stored?.mcpOAuth?.[getServerKey('beta', beta)]?.accessToken).toBe(
      'beta-access-token',
    )
    expect(
      stored?.mcpOAuthClientConfig?.[getServerKey('beta', beta)]?.clientSecret,
    ).toBe('beta-client-secret')
  })
})
