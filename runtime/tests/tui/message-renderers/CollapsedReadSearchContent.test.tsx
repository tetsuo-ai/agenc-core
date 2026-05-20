import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../hooks/useMinDisplayTime.js', () => ({
  useMinDisplayTime: (value: string | undefined) => value,
}))

vi.mock('../glyphs.js', () => ({
  selectAgenCTuiGlyphs: () => ({
    ellipsis: '...',
    responseGutter: '>',
    separator: '*',
  }),
}))

vi.mock('../../tools/Tool.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../tools/Tool.js')>()
  return {
    ...actual,
    findToolByName: (tools: Array<{ name: string }> | undefined, name: string) =>
      tools?.find(tool => tool.name === name),
  }
})

vi.mock('../../tools/REPLTool/primitiveTools.js', () => ({
  getReplPrimitiveTools: () => [],
}))

vi.mock('../../utils/collapseReadSearch.js', () => ({
  getToolUseIdsFromCollapsedGroup: (message: { toolUseIDs?: string[] }) =>
    message.toolUseIDs ?? [],
}))

vi.mock('../../utils/file.js', () => ({
  getDisplayPath: (path: string) => `display:${path}`,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => true,
}))

vi.mock('../components/CtrlOToExpand.js', () => ({
  CtrlOToExpand: () => <>expand</>,
}))

vi.mock('../components/messageActions.js', () => ({
  useSelectedMessageBg: () => undefined,
}))

vi.mock('../components/PrBadge.js', () => ({
  PrBadge: ({ number }: { readonly number: number }) => (
    <>{`PR #${number}`}</>
  ),
}))

