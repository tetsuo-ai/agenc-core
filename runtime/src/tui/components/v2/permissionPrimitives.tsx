import type React from 'react'

import type { Theme } from '../../../utils/theme.js'
import { toInkColor } from '../../../utils/ink.js'
import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { Box } from '../../ink.js'
import ThemedBox from '../design-system/ThemedBox.js'
import ThemedText from '../design-system/ThemedText.js'

type ThemeColor = keyof Theme

export type WorkerBadgeProps = {
  readonly name: string
  readonly color: string
}

export function WorkerBadge({
  name,
  color,
}: WorkerBadgeProps): React.ReactNode {
  const statusDot = selectAgenCTuiGlyphs().statusDot
  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText color={toInkColor(color)}>
        {statusDot} <ThemedText bold>@{name}</ThemedText>
      </ThemedText>
    </Box>
  )
}

export function PermissionRequestTitle({
  title,
  subtitle,
  color = 'permission',
  workerBadge,
}: {
  readonly title: string
  readonly subtitle?: React.ReactNode
  readonly color?: ThemeColor
  readonly workerBadge?: WorkerBadgeProps
}): React.ReactNode {
  const separator = selectAgenCTuiGlyphs().separator
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <ThemedText color={color} bold>
          {title}
        </ThemedText>
        {workerBadge ? (
          <ThemedText color="subtle">
            {separator} @{workerBadge.name}
          </ThemedText>
        ) : null}
      </Box>
      {subtitle != null ? (
        typeof subtitle === 'string' ? (
          <ThemedText color="subtle" wrap="truncate-start">
            {subtitle}
          </ThemedText>
        ) : (
          subtitle
        )
      ) : null}
    </Box>
  )
}

export function PermissionDialog({
  title,
  subtitle,
  color = 'permission',
  titleColor,
  innerPaddingX = 1,
  workerBadge,
  titleRight,
  children,
}: {
  readonly title: string
  readonly subtitle?: React.ReactNode
  readonly color?: ThemeColor
  readonly titleColor?: ThemeColor
  readonly innerPaddingX?: number
  readonly workerBadge?: WorkerBadgeProps
  readonly titleRight?: React.ReactNode
  readonly children: React.ReactNode
}): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      backgroundColor="clawd_background"
      marginTop={1}
      paddingY={1}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <PermissionRequestTitle
            title={title}
            subtitle={subtitle}
            color={titleColor ?? color}
            workerBadge={workerBadge}
          />
          {titleRight}
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={innerPaddingX}>
        {children}
      </Box>
    </ThemedBox>
  )
}
