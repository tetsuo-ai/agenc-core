import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function source(relativePath: string): string {
  return readFileSync(new URL(`../../../src/${relativePath}`, import.meta.url), 'utf8')
}

describe('bound provider request architecture', () => {
  test('does not resolve provider selection or credentials inside request clients', () => {
    const requestClients = [
      source('services/api/client.ts'),
      source('services/api/openaiShim.ts'),
      source('services/api/providerConfig.ts'),
    ].join('\n')

    for (const retiredRead of [
      'getSelectedProvider',
      'getSelectedProviderEnvironment',
      'readGithubToken',
      'readGithubModelsToken',
      'readOpenAiOauthCredentials',
      'refreshOpenAiSubscriptionIfNeeded',
      'resolveSecureStorageHome',
      'process.env',
    ]) {
      expect(requestClients).not.toContain(retiredRead)
    }
  })

  test('requires a bound connection at the compatibility shim boundary', () => {
    const shim = source('services/api/openaiShim.ts')

    expect(shim).toContain('connection: BoundProviderConnection')
    expect(shim).toContain("options.connection.transport !== 'openai-compatible'")
    expect(shim).toContain('provider: self.connection.provider')
    expect(shim).toContain('model: self.connection.model')
    expect(shim).toContain('const baseUrl = self.connection.baseURL')
    expect(shim).toContain('baseUrl,')
  })
})
