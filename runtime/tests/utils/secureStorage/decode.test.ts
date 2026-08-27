import { describe, expect, test } from 'vitest'

import { decodeSecureStorageData } from '../../../src/utils/secureStorage/decode.js'

describe('native secure storage decoder', () => {
  test.each([
    ['null', /non-null JSON object/u],
    ['[]', /non-null JSON object/u],
    ['"secret"', /non-null JSON object/u],
    ['42', /non-null JSON object/u],
    ['{"primaryApiKey":"one","primaryApiKey":"two"}', /duplicate object keys/u],
  ])('rejects corrupt shared-storage payload %s', (payload, message) => {
    expect(() => decodeSecureStorageData(payload, 'test secure storage')).toThrow(message)
  })

  test('accepts a plain credential object', () => {
    expect(
      decodeSecureStorageData(
        '{"primaryApiKey":"secret"}',
        'test secure storage',
      ),
    ).toEqual({ primaryApiKey: 'secret' })
  })

  test('drops retired MCP step-up state without disturbing other credentials', () => {
    expect(
      decodeSecureStorageData(
        JSON.stringify({
          primaryApiKey: 'unrelated-secret',
          mcpOAuth: {
            retired: {
              serverName: 'retired',
              serverUrl: 'https://retired.example.test/mcp',
              accessToken: 'retired-access-token',
              expiresAt: 1,
              scope: 'read',
              stepUpScope: 'write',
            },
            current: {
              serverName: 'current',
              serverUrl: 'https://current.example.test/mcp',
              accessToken: 'current-access-token',
              expiresAt: 2,
            },
          },
        }),
        'test secure storage',
      ),
    ).toEqual({
      primaryApiKey: 'unrelated-secret',
      mcpOAuth: {
        retired: {
          serverName: 'retired',
          serverUrl: 'https://retired.example.test/mcp',
          accessToken: 'retired-access-token',
          expiresAt: 1,
          scope: 'read',
        },
        current: {
          serverName: 'current',
          serverUrl: 'https://current.example.test/mcp',
          accessToken: 'current-access-token',
          expiresAt: 2,
        },
      },
    })
  })
})
