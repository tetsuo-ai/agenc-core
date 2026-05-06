import * as React from 'react'
import { useEffect, useState } from 'react'

import { useTerminalSize } from '../../hooks/useTerminalSize'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  buildCodexUsageRows,
  fetchCodexUsage,
  formatCodexPlanType,
  type CodexUsageData,
  type CodexUsageRow,
} from '../../../agenc/upstream/services/api/codexUsage' // upstream-import: keep target is owned by another Z-PURGE item
import { formatResetText } from '../../../agenc/upstream/utils/format' // upstream-import: keep target is owned by another Z-PURGE item
import { logError } from '../../../agenc/upstream/utils/log' // upstream-import: keep target is owned by another Z-PURGE item
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint'
import { Byline } from '../design-system/Byline'
import { ProgressBar } from '../design-system/ProgressBar'

type CodexUsageLimitBarProps = {
  label: string
  usedPercent: number
  resetsAt?: string
  maxWidth: number
}

function CodexUsageLimitBar({
  label,
  usedPercent,
  resetsAt,
  maxWidth,
}: CodexUsageLimitBarProps): React.ReactNode {
  const normalizedUsedPercent = Math.max(0, Math.min(100, usedPercent))
  const usedText = `${Math.floor(normalizedUsedPercent)}% used`
  const resetText = resetsAt
    ? `Resets ${formatResetText(resetsAt, true, true)}`
    : undefined

  if (maxWidth >= 62) {
    return (
      <Box flexDirection="column">
        <Text bold>{label}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={normalizedUsedPercent / 100}
            width={50}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text>{usedText}</Text>
        </Box>
        {resetText ? <Text dimColor>{resetText}</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{label}</Text>
        {resetText ? (
          <>
            <Text> </Text>
            <Text dimColor>· {resetText}</Text>
          </>
        ) : null}
      </Text>
      <ProgressBar
        ratio={normalizedUsedPercent / 100}
        width={maxWidth}
        fillColor="rate_limit_fill"
        emptyColor="rate_limit_empty"
      />
      <Text>{usedText}</Text>
    </Box>
  )
}

function CodexUsageTextRow({
  label,
  value,
}: Extract<CodexUsageRow, { kind: 'text' }>): React.ReactNode {
  if (!value) {
    return <Text bold>{label}</Text>
  }

  return (
    <Text>
      <Text bold>{label}</Text>
      <Text dimColor> · {value}</Text>
    </Text>
  )
}

export function CodexUsage(): React.ReactNode {
  const [usage, setUsage] = useState<CodexUsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const { columns } = useTerminalSize()
  const availableWidth = columns - 2
  const maxWidth = Math.min(availableWidth, 80)

  const loadUsage = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      setUsage(await fetchCodexUsage())
    } catch (err) {
      logError(err as Error)
      setError(err instanceof Error ? err.message : 'Failed to load Codex usage')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  useKeybinding(
    'settings:retry',
    () => {
      void loadUsage()
    },
    {
      context: 'Settings',
      isActive: !!error && !isLoading,
    },
  )

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="Esc"
              description="cancel"
            />
          </Byline>
        </Text>
      </Box>
    )
  }

  if (!usage) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Loading Codex usage data…</Text>
        <Text dimColor>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Text>
      </Box>
    )
  }

  const rows = buildCodexUsageRows(usage.snapshots)
  const planType = formatCodexPlanType(usage.planType)

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {planType ? <Text dimColor>Plan: {planType}</Text> : null}

      {rows.length === 0 ? (
        <Text dimColor>Codex usage data is not available for this account.</Text>
      ) : null}

      {rows.map((row, index) =>
        row.kind === 'window' ? (
          <CodexUsageLimitBar
            key={`${row.label}-${index}`}
            label={row.label}
            usedPercent={row.usedPercent}
            resetsAt={row.resetsAt}
            maxWidth={maxWidth}
          />
        ) : (
          <CodexUsageTextRow
            key={`${row.label}-${index}`}
            label={row.label}
            value={row.value}
          />
        ),
      )}

      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}
