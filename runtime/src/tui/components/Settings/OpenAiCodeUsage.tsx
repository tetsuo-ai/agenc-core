import * as React from 'react'
import { useEffect, useState } from 'react'

import { useTerminalSize } from '../../hooks/useTerminalSize'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  buildCodexUsageRows as buildOpenAiCodeUsageRows, // branding-scan: allow provider API name
  fetchCodexUsage as fetchOpenAiCodeUsage, // branding-scan: allow provider API name
  formatCodexPlanType as formatOpenAiCodePlanType, // branding-scan: allow provider API name
  type CodexUsageData as OpenAiCodeUsageData, // branding-scan: allow provider API name
  type CodexUsageRow as OpenAiCodeUsageRow, // branding-scan: allow provider API name
} from '../../../services/api/openAiCodeUsage.js'
import { formatResetText } from '../../../utils/format' // upstream-import: keep target is owned by another Z-PURGE item
import { logError } from '../../../utils/log' // upstream-import: keep target is owned by another Z-PURGE item
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint'
import { Byline } from '../design-system/Byline'
import { ProgressBar } from '../design-system/ProgressBar'

type OpenAiCodeUsageLimitBarProps = {
  label: string
  usedPercent: number
  resetsAt?: string
  maxWidth: number
}

function OpenAiCodeUsageLimitBar({
  label,
  usedPercent,
  resetsAt,
  maxWidth,
}: OpenAiCodeUsageLimitBarProps): React.ReactNode {
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

function OpenAiCodeUsageTextRow({
  label,
  value,
}: Extract<OpenAiCodeUsageRow, { kind: 'text' }>): React.ReactNode {
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

export function OpenAiCodeUsage(): React.ReactNode {
  const [usage, setUsage] = useState<OpenAiCodeUsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const { columns } = useTerminalSize()
  const availableWidth = columns - 2
  const maxWidth = Math.min(availableWidth, 80)

  const loadUsage = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      setUsage(await fetchOpenAiCodeUsage())
    } catch (err) {
      logError(err as Error)
      setError(err instanceof Error ? err.message : 'Failed to load code usage')
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
        <Text dimColor>Loading code usage data…</Text>
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

  const rows = buildOpenAiCodeUsageRows(usage.snapshots)
  const planType = formatOpenAiCodePlanType(usage.planType)

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {planType ? <Text dimColor>Plan: {planType}</Text> : null}

      {rows.length === 0 ? (
        <Text dimColor>Code usage data is not available for this account.</Text>
      ) : null}

      {rows.map((row, index) =>
        row.kind === 'window' ? (
          <OpenAiCodeUsageLimitBar
            key={`${row.label}-${index}`}
            label={row.label}
            usedPercent={row.usedPercent}
            resetsAt={row.resetsAt}
            maxWidth={maxWidth}
          />
        ) : (
          <OpenAiCodeUsageTextRow
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
