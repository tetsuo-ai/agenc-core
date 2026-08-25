import { describe, expect, test } from 'vitest'

import { AgentDefinitionSchema } from '../../../src/entrypoints/sdk/coreSchemas.js'
import { McpServerConfigSchema } from '../../../src/services/mcp/types.js'

const retiredSdkTransport = {
  type: 'sdk',
  name: 'retired',
} as const

describe('retired in-process SDK MCP transport', () => {
  test('runtime MCP configuration rejects the retired transport', () => {
    expect(
      McpServerConfigSchema().safeParse({
        type: 'stdio',
        command: 'mcp-server',
      }).success,
    ).toBe(true)
    expect(McpServerConfigSchema().safeParse(retiredSdkTransport).success).toBe(
      false,
    )
  })

  test('committed agent SDK schemas reject the retired transport', () => {
    const definition = {
      description: 'Retired transport regression',
      prompt: 'Reject retired MCP configuration.',
    }
    expect(AgentDefinitionSchema().safeParse(definition).success).toBe(true)
    const result = AgentDefinitionSchema().safeParse({
      ...definition,
      mcpServers: [{ retired: retiredSdkTransport }],
    })

    expect(result.success).toBe(false)
  })
})
