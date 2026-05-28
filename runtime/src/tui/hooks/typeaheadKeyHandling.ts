export type AutocompleteKeyboardEvent = {
  key: string
  shift: boolean
  meta: boolean
  preventDefault: () => void
  stopImmediatePropagation: () => void
}

export function consumeAutocompleteEnterKey(
  event: AutocompleteKeyboardEvent,
  suggestionCount: number,
): boolean {
  if (suggestionCount === 0) return false
  if (
    event.key !== 'return' &&
    event.key !== 'enter' &&
    event.key !== 'Enter'
  ) {
    return false
  }
  if (event.shift || event.meta) return false

  event.preventDefault()
  event.stopImmediatePropagation()
  return true
}
