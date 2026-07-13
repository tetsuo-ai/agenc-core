import React from 'react'

import { Box, useInput } from '../../ink.js'
import ThemedText from '../design-system/ThemedText.js'
import { Popup } from './primitives.js'

function rowsFromText(text: string): readonly string[] {
  const rows = text.split(/\r?\n/u).map(line => line.trimEnd())
  return rows.length > 0 ? rows : ['No context usage data available.']
}

function parseTokenCount(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value.replace(/,/gu, ''))
  return Number.isFinite(parsed) ? parsed : null
}

type ContextUsageSummary = {
  readonly used: number
  readonly hardLimit: number
  readonly percent: number
  readonly messagesTokens?: number
  readonly toolsTokens?: number
  readonly compactionThreshold?: number
  readonly compactionDetail?: string
  readonly autoCompactDetail?: string
  readonly cacheDetail?: string
  readonly fileTokens?: number
  readonly systemTokens?: number
  readonly planTokens?: number
}

function parseContextUsage(text: string): ContextUsageSummary | null {
  const rows = rowsFromText(text)
  const header = rows[0]?.match(
    /^Context:\s+([\d,]+)\s+\/\s+([\d,]+)\s+tokens\s+\(([\d.]+)%/u,
  )
  const used = parseTokenCount(header?.[1])
  const hardLimit = parseTokenCount(header?.[2])
  const percent = header?.[3] !== undefined ? Number(header[3]) : null
  if (used === null || hardLimit === null || percent === null || !Number.isFinite(percent)) {
    return null
  }

  const messages = rows
    .find(row => row.includes('messages:'))
    ?.match(/messages:\s+([\d,]+)\s+tokens/u)
  const tools = rows
    .find(row => row.includes('tool catalog:'))
    ?.match(/tool catalog:\s+([\d,]+)\s+tokens/u)
  const files = rows
    .find(row => row.includes('files:'))
    ?.match(/files:\s+([\d,]+)\s+tokens/u)
  const system = rows
    .find(row => row.includes('system:'))
    ?.match(/system:\s+([\d,]+)\s+tokens/u)
  const plan = rows
    .find(row => row.includes('plan:'))
    ?.match(/plan:\s+([\d,]+)\s+tokens/u)
  const compaction = rows
    .find(row => row.includes('compaction threshold:'))
    ?.match(/compaction threshold:\s+([\d,]+)\s+tokens(?:\s+\((.*)\))?/u)
  const autoCompactDetail = rows
    .find(row => row.includes('auto-compact:'))
    ?.replace(/^.*auto-compact:\s*/u, '')
  const cacheDetail = rows
    .find(row => row.includes('prompt cache:'))
    ?.replace(/^.*prompt cache:\s*/u, '')

  return {
    used,
    hardLimit,
    percent,
    ...(parseTokenCount(messages?.[1]) !== null
      ? { messagesTokens: parseTokenCount(messages?.[1])! }
      : {}),
    ...(parseTokenCount(tools?.[1]) !== null
      ? { toolsTokens: parseTokenCount(tools?.[1])! }
      : {}),
    ...(parseTokenCount(files?.[1]) !== null
      ? { fileTokens: parseTokenCount(files?.[1])! }
      : {}),
    ...(parseTokenCount(system?.[1]) !== null
      ? { systemTokens: parseTokenCount(system?.[1])! }
      : {}),
    ...(parseTokenCount(plan?.[1]) !== null
      ? { planTokens: parseTokenCount(plan?.[1])! }
      : {}),
    ...(parseTokenCount(compaction?.[1]) !== null
      ? { compactionThreshold: parseTokenCount(compaction?.[1])! }
      : {}),
    ...(compaction?.[2] !== undefined ? { compactionDetail: compaction[2] } : {}),
    ...(autoCompactDetail !== undefined ? { autoCompactDetail } : {}),
    ...(cacheDetail !== undefined ? { cacheDetail } : {}),
  }
}

function formatTokens(value: number): string {
  return value.toLocaleString()
}

function ProgressBar({
  percent,
  width = 44,
  color = 'agenc',
}: {
  readonly percent: number
  readonly width?: number
  readonly color?: 'agenc' | 'worker' | 'success' | 'error' | 'subtle'
}): React.ReactNode {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)))
  const resolvedColor = clamped >= 95 ? 'error' : clamped >= 80 ? 'worker' : color
  return (
    <Box flexDirection="row">
      <ThemedText color={resolvedColor}>
        {'█'.repeat(filled)}
      </ThemedText>
      <ThemedText color="muted3">{'░'.repeat(Math.max(0, width - filled))}</ThemedText>
    </Box>
  )
}

function UsageRow({
  label,
  tokens,
  total,
  detail,
  color = 'agenc',
  indent = false,
}: {
  readonly label: string
  readonly tokens?: number
  readonly total?: number
  readonly detail?: string
  readonly color?: 'agenc' | 'worker' | 'success' | 'error' | 'subtle'
  readonly indent?: boolean
}): React.ReactNode {
  const percent = tokens !== undefined && total !== undefined && total > 0
    ? Number(((tokens / total) * 100).toFixed(1))
    : null
  return (
    <Box flexDirection="row" gap={2}>
      <Box width={19}>
        <ThemedText color={indent ? 'inactive' : 'subtle'}>
          {indent ? `  ${label}` : label.toUpperCase()}
        </ThemedText>
      </Box>
      <Box width={14}>
        <ThemedText color="text2" wrap="truncate-end">
          {tokens !== undefined ? formatTokens(tokens) : '—'}
        </ThemedText>
      </Box>
      <Box width={7}>
        <ThemedText color="inactive">{percent !== null ? `${percent}%` : ''}</ThemedText>
      </Box>
      <Box width={22}>
        {percent !== null ? <ProgressBar percent={percent} width={18} color={color} /> : null}
      </Box>
      <ThemedText color="subtle" wrap="truncate-end">
        {detail ?? ''}
      </ThemedText>
    </Box>
  )
}

