/**
 * AgentProgressLine — single-line subagent status row used inside the
 * coordinator status block.
 *
 * Adapted from the upstream agent-progress-line component.
 *
 * AgenC scope notes:
 *   - Upstream's swarm shape gives each agent a custom name + color
 *     (loaded from a per-agent config file or wizard). AgenC uses a
 *     thread-manager-style state — `{ threadId, role, status, label?,
 *     model?, tokenUsage? }`. The agent CRUD wizard is explicitly NOT
 *     being ported, so per-agent custom colors are dropped: this row
 *     uses static defaults (`accent` brand color, role label as the
 *     agent label, first letter of role as a badge when no glyph is
 *     provided).
 *   - The upstream `descriptionColor` knob is also dropped — it backed
 *     a similar per-agent customization.
 *   - The "Initializing…", "Running in the background", "Done" copy is
 *     preserved verbatim from upstream.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'
import type { Theme } from '../../theme.js'

type ColorKey = keyof Theme['colors']

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

export interface AgentProgressLineProps {
  /**
   * Role label for the row's primary tag (e.g. "scout", "verifier").
   * Falls back to `name` if the caller has no role on hand.
   */
  readonly role: string
  /** Optional human-readable description, shown after the role tag. */
  readonly description?: string
  /** Optional display nickname, used when `hideRole` is true. */
  readonly name?: string
  /** Optional task description shown when the agent is backgrounded. */
  readonly taskDescription?: string
  /** Number of tool calls the agent has issued so far. */
  readonly toolUseCount: number
  /** Cumulative token usage; pass null when unknown. */
  readonly tokens: number | null
  /** Theme color key for the role tag background. Default: `accent`. */
  readonly color?: ColorKey
  /** Whether this row is the last child in the tree. */
  readonly isLast: boolean
  /** Whether the agent has reached a terminal status. */
  readonly isResolved: boolean
  /** Whether the agent terminated with an error status. */
  readonly isError?: boolean
  /** Whether the agent is running asynchronously / in the background. */
  readonly isAsync?: boolean
  /** Optional last-tool-info string shown while running ("Reading …"). */
  readonly lastToolInfo?: string | null
  /**
   * When true, suppress the role tag and show the `name`/`description`
   * inline instead. Used by call sites that already render the role
   * separately.
   */
  readonly hideRole?: boolean
}

export function AgentProgressLine({
  role,
  description,
  name,
  taskDescription,
  toolUseCount,
  tokens,
  color = 'accent',
  isLast,
  isResolved,
  isAsync = false,
  lastToolInfo,
  hideRole = false,
}: AgentProgressLineProps): React.ReactElement {
  const treeChar = isLast ? '└─' : '├─'
  const isBackgrounded = isAsync && isResolved

  const getStatusText = (): string => {
    if (!isResolved) {
      return lastToolInfo || 'Initializing…'
    }
    if (isBackgrounded) {
      return taskDescription ?? 'Running in the background'
    }
    return 'Done'
  }

  // Header: role tag (or hideRole inline name+description), then
  // optional " · N tool uses · M tokens" suffix when not backgrounded.
  const header = hideRole ? (
    <>
      <Text bold>{name ?? description ?? role}</Text>
      {name && description ? <Text dimColor>{`: ${description}`}</Text> : null}
    </>
  ) : (
    <>
      <Text bold backgroundColor={color} color="ink">
        {role}
      </Text>
      {description ? (
        <>
          {' ('}
          <Text color={color}>{description}</Text>
          {')'}
        </>
      ) : null}
    </>
  )

  const stats = !isBackgrounded ? (
    <>
      {' · '}
      {`${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'}`}
      {tokens !== null ? ` · ${formatNumber(tokens)} tokens` : ''}
    </>
  ) : null

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3}>
        <Text dimColor>{`${treeChar} `}</Text>
        <Text dimColor={!isResolved}>
          {header}
          {stats}
        </Text>
      </Box>
      {!isBackgrounded ? (
        <Box paddingLeft={3} flexDirection="row">
          <Text dimColor>{isLast ? '   ⏿  ' : '│  ⏿  '}</Text>
          <Text dimColor>{getStatusText()}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default AgentProgressLine
