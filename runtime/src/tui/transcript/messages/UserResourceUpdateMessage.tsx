/**
 * Renders the inline notice that an MCP server has signaled either a
 * resource update (a file/URL the user previously attached has new
 * content) or a polling-tool update (a live tool's view has changed).
 *
 * The runtime tags these in the user-message stream as
 * `<mcp-resource-update server="..." uri="...">` or
 * `<mcp-polling-update type="..." server="..." tool="...">`, with an
 * optional `<reason>` child.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

export interface UserResourceUpdateParam {
  readonly text: string
  readonly type?: 'text'
}

export interface UserResourceUpdateMessageProps {
  readonly addMargin: boolean
  readonly param: UserResourceUpdateParam
}

interface ParsedUpdate {
  readonly kind: 'resource' | 'polling'
  readonly server: string
  /** URI for resource updates, tool name for polling updates. */
  readonly target: string
  readonly reason?: string
}

function parseUpdates(text: string): ParsedUpdate[] {
  const updates: ParsedUpdate[] = []

  const resourceRegex =
    /<mcp-resource-update\s+server="([^"]+)"\s+uri="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g
  let match: RegExpExecArray | null
  while ((match = resourceRegex.exec(text)) !== null) {
    updates.push({
      kind: 'resource',
      server: match[1] ?? '',
      target: match[2] ?? '',
      reason: match[3],
    })
  }

  const pollingRegex =
    /<mcp-polling-update\s+type="([^"]+)"\s+server="([^"]+)"\s+tool="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g
  while ((match = pollingRegex.exec(text)) !== null) {
    updates.push({
      kind: 'polling',
      server: match[2] ?? '',
      target: match[3] ?? '',
      reason: match[4],
    })
  }
  return updates
}

function formatUri(uri: string): string {
  if (uri.startsWith('file://')) {
    const path = uri.slice(7)
    const parts = path.split('/')
    return parts[parts.length - 1] || path
  }
  if (uri.length > 40) {
    return uri.slice(0, 39) + '…'
  }
  return uri
}

const REFRESH_ARROW = '⟳'

export function UserResourceUpdateMessage({
  addMargin,
  param: { text },
}: UserResourceUpdateMessageProps): React.ReactNode {
  const updates = parseUpdates(text)
  if (updates.length === 0) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      {updates.map((update, i) => (
        <Box key={i}>
          <Text>
            <Text color="success">{REFRESH_ARROW}</Text>
            {' '}
            <Text dimColor>{`${update.server}:`}</Text>
            {' '}
            <Text color="accent">
              {update.kind === 'resource'
                ? formatUri(update.target)
                : update.target}
            </Text>
            {update.reason ? (
              <Text dimColor>{` · ${update.reason}`}</Text>
            ) : null}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
