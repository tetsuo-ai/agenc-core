import { describe, expect, test } from 'vitest'

import type { PastedContent } from '../../../src/utils/config.js'
import {
  maybeTruncateInput,
  maybeTruncateMessageForInput,
} from '../../../src/tui/components/PromptInput/inputPaste.js'

const truncationThreshold = 10_000
const previewHalfLength = 500

function oversizedInput({
  middle = 'm'.repeat(truncationThreshold - previewHalfLength * 2 + 1),
  prefix = 'S'.repeat(previewHalfLength),
  suffix = 'E'.repeat(previewHalfLength),
}: {
  middle?: string
  prefix?: string
  suffix?: string
} = {}): string {
  return `${prefix}${middle}${suffix}`
}

describe('maybeTruncateMessageForInput', () => {
  test('leaves input at the truncation threshold untouched', () => {
    const input = 'a'.repeat(truncationThreshold)

    expect(maybeTruncateMessageForInput(input, 7)).toEqual({
      truncatedText: input,
      placeholderContent: '',
    })
  })

  test('keeps start and end previews while moving the middle into placeholder content', () => {
    const middle = `one\ntwo\r\nthree\rfour${'m'.repeat(9_000)}`
    const input = oversizedInput({ middle })

    const result = maybeTruncateMessageForInput(input, 42)

    expect(result.placeholderContent).toBe(middle)
    expect(result.truncatedText).toBe(
      `${'S'.repeat(previewHalfLength)}[...Truncated text #42 +3 lines...]${'E'.repeat(previewHalfLength)}`,
    )
  })
})

describe('maybeTruncateInput', () => {
  test('returns the original input and pasted content object when no truncation is needed', () => {
    const pastedContents: Record<number, PastedContent> = {
      3: {
        id: 3,
        type: 'text',
        content: 'existing paste',
      },
    }

    const result = maybeTruncateInput('short prompt', pastedContents)

    expect(result).toEqual({
      newInput: 'short prompt',
      newPastedContents: pastedContents,
    })
    expect(result.newPastedContents).toBe(pastedContents)
  })

  test('adds truncated content under the next id after existing pasted content', () => {
    const pastedContents: Record<number, PastedContent> = {
      2: {
        id: 2,
        type: 'text',
        content: 'first paste',
      },
      9: {
        id: 9,
        type: 'image',
        content: 'image-bytes',
        mediaType: 'image/png',
      },
    }
    const middle = 'hidden'.repeat(1_600)
    const input = oversizedInput({ middle })

    const result = maybeTruncateInput(input, pastedContents)

    expect(result.newInput).toBe(
      `${'S'.repeat(previewHalfLength)}[...Truncated text #10 +0 lines...]${'E'.repeat(previewHalfLength)}`,
    )
    expect(result.newPastedContents).toEqual({
      ...pastedContents,
      10: {
        id: 10,
        type: 'text',
        content: middle,
      },
    })
    expect(result.newPastedContents[2]).toBe(pastedContents[2])
    expect(result.newPastedContents[9]).toBe(pastedContents[9])
  })
})
