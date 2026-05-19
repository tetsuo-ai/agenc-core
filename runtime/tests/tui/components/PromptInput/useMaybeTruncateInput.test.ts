import { describe, expect, test } from 'vitest'

import { buildTruncatedPromptInputUpdate } from './useMaybeTruncateInput.js'

const oversizedInput = (prefix: string) =>
  `${prefix}\n${'x'.repeat(10_500)}\n${prefix}`

describe('buildTruncatedPromptInputUpdate', () => {
  test('truncates each distinct oversized input even when pasted content already exists', () => {
    const firstUpdate = buildTruncatedPromptInputUpdate(oversizedInput('first'), {})

    expect(firstUpdate).not.toBeNull()
    expect(firstUpdate!.newInput).toContain('[...Truncated text #1 +')
    expect(firstUpdate!.newPastedContents[1]?.type).toBe('text')

    const secondUpdate = buildTruncatedPromptInputUpdate(
      oversizedInput('second'),
      firstUpdate!.newPastedContents,
    )

    expect(secondUpdate).not.toBeNull()
    expect(secondUpdate!.newInput).toContain('[...Truncated text #2 +')
    expect(secondUpdate!.newPastedContents[1]).toBe(firstUpdate!.newPastedContents[1])
    expect(secondUpdate!.newPastedContents[2]?.type).toBe('text')
    expect(secondUpdate!.newPastedContents[2]?.content).toContain('x')
  })

  test('returns null for input that is already compact enough', () => {
    expect(buildTruncatedPromptInputUpdate('short prompt', {})).toBeNull()
  })
})
