/**
 * CoordinatorAgentStatus — coordinator-side status block listing live
 * subagents, shown beneath the main transcript / above the prompt input.
 *
 * Adapted from the upstream coordinator-task-panel component.
 *
 * AgenC scope notes:
 *   - Upstream is heavily wired to a per-named-agent swarm AppState:
 *     selection cursor, evictAfter/dismiss keybindings, agent name
 *     registry, viewing-cursor toggling, mailbox-driven "x to stop"
 *     hints. AgenC's thread-manager state has none of those — the
 *     `AgentRegistry` just tracks live `AgentMetadata`. This component
 *     therefore renders a presentational status block only: one line
 *     per live agent with the role label, status, elapsed time, and
 *     token count when known. Selection / dismissal hooks will land
 *     in a later tranche.
 *   - The upstream `agentNameRegistry` / `coordinatorTaskIndex` /
 *     `viewingAgentTaskId` AppState reads are removed. Callers pass
 *     a flat `agents` array of `LiveAgentStatus` snapshots, which
 *     downstream dispatchers can build from `AgentRegistry.liveAgents()`
 *     and per-thread `AgentStatus` reads.
 *   - `formatDuration` and `formatNumber` are inlined here so the file
 *     does not depend on a `utils/format.js` we have not ported.
 *
 * @module
 */

import React from 'react'

import { formatAgentRoleLabel } from '../../../agents/role-presentation.js'
import { Box, Text } from '../../ink-public.js'
import { glyphs } from '../../design-system/glyphs.js'

const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●'

/** Status FSM for a live subagent (mirrors `AgentStatus` from session.ts). */
export type LiveAgentStatusKind =
  | 'pending_init'
  | 'idle'
  | 'running'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'interrupted'

export interface LiveAgentStatus {
  /** Stable thread / agent id. */
  readonly threadId: string
  /** Role label (e.g. "scout", "verifier"). */
  readonly role: string
  /** Optional display nickname. Falls back to role when absent. */
  readonly nickname?: string
  /** Optional model identifier (informational only). */
  readonly model?: string
  /** Current status kind. */
  readonly status: LiveAgentStatusKind
  /** Wall-clock millisecond timestamp the agent started. */
  readonly startedAtMs?: number
  /** Wall-clock millisecond timestamp the agent ended (terminal only). */
  readonly endedAtMs?: number
  /** Optional cumulative token usage. */
  readonly tokens?: number
  /**
   * Optional last-tool-info string ("Reading config.toml") shown while
   * the agent is in `running`. Populated by the dispatcher from the
   * latest `tool_call_started` for that thread.
   */
  readonly lastToolInfo?: string
  /** Optional task description shown when the agent is backgrounded. */
  readonly taskDescription?: string
}

export interface CoordinatorAgentStatusProps {
  readonly agents: readonly LiveAgentStatus[]
  /**
   * "Now" timestamp used to compute elapsed durations. Tests pass a
   * fixed value; production passes `Date.now()` from a 1s tick.
   */
  readonly now?: number
}

function isTerminalStatus(s: LiveAgentStatusKind): boolean {
  return (
    s === 'completed' ||
    s === 'errored' ||
    s === 'shutdown' ||
    s === 'interrupted'
  )
}

function statusBullet(s: LiveAgentStatusKind): string {
  switch (s) {
    case 'running':
      return BLACK_CIRCLE
    case 'pending_init':
      return glyphs.circle
    case 'completed':
      return glyphs.tick
    case 'errored':
      return glyphs.cross
    case 'shutdown':
    case 'interrupted':
      return glyphs.warning
    case 'idle':
    default:
      return glyphs.circle
  }
}

function statusColor(
  s: LiveAgentStatusKind,
): 'success' | 'error' | 'warning' | 'accent' | undefined {
  switch (s) {
    case 'running':
    case 'pending_init':
      return 'accent'
    case 'completed':
      return 'success'
    case 'errored':
      return 'error'
    case 'shutdown':
    case 'interrupted':
      return 'warning'
    case 'idle':
    default:
      return undefined
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

export function CoordinatorAgentStatus({
  agents,
  now,
}: CoordinatorAgentStatusProps): React.ReactElement | null {
  if (!Array.isArray(agents) || agents.length === 0) return null

  const ts = typeof now === 'number' ? now : Date.now()

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>{`  ${BLACK_CIRCLE} main`}</Text>
      </Box>
      {agents.map((agent) => (
        <AgentLine key={agent.threadId} agent={agent} now={ts} />
      ))}
    </Box>
  )
}

interface AgentLineProps {
  readonly agent: LiveAgentStatus
  readonly now: number
}

function AgentLine({ agent, now }: AgentLineProps): React.ReactElement {
  const isRunning = !isTerminalStatus(agent.status)
  const startedAt = agent.startedAtMs ?? now
  const endedAt = agent.endedAtMs ?? now
  const elapsedMs = Math.max(
    0,
    isRunning ? now - startedAt : endedAt - startedAt,
  )
  const elapsed = formatDuration(elapsedMs)

  const label = agent.nickname ?? formatAgentRoleLabel(agent.role, agent.role)
  const tokens = typeof agent.tokens === 'number' && agent.tokens > 0
    ? ` · ${glyphs.arrowUp} ${formatNumber(agent.tokens)} tokens`
    : ''

  const tail = isRunning && agent.lastToolInfo
    ? ` · ${agent.lastToolInfo}`
    : !isRunning && agent.taskDescription
      ? ` · ${agent.taskDescription}`
      : ''

  const bullet = statusBullet(agent.status)
  const color = statusColor(agent.status)

  return (
    <Box>
      <Text>
        {'  '}
        <Text color={color}>{bullet}</Text>
        {' '}
        <Text bold>{label}</Text>
        {agent.model ? <Text dimColor>{` (${agent.model})`}</Text> : null}
        <Text dimColor>{` · ${elapsed}${tokens}${tail}`}</Text>
      </Text>
    </Box>
  )
}

export default CoordinatorAgentStatus
