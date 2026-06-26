import React from 'react'

import type { CostReport } from '../../../commands/cost.js'
import { formatTokenCount, formatUsdCost } from '../../../session/cost.js'
import { Box, useInput } from '../../ink.js'
import ThemedText from '../design-system/ThemedText.js'
import { Popup } from './primitives.js'

function Row({
  label,
  value,
  detail,
  labelColor = 'subtle',
}: {
  readonly label: string
  readonly value: string
  readonly detail?: string
  readonly labelColor?: 'subtle' | 'inactive' | 'agenc'
}): React.ReactNode {
  return (
    <Box flexDirection="row" gap={2}>
      <Box width={26}>
        <ThemedText color={labelColor} wrap="truncate-end">
          {label}
        </ThemedText>
      </Box>
      <Box width={16}>
        <ThemedText color="text2" wrap="truncate-end">
          {value}
        </ThemedText>
      </Box>
      <ThemedText color="muted3" wrap="truncate-end">
        {detail ?? ''}
      </ThemedText>
    </Box>
  )
}

export function CostUsageModal({
  report,
  onDone,
  active = true,
}: {
  readonly report: CostReport
  readonly onDone: () => void
  readonly active?: boolean
}): React.ReactNode {
  useInput(
    (input, key) => {
      if (key.escape || input === 'q') onDone()
    },
    { isActive: active },
  )

  const totalCost =
    report.totalCostUsd !== undefined
      ? `${formatUsdCost(report.totalCostUsd)}${report.totalIsEstimated ? ' est.' : ''}${report.hasUnknownCost ? ' *' : ''}`
      : '—'
  const tokenDetail =
    report.inputTokens !== undefined || report.outputTokens !== undefined
      ? `${formatTokenCount(report.inputTokens ?? 0)} in · ${formatTokenCount(report.outputTokens ?? 0)} out` +
        (report.turns !== undefined ? ` · ${report.turns} turns` : '')
      : report.totalTokens !== undefined
        ? `${formatTokenCount(report.totalTokens)} total${report.totalIsEstimated ? ' est.' : ''}`
        : '—'

  return (
    <Popup
      title="cost"
      status={
        report.totalCostUsd !== undefined
          ? `session ${formatUsdCost(report.totalCostUsd)}${report.totalIsEstimated ? ' est.' : ''}`
          : 'cost tracking unavailable'
      }
      minHeight={18}
      footer={[{ keyName: 'q', label: 'close' }]}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <ThemedText color="agenc">SESSION</ThemedText>
          <ThemedText color="text2">{totalCost}</ThemedText>
        </Box>
        <Row label="tokens" value={tokenDetail} labelColor="inactive" />
        {report.hasUnknownCost ? (
          <ThemedText color="muted3">* some model pricing unknown — cost approximate</ThemedText>
        ) : null}
      </Box>

      {report.models.length > 0 ? (
        <Box flexDirection="column">
          <ThemedText color="agenc">BY MODEL</ThemedText>
          <Box minHeight={1} />
          {report.models.map((m, i) => (
            <Row
              key={`model-${i}`}
              label={m.label}
              value={formatUsdCost(m.costUsd)}
              detail={`${formatTokenCount(m.inputTokens)} in · ${formatTokenCount(m.outputTokens)} out`}
            />
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column">
        <ThemedText color="agenc">BY AGENT</ThemedText>
        <Box minHeight={1} />
        {report.agents.length === 0 ? (
          <ThemedText color="muted3">no fan-out agents active</ThemedText>
        ) : (
          report.agents.map((a, i) => (
            <Row
              key={`agent-${i}`}
              label={a.label}
              value={
                a.estimatedCostUsd !== undefined
                  ? `${formatUsdCost(a.estimatedCostUsd)} est.`
                  : '—'
              }
              detail={`${a.status} · ${a.tokenCount !== undefined ? `${formatTokenCount(a.tokenCount)} tokens` : '—'}`}
            />
          ))
        )}
      </Box>
      <ThemedText color="muted3">
        per-agent $ estimated from token totals; — = unknown
      </ThemedText>
    </Popup>
  )
}

export default CostUsageModal
