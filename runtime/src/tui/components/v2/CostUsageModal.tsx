import React from 'react'

import type { CostReport } from '../../../commands/cost.js'
import { COST_FOOTNOTE, costApiKeyLine, costModelDetail, costPlanLine, unpricedCallDescription, unpricedCallsHeading } from '../../../commands/cost.js'
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
  // The value column is 16 cells wide: the input count goes there and the rest in the detail column.
  const [tokenValue, tokenRest] =
    report.inputTokens !== undefined || report.outputTokens !== undefined
      ? [`${formatTokenCount(report.inputTokens ?? 0)} in`,
        `${formatTokenCount(report.outputTokens ?? 0)} out` + (report.turns !== undefined ? ` · ${report.turns} turns` : '')]
      : report.totalTokens !== undefined
        ? [`${formatTokenCount(report.totalTokens)} total${report.totalIsEstimated ? ' est.' : ''}`, '']
        : ['unknown', '']
  // The headline is the figure the status line shows: the billed estimate when one exists.
  const billed = report.totalCostUsd !== undefined && report.billedEstimateUsd !== undefined && !report.totalIsEstimated
    ? `${report.hasUnknownCost ? '≥' : ''}${formatUsdCost(report.billedEstimateUsd)} billed`
    : undefined
  const headline = billed ?? totalCost
  const planLine = costPlanLine(report)
  const apiKeyLine = costApiKeyLine(report)
  const unpriced = report.unpricedCalls ?? []

  return (
    <Popup
      title="cost"
      status={
        report.totalCostUsd !== undefined
          ? `session ${headline}`
          : 'cost tracking unavailable'
      }
      minHeight={18}
      footer={[{ keyName: 'q', label: 'close' }]}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <ThemedText color="agenc">SESSION</ThemedText>
          <ThemedText color="text2">{headline}</ThemedText>
        </Box>
        {billed !== undefined ? (
          <ThemedText color="muted3">Billed estimate: metered calls, with recorded per-call off-peak hours applied.</ThemedText>
        ) : (
          <ThemedText color="muted3">Accounting total: metered calls at peak rates before off-peak discounts.</ThemedText>
        )}
        {planLine !== null ? <ThemedText color="text2">{planLine}</ThemedText> : null}
        {apiKeyLine !== null ? <ThemedText color="text2">{apiKeyLine}</ThemedText> : null}
        {billed !== undefined ? (
          <Row label="at peak rates" value={totalCost} detail="accounting total before off-peak discounts; budgets use it" />
        ) : null}
        {report.apiEquivalentUnknown ? <ThemedText color="text2">Some plan calls have no known API price.</ThemedText> : null}
        <Row label="tokens" value={tokenValue} detail={tokenRest} labelColor="inactive" />
        {report.hasUnknownCost || unpriced.length > 0 ? (
          <Box flexDirection="column">
            <ThemedText color="text2">{unpricedCallsHeading(report)}</ThemedText>
            {unpriced.map(call => (
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
            <Box key={`model-${i}`} flexDirection="column">
              <ThemedText color="text2">{m.label}</ThemedText>
              <ThemedText color="muted3">{costModelDetail(m)}</ThemedText>
            </Box>
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column">
        <ThemedText color="agenc">BY AGENT</ThemedText>
        <Box minHeight={1} />
        {report.agentModels !== undefined ? report.agentModels.map((row, i) => (
          <Box key={`agent-model-${i}`} flexDirection="column">
            <ThemedText color="text2">{`${row.agentLabel} · ${row.label}`}</ThemedText>
            <ThemedText color="muted3">{costModelDetail(row)}</ThemedText>
          </Box>
        )) : report.agents.length === 0 ? (
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
      <ThemedText color="muted3">{COST_FOOTNOTE}</ThemedText>
    </Popup>
  )
}

export default CostUsageModal
