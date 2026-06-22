const QUOTED_AGENT_RE = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
const UNQUOTED_AGENT_RE = /(^|\s)@(agent-[\w:.@-]+)/g

interface AgentMentionToken {
  readonly type: string
  readonly legacyValue: string
}

function extractAgentMentionTokens(input: string | null): AgentMentionToken[] {
  if (input === null || input.length === 0) return []

  const tokens: AgentMentionToken[] = []
  const seenLegacyValues = new Set<string>()
  const pushToken = (type: string, legacyValue: string): void => {
    if (type.length === 0 || seenLegacyValues.has(legacyValue)) return
    seenLegacyValues.add(legacyValue)
    tokens.push({ type, legacyValue })
  }

  let match: RegExpExecArray | null
  QUOTED_AGENT_RE.lastIndex = 0
  while ((match = QUOTED_AGENT_RE.exec(input)) !== null) {
    const type = match[2]
    if (type !== undefined) pushToken(type, type)
  }

  UNQUOTED_AGENT_RE.lastIndex = 0
  while ((match = UNQUOTED_AGENT_RE.exec(input)) !== null) {
    const raw = match[2]
    if (raw === undefined || !raw.startsWith('agent-')) continue
    const type = raw.slice('agent-'.length)
    pushToken(type, raw)
  }

  return tokens
}

export function extractLegacyAgentMentions(input: string | null): string[] {
  return extractAgentMentionTokens(input).map(token => token.legacyValue)
}

export function extractAgentMentionTypes(input: string | null): string[] {
  const seenTypes = new Set<string>()
  const types: string[] = []
  for (const token of extractAgentMentionTokens(input)) {
    if (seenTypes.has(token.type)) continue
    seenTypes.add(token.type)
    types.push(token.type)
  }
  return types
}
