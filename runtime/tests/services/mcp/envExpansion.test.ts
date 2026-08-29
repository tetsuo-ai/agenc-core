import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseMcpConfig } from './config.js'
import { expandEnvVarsInString } from './envExpansion.js'

test('MCP interpolation resolves only from the explicit environment', () => {
  assert.deepEqual(
    expandEnvVarsInString(
      '${CAPTURED_VALUE}/${MISSING_VALUE:-fallback}/${UNBOUND_VALUE}',
      { CAPTURED_VALUE: 'captured' },
    ),
    {
      expanded: 'captured/fallback/${UNBOUND_VALUE}',
      missingVars: ['UNBOUND_VALUE'],
    },
  )
})

test('MCP config parsing receives the same explicit interpolation authority', () => {
  const result = parseMcpConfig({
    configObject: {
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://${MCP_HOST}/api',
        },
      },
    },
    expandVars: true,
    environment: { MCP_HOST: 'captured.example.test' },
    scope: 'user',
  })

  assert.equal(result.errors.length, 0)
  assert.equal(
    result.config?.mcpServers.docs?.url,
    'https://captured.example.test/api',
  )
})