vi.mock('../components/ToolUseLoader.js', () => ({
  ToolUseLoader: ({
    isError,
    isUnresolved,
  }: {
    readonly isError?: boolean
    readonly isUnresolved?: boolean
  }) => (
    <>{`loader:${isUnresolved ? 'unresolved' : 'resolved'}:${isError ? 'error' : 'ok'}`}</>
  ),
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>('../ink.js')
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

import { CollapsedReadSearchContent } from './CollapsedReadSearchContent.js'

function baseLookups(overrides: Record<string, unknown> = {}) {
  return {
    erroredToolUseIDs: new Set<string>(),
    progressMessagesByToolUseID: new Map(),
    resolvedToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map(),
    ...overrides,
  } as never
}

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    bashCount: 0,
    gitOpBashCount: 0,
    listCount: 0,
    mcpCallCount: 0,
    memoryReadCount: 0,
    memorySearchCount: 0,
    memoryWriteCount: 0,
    messages: [],
    readCount: 0,
    replCount: 0,
    searchCount: 0,
    toolUseIDs: [],
    ...overrides,
  } as never
}

function renderCollapsed(
  message: ReturnType<typeof baseMessage>,
  options: {
    readonly inProgressToolUseIDs?: Set<string>
    readonly isActiveGroup?: boolean
    readonly lookups?: ReturnType<typeof baseLookups>
    readonly tools?: unknown[]
    readonly verbose?: boolean
  } = {},
): Promise<string> {
  return renderToString(
    <CollapsedReadSearchContent
      inProgressToolUseIDs={options.inProgressToolUseIDs ?? new Set()}
      isActiveGroup={options.isActiveGroup}
      lookups={options.lookups ?? baseLookups()}
      message={message}
      shouldAnimate={false}
      tools={(options.tools ?? []) as never}
      verbose={options.verbose ?? false}
    />,
    120,
  )
}

describe('CollapsedReadSearchContent', () => {
  test('renders nothing for an empty collapsed group', async () => {
    const output = await renderCollapsed(baseMessage())

    expect(output.trim()).toBe('')
  })

  test('renders active non-verbose operation summaries, hint, progress, and hook totals', async () => {
    const progressMessagesByToolUseID = new Map([
      [
        'bash-1',
        [
          {
            data: {
              elapsedTimeSeconds: 3,
              totalLines: 1,
              type: 'bash_progress',
            },
          },
        ],
      ],
    ])
    const output = await renderCollapsed(
      baseMessage({
        bashCount: 3,
        branches: [{ action: 'rebased', ref: 'main' }],
        commits: [{ kind: 'committed', sha: 'abc123' }],
        gitOpBashCount: 1,
        hookCount: 2,
        hookTotalMs: 1200,
        isActiveGroup: true,
        latestDisplayHint: 'npm test',
        listCount: 1,
        mcpCallCount: 2,
        mcpServerNames: ['agenc.ai docs'],
        memoryReadCount: 1,
        memorySearchCount: 1,
        memoryWriteCount: 2,
        prs: [{ action: 'created', number: 7, url: 'https://example.test/pr/7' }],
        pushes: [{ branch: 'feature/tui' }],
        readCount: 1,
        replCount: 2,
        searchCount: 2,
        toolUseIDs: ['bash-1'],
      }),
      {
        inProgressToolUseIDs: new Set(['bash-1']),
        isActiveGroup: true,
        lookups: baseLookups({ progressMessagesByToolUseID }),
      },
    )

    const flatOutput = output.replace(/\s+/g, ' ')
    expect(output).toContain('Committed abc123')
    expect(output).toContain('pushed to feature/tui')
    expect(output).toContain('rebased onto main')
    expect(output).toContain('created PR #7')
    expect(output).toContain('searching for 2 patterns')
    expect(output).toContain('reading 1 file')
    expect(output).toContain('listing 1 directory')
    expect(output).toContain("REPL'ing 2 times")
    expect(output).toContain('querying docs 2 times')
    expect(output).toContain('running 2 bash commands')
    expect(output).toContain('recalling 1 memory')
    expect(flatOutput).toContain('searching memories')
    expect(output).toContain('writing 2 memories')
    expect(output).toContain('...')
    expect(output).toContain('expand')
    expect(output).toContain('npm test')
    expect(output).toContain('1 line')
    expect(output).toContain('Ran 2 PreToolUse hooks')
  })

  test('renders finalized summaries and falls back from read/search history to display hints', async () => {
    const output = await renderCollapsed(
      baseMessage({
        hookCount: 1,
        hookTotalMs: 250,
        listCount: 2,
        readCount: 2,
        readFilePaths: ['/tmp/last-read.ts'],
        searchArgs: ['needle'],
        searchCount: 1,
      }),
    )

    expect(output).toContain('Searched for 1 pattern')
    expect(output).toContain('read 2 files')
    expect(output).toContain('listed 2 directories')
    expect(output).toContain('Ran 1 PreToolUse hook')
    expect(output).not.toContain('display:/tmp/last-read.ts')
  })

  test('renders verbose tool uses, hooks, results, and recalled memories', async () => {
    const renderToolResultMessage = vi.fn((result: { value: string }) => (
      <>{`result:${result.value}`}</>
    ))
    const renderToolUseTag = vi.fn(() => <>tag</>)
    const tool = {
      inputSchema: {
        safeParse: (input: unknown) => ({ data: input, success: true }),
      },
      name: 'DemoTool',
      outputSchema: {
        safeParse: (output: unknown) => ({ data: output, success: true }),
      },
      renderToolResultMessage,
      renderToolUseMessage: (input: { value: string }) => `input:${input.value}`,
      renderToolUseTag,
      userFacingName: () => 'Demo tool',
    }
    const lookups = baseLookups({
      resolvedToolUseIDs: new Set(['tool-1']),
      toolResultByToolUseID: new Map([
        ['tool-1', { toolUseResult: { value: 'done' }, type: 'user' }],
      ]),
    })

    const output = await renderCollapsed(
      baseMessage({
        hookCount: 1,
        hookInfos: [{ command: 'preflight', durationMs: 400 }],
        hookTotalMs: 400,
        messages: [
          {
            message: {
              content: [
                {
                  id: 'tool-1',
                  input: { value: 'ok' },
                  name: 'DemoTool',
                  type: 'tool_use',
                },
              ],
            },
            type: 'assistant',
          },
          {
            message: {
              content: [{ text: 'not a tool', type: 'text' }],
            },
            type: 'assistant',
          },
          {
            messages: [
              {
                message: {
                  content: [
                    {
                      id: 'missing-tool',
                      input: {},
                      name: 'MissingTool',
                      type: 'tool_use',
                    },
                  ],
                },
                type: 'assistant',
              },
            ],
            type: 'grouped_tool_use',
          },
        ],
        relevantMemories: [{ content: 'Remember this', path: '/tmp/team.md' }],
      }),
      { lookups, tools: [tool], verbose: true },
    )

    expect(output).toContain('Demo tool')
    expect(output).toContain('input:ok')
    expect(renderToolUseTag).toHaveBeenCalledOnce()
    expect(renderToolResultMessage).toHaveBeenCalledWith(
      { value: 'done' },
      [],
      expect.objectContaining({ verbose: true }),
    )
    expect(output).toContain('Ran 1 PreToolUse hook')
    expect(output).toContain('preflight')
    expect(output).toContain('Recalled team.md')
    expect(output).toContain('Remember this')
    expect(output).not.toContain('MissingTool')
  })
})
