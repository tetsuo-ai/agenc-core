import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from 'src/utils/staticRender.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('src/tui/hooks/useMinDisplayTime.js', () => ({
  useMinDisplayTime: (value: string | undefined) => value,
}))

vi.mock('src/tui/glyphs.js', () => ({
  selectAgenCTuiGlyphs: () => ({
    ellipsis: '...',
    responseGutter: '>',
    separator: '*',
  }),
}))

vi.mock('src/tools/Tool.js', async importOriginal => {
  const actual = await importOriginal<typeof import('src/tools/Tool.js')>()
  return {
    ...actual,
    findToolByName: (tools: Array<{ name: string }> | undefined, name: string) =>
      tools?.find(tool => tool.name === name),
  }
})

vi.mock('src/tools/REPLTool/primitiveTools.js', () => ({
  getReplPrimitiveTools: () => [],
}))

vi.mock('src/utils/collapseReadSearch.js', () => ({
  getToolUseIdsFromCollapsedGroup: (message: { toolUseIDs?: string[] }) =>
    message.toolUseIDs ?? [],
}))

vi.mock('src/utils/file.js', () => ({
  getDisplayPath: (path: string) => `display:${path}`,
}))

vi.mock('src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => true,
}))

vi.mock('src/tui/components/CtrlOToExpand.js', () => ({
  CtrlOToExpand: () => <>expand</>,
}))

vi.mock('src/tui/components/messageActions.js', () => ({
  useSelectedMessageBg: () => undefined,
}))

vi.mock('src/tui/components/PrBadge.js', () => ({
  PrBadge: ({ number }: { readonly number: number }) => (
    <>{`PR #${number}`}</>
  ),
}))

vi.mock('src/tui/components/ToolUseLoader.js', () => ({
  ToolUseLoader: ({
    isError,
    isUnresolved,
    shouldAnimate,
  }: {
    readonly isError?: boolean
    readonly isUnresolved?: boolean
    readonly shouldAnimate?: boolean
  }) => (
    <>
      {`loader:${isUnresolved ? 'unresolved' : 'resolved'}:${
        isError ? 'error' : 'ok'
      }:${shouldAnimate ? 'animated' : 'still'}`}
    </>
  ),
}))

