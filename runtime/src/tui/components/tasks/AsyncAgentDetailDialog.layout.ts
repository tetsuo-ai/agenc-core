const ASYNC_AGENT_DETAIL_HORIZONTAL_PADDING = 4
const ASYNC_AGENT_PROMPT_PREVIEW_ROWS = 4

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0
}

export function getAsyncAgentDetailContentColumns(columns: number): number {
  return Math.max(1, normalizeColumns(columns) - ASYNC_AGENT_DETAIL_HORIZONTAL_PADDING)
}

export function getAsyncAgentPromptPreview(
  prompt: string,
  columns: number,
): string {
  const previewColumns = getAsyncAgentDetailContentColumns(columns)
  const maxCharacters = Math.max(1, Math.min(300, previewColumns * ASYNC_AGENT_PROMPT_PREVIEW_ROWS))

  if (prompt.length <= maxCharacters) {
    return prompt
  }

  if (maxCharacters === 1) {
    return '…'
  }

  return `${prompt.slice(0, maxCharacters - 1)}…`
}
