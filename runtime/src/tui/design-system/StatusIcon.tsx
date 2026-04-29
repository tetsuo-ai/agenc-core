import React from 'react'
import type { Theme } from '../theme.js'
import { glyphs } from './glyphs.js'
import ThemedText from './ThemedText.js'

type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading'

type Props = {
  /**
   * The status to display. Determines both the icon and color.
   *
   * - `success`: ✓ in success color (frost violet in cyberpunk)
   * - `error`: ✗ in error color (crimson)
   * - `warning`: ⚠ in warning color (rose)
   * - `info`: ℹ in info color (periwinkle)
   * - `pending`: ◯ dimmed
   * - `loading`: … dimmed
   */
  status: Status
  /**
   * Include a trailing space after the icon. Useful when followed by text.
   * @default false
   */
  withSpace?: boolean
}

const STATUS_CONFIG: Record<
  Status,
  {
    icon: string
    color: keyof Theme['colors'] | undefined
  }
> = {
  success: { icon: glyphs.tick, color: 'success' },
  error: { icon: glyphs.cross, color: 'error' },
  warning: { icon: glyphs.warning, color: 'warning' },
  info: { icon: glyphs.info, color: 'info' },
  pending: { icon: glyphs.circle, color: undefined },
  loading: { icon: '…', color: undefined },
}

/**
 * Renders a status indicator icon with appropriate color.
 *
 * @example
 * // Success indicator
 * <StatusIcon status="success" />
 *
 * @example
 * // Error with trailing space for text
 * <ThemedText><StatusIcon status="error" withSpace />Failed to connect</ThemedText>
 */
export function StatusIcon({ status, withSpace = false }: Props) {
  const config = STATUS_CONFIG[status]
  return (
    <ThemedText color={config.color} dimColor={!config.color}>
      {config.icon}
      {withSpace && ' '}
    </ThemedText>
  )
}
