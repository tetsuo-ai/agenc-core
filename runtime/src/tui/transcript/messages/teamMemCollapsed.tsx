/**
 * teamMemCollapsed — renders the "team memory" count parts inside the
 * collapsed read/search aggregate row (e.g. "Read 2 files, recalled 3
 * team memories"). Lives next to the collapsed-read-search renderer
 * so call sites can compose it inline with the rest of the count list.
 *
 * Adapted from the upstream collapsed team-memory count helpers.
 *
 * AgenC scope notes:
 *   - Upstream gates this module behind a `feature('TEAMMEM')` macro so
 *     dead-code elimination can drop it from external builds. AgenC has
 *     no bundler-feature macro; the module is always available and call
 *     sites decide visibility based on the row payload's counts.
 *   - The shape upstream operates on (`CollapsedReadSearchGroup` with
 *     `teamMemorySearchCount`, `teamMemoryReadCount`, `teamMemoryWriteCount`)
 *     is preserved here as `TeamMemCounts` so AgenC's collapsed renderer
 *     can pass equivalent counts without reaching back into upstream
 *     types.
 *
 * @module
 */

import React from 'react'

import { Text } from '../../ink-public.js'

export interface TeamMemCounts {
  readonly teamMemorySearchCount?: number
  readonly teamMemoryReadCount?: number
  readonly teamMemoryWriteCount?: number
}

/**
 * Plain helper, not a React component, so consumers can branch on
 * presence before mounting any of the renderers below. Mirrors
 * upstream's `checkHasTeamMemOps` shape.
 */
export function checkHasTeamMemOps(message: TeamMemCounts): boolean {
  return (
    (message.teamMemorySearchCount ?? 0) > 0 ||
    (message.teamMemoryReadCount ?? 0) > 0 ||
    (message.teamMemoryWriteCount ?? 0) > 0
  )
}

export interface TeamMemCountPartsProps {
  readonly message: TeamMemCounts
  /** Whether the parent group is the active (currently in-flight) one. */
  readonly isActiveGroup: boolean
  /**
   * When true, the count list already has a leading entry (e.g. file
   * reads) and the team-memory parts should join with a comma prefix.
   */
  readonly hasPrecedingParts: boolean
}

/**
 * Renders the collapsed "recalled N team memories, searched team
 * memories, wrote N team memories" segment. Returns `null` when none of
 * the team-memory counts are non-zero.
 */
export function TeamMemCountParts({
  message,
  isActiveGroup,
  hasPrecedingParts,
}: TeamMemCountPartsProps): React.ReactElement | null {
  const tmReadCount = message.teamMemoryReadCount ?? 0
  const tmSearchCount = message.teamMemorySearchCount ?? 0
  const tmWriteCount = message.teamMemoryWriteCount ?? 0

  if (tmReadCount === 0 && tmSearchCount === 0 && tmWriteCount === 0) {
    return null
  }

  const nodes: React.ReactNode[] = []
  let count = hasPrecedingParts ? 1 : 0

  if (tmReadCount > 0) {
    const verb = isActiveGroup
      ? count === 0
        ? 'Recalling'
        : 'recalling'
      : count === 0
        ? 'Recalled'
        : 'recalled'
    if (count > 0) nodes.push(<Text key="comma-tmr">{', '}</Text>)
    nodes.push(
      <Text key="team-mem-read">
        {`${verb} `}
        <Text bold>{tmReadCount}</Text>
        {` team ${tmReadCount === 1 ? 'memory' : 'memories'}`}
      </Text>,
    )
    count += 1
  }

  if (tmSearchCount > 0) {
    const verb = isActiveGroup
      ? count === 0
        ? 'Searching'
        : 'searching'
      : count === 0
        ? 'Searched'
        : 'searched'
    if (count > 0) nodes.push(<Text key="comma-tms">{', '}</Text>)
    nodes.push(
      <Text key="team-mem-search">{`${verb} team memories`}</Text>,
    )
    count += 1
  }

  if (tmWriteCount > 0) {
    const verb = isActiveGroup
      ? count === 0
        ? 'Writing'
        : 'writing'
      : count === 0
        ? 'Wrote'
        : 'wrote'
    if (count > 0) nodes.push(<Text key="comma-tmw">{', '}</Text>)
    nodes.push(
      <Text key="team-mem-write">
        {`${verb} `}
        <Text bold>{tmWriteCount}</Text>
        {` team ${tmWriteCount === 1 ? 'memory' : 'memories'}`}
      </Text>,
    )
  }

  return <>{nodes}</>
}

export default TeamMemCountParts
