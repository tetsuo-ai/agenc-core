import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: (flag: string) => flag === 'BASH_CLASSIFIER',
}))

import type { Tool, Tools } from '../../../tools/Tool.js'
import { clearClassifierApprovals, setClassifierApproval } from '../../../utils/classifierApprovals.js'
import { renderToString } from '../../../utils/staticRender.js'
import { Text } from '../../ink.js'
import { UserToolSuccessMessage } from './UserToolSuccessMessage.js'

afterEach(() => {
  clearClassifierApprovals()
})

function createLookups(toolUseID: string) {
  return {
    inProgressHookCounts: new Map([
      [toolUseID, new Map([['PostToolUse', 1]])],
    ]),
    resolvedHookCounts: new Map(),
    toolUseByToolUseID: new Map([
      [toolUseID, { input: { path: 'src/recovered.ts' } }],
    ]),
  } as never
}

describe('UserToolSuccessMessage wave200-060 coverage', () => {
  const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('renders parsed successful output with filtered progress, input, approval, and hook status', async () => {
    const toolUseID = 'toolu_success_wave200_060'
    setClassifierApproval(toolUseID, 'Bash(ls:*)')

    const renderToolResultMessage = vi.fn(
      (
        result: { summary: string },
        progressMessages: ReadonlyArray<{ data: { type: string } }>,
        options: { input?: unknown; isBriefOnly?: boolean },
      ) => (
        <Text>
          {[
            result.summary,
            `progress:${progressMessages.length}`,
            `input:${(options.input as { path: string }).path}`,
            `brief:${String(options.isBriefOnly)}`,
          ].join(' ')}
        </Text>
      ),
    )

    const tool = {
      outputSchema: {
        safeParse: () => ({
          success: true,
          data: { summary: 'parsed tool result' },
        }),
      },
      renderToolResultMessage,
      userFacingName: () => 'Coverage tool',
    } as unknown as Tool
    const tools = [tool] as Tools

    const output = await renderToString(
      <UserToolSuccessMessage
        message={{
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseID,
                content: '<persisted-output>fallback should stay hidden</persisted-output>',
              },
            ],
          },
          toolUseResult: { raw: 'serialized result' },
        } as never}
        lookups={createLookups(toolUseID)}
        toolUseID={toolUseID}
        progressMessagesForMessage={[
          {
            toolUseID,
            data: { type: 'hook_progress', hookEvent: 'PostToolUse' },
          },
          {
            toolUseID,
            data: { type: 'bash_progress', totalLines: 3 },
          },
        ] as never}
        style="condensed"
        tool={tool}
        tools={tools}
        verbose={true}
        width={72}
      />,
      { columns: 100, rows: 12 },
    )

    expect(renderToolResultMessage).toHaveBeenCalledTimes(1)
    expect(renderToolResultMessage.mock.calls[0]?.[0]).toEqual({
      summary: 'parsed tool result',
    })
    expect(renderToolResultMessage.mock.calls[0]?.[1]).toHaveLength(1)
    expect(renderToolResultMessage.mock.calls[0]?.[1]?.[0]?.data.type).toBe(
      'bash_progress',
    )
    expect(renderToolResultMessage.mock.calls[0]?.[2]).toMatchObject({
      style: 'condensed',
      tools,
      verbose: true,
      isBriefOnly: false,
      input: { path: 'src/recovered.ts' },
    })
    expect(output).toContain('parsed tool result')
    expect(output).toContain('progress:1')
    expect(output).toContain('input:src/recovered.ts')
    expect(output).toContain('brief:false')
    expect(output).toContain('Auto-approved')
    expect(output).toContain('"Bash(ls:*)"')
    expect(output).toContain('Running PostToolUse hook')
    expect(output).not.toContain('fallback should stay hidden')
  })

  test('uses ASCII glyphs for auto-approval rows when glyph mode is ASCII', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    const toolUseID = 'toolu_success_ascii_approval'
    const fallbackToolUseID = 'toolu_success_ascii_fallback_approval'
    setClassifierApproval(toolUseID, 'Bash(cat:*)')
    setClassifierApproval(fallbackToolUseID, 'Bash(echo:*)')

    const tool = {
      renderToolResultMessage: () => <Text>ascii tool result</Text>,
      userFacingName: () => 'ASCII tool',
    } as unknown as Tool

    const output = await renderToString(
      <UserToolSuccessMessage
        message={{
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseID,
                content: 'fallback should stay hidden',
              },
            ],
          },
          toolUseResult: { ok: true },
        } as never}
        lookups={createLookups(toolUseID)}
        toolUseID={toolUseID}
        progressMessagesForMessage={[]}
        tool={tool}
        tools={[tool] as Tools}
        verbose={false}
        width={72}
      />,
      { columns: 100, rows: 12 },
    )
    const fallbackOutput = await renderToString(
      <UserToolSuccessMessage
        message={{
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: fallbackToolUseID,
                content: '<persisted-output>ascii fallback output</persisted-output>',
              },
            ],
          },
          toolUseResult: null,
        } as never}
        lookups={createLookups(fallbackToolUseID)}
        toolUseID={fallbackToolUseID}
        progressMessagesForMessage={[]}
        tools={[]}
        verbose={false}
        width={72}
      />,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('OK Auto-approved - matched "Bash(cat:*)"')
    expect(fallbackOutput).toContain('ascii fallback output')
    expect(fallbackOutput).toContain(
      'OK Auto-approved - matched "Bash(echo:*)"',
    )
    expect(`${output}\n${fallbackOutput}`).not.toMatch(/[✓✔·]/u)
  })
})