vi.mock('src/tui/ink.js', async () => {
  const actual = await vi.importActual<typeof import('src/tui/ink.js')>(
    'src/tui/ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

import { CollapsedReadSearchContent } from 'src/tui/message-renderers/CollapsedReadSearchContent.js'

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

async function renderCollapsed(
  message: ReturnType<typeof baseMessage>,
  options: {
    readonly inProgressToolUseIDs?: Set<string>
    readonly isActiveGroup?: boolean
    readonly lookups?: ReturnType<typeof baseLookups>
    readonly shouldAnimate?: boolean
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
      shouldAnimate={options.shouldAnimate ?? false}
      tools={(options.tools ?? []) as never}
      verbose={options.verbose ?? false}
    />,
    120,
  )
}

describe('CollapsedReadSearchContent swarm row 029 coverage', () => {
  test('uses active REPL fallback hints and the slowest shell progress details', async () => {
    const progressMessagesByToolUseID = new Map([
      [
        'skipped',
        [
          {
            data: {
              elapsedTimeSeconds: 10,
              totalLines: 99,
              type: 'bash_progress',
            },
          },
        ],
      ],
      [
        'pattern',
        [
          {
            data: {
              phase: 'start',
              toolInput: { pattern: 'live-pattern' },
              toolName: 'Search',
              type: 'repl_tool_call',
            },
          },
        ],
      ],
      [
        'command',
        [
          {
            data: {
              phase: 'start',
              toolInput: { command: 'node fallback.js' },
              toolName: 'Bash',
              type: 'repl_tool_call',
            },
          },
        ],
      ],
      [
        'tool-name',
        [
          {
            data: {
              phase: 'start',
              toolInput: {},
              toolName: 'FallbackTool',
              type: 'repl_tool_call',
            },
          },
        ],
      ],
      [
        'ignored',
        [
          {
            data: {
              type: 'other_progress',
            },
          },
        ],
      ],
      [
        'slow',
        [
          {
            data: {
              elapsedTimeSeconds: 2,
              totalLines: 1,
              type: 'bash_progress',
            },
          },
        ],
      ],
      [
        'faster',
        [
          {
            data: {
              elapsedTimeSeconds: 4,
              totalLines: 3,
              type: 'powershell_progress',
            },
          },
        ],
      ],
    ])

    const output = await renderCollapsed(
      baseMessage({
        bashCount: 1,
        searchCount: 1,
        toolUseIDs: [
          'skipped',
          'pattern',
          'command',
          'tool-name',
          'ignored',
          'slow',
          'faster',
        ],
      }),
      {
        inProgressToolUseIDs: new Set([
          'pattern',
          'command',
          'tool-name',
          'ignored',
          'slow',
          'faster',
        ]),
        isActiveGroup: true,
        lookups: baseLookups({
          erroredToolUseIDs: new Set(['faster']),
          progressMessagesByToolUseID,
        }),
      },
    )

    expect(output).toContain('Searching for 1 pattern')
    expect(output).toContain('running 1 bash command')
    expect(output).toContain('FallbackTool')
    expect(output).toContain('4s')
    expect(output).toContain('3 lines')
    expect(output).not.toContain('99 lines')
  })

  test('renders finalized git, PR, MCP, list, read, and REPL variants', async () => {
    const output = await renderCollapsed(
      baseMessage({
        bashCount: undefined,
        commits: [
          { kind: 'amended', sha: 'def456' },
          { kind: 'cherry-picked', sha: 'fedcba' },
        ],
        gitOpBashCount: undefined,
        listCount: 1,
        mcpCallCount: 1,
        mcpServerNames: undefined,
        prs: [{ action: 'ready', number: 12 }],
        readCount: 1,
        replCount: 1,
      }),
    )

    expect(output).toContain('Amended commit def456')
    expect(output).toContain('cherry-picked fedcba')
    expect(output).toContain('marked ready PR #12')
    expect(output).toContain('read 1 file')
    expect(output).toContain('listed 1 directory')
    expect(output).toContain("REPL'd 1 time")
    expect(output).toContain('queried MCP')
  })

  test('renders memory-only summaries with first and following verbs', async () => {
    const finalized = await renderCollapsed(
      baseMessage({
        bashCount: undefined,
        gitOpBashCount: undefined,
        mcpCallCount: undefined,
        memoryReadCount: 2,
        memorySearchCount: 1,
        memoryWriteCount: 1,
      }),
    )
    const activeSearch = await renderCollapsed(
      baseMessage({
        memorySearchCount: 1,
      }),
      { isActiveGroup: true },
    )
    const activeWrite = await renderCollapsed(
      baseMessage({
        memoryWriteCount: 2,
      }),
      { isActiveGroup: true },
    )

    expect(finalized).toContain('Recalled 2 memories')
    expect(finalized).toContain('searched memories')
    expect(finalized).toContain('wrote 1 memory')
    expect(activeSearch).toContain('Searching memories')
    expect(activeWrite).toContain('Writing 2 memories')
  })

  test('renders multiline active hints and shell timing without line counts', async () => {
    const output = await renderCollapsed(
      baseMessage({
        bashCount: 1,
        latestDisplayHint: 'first line\nsecond line',
        toolUseIDs: ['bash'],
      }),
      {
        inProgressToolUseIDs: new Set(['bash']),
        isActiveGroup: true,
        lookups: baseLookups({
          progressMessagesByToolUseID: new Map([
            [
              'bash',
              [
                {
                  data: {
                    elapsedTimeSeconds: 2,
                    totalLines: 0,
                    type: 'bash_progress',
                  },
                },
              ],
            ],
          ]),
        }),
      },
    )

    expect(output).toContain('Running 1 bash command')
    expect(output).toContain('first line')
    expect(output).toContain('second line')
    expect(output).toContain('2s')
  })

  test('uses search arguments as the active hint when no read path is present', async () => {
    const output = await renderCollapsed(
      baseMessage({
        searchArgs: ['needle'],
        searchCount: 1,
      }),
      { isActiveGroup: true },
    )

    expect(output).toContain('Searching for 1 pattern')
    expect(output).toContain('"needle"')
  })

  test('renders verbose tool uses with missing tools and parser failures', async () => {
    const invalidInputMessage = vi.fn(() => 'should not render')
    const parsedFailResult = vi.fn(() => <>result should not render</>)
    const tools = [
      {
        inputSchema: {
          safeParse: () => ({ success: false }),
        },
        name: 'InvalidInputTool',
        renderToolUseMessage: invalidInputMessage,
        userFacingName: (input: unknown) =>
          input === undefined ? 'Invalid input tool' : 'Unexpected input',
      },
      {
        inputSchema: {
          safeParse: (input: unknown) => ({ data: input, success: true }),
        },
        name: 'ParsedFailTool',
        outputSchema: {
          safeParse: () => ({ success: false }),
        },
        renderToolResultMessage: parsedFailResult,
        renderToolUseMessage: (input: { value: string }) => `input:${input.value}`,
        userFacingName: () => 'Parsed fail tool',
      },
      {
        inputSchema: {
          safeParse: (input: unknown) => ({ data: input, success: true }),
        },
        name: 'ErroredTool',
        renderToolUseMessage: () => 'running',
        userFacingName: () => 'Errored tool',
      },
    ]

    const output = await renderCollapsed(
      baseMessage({
        messages: [
          {
            message: {
              content: [
                {
                  id: 'missing',
                  input: {},
                  name: 'MissingTool',
                  type: 'tool_use',
                },
              ],
            },
            type: 'assistant',
          },
          {
            message: {
              content: [
                {
                  id: 'invalid-input',
                  input: { value: 'bad' },
                  name: 'InvalidInputTool',
                  type: 'tool_use',
                },
              ],
            },
            type: 'assistant',
          },
          {
            message: {
              content: [
                {
                  id: 'parsed-fail',
                  input: { value: 'ok' },
                  name: 'ParsedFailTool',
                  type: 'tool_use',
                },
              ],
            },
            type: 'assistant',
          },
          {
            message: {
              content: [
                {
                  id: 'errored',
                  input: { value: 'boom' },
                  name: 'ErroredTool',
                  type: 'tool_use',
                },
              ],
            },
            type: 'assistant',
          },
        ],
      }),
      {
        inProgressToolUseIDs: new Set(['errored']),
        lookups: baseLookups({
          erroredToolUseIDs: new Set(['errored']),
          resolvedToolUseIDs: new Set(['parsed-fail']),
          toolResultByToolUseID: new Map([
            ['parsed-fail', { toolUseResult: { value: 'ignored' }, type: 'user' }],
          ]),
        }),
        shouldAnimate: true,
        tools,
        verbose: true,
      },
    )

    expect(output).not.toContain('MissingTool')
    expect(output).toContain('Invalid input tool')
    expect(output).toContain('Parsed fail tool')
    expect(output).toContain('input:ok')
    expect(output).toContain('Errored tool')
    expect(invalidInputMessage).not.toHaveBeenCalled()
    expect(parsedFailResult).not.toHaveBeenCalled()
  })
})
