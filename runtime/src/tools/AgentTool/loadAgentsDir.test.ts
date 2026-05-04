import { describe, expect, test } from 'vitest'

import {
  filterAgentsByMcpRequirements,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  parseAgentFromJson,
  parseAgentsFromJson,
  type AgentDefinition,
} from './loadAgentsDir.js'

function agent(agentType: string, source: AgentDefinition['source']): AgentDefinition {
  return {
    agentType,
    source,
    whenToUse: `${agentType} use`,
    baseDir: source === 'built-in' ? 'built-in' : '.agenc/agents',
    getSystemPrompt: () => `${agentType} prompt`,
  } as AgentDefinition
}

describe('AgentTool loadAgentsDir adapter', () => {
  test('applies source precedence when active agents collide by type', () => {
    const active = getActiveAgentsFromList([
      agent('same', 'built-in'),
      agent('same', 'plugin'),
      agent('same', 'userSettings'),
      agent('same', 'projectSettings'),
      agent('same', 'flagSettings'),
      agent('same', 'policySettings'),
    ])

    expect(active).toHaveLength(1)
    expect(active[0]?.source).toBe('policySettings')
  })

  test('filters agents by required MCP server patterns', () => {
    const agents = [
      { ...agent('plain', 'built-in') },
      {
        ...agent('slack-agent', 'built-in'),
        requiredMcpServers: ['slack'],
      },
    ]

    expect(filterAgentsByMcpRequirements(agents, ['github'])).toEqual([
      agents[0],
    ])
    expect(filterAgentsByMcpRequirements(agents, ['company-slack'])).toEqual(
      agents,
    )
  })

  test('parses JSON agent definitions defensively', () => {
    expect(
      parseAgentFromJson('reviewer', {
        description: 'Review code',
        prompt: 'Be strict.',
        tools: ['Read', 1, 'Grep'],
      }),
    ).toMatchObject({
      agentType: 'reviewer',
      whenToUse: 'Review code',
      source: 'flagSettings',
      tools: ['Read', 'Grep'],
    })

    expect(parseAgentFromJson('bad', { description: 'missing prompt' })).toBeNull()
    expect(
      parseAgentsFromJson({
        one: { description: 'one', prompt: 'one prompt' },
        bad: { prompt: 'missing description' },
      }).map(a => a.agentType),
    ).toEqual(['one'])
  })

  test('projects registered AgenC roles into built-in agent definitions', async () => {
    const definitions = await getAgentDefinitionsWithOverrides(process.cwd())
    expect(definitions.activeAgents.length).toBeGreaterThan(0)
    expect(definitions.activeAgents.every(agent => agent.source === 'built-in')).toBe(
      true,
    )
  })
})
