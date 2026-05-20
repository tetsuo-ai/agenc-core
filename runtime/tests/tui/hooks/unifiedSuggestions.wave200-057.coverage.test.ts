import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  generateFileSuggestions: vi.fn(),
  getAgentColor: vi.fn((agentType: string) =>
    agentType === 'planner' ? 'cyan' : undefined,
  ),
  logError: vi.fn(),
  reset() {
    this.generateFileSuggestions.mockReset()
    this.getAgentColor.mockReset()
    this.getAgentColor.mockImplementation((agentType: string) =>
      agentType === 'planner' ? 'cyan' : undefined,
    )
    this.logError.mockClear()
  },
}))

vi.mock('./fileSuggestions.js', () => ({
  generateFileSuggestions: harness.generateFileSuggestions,
}))

vi.mock('src/tools/AgentTool/agentColorManager.js', () => ({
  getAgentColor: harness.getAgentColor,
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

import { generateUnifiedSuggestions } from './unifiedSuggestions.js'

beforeEach(() => {
  harness.reset()
})

describe('generateUnifiedSuggestions coverage', () => {
  test('returns no suggestions for an empty query until the empty-state list is requested', async () => {
    await expect(generateUnifiedSuggestions('', {}, [])).resolves.toEqual([])
    expect(harness.generateFileSuggestions).not.toHaveBeenCalled()
  })

  test('merges empty-state file, MCP resource, and agent rows with normalized descriptions', async () => {
    harness.generateFileSuggestions.mockResolvedValue([
      {
        id: 'source-file',
        displayText: 'src/index.ts',
        description: 'local file',
      },
    ])

    const suggestions = await generateUnifiedSuggestions(
      '',
      {
        docs: [
          {
            server: 'docs',
            uri: 'file:///docs/start',
            name: 'Start Guide',
            description: '  multi\nline   resource  ',
          },
        ],
      },
      [
        {
          agentType: 'planner',
          whenToUse: '  writes\nplans   quickly  ',
        },
      ],
      true,
    )

    expect(harness.generateFileSuggestions).toHaveBeenCalledWith('', true)
    expect(suggestions).toEqual([
      {
        id: 'file-src/index.ts',
        displayText: 'src/index.ts',
        description: 'local file',
      },
      {
        id: 'mcp-resource-docs__file:///docs/start',
        displayText: 'docs:file:///docs/start',
        description: 'multi line resource',
      },
      {
        id: 'agent-planner',
        displayText: 'planner (agent)',
        description: 'writes plans quickly',
        color: 'cyan',
      },
    ])
  })

  test('ranks query results by file metadata, default file score, and Fuse matches', async () => {
    harness.generateFileSuggestions.mockResolvedValue([
      {
        id: 'source-high',
        displayText: 'src/high.ts',
        metadata: { score: 0.7 },
      },
      {
        id: 'source-low',
        displayText: 'src/low.ts',
        metadata: { score: 0.1 },
      },
      {
        id: 'source-default',
        displayText: 'src/default.ts',
      },
    ])

    const suggestions = await generateUnifiedSuggestions(
      'deploy',
      {
        ops: [
          {
            server: 'ops',
            uri: 'deploy://playbook',
            name: 'Deploy Playbook',
            description: '',
          },
        ],
      },
      [
        {
          agentType: 'deploy',
          whenToUse: 'deploys releases safely',
        },
      ],
    )

    expect(harness.generateFileSuggestions).toHaveBeenCalledWith(
      'deploy',
      false,
    )
    expect(suggestions.map(item => item.id)).toEqual(
      expect.arrayContaining([
        'agent-deploy',
        'mcp-resource-ops__deploy://playbook',
      ]),
    )
    expect(
      suggestions
        .filter(item => item.id.startsWith('file-'))
        .map(item => item.id),
    ).toEqual(['file-src/low.ts', 'file-src/default.ts', 'file-src/high.ts'])
  })

  test('logs and omits agent suggestions when agent suggestion creation fails', async () => {
    const error = new Error('agent color failed')
    harness.getAgentColor.mockImplementation(() => {
      throw error
    })
    harness.generateFileSuggestions.mockResolvedValue([])

    await expect(
      generateUnifiedSuggestions(
        '',
        {},
        [{ agentType: 'broken', whenToUse: 'x' }],
        true,
      ),
    ).resolves.toEqual([])

    expect(harness.logError).toHaveBeenCalledWith(error)
  })
})
