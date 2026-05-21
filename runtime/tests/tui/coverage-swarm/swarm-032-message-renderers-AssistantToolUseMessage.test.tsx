import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tool } from '../../tools/Tool.js'
import type { AgenCToolUseBlockParam } from '../../types/message.js'
import { renderToString } from '../../utils/staticRender.js'
import { Text } from '../ink.js'
import {
  AssistantToolUseMessage,
  getAssistantToolUsePendingText,
} from '../message-renderers/AssistantToolUseMessage.js'

const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

vi.mock('../../utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => false,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 96, rows: 32 }),
}))

vi.mock('../state/AppState.js', () => ({
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: typeof appStateMock) => unknown,
  ) => selector(appStateMock),
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>(
    '../ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

function lookups(options: {
  readonly resolved?: readonly string[]
  readonly errored?: readonly string[]
} = {}) {
  return {
    resolvedToolUseIDs: new Set(options.resolved ?? []),
    erroredToolUseIDs: new Set(options.errored ?? []),
    inProgressHookCounts: new Map<string, Map<string, number>>(),
    resolvedHookCounts: new Map<string, Map<string, number>>(),
  } as never
}

function toolUseParam(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AgenCToolUseBlockParam {
  return {
    type: 'tool_use',
    id,
    name,
    input,
  }
}

function makeTool(options: {
  readonly name: string
  readonly label?: string
  readonly renderToolUseMessage?: Tool['renderToolUseMessage']
  readonly renderToolUseQueuedMessage?: Tool['renderToolUseQueuedMessage']
  readonly renderToolUseTag?: Tool['renderToolUseTag']
  readonly isTransparentWrapper?: () => boolean
  readonly inputSchema?: Tool['inputSchema']
}): Tool {
  return {
    name: options.name,
    inputSchema: options.inputSchema ?? {
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    userFacingName: () => options.label ?? options.name,
    renderToolUseMessage: options.renderToolUseMessage ?? (() => ''),
    ...(options.renderToolUseQueuedMessage
      ? { renderToolUseQueuedMessage: options.renderToolUseQueuedMessage }
      : {}),
    ...(options.renderToolUseTag
      ? { renderToolUseTag: options.renderToolUseTag }
      : {}),
    ...(options.isTransparentWrapper
      ? { isTransparentWrapper: options.isTransparentWrapper }
      : {}),
  } as unknown as Tool
}

async function renderToolUse(options: {
  readonly param: AgenCToolUseBlockParam
  readonly tool: Tool
  readonly inProgress?: boolean
  readonly resolved?: boolean
  readonly errored?: boolean
}): Promise<string> {
  return renderToString(
    <AssistantToolUseMessage
      param={options.param}
      addMargin={false}
      tools={[options.tool]}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={
        options.inProgress === false ? new Set() : new Set([options.param.id])
      }
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      lookups={lookups({
        resolved: options.resolved ? [options.param.id] : [],
        errored: options.errored ? [options.param.id] : [],
      })}
    />,
    96,
  )
}

describe('AssistantToolUseMessage swarm 032 coverage', () => {
  beforeEach(() => {
    appStateMock.pendingWorkerRequest = undefined
    appStateMock.toolPermissionContext.mode = 'default'
    appStateMock.toolPermissionContext.strippedDangerousRules = undefined
  })

  it('formats pending text for each classifier state with selectable glyphs', () => {
    expect(
      getAssistantToolUsePendingText('permission', {
        AGENC_TUI_GLYPHS: 'ascii',
      }),
    ).toBe('Waiting for permission...')
    expect(
      getAssistantToolUsePendingText('auto-classifier', {
        AGENC_TUI_GLYPHS: 'unicode',
      }),
    ).toBe('Auto classifier checking…')
    expect(
      getAssistantToolUsePendingText('bash-classifier', {
        AGENC_TUI_GLYPHS: 'ascii',
      }),
    ).toBe('Bash classifier checking...')
  })

  it('renders every tool-kind classifier path while summarizing fallback args', async () => {
    const cases = [
      ['PowerShell', 'Shell Runner', { command: 'Write-Host hi' }, 'Write-Host hi'],
      ['Glob', 'Glob Search', { pattern: '**/*.ts' }, '**/*.ts'],
      ['PatchWriter', 'File Edit', { file_path: 'src/file.ts' }, 'src/file.ts'],
      ['Task', 'Delegate Agent', { description: 'delegate work' }, 'delegate work'],
      ['ProofCheck', 'Proof Verify', { prompt: 'prove it' }, 'prove it'],
      ['ClaimSubmit', 'Claim Submit', { path: 'claim.json' }, 'claim.json'],
      ['SettleTrade', 'Settle Market', { query: 'market-1' }, 'market-1'],
      ['StakeVote', 'Stake Lock', { path: 'stake.toml' }, 'stake.toml'],
      ['PlainRead', 'Plain Read', { value: 42 }, '{"value":42}'],
    ] as const

    for (const [name, label, input, expectedArg] of cases) {
      const param = toolUseParam(`toolu_${name}`, name, input)
      const output = await renderToolUse({
        param,
        tool: makeTool({ name, label }),
        resolved: true,
      })

      expect(output).toContain(label)
      expect(output).toContain(expectedArg)
      expect(output).toContain('●')
    }
  })

  it('omits tools with an intentionally empty user-facing name', async () => {
    const renderToolUseMessage = vi.fn(() => 'hidden details')
    const param = toolUseParam('toolu_hidden', 'HiddenTool', { command: 'hide' })
    const output = await renderToolUse({
      param,
      tool: makeTool({
        name: 'HiddenTool',
        label: '',
        renderToolUseMessage,
      }),
    })

    expect(output.trim()).toBe('')
    expect(renderToolUseMessage).not.toHaveBeenCalled()
  })

  it('keeps failed JSX detail expanded with tags and summarized args', async () => {
    const param = toolUseParam('toolu_failed_detail', 'ClaimTool', {
      prompt: 'claim payload',
    })
    const output = await renderToolUse({
      param,
      tool: makeTool({
        name: 'ClaimTool',
        label: 'Claim Submit',
        renderToolUseMessage: () => <Text>expanded claim detail</Text>,
        renderToolUseTag: () => <Text>tag detail</Text>,
      }),
      resolved: true,
      errored: true,
    })

    expect(output).toContain('✕')
    expect(output).toContain('Claim Submit')
    expect(output).toContain('claim payload')
    expect(output).toContain('expanded claim detail')
    expect(output).toContain('tag detail')
  })

  it('uses input summaries and React queued detail when the display reparse fails', async () => {
    let parseCount = 0
    const renderToolUseMessage = vi.fn(() => 'should not render')
    const param = toolUseParam('toolu_queued_node', 'SearchTool', {
      path: 'queued/path.ts',
    })
    const output = await renderToolUse({
      param,
      tool: makeTool({
        name: 'SearchTool',
        label: 'Search Tool',
        inputSchema: {
          safeParse: (input: unknown) => {
            parseCount += 1
            return parseCount === 1
              ? { success: true, data: input }
              : { success: false, error: new Error('second parse failed') }
          },
        } as unknown as Tool['inputSchema'],
        renderToolUseMessage,
        renderToolUseQueuedMessage: () => <Text>queued as node</Text>,
      }),
      inProgress: false,
    })

    expect(parseCount).toBe(2)
    expect(renderToolUseMessage).not.toHaveBeenCalled()
    expect(output).toContain('Search Tool')
    expect(output).toContain('queued/path.ts')
    expect(output).toContain('queued as node')
    expect(output).toContain('○')
  })

  it('suppresses queued and resolved transparent wrappers', async () => {
    const param = toolUseParam('toolu_transparent', 'Delegate', {
      prompt: 'outer task',
    })
    const renderToolUseProgressMessage = vi.fn(() => <Text>progress detail</Text>)
    const tool = {
      ...makeTool({
        name: 'Delegate',
        label: 'Delegate',
        isTransparentWrapper: () => true,
      }),
      renderToolUseProgressMessage,
    } as unknown as Tool

    const queuedOutput = await renderToolUse({
      param,
      tool,
      inProgress: false,
    })
    const resolvedOutput = await renderToolUse({
      param,
      tool,
      resolved: true,
    })

    expect(queuedOutput.trim()).toBe('')
    expect(resolvedOutput.trim()).toBe('')
    expect(renderToolUseProgressMessage).not.toHaveBeenCalled()
  })
})
