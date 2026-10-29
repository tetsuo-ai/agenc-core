import React from 'react'

import type { CostReport } from '../../../commands/cost.js'
import { unpricedCallDescription } from '../../../commands/cost.js'
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
      ? `${report.hasUnknownCost ? '≥' : ''}${formatUsdCost(report.totalCostUsd)}${report.totalIsEstimated ? ' est.' : ''}`
      : 'unknown'
  const tokenDetail =
    report.inputTokens !== undefined || report.outputTokens !== undefined
      ? `${formatTokenCount(report.inputTokens ?? 0)} in · ${formatTokenCount(report.outputTokens ?? 0)} out` +
        (report.turns !== undefined ? ` · ${report.turns} turns` : '')
      : report.totalTokens !== undefined
        ? `${formatTokenCount(report.totalTokens)} total${report.totalIsEstimated ? ' est.' : ''}`
        : 'unknown'

  return (
    <Popup
      title="cost"
      status={
        report.totalCostUsd !== undefined
          ? `session ${totalCost}`
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
        <ThemedText color="muted3">Accounting total: peak rates before off-peak discounts.</ThemedText>
        {report.billedEstimateUsd !== undefined && !report.totalIsEstimated ? (
          <Row label="billed estimate" value={`${report.hasUnknownCost ? '≥' : ''}${formatUsdCost(report.billedEstimateUsd)}`}
            detail="recorded per-call off-peak hours" />
        ) : null}
        <Row label="tokens" value={tokenDetail} labelColor="inactive" />
        {report.hasUnknownCost ? (
          <Box flexDirection="column">
            <ThemedText color="text2">Unpriced calls (excluded from the known cost):</ThemedText>
            {(report.unpricedCalls ?? []).map(call => (
              <ThemedText key={call.reservationId} color="text2">
                {`${unpricedCallDescription(call)} · run ${call.runId}`}
              </ThemedText>
            ))}
            {(report.unpricedCallCount ?? 0) > (report.unpricedCalls?.length ?? 0) ? (
              <ThemedText color="text2">{`Showing ${report.unpricedCalls?.length ?? 0} of ${report.unpricedCallCount} unpriced calls.`}</ThemedText>
            ) : !report.unpricedCalls?.length ? (
              <ThemedText color="text2">Call details unavailable for this older session.</ThemedText>
            ) : null}
          </Box>
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
              value={`${m.hasUnknownCost ? '≥' : ''}${formatUsdCost(m.costUsd)}${m.costEstimated ? ' est.' : ''}`}
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
                a.costUsd !== undefined
                  ? `${a.hasUnknownCost ? '≥' : ''}${formatUsdCost(a.costUsd)}${a.costEstimated ? ' est.' : ''}`
                  : a.estimatedCostUsd !== undefined
                  ? `${formatUsdCost(a.estimatedCostUsd)} est.`
                  : 'unknown'
              }
              detail={a.tokenCount !== undefined ? `${a.status} · ${formatTokenCount(a.tokenCount)} tokens` : a.status}
            />
          ))
        )}
      </Box>
      <ThemedText color="muted3">
        Model/agent totals use accounting rates. Provider-reported charges stay as reported.
        Billed estimates cover recorded schedules; holidays and other discounts may be missing.
      </ThemedText>
    </Popup>
  )
}

export default CostUsageModal
