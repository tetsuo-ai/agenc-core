import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const CLIENT_SOURCE = readFileSync(
  new URL('../../../src/services/mcp/client.ts', import.meta.url),
  'utf8',
)
const MCP_AUTHORITY_SOURCES = [
  'client.ts',
  'config.ts',
  'envExpansion.ts',
  'headersHelper.ts',
].map(name => readFileSync(
  new URL(`../../../src/services/mcp/${name}`, import.meta.url),
  'utf8',
))

describe('MCP connection authority', () => {
  test('never reacquires provider or runtime authority from an ambient session', () => {
    expect(CLIENT_SOURCE).not.toContain('peekAmbientRuntimeSession')
    expect(CLIENT_SOURCE).not.toContain('capturedMcpEnvironment')
    expect(CLIENT_SOURCE).toContain('mcpConnectionAuthority(client)')
  })

  test('MCP config, helpers, and lifecycle never read process environment', () => {
    for (const source of MCP_AUTHORITY_SOURCES) {
      expect(source).not.toContain('process.env')
    }
  })

  test('binds environment and command-wrapper authority into the connection cache key', () => {
    expect(CLIENT_SOURCE).toContain('mcpEnvironmentIdentity(environment)')
    expect(CLIENT_SOURCE).toContain('command-wrapper-')
    expect(CLIENT_SOURCE).toContain('MCP_CONNECTION_AUTHORITIES.set')
  })
})
