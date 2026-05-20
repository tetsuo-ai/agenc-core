import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { UserPromptMessage } from './UserPromptMessage.js'

describe('UserPromptMessage coverage', () => {
  test('renders long prompts with head-tail truncation in the user message layout', async () => {
    const head = `HEAD_START ${'h'.repeat(2_489)}`
    const hidden = Array.from(
      { length: 900 },
      (_, index) => `MIDDLE_SENTINEL_${index}`,
    ).join('\n')
    const tail = `${'t'.repeat(2_491)} TAIL_END`

    const output = await renderToString(
      <UserPromptMessage
        addMargin={false}
        param={{ type: 'text', text: `${head}\n${hidden}\n${tail}` }}
        timestamp="12:34"
      />,
      { columns: 6_000, rows: 24 },
    )

    expect(output).toContain('YOU')
    expect(output).toContain('12:34')
    expect(output).toContain('HEAD_START')
    expect(output).toContain('TAIL_END')
    expect(output).toMatch(/… \+\d+ lines …/)
    expect(output).not.toContain('MIDDLE_SENTINEL')
  })
})
