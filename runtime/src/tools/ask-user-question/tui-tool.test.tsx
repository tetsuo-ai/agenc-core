import { describe, expect, test, vi } from 'vitest'

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
})

function never(): never {
  throw new Error('unreachable')
}
