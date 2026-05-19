import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { getAgentColor } from './agentColorManager.js'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../bootstrap/state.js'
import {
  __setMarkdownAgentDirsForTesting,
  __setPluginAgentCacheClearerForTesting,
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
import { getPrompt } from './prompt.js'

const allSettingSources = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

type SettingSourceForTesting = (typeof allSettingSources)[number]

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

async function getAllowedSettingSourcesForTesting(): Promise<
  SettingSourceForTesting[]
> {
  return getAllowedSettingSources() as SettingSourceForTesting[]
}

async function setAllowedSettingSourcesForTesting(
  sources: SettingSourceForTesting[],
): Promise<void> {
  setAllowedSettingSources(sources)
}

afterEach(async () => {
  await setAllowedSettingSourcesForTesting([...allSettingSources])
  __setMarkdownAgentDirsForTesting(undefined)
  __setPluginAgentCacheClearerForTesting(undefined)
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
      mcpServers: ['github', { slack: { type: 'stdio', command: 'slack-mcp' } }],
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
      mcpServers: ['github', { slack: { type: 'stdio', command: 'slack-mcp' } }],
      hooks: { PreToolUse: [] },
      maxTurns: 3,
      skills: ['security'],
      initialPrompt: 'Start here.',
      background: true,
      memory: 'project',
      isolation: 'worktree',
    })
    const previousCwd = process.cwd()
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-agent-memory-'))
    process.chdir(cwd)
    try {
      const prompt = parsed?.getSystemPrompt()
      expect(prompt).toContain('Be strict.')
      expect(prompt).toContain('Persistent Agent Memory')
    } finally {
      process.chdir(previousCwd)
    }

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
        mcpServers: ['github', { slack: { type: 'stdio', command: 'slack-mcp' } }],
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
      mcpServers: ['github', { slack: { type: 'stdio', command: 'slack-mcp' } }],
      hooks: { Stop: [] },
      model: 'gpt-5.4',
      effort: 2,
      permissionMode: 'acceptEdits',
      maxTurns: 4,
      background: true,
      memory: 'user',
    })
  })

  test('rejects remote isolation outside internal builds', () => {
    const previousUserType = process.env.USER_TYPE
    delete process.env.USER_TYPE
    try {
      expect(
        parseAgentFromJson('remote-json', {
          description: 'Remote JSON',
          prompt: 'Run remotely.',
          isolation: 'remote',
        }),
      ).not.toMatchObject({ isolation: 'remote' })

      const parsed = parseAgentFromMarkdown(
        '/repo/.agenc/agents/remote.md',
        '/repo/.agenc/agents',
        {
          name: 'remote-markdown',
          description: 'Remote markdown',
          isolation: 'remote',
        },
        'Run remotely.',
        'projectSettings',
      )
      expect(parsed).not.toMatchObject({ isolation: 'remote' })
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE
      } else {
        process.env.USER_TYPE = previousUserType
      }
    }
  })

  test('omits invalid hook and MCP server settings', () => {
    const jsonAgent = parseAgentFromJson('bad-config-json', {
      description: 'Bad config',
      prompt: 'Skip invalid config.',
      hooks: 'not-hooks',
      mcpServers: [{ broken: { type: 'stdio' } }],
    })
    expect(jsonAgent).not.toHaveProperty('hooks')
    expect(jsonAgent).not.toHaveProperty('mcpServers')

    const markdownAgent = parseAgentFromMarkdown(
      '/repo/.agenc/agents/bad-config.md',
      '/repo/.agenc/agents',
      {
        name: 'bad-config-markdown',
        description: 'Bad config',
        hooks: 'not-hooks',
        mcpServers: [{ broken: { type: 'stdio' } }],
      },
      'Skip invalid config.',
      'projectSettings',
    )
    expect(markdownAgent).not.toHaveProperty('hooks')
    expect(markdownAgent).not.toHaveProperty('mcpServers')
  })

  test('loads project agents through the shared markdown config loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-agent-shared-loader-'))
    const projectDir = join(root, '.agenc', 'agents')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'project.md'),
      `---
name: project-loader-agent
description: Project loader agent
---
Loaded through shared discovery.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])

    const definitions = await getAgentDefinitionsWithOverrides(root)
    expect(definitions.allAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentType: 'project-loader-agent',
          source: 'projectSettings',
        }),
      ]),
    )
  })

  test('honors shared setting-source gates for project agents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-agent-source-gate-'))
    const projectDir = join(root, '.agenc', 'agents')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'project.md'),
      `---
