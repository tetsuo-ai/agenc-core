import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'

const mcpAuthMocks = vi.hoisted(() => ({
  logMCPDebug: vi.fn(),
}))

vi.mock('../../utils/log.js', () => ({
  logMCPDebug: mcpAuthMocks.logMCPDebug,
}))

import {
  AgenCAuthProvider,
  validateMcpOAuthAuthorizationServerMetadata,
  validateOAuthCallbackParams,
} from './auth.js'
import type { McpSSEServerConfig } from './types.js'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const validOAuthMetadata = {
  issuer: 'https://auth.example.test',
  authorization_endpoint: 'https://auth.example.test/authorize',
  token_endpoint: 'https://auth.example.test/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
}

test('OAuth callback rejects error parameters before state validation can be bypassed', () => {
  const result = validateOAuthCallbackParams(
    {
      error: 'access_denied',
      error_description: 'denied by provider',
    },
    'expected-state',
  )

  assert.deepEqual(result, { type: 'state_mismatch' })
})

test('OAuth callback accepts provider errors only when state matches', () => {
  const result = validateOAuthCallbackParams(
    {
      state: 'expected-state',
      error: 'access_denied',
      error_description: 'denied by provider',
      error_uri: 'https://example.test/error',
    },
    'expected-state',
  )

  assert.deepEqual(result, {
    type: 'error',
    error: 'access_denied',
    errorDescription: 'denied by provider',
    errorUri: 'https://example.test/error',
    message:
      'OAuth error: access_denied - denied by provider (See: https://example.test/error)',
  })
})

test('OAuth callback accepts authorization codes only when state matches', () => {
  assert.deepEqual(
    validateOAuthCallbackParams(
      {
        state: 'expected-state',
        code: 'auth-code',
      },
      'expected-state',
    ),
    { type: 'code', code: 'auth-code' },
  )

  assert.deepEqual(
    validateOAuthCallbackParams(
      {
        state: 'wrong-state',
        code: 'auth-code',
      },
      'expected-state',
    ),
    { type: 'state_mismatch' },
  )
})

test('configured auth metadata invalid JSON is logged as a controlled discovery failure', async () => {
  const metadataUrl =
    'https://auth.example.test/.well-known/oauth-authorization-server'
  const fetchMock = vi.fn(async () =>
    new Response('<html>login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)

  const serverConfig: McpSSEServerConfig = {
    type: 'sse',
    url: 'https://mcp.example.test/sse',
    oauth: {
      authServerMetadataUrl: metadataUrl,
    },
  }
  const provider = new AgenCAuthProvider('configured-auth', serverConfig)

  await expect(provider.discoveryState()).resolves.toBeUndefined()

  expect(fetchMock).toHaveBeenCalledWith(
    metadataUrl,
    expect.objectContaining({
      headers: { Accept: 'application/json' },
    }),
  )
  expect(mcpAuthMocks.logMCPDebug).toHaveBeenCalledWith(
    'configured-auth',
    expect.stringContaining(
      `Configured auth server metadata returned invalid JSON from ${metadataUrl}`,
    ),
  )
})

test('MCP OAuth metadata rejects plaintext authorization server endpoints', () => {
  assert.throws(
    () =>
      validateMcpOAuthAuthorizationServerMetadata({
        ...validOAuthMetadata,
        token_endpoint: 'http://auth.example.test/token',
      }),
    /token_endpoint must use https:\/\//,
  )

  assert.throws(
    () =>
      validateMcpOAuthAuthorizationServerMetadata({
        ...validOAuthMetadata,
        registration_endpoint: 'http://auth.example.test/register',
      }),
    /registration_endpoint must use https:\/\//,
  )
})

test('MCP OAuth metadata requires S256 PKCE before authorization redirect', async () => {
  const provider = new AgenCAuthProvider(
    'pkce-auth',
    {
      type: 'sse',
      url: 'https://mcp.example.test/sse',
    },
    'http://127.0.0.1:3000/callback',
    true,
    vi.fn(),
    true,
  )

  provider.setMetadata({
    ...validOAuthMetadata,
    code_challenge_methods_supported: undefined,
  })

  await expect(
    provider.redirectToAuthorization(
      new URL('https://auth.example.test/authorize'),
    ),
  ).rejects.toThrow(/code_challenge_methods_supported must include S256/)
})

test('configured auth metadata with plaintext endpoints is logged as a controlled discovery failure', async () => {
  const metadataUrl =
    'https://auth.example.test/.well-known/oauth-authorization-server'
  const fetchMock = vi.fn(async () =>
    Response.json({
      ...validOAuthMetadata,
      token_endpoint: 'http://auth.example.test/token',
    }),
  )
  vi.stubGlobal('fetch', fetchMock)

  const serverConfig: McpSSEServerConfig = {
    type: 'sse',
    url: 'https://mcp.example.test/sse',
    oauth: {
      authServerMetadataUrl: metadataUrl,
    },
  }
  const provider = new AgenCAuthProvider('plaintext-auth', serverConfig)

  await expect(provider.discoveryState()).resolves.toBeUndefined()

  expect(mcpAuthMocks.logMCPDebug).toHaveBeenCalledWith(
    'plaintext-auth',
    expect.stringContaining('token_endpoint must use https://'),
  )
})
