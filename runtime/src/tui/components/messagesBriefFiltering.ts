/**
 * In brief-only mode, filter messages to show ONLY Brief tool_use blocks,
 * their tool_results, and real user input. All assistant text is dropped.
 */
export function filterForBriefTool<T extends {
  type: string
  subtype?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  message?: {
    content: Array<{
      type: string
      name?: string
      tool_use_id?: string
    }>
  }
  attachment?: {
    type: string
    isMeta?: boolean
    origin?: unknown
    commandMode?: string
  }
}>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames)
  const briefToolUseIDs = new Set<string>()
  return messages.filter((msg) => {
    if (msg.type === 'system') return msg.subtype !== 'api_metrics'
    const block = msg.message?.content[0]
    if (msg.type === 'assistant') {
      if (msg.isApiErrorMessage) return true
      if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        if ('id' in block) {
          briefToolUseIDs.add((block as { id: string }).id)
        }
        return true
      }
      return false
    }
    if (msg.type === 'user') {
      if (block?.type === 'tool_result') {
        return (
          block.tool_use_id !== undefined &&
          briefToolUseIDs.has(block.tool_use_id)
        )
      }
      return !msg.isMeta
    }
    if (msg.type === 'attachment') {
      const att = msg.attachment
      return (
        att?.type === 'queued_command' &&
        att.commandMode === 'prompt' &&
        !att.isMeta &&
        att.origin === undefined
      )
    }
    return false
  })
}

/**
 * Full-transcript companion to filterForBriefTool. When the Brief tool is
 * in use, the model's text output is redundant with the SendUserMessage
 * content it wrote right after, so drop the text for that turn.
 */
export function dropTextInBriefTurns<T extends {
  type: string
  isMeta?: boolean
  message?: {
    content: Array<{
      type: string
      name?: string
    }>
  }
}>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames)
  const turnsWithBrief = new Set<number>()
  const textIndexToTurn: number[] = []
  let turn = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const block = msg.message?.content[0]
    if (msg.type === 'user' && block?.type !== 'tool_result' && !msg.isMeta) {
      turn++
      continue
    }
    if (msg.type === 'assistant') {
      if (block?.type === 'text') {
        textIndexToTurn[i] = turn
      } else if (
        block?.type === 'tool_use' &&
        block.name &&
        nameSet.has(block.name)
      ) {
        turnsWithBrief.add(turn)
      }
    }
  }
  if (turnsWithBrief.size === 0) return messages
  return messages.filter((_, i) => {
    const t = textIndexToTurn[i]
    return t === undefined || !turnsWithBrief.has(t)
  })
}
