import { describe, expect, test, vi } from 'vitest'

import {
  renderableSearchText,
  toolResultSearchText,
  toolUseSearchText,
} from './transcriptSearch.js'

vi.mock('../../utils/messages.js', () => ({
  INTERRUPT_MESSAGE: '[Request interrupted by user]',
  INTERRUPT_MESSAGE_FOR_TOOL_USE: '[Request interrupted by user for tool use]',
}))

const INTERRUPT_MESSAGE = '[Request interrupted by user]'

describe('renderableSearchText', () => {
  test('lowercases user text and omits rendered interrupt sentinels', () => {
    expect(renderableSearchText({
      type: 'user',
      message: {
        content: 'Find ME',
      },
    } as never)).toBe('find me')

    expect(renderableSearchText({
      type: 'user',
      message: {
        content: INTERRUPT_MESSAGE,
      },
    } as never)).toBe('')
  })

  test('indexes native tool output instead of model-facing tool result content', () => {
    const result = renderableSearchText({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: '<system-reminder>hidden model reminder</system-reminder>',
          },
        ],
      },
      toolUseResult: {
        stdout: 'Visible STDOUT',
        stderr: 'Visible STDERR',
      },
    } as never)

    expect(result).toContain('visible stdout')
    expect(result).toContain('visible stderr')
    expect(result).not.toContain('hidden model reminder')
  })

  test('indexes assistant text and visible tool-use fields', () => {
    const result = renderableSearchText({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Answer block',
          },
          {
            type: 'thinking',
            thinking: 'hidden chain',
          },
          {
            type: 'tool_use',
            input: {
              command: 'npm test',
              rawOutputPath: 'not rendered',
            },
          },
        ],
      },
    } as never)

    expect(result).toContain('answer block')
    expect(result).toContain('npm test')
    expect(result).not.toContain('hidden chain')
    expect(result).not.toContain('not rendered')
  })
})

describe('tool search helpers', () => {
  test('extracts common tool-use fields and arrays', () => {
    expect(toolUseSearchText({
      pattern: 'needle',
      files: ['a.ts', 'b.ts'],
      ignored: 'metadata',
    })).toBe('needle\na.ts b.ts')
  })

  test('extracts allowlisted tool-result fields only', () => {
    expect(toolResultSearchText({
      output: 'shown',
      rawOutputPath: 'hidden',
    })).toBe('shown')
  })
})
