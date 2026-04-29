/**
 * HistorySearchDialog — Ctrl+R-style fuzzy picker over the composer
 * history file (`~/.agenc/history.jsonl`).
 *
 * Ported from upstream and rewired to AgenC's `tui/composer/history.ts`
 * reader. The dialog loads the entire history once on mount, filters
 * caller-side on every keystroke, and resolves the selected entry to a
 * plain string passed back via `onSelect`.
 */
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../ink-public.js'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { FuzzyPicker } from '../design-system/FuzzyPicker.js'
import {
  readHistory,
  type HistoryEntry,
} from '../composer/history.js'

type Props = {
  readonly home: string
  readonly initialQuery?: string
  readonly onSelect: (entry: HistoryEntry) => void
  readonly onCancel: () => void
}

const PREVIEW_ROWS = 6
const AGE_WIDTH = 8

type Item = {
  readonly entry: HistoryEntry
  readonly display: string
  readonly lower: string
  readonly firstLine: string
  readonly age: string
}

export function HistorySearchDialog({
  home,
  initialQuery,
  onSelect,
  onCancel,
}: Props): React.ReactElement {
  const { columns } = useTerminalSize()
  const [items, setItems] = useState<Item[] | null>(null)
  const [query, setQuery] = useState(initialQuery ?? '')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const entries = await readHistory(home)
        if (cancelled) return
        const loaded: Item[] = entries.map((entry) => {
          const display = entry.value
          const nl = display.indexOf('\n')
          const age = formatRelativeTimeAgo(new Date(entry.timestamp))
          return {
            entry,
            display,
            lower: display.toLowerCase(),
            firstLine: nl === -1 ? display : display.slice(0, nl),
            age:
              age + ' '.repeat(Math.max(0, AGE_WIDTH - stringWidth(age))),
          }
        })
        if (!cancelled) setItems(loaded)
      } catch {
        if (!cancelled) setItems([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [home])

  const filtered = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    if (!q) return items
    const exact: Item[] = []
    const fuzzy: Item[] = []
    for (const item of items) {
      if (item.lower.includes(q)) {
        exact.push(item)
      } else if (isSubsequence(item.lower, q)) {
        fuzzy.push(item)
      }
    }
    // TODO(tranche-2D): swap simple includes match for fuzzysort once
    // dep is added.
    return exact.concat(fuzzy)
  }, [items, query])

  const previewOnRight = columns >= 100
  const listWidth = previewOnRight
    ? Math.floor((columns - 6) * 0.5)
    : columns - 6
  const rowWidth = Math.max(20, listWidth - AGE_WIDTH - 1)
  const previewWidth = previewOnRight
    ? Math.max(20, columns - listWidth - 12)
    : Math.max(20, columns - 10)

  return (
    <FuzzyPicker<Item>
      title="Search prompts"
      placeholder="Filter history…"
      initialQuery={initialQuery}
      items={filtered}
      getKey={(item: Item) => String(item.entry.timestamp)}
      onQueryChange={setQuery}
      onSelect={(item: Item) => onSelect(item.entry)}
      onCancel={onCancel}
      emptyMessage={(q: string) =>
        items === null
          ? 'Loading…'
          : q
            ? 'No matching prompts'
            : 'No history yet'
      }
      selectAction="use"
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      renderItem={(item: Item, isFocused: boolean) => (
        <Text>
          <Text dimColor>{item.age}</Text>
          <Text color={isFocused ? 'accent' : undefined}>
            {' '}
            {truncateToWidth(item.firstLine, rowWidth)}
          </Text>
        </Text>
      )}
      renderPreview={(item: Item) => {
        const wrapped = wrapAnsi(item.display, previewWidth, { hard: true })
          .split('\n')
          .filter((l: string) => l.trim() !== '')
        const overflow = wrapped.length > PREVIEW_ROWS
        const shown = wrapped.slice(0, overflow ? PREVIEW_ROWS - 1 : PREVIEW_ROWS)
        const more = wrapped.length - shown.length
        return (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderDimColor
            paddingX={1}
            height={PREVIEW_ROWS + 2}
          >
            {shown.map((row: string, i: number) => (
              <Text key={i} dimColor>
                {row}
              </Text>
            ))}
            {more > 0 && <Text dimColor>{`… +${more} more lines`}</Text>}
          </Box>
        )
      }}
    />
  )
}

function isSubsequence(text: string, query: string): boolean {
  let j = 0
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] === query[j]) j++
  }
  return j === query.length
}

function truncateToWidth(s: string, width: number): string {
  if (s.length <= width) return s
  return s.slice(0, Math.max(0, width - 1)) + '…'
}

/**
 * Tiny relative-time helper so this dialog stays self-contained until
 * the runtime grows a shared `format.ts` utility module. Format mirrors
 * `Xs ago / Xm ago / Xh ago / Xd ago / Xmo ago / Xy ago`.
 */
function formatRelativeTimeAgo(d: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
