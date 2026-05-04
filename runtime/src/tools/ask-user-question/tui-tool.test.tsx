import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../tui/ink.js', () => ({
  Box: ({ children }: { readonly children?: unknown }) => ({
    type: 'Box',
    props: { children },
  }),
  Text: ({ children }: { readonly children?: unknown }) => ({
    type: 'Text',
    props: { children },
  }),
}))

import { AskUserQuestionTool } from './tui-tool.js'
import {
  setAllowedChannels,
  setQuestionPreviewFormat,
} from '../../agenc/upstream/bootstrap/state.js'

const input = {
  questions: [
    {
      question: 'Which path should AgenC take?',
      header: 'Path',
      options: [
        { label: 'Port', description: 'Move the behavior into AgenC.' },
        { label: 'Defer', description: 'Leave it for a later item.' },
      ],
    },
  ],
}

describe('AskUserQuestion TUI tool adapter', () => {
  afterEach(() => {
    setAllowedChannels([])
    setQuestionPreviewFormat('markdown')
  })

  test('rejects malformed input and output payloads', () => {
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [] })).toMatchObject({
      success: false,
    })
    expect(AskUserQuestionTool.outputSchema.safeParse(input)).toMatchObject({
      success: false,
    })
  })

  test('formats answers, annotations, and tool-result blocks', () => {
    const output = {
      ...input,
      answers: {
        'Which path should AgenC take?': 'Port',
      },
      annotations: {
        'Which path should AgenC take?': {
          preview: 'diff preview',
          notes: 'user note',
        },
      },
    }

    const parsed = AskUserQuestionTool.outputSchema.safeParse(output)
    expect(parsed.success).toBe(true)
    const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
      parsed.success ? parsed.data : never(),
      'toolu-1',
    )

    expect(block).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu-1',
    })
    expect(block.content).toContain('"Which path should AgenC take?"="Port"')
    expect(block.content).toContain('selected preview:\ndiff preview')
    expect(block.content).toContain('user notes: user note')
  })

  test('renders visible answered and rejected messages', () => {
    const output = {
      ...input,
      answers: {
        'Which path should AgenC take?': 'Port',
      },
    }

    expect(AskUserQuestionTool.renderToolResultMessage(output)).not.toBeNull()
    expect(AskUserQuestionTool.renderToolUseRejectedMessage()).toMatchObject({
      props: { children: 'User declined to answer questions' },
    })
  })

  test('disables interactive questions when channel sessions are active', () => {
    expect(AskUserQuestionTool.isEnabled()).toBe(true)
    setAllowedChannels([{ kind: 'server', name: 'slack' }])
    expect(AskUserQuestionTool.isEnabled()).toBe(false)
  })

  test('validates HTML previews when HTML preview mode is active', async () => {
    setQuestionPreviewFormat('html')

    await expect(
      AskUserQuestionTool.validateInput({
        questions: [
          {
            question: 'Which preview?',
            header: 'Preview',
            options: [
              { label: 'Good', description: 'fragment', preview: '<div>ok</div>' },
              { label: 'Plain', description: 'no preview' },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ result: true })

    await expect(
      AskUserQuestionTool.validateInput({
        questions: [
          {
            question: 'Which preview?',
            header: 'Preview',
            options: [
              {
                label: 'Doc',
                description: 'full document',
                preview: '<html><body>bad</body></html>',
              },
              { label: 'Other', description: 'no preview' },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 1,
      message: expect.stringContaining('full document'),
    })

    await expect(
      AskUserQuestionTool.validateInput({
        questions: [
          {
            question: 'Which preview?',
            header: 'Preview',
            options: [
              {
                label: 'Script',
                description: 'script tag',
                preview: '<script>alert(1)</script>',
              },
              { label: 'Other', description: 'no preview' },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 1,
      message: expect.stringContaining('<script> or <style>'),
    })
  })
})

function never(): never {
  throw new Error('unreachable')
}