name: disabled-project-agent
description: Project-only agent
---
Should be disabled with project settings.
`,
    )
    const previousSources = await getAllowedSettingSourcesForTesting()
    await setAllowedSettingSourcesForTesting(
      previousSources.filter(source => source !== 'projectSettings'),
    )
    clearAgentDefinitionsCache()
    __setPluginAgentsLoaderForTesting(async () => [])

    const definitions = await getAgentDefinitionsWithOverrides(root)
    expect(definitions.allAgents.map(agent => agent.agentType)).not.toContain(
      'disabled-project-agent',
    )
  })

  test('deduplicates symlinked markdown agents through shared discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-agent-symlink-dedupe-'))
    const config = join(root, 'config')
    const userDir = join(config, 'agents')
    const projectDir = join(root, '.agenc', 'agents')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    const projectFile = join(projectDir, 'dupe.md')
    writeFileSync(
      projectFile,
      `---
name: deduped-agent
description: Deduped agent
---
Only load once.
`,
    )
    symlinkSync(projectFile, join(userDir, 'dupe.md'))

    const previousConfigDir = process.env.AGENC_CONFIG_DIR
    process.env.AGENC_CONFIG_DIR = config
    clearAgentDefinitionsCache()
    __setPluginAgentsLoaderForTesting(async () => [])
    try {
      const definitions = await getAgentDefinitionsWithOverrides(root)
      const deduped = definitions.allAgents.filter(
        agent => agent.agentType === 'deduped-agent',
      )
      expect(deduped).toHaveLength(1)
      expect(deduped[0]?.source).toBe('userSettings')
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.AGENC_CONFIG_DIR
      } else {
        process.env.AGENC_CONFIG_DIR = previousConfigDir
      }
    }
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

  test('keeps built-ins and reports malformed markdown files', async () => {
    const dir = tempAgentDir()
    writeFileSync(
      join(dir, 'broken.md'),
      `---
name: broken
description: [unterminated
---
Broken prompt.
`,
    )

    __setMarkdownAgentDirsForTesting([{ dir, source: 'projectSettings' }])
    __setPluginAgentsLoaderForTesting(async () => [])

    const definitions = await getAgentDefinitionsWithOverrides(process.cwd())
    expect(definitions.activeAgents.length).toBeGreaterThan(0)
    expect(definitions.activeAgents.every(agent => agent.source === 'built-in')).toBe(
      true,
    )
    expect(definitions.failedFiles).toEqual([
      expect.objectContaining({
        path: join(dir, 'broken.md'),
      }),
    ])
  })

  test('clears plugin agent cache with agent definition cache', () => {
    let cleared = 0
    __setPluginAgentCacheClearerForTesting(() => {
      cleared += 1
    })

    clearAgentDefinitionsCache()

    expect(cleared).toBe(1)
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

  test('renders full AgentTool guidance for non-coordinator prompts', async () => {
    const previousListMode = process.env.AGENC_AGENT_LIST_IN_MESSAGES
    const previousBackground = process.env.AGENC_DISABLE_BACKGROUND_TASKS
    process.env.AGENC_AGENT_LIST_IN_MESSAGES = 'false'
    delete process.env.AGENC_DISABLE_BACKGROUND_TASKS
    try {
      const prompt = await getPrompt([
        {
          ...agent('reviewer', 'built-in'),
          tools: ['FileRead'],
        },
      ])
      expect(prompt).toContain('When NOT to use the spawn_agent tool')
      expect(prompt).toContain('run_in_background parameter')
      expect(prompt).toContain('Writing the prompt')
      expect(prompt).toContain('- reviewer: reviewer use (Tools: FileRead)')
    } finally {
      if (previousListMode === undefined) {
        delete process.env.AGENC_AGENT_LIST_IN_MESSAGES
      } else {
        process.env.AGENC_AGENT_LIST_IN_MESSAGES = previousListMode
      }
      if (previousBackground === undefined) {
        delete process.env.AGENC_DISABLE_BACKGROUND_TASKS
      } else {
        process.env.AGENC_DISABLE_BACKGROUND_TASKS = previousBackground
      }
    }
  })
})
