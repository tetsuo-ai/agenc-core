import { isMemoryMention } from '../memory/index.js'

// Extract MCP resources mentioned with @ symbol in format @server:uri.
// Two guards prevent Windows-path / quoted-file collisions:
// 1. `(?!")` drops quoted tokens entirely, avoiding ghost matches for quoted
//    file mentions containing a colon.
// 2. `"` in the character classes prevents consuming quotes mid-match if the
//    lookahead is later changed.
const MCP_RESOURCE_MENTION_RE = /(^|\s)@(?!")([^\s"]+:[^\s"]+)\b/g

export interface McpResourceMention {
  readonly serverName: string
  readonly uri: string
}

export function extractMcpResourceMentions(content: string | null): string[] {
  if (content === null || content.length === 0) return []

  const mentions: string[] = []
  const seen = new Set<string>()
  MCP_RESOURCE_MENTION_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = MCP_RESOURCE_MENTION_RE.exec(content)) !== null) {
    const mention = match[2]
    if (mention === undefined) continue
    // A single-letter "server" followed by `:\` or `:/` is always a Windows
    // drive-letter prefix, never a real MCP resource.
    if (/^[A-Za-z]:[\\/]/.test(mention)) continue
    if (isMemoryMention(`@${mention}`)) continue
    if (seen.has(mention)) continue
    seen.add(mention)
    mentions.push(mention)
  }

  return mentions
}

export function parseMcpResourceMention(
  mention: string,
): McpResourceMention | null {
  const [serverName, ...uriParts] = mention.split(':')
  const uri = uriParts.join(':')
  if (serverName === undefined || serverName.length === 0 || uri.length === 0) {
    return null
  }
  return { serverName, uri }
}
