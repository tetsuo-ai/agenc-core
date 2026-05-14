export const CONSOLE_OAUTH_PASTE_PROMPT = 'Paste code here if prompted > '

const CONTENT_PADDING_COLUMNS = 1
const MIN_INLINE_PASTE_INPUT_COLUMNS = 8

export type ConsoleOAuthPasteLayout = {
  flexDirection: 'row' | 'column'
  inputColumns: number
}

export function getConsoleOAuthPasteLayout(
  terminalColumns: number,
): ConsoleOAuthPasteLayout {
  const normalizedColumns = Number.isFinite(terminalColumns)
    ? Math.floor(terminalColumns)
    : 0
  const availableColumns = Math.max(
    1,
    normalizedColumns - CONTENT_PADDING_COLUMNS,
  )
  const inlineInputColumns =
    availableColumns - CONSOLE_OAUTH_PASTE_PROMPT.length - 1

  if (inlineInputColumns >= MIN_INLINE_PASTE_INPUT_COLUMNS) {
    return {
      flexDirection: 'row',
      inputColumns: inlineInputColumns,
    }
  }

  return {
    flexDirection: 'column',
    inputColumns: availableColumns,
  }
}
