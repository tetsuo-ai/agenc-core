import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import Text from '../../ink/components/Text.js'
import { renderToString } from '../../../utils/staticRender.js'
import {
  buildTruncatedPromptInputUpdate,
  useMaybeTruncateInput,
} from './useMaybeTruncateInput.js'

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

  test('returns null when truncation leaves oversized input unchanged', async () => {
    const input = oversizedInput('unchanged')

    vi.resetModules()
    vi.doMock('./inputPaste.js', () => ({
      maybeTruncateInput: () => ({
        newInput: input,
        newPastedContents: {},
      }),
    }))

    const { buildTruncatedPromptInputUpdate } = await import(
      './useMaybeTruncateInput.js'
    )

    expect(buildTruncatedPromptInputUpdate(input, {})).toBeNull()
  })
})

afterEach(() => {
  vi.doUnmock('./inputPaste.js')
})

function TruncateProbe({
  input,
  onInputChange,
  setCursorOffset,
  setPastedContents,
}: {
  input: string
  onInputChange: (input: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (contents: Record<number, unknown>) => void
}) {
  useMaybeTruncateInput({
    input,
    pastedContents: {},
    onInputChange,
    setCursorOffset,
    setPastedContents: setPastedContents as never,
  })

  return <Text>probe</Text>
}

describe('useMaybeTruncateInput', () => {
  test('does nothing while input is below the truncation threshold', async () => {
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const setPastedContents = vi.fn()

    await renderToString(
      <TruncateProbe
        input="short prompt"
        onInputChange={onInputChange}
        setCursorOffset={setCursorOffset}
        setPastedContents={setPastedContents}
      />,
      80,
    )

    expect(onInputChange).not.toHaveBeenCalled()
    expect(setCursorOffset).not.toHaveBeenCalled()
    expect(setPastedContents).not.toHaveBeenCalled()
  })

  test('applies truncated input and pasted content updates', async () => {
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const setPastedContents = vi.fn()

    await renderToString(
      <TruncateProbe
        input={oversizedInput('hook')}
        onInputChange={onInputChange}
        setCursorOffset={setCursorOffset}
        setPastedContents={setPastedContents}
      />,
      80,
    )

    const newInput = onInputChange.mock.calls[0]?.[0] as string
    expect(newInput).toContain('[...Truncated text #1 +')
    expect(setCursorOffset).toHaveBeenCalledWith(newInput.length)
    expect(setPastedContents.mock.calls[0]?.[0][1]?.type).toBe('text')
  })
})
