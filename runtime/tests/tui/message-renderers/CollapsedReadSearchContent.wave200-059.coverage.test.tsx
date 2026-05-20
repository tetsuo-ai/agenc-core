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
    separator: '|',
  }),
}))

vi.mock('../../utils/collapseReadSearch.js', () => ({
  getToolUseIdsFromCollapsedGroup: (message: { toolUseIDs?: string[] }) =>
    message.toolUseIDs ?? [],
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

vi.mock('../components/ToolUseLoader.js', () => ({
  ToolUseLoader: () => <>loader</>,
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>('../ink.js')
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

import { CollapsedReadSearchContent } from './CollapsedReadSearchContent.js'

function lookupsWithReplProgress() {
  return {
    erroredToolUseIDs: new Set<string>(),
    progressMessagesByToolUseID: new Map([
      [
        'repl-tool',
        [
          {
            data: {
              phase: 'start',
              toolInput: {
                command: 'cat fallback-command.ts',
                file_path: '/workspace/src/live-repl-target.ts',
                pattern: 'fallback-pattern',
              },
              toolName: 'Read',
              type: 'repl_tool_call',
            },
          },
        ],
      ],
    ]),
    resolvedToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map(),
  } as never
}

describe('CollapsedReadSearchContent wave200-059 coverage', () => {
  test('shows the active REPL inner tool file path as the live hint', async () => {
    const output = await renderToString(
      <CollapsedReadSearchContent
        inProgressToolUseIDs={new Set(['repl-tool'])}
        isActiveGroup={true}
        lookups={lookupsWithReplProgress()}
        message={
          {
            bashCount: 0,
            gitOpBashCount: 0,
            listCount: 0,
            mcpCallCount: 0,
            memoryReadCount: 0,
            memorySearchCount: 0,
            memoryWriteCount: 0,
            messages: [],
            readCount: 0,
            readFilePaths: ['/workspace/src/stale-read-fallback.ts'],
            replCount: 1,
            searchArgs: ['stale-search-fallback'],
            searchCount: 0,
            toolUseIDs: ['repl-tool'],
          } as never
        }
        shouldAnimate={false}
        tools={[]}
        verbose={false}
      />,
      120,
    )

    expect(output).toContain("REPL'ing 1 time")
    expect(output).toContain('/workspace/src/live-repl-target.ts')
    expect(output).not.toContain('stale-read-fallback')
    expect(output).not.toContain('stale-search-fallback')
    expect(output).not.toContain('fallback-command')
    expect(output).not.toContain('fallback-pattern')
  })
})