function StructuredContextUsage({
  summary,
}: {
  readonly summary: ContextUsageSummary
}): React.ReactNode {
  const messagesTokens = summary.messagesTokens ?? Math.max(0, summary.used - (
    (summary.systemTokens ?? 0) +
    (summary.planTokens ?? 0) +
    (summary.fileTokens ?? 0) +
    (summary.toolsTokens ?? 0)
  ))
  // Guard against a zero hardLimit (parseContextUsage accepts `0 / 0 tokens`),
  // which otherwise yields `auto-compact at Infinity%`.
  const compactionPercent =
    summary.compactionThreshold !== undefined && summary.hardLimit > 0
      ? Number(((summary.compactionThreshold / summary.hardLimit) * 100).toFixed(1))
      : 92
  return (
    <Popup
      title="context"
      status={`${summary.percent}% used · headroom ${Math.round(Math.max(0, summary.hardLimit - summary.used) / 1000)}k`}
      minHeight={24}
      footer={[
        { keyName: 'c', label: '/compact' },
        { keyName: 'd', label: 'drop file' },
        { keyName: 'r', label: 'rewind' },
        { keyName: 'b', label: '/btw side-question' },
      ]}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <ThemedText color="agenc">CONTEXT</ThemedText>
          <ThemedText color="text2">
          {formatTokens(summary.used)} / {formatTokens(summary.hardLimit)} tokens
          </ThemedText>
        </Box>
        <ProgressBar percent={summary.percent} width={54} />
        <ThemedText color="muted3">
          soft warning at 80% · auto-compact at {compactionPercent}%
        </ThemedText>
      </Box>
      <Box flexDirection="column">
        <ThemedText color="agenc">BREAKDOWN BY SOURCE</ThemedText>
        <Box minHeight={1} />
        <UsageRow label="system" tokens={summary.systemTokens ?? summary.toolsTokens} total={summary.used} color="subtle" />
        <UsageRow label="plan" tokens={summary.planTokens} total={summary.used} color="agenc" />
        <Box minHeight={1} />
        {/* Only the aggregate file-token total is available from /context; the
            per-file breakdown here was fabricated fixture data (lib.rs/pool.rs/
            math.rs split by magic ratios) and has been removed. */}
        <UsageRow label="files" tokens={summary.fileTokens} total={summary.used} color="worker" />
        <UsageRow label="history" tokens={messagesTokens} total={summary.used} color="agenc" />
        <UsageRow label="tool catalog" tokens={summary.toolsTokens} total={summary.used} color="subtle" />
      </Box>
      {summary.compactionThreshold !== undefined ? (
        <Box flexDirection="row" gap={2} paddingX={4}>
          <Box width={19}>
            <ThemedText color="muted3">COMPACT AT</ThemedText>
          </Box>
          <ThemedText color="text2">{formatTokens(summary.compactionThreshold)}</ThemedText>
          {summary.compactionDetail ? <ThemedText color="muted3" wrap="truncate-end">{summary.compactionDetail}</ThemedText> : null}
        </Box>
      ) : null}
      {summary.autoCompactDetail !== undefined ? (
        <Box flexDirection="row" gap={2} paddingX={4}>
          <Box width={19}>
            <ThemedText color="muted3">AUTO COMPACT</ThemedText>
          </Box>
          <ThemedText color="text2" wrap="wrap">{summary.autoCompactDetail}</ThemedText>
        </Box>
      ) : null}
      {summary.cacheDetail !== undefined ? (
        <Box flexDirection="row" gap={2} paddingX={4}>
          <Box width={19}>
            <ThemedText color="muted3">PROMPT CACHE</ThemedText>
          </Box>
          <ThemedText color="text2" wrap="wrap">{summary.cacheDetail}</ThemedText>
        </Box>
      ) : null}
    </Popup>
  )
}

export function ContextUsageModal({
  text,
  onDone,
  active = true,
}: {
  readonly text: string
  readonly onDone: () => void
  readonly active?: boolean
}): React.ReactNode {
  const rows = React.useMemo(() => rowsFromText(text), [text])
  useInput((input, key) => {
    if (key.escape || input === 'q') onDone()
  }, { isActive: active })

  const summary = React.useMemo(() => parseContextUsage(text), [text])
  if (summary !== null) return <StructuredContextUsage summary={summary} />

  return (
    <Popup title="context" minHeight={24} footer={[{ keyName: 'q', label: 'close' }]}>
      <ThemedText color="agenc">CONTEXT</ThemedText>
      {rows.map((row, index) => (
        <Box key={index} flexDirection="row" gap={1}>
          <ThemedText color="muted3">{String(index + 1).padStart(3, '0')}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{row.length > 0 ? row : ' '}</ThemedText>
        </Box>
      ))}
    </Popup>
  )
}

export default ContextUsageModal
