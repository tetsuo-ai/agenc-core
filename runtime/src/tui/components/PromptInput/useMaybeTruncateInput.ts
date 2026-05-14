import { useEffect } from 'react'
import type { PastedContent } from '../../../utils/config.js'
import { maybeTruncateInput } from './inputPaste.js'

const TRUNCATE_INPUT_THRESHOLD = 10_000

type Props = {
  input: string
  pastedContents: Record<number, PastedContent>
  onInputChange: (input: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (contents: Record<number, PastedContent>) => void
}

export function buildTruncatedPromptInputUpdate(
  input: string,
  pastedContents: Record<number, PastedContent>,
): { newInput: string; newPastedContents: Record<number, PastedContent> } | null {
  if (input.length <= TRUNCATE_INPUT_THRESHOLD) {
    return null
  }

  const update = maybeTruncateInput(input, pastedContents)
  return update.newInput === input ? null : update
}

export function useMaybeTruncateInput({
  input,
  pastedContents,
  onInputChange,
  setCursorOffset,
  setPastedContents,
}: Props) {
  // Process input for truncation and pasted images from MessageSelector.
  useEffect(() => {
    const update = buildTruncatedPromptInputUpdate(
      input,
      pastedContents,
    )
    if (!update) {
      return
    }

    const { newInput, newPastedContents } = update
    onInputChange(newInput)
    setCursorOffset(newInput.length)
    setPastedContents(newPastedContents)
  }, [
    input,
    pastedContents,
    onInputChange,
    setPastedContents,
    setCursorOffset,
  ])
}
