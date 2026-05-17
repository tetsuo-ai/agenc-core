import React from 'react'

import { Box, useInput } from '../../ink.js'
import ThemedBox from '../design-system/ThemedBox.js'
import ThemedText from '../design-system/ThemedText.js'
import { KeyHint } from './primitives.js'

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
}

function parseContextUsage(text: string): ContextUsageSummary | null {
  const rows = rowsFromText(text)
  const header = rows[0]?.match(
    /^Context:\s+([\d,]+)\s+\/\s+([\d,]+)\s+tokens\s+\((\d+)%/u,
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
}: {
  readonly percent: number
  readonly width?: number
}): React.ReactNode {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)))
  return (
    <Box flexDirection="row">
      <ThemedText color={clamped >= 95 ? 'error' : clamped >= 80 ? 'worker' : 'agenc'}>
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
}: {
  readonly label: string
  readonly tokens?: number
  readonly total?: number
  readonly detail?: string
}): React.ReactNode {
  const percent = tokens !== undefined && total !== undefined && total > 0
    ? Math.round((tokens / total) * 100)
    : null
  return (
    <Box flexDirection="row" gap={2}>
      <Box width={16}>
        <ThemedText color="subtle">{label.toUpperCase()}</ThemedText>
      </Box>
      <Box width={14}>
        <ThemedText color="text2" wrap="truncate-end">
          {tokens !== undefined ? `${formatTokens(tokens)} tok` : '—'}
        </ThemedText>
      </Box>
      <Box width={7}>
        <ThemedText color="inactive">{percent !== null ? `${percent}%` : ''}</ThemedText>
      </Box>
      <Box width={22}>
        {percent !== null ? <ProgressBar percent={percent} width={18} /> : null}
      </Box>
      <ThemedText color="subtle" wrap="truncate-end">
        {detail ?? ''}
      </ThemedText>
    </Box>
  )
}

function StructuredContextUsage({
  summary,
  rawText,
}: {
  readonly summary: ContextUsageSummary
  readonly rawText: string
}): React.ReactNode {
  const rows = rowsFromText(rawText).slice(1)
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="agenc"
      backgroundColor="clawd_background"
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <Box flexDirection="row" gap={1}>
        <ThemedText color="agenc">CONTEXT</ThemedText>
        <ThemedText color="text">
          {formatTokens(summary.used)} / {formatTokens(summary.hardLimit)}
        </ThemedText>
        <ThemedText color="subtle">({summary.percent}%)</ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="inactive">/ctx</ThemedText>
      </Box>
      <ProgressBar percent={summary.percent} width={54} />
      <UsageRow label="history" tokens={summary.messagesTokens} total={summary.used} />
      <UsageRow label="tools" tokens={summary.toolsTokens} total={summary.used} />
      {summary.compactionThreshold !== undefined ? (
        <UsageRow
          label="compact at"
          tokens={summary.compactionThreshold}
          total={summary.hardLimit}
          detail={summary.compactionDetail}
        />
      ) : null}
      {summary.autoCompactDetail !== undefined ? (
        <Box flexDirection="row" gap={2}>
          <Box width={16}>
            <ThemedText color="subtle">AUTO COMPACT</ThemedText>
          </Box>
          <ThemedText color="text2" wrap="wrap">{summary.autoCompactDetail}</ThemedText>
        </Box>
      ) : null}
      {summary.cacheDetail !== undefined ? (
        <Box flexDirection="row" gap={2}>
          <Box width={16}>
            <ThemedText color="subtle">PROMPT CACHE</ThemedText>
          </Box>
          <ThemedText color="text2" wrap="wrap">{summary.cacheDetail}</ThemedText>
        </Box>
      ) : null}
      {rows.length > 0 ? (
        <ThemedBox flexDirection="column" borderTop borderTopColor="lineSoft" paddingTop={1}>
          {rows.map((row, index) => (
            <ThemedText key={index} color="inactive" wrap="truncate-end">
              {row.replace(/^\s*•\s*/u, '')}
            </ThemedText>
          ))}
        </ThemedBox>
      ) : null}
      <Box flexDirection="row" gap={2}>
        <KeyHint k="c" label="compact" />
        <KeyHint k="r" label="rewind" />
        <KeyHint k="q" label="close" />
        <Box flexGrow={1} />
        <KeyHint k="esc" label="dismiss" />
      </Box>
    </ThemedBox>
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
  if (summary !== null) return <StructuredContextUsage summary={summary} rawText={text} />

  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="agenc"
      backgroundColor="clawd_background"
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <ThemedText color="agenc">CONTEXT</ThemedText>
      {rows.map((row, index) => (
        <Box key={index} flexDirection="row" gap={1}>
          <ThemedText color="muted3">{String(index + 1).padStart(3, '0')}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{row.length > 0 ? row : ' '}</ThemedText>
        </Box>
      ))}
      <Box flexDirection="row" gap={2}>
        <KeyHint k="q" label="close" />
        <Box flexGrow={1} />
        <KeyHint k="esc" label="dismiss" />
      </Box>
    </ThemedBox>
  )
}

export default ContextUsageModal
