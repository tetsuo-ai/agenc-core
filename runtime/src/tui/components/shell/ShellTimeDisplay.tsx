import React from 'react'

import { formatDuration } from '../../../utils/format.js' // upstream-import: keep target is owned by another Z-PURGE item
import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { Text } from '../../ink.js'

type Props = {
  elapsedTimeSeconds?: number
  timeoutMs?: number
}

export function ShellTimeDisplay({
  elapsedTimeSeconds,
  timeoutMs,
}: Props): React.ReactNode {
  if (elapsedTimeSeconds === undefined && !timeoutMs) {
    return null
  }

  const timeout = timeoutMs
    ? formatDuration(timeoutMs, { hideTrailingZeros: true })
    : undefined

  if (elapsedTimeSeconds === undefined) {
    return <Text dimColor>{`(timeout ${timeout})`}</Text>
  }

  const elapsed = formatDuration(elapsedTimeSeconds * 1000)
  if (timeout) {
    const separator = selectAgenCTuiGlyphs().separator
    return <Text dimColor>{`(${elapsed} ${separator} timeout ${timeout})`}</Text>
  }

  return <Text dimColor>{`(${elapsed})`}</Text>
}
