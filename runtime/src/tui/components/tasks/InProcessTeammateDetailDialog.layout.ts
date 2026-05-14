const TEAMMATE_DETAIL_HORIZONTAL_PADDING = 4
const TEAMMATE_PROMPT_PREVIEW_ROWS = 4

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0
}

export function getInProcessTeammateDetailContentColumns(
  columns: number,
): number {
  return Math.max(1, normalizeColumns(columns) - TEAMMATE_DETAIL_HORIZONTAL_PADDING)
}

export function getInProcessTeammatePromptPreview(
  prompt: string,
  columns: number,
  ellipsis = '…',
): string {
  const previewColumns = getInProcessTeammateDetailContentColumns(columns)
  const maxCharacters = Math.max(
    1,
    Math.min(300, previewColumns * TEAMMATE_PROMPT_PREVIEW_ROWS),
  )

  if (prompt.length <= maxCharacters) {
    return prompt
  }

  if (maxCharacters <= ellipsis.length) {
    return ellipsis.slice(0, maxCharacters)
  }

  return `${prompt.slice(0, maxCharacters - ellipsis.length)}${ellipsis}`
}
