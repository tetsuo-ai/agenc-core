import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { getAgentColor } from './agentColorManager.js'
import {
  __setMarkdownAgentDirsForTesting,
  __setPluginAgentsLoaderForTesting,
  clearAgentDefinitionsCache,
  filterAgentsByMcpRequirements,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  parseAgentFromJson,
  parseAgentFromMarkdown,
  parseAgentsFromJson,
  type AgentDefinition,
  type PluginAgentDefinition,
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

function tempAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'agenc-agent-loader-'))
  const dir = join(root, '.agenc', 'agents')
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  __setMarkdownAgentDirsForTesting(undefined)
  __setPluginAgentsLoaderForTesting(undefined)
  clearAgentDefinitionsCache()
})

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

  test('parses JSON agent definitions with donor metadata fields', () => {
    const parsed = parseAgentFromJson('reviewer', {
      description: 'Review code',
      prompt: 'Be strict.',
      tools: ['Read', 1, 'Grep'],
      disallowedTools: ['Write'],
      model: 'inherit',
      effort: 'high',
      permissionMode: 'plan',
      mcpServers: ['github', { slack: { type: 'stdio' } }],
      hooks: { PreToolUse: [] },
      maxTurns: '3',
      skills: ['security'],
      initialPrompt: 'Start here.',
      background: true,
      memory: 'project',
      isolation: 'worktree',
    })

    expect(parsed).toMatchObject({
      agentType: 'reviewer',
      whenToUse: 'Review code',
      source: 'flagSettings',
      tools: ['Read', 'Grep', 'Write', 'Edit', 'FileRead'],
      disallowedTools: ['Write'],
      model: 'inherit',
      effort: 'high',
      permissionMode: 'plan',
      mcpServers: ['github', { slack: { type: 'stdio' } }],
      hooks: { PreToolUse: [] },
      maxTurns: 3,
      skills: ['security'],
      initialPrompt: 'Start here.',
      background: true,
      memory: 'project',
      isolation: 'worktree',
    })

    expect(parseAgentFromJson('bad', { description: 'missing prompt' })).toBeNull()
    expect(
      parseAgentsFromJson({
        one: { description: 'one', prompt: 'one prompt' },
        bad: { prompt: 'missing description' },
      }).map(a => a.agentType),
    ).toEqual(['one'])
  })

  test('parses markdown agents and preserves source metadata', () => {
    const parsed = parseAgentFromMarkdown(
      '/repo/.agenc/agents/review.md',
      '/repo/.agenc/agents',
      {
        name: 'reviewer',
        description: 'Review\\ncode',
        color: 'green',
        tools: 'Read Grep',
        disallowedTools: ['Write'],
        skills: ['security'],
        mcpServers: ['github'],
        hooks: { Stop: [] },
        model: 'gpt-5.4',
        effort: 2,
        permissionMode: 'acceptEdits',
        maxTurns: '4',
        background: 'true',
        memory: 'user',
      },
      'Review the patch.',
      'projectSettings',
    )

    expect(parsed).toMatchObject({
      agentType: 'reviewer',
      whenToUse: 'Review\ncode',
      source: 'projectSettings',
      filename: 'review',
      baseDir: '/repo/.agenc/agents',
      color: 'green',
      tools: ['Read', 'Grep', 'Write', 'Edit', 'FileRead'],
      disallowedTools: ['Write'],
      skills: ['security'],
      mcpServers: ['github'],
      hooks: { Stop: [] },
      model: 'gpt-5.4',
      effort: 2,
      permissionMode: 'acceptEdits',
      maxTurns: 4,
      background: true,
      memory: 'user',
    })
  })

  test('loads custom markdown and plugin agents with active color propagation', async () => {
    const dir = tempAgentDir()
    writeFileSync(
      join(dir, 'local.md'),
      `---
name: local-reviewer
description: Local reviewer
color: blue
tools:
  - Read
---
Review local changes.
`,
    )

    const pluginAgent: PluginAgentDefinition = {
      agentType: 'plugin-helper',
      whenToUse: 'Plugin help',
      source: 'plugin',
      plugin: 'example',
      color: 'red',
      getSystemPrompt: () => 'plugin prompt',
    }

    __setMarkdownAgentDirsForTesting([{ dir, source: 'projectSettings' }])
    __setPluginAgentsLoaderForTesting(async () => [pluginAgent])

    const definitions = await getAgentDefinitionsWithOverrides(process.cwd())
    expect(definitions.allAgents.map(agent => agent.agentType)).toContain(
      'local-reviewer',
    )
    expect(definitions.allAgents.map(agent => agent.agentType)).toContain(
      'plugin-helper',
    )
    expect(
      definitions.activeAgents.find(agent => agent.agentType === 'local-reviewer'),
    ).toMatchObject({
      source: 'projectSettings',
      tools: ['Read'],
      color: 'blue',
    })
    expect(getAgentColor('local-reviewer')).toBe('blue_FOR_SUBAGENTS_ONLY')
    expect(getAgentColor('plugin-helper')).toBe('red_FOR_SUBAGENTS_ONLY')
  })

  test('projects registered AgenC roles into built-in agent definitions', async () => {
    __setPluginAgentsLoaderForTesting(async () => [])
    __setMarkdownAgentDirsForTesting([])

    const definitions = await getAgentDefinitionsWithOverrides(process.cwd())
    expect(definitions.activeAgents.length).toBeGreaterThan(0)
    expect(definitions.activeAgents.every(agent => agent.source === 'built-in')).toBe(
      true,
    )
  })
})
