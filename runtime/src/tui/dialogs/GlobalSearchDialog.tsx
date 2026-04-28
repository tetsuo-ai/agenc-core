/**
 * GlobalSearchDialog — debounced ripgrep search across the workspace.
 *
 * Ported from upstream's Global Search dialog and adapted to AgenC's local
 * `FuzzyPicker` and Node runtime. Results come from `rg --json` so paths,
 * line numbers, and match text are parsed structurally instead of by
 * splitting colon-delimited output.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Text } from '../ink-public.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { FuzzyPicker } from '../design-system/FuzzyPicker.js'
import { LoadingState } from '../design-system/LoadingState.js'

type Props = {
  readonly onDone: () => void
  readonly onInsert?: (text: string) => void
  readonly cwd?: string
}

type Match = {
  readonly file: string
  readonly line: number
  readonly text: string
}

const VISIBLE_RESULTS = 12
const DEBOUNCE_MS = 100
const PREVIEW_CONTEXT_LINES = 4
const MAX_MATCHES_PER_FILE = 10
const MAX_TOTAL_MATCHES = 500

export function GlobalSearchDialog({
  onDone,
  onInsert,
  cwd = process.cwd(),
}: Props): React.ReactElement {
  const { columns, rows } = useTerminalSize()
  const previewOnRight = columns >= 140
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14))
  const [matches, setMatches] = useState<readonly Match[]>([])
  const [truncated, setTruncated] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<Match | undefined>(undefined)
  const [preview, setPreview] = useState<{
    readonly file: string
    readonly line: number
    readonly content: string
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!focused) {
      setPreview(null)
      return
    }
    const controller = new AbortController()
    const absolute = path.resolve(cwd, focused.file)
    const start = Math.max(1, focused.line - PREVIEW_CONTEXT_LINES)
    void readFileInRange(
      absolute,
      start,
      PREVIEW_CONTEXT_LINES * 2 + 1,
      controller.signal,
    )
      .then((content) => {
        if (controller.signal.aborted) return
        setPreview({ file: focused.file, line: focused.line, content })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setPreview({
          file: focused.file,
          line: focused.line,
          content: '(preview unavailable)',
        })
      })
    return () => controller.abort()
  }, [cwd, focused])

  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      abortRef.current?.abort()
      if (!q.trim()) {
        setMatches([])
        setIsSearching(false)
        setTruncated(false)
        return
      }

      const controller = new AbortController()
      abortRef.current = controller
      setIsSearching(true)
      setTruncated(false)

      timeoutRef.current = setTimeout(() => {
        void searchWorkspace(cwd, q, controller.signal)
          .then((result) => {
            if (controller.signal.aborted) return
            setMatches(result.matches)
            setTruncated(result.truncated)
          })
          .catch(() => {
            if (controller.signal.aborted) return
            setMatches([])
            setTruncated(false)
          })
          .finally(() => {
            if (!controller.signal.aborted) setIsSearching(false)
          })
      }, DEBOUNCE_MS)
    },
    [cwd],
  )

  const listWidth = previewOnRight
    ? Math.floor((columns - 10) * 0.5)
    : columns - 8
  const maxPathWidth = Math.max(20, Math.floor(listWidth * 0.4))
  const maxTextWidth = Math.max(20, listWidth - maxPathWidth - 4)
  const previewWidth = previewOnRight
    ? Math.max(40, columns - listWidth - 14)
    : columns - 6

  const handleOpen = useCallback(
    (m: Match) => {
      openFileInExternalEditor(path.resolve(cwd, m.file), m.line)
      onDone()
    },
    [cwd, onDone],
  )

  const handleInsert = useCallback(
    (m: Match, mention: boolean) => {
      onInsert?.(mention ? `@${m.file}#L${m.line} ` : `${m.file}:${m.line} `)
      onDone()
    },
    [onDone, onInsert],
  )

  const matchLabel = useMemo(
    () =>
      matches.length > 0
        ? `${matches.length}${truncated ? '+' : ''} matches${isSearching ? '...' : ''}`
        : ' ',
    [isSearching, matches.length, truncated],
  )

  return (
    <FuzzyPicker<Match>
      title="Global Search"
      placeholder="Type to search..."
      items={matches}
      getKey={matchKey}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={setFocused}
      onSelect={handleOpen}
      onTab={
        onInsert
          ? {
              action: 'mention',
              handler: (m: Match) => handleInsert(m, true),
            }
          : undefined
      }
      onShiftTab={
        onInsert
          ? {
              action: 'insert path',
              handler: (m: Match) => handleInsert(m, false),
            }
          : undefined
      }
      onCancel={onDone}
      emptyMessage={(q: string) =>
        isSearching ? 'Searching...' : q ? 'No matches' : 'Type to search...'
      }
      matchLabel={matchLabel}
      selectAction="open in editor"
      renderItem={(m: Match, isFocused: boolean) => (
        <Text color={isFocused ? 'accent' : undefined}>
          <Text dimColor>{truncatePathMiddle(m.file, maxPathWidth)}:{m.line}</Text>{' '}
          {highlightMatch(truncateToWidth(m.text.trimStart(), maxTextWidth), query)}
        </Text>
      )}
      renderPreview={(m: Match) =>
        preview?.file === m.file && preview.line === m.line ? (
          <>
            <Text dimColor>
              {truncatePathMiddle(m.file, previewWidth)}:{m.line}
            </Text>
            {preview.content.split('\n').map((line: string, i: number) => (
              <Text key={i}>
                {highlightMatch(truncateToWidth(line, previewWidth), query)}
              </Text>
            ))}
          </>
        ) : (
          <LoadingState message="Loading..." dimColor />
        )
      }
    />
  )
}

function matchKey(match: Match): string {
  return `${match.file}:${match.line}:${match.text}`
}

async function searchWorkspace(
  cwd: string,
  query: string,
  signal: AbortSignal,
): Promise<{ matches: readonly Match[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--line-number',
      '--color',
      'never',
      '--hidden',
      '--glob',
      '!.git',
      '--glob',
      '!node_modules',
      '--max-count',
      String(MAX_MATCHES_PER_FILE),
      query,
      cwd,
    ]
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const matches: Match[] = []
    let buffer = ''
    let stderr = ''
    let truncated = false

    const abort = () => {
      child.kill('SIGTERM')
      const err = new Error('Search aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const match = parseRipgrepJsonLine(line, cwd)
        if (match) matches.push(match)
        if (matches.length >= MAX_TOTAL_MATCHES) {
          truncated = true
          child.kill('SIGTERM')
          break
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) return
      if (code === 0 || code === 1 || truncated) {
        resolve({ matches, truncated })
        return
      }
      reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`))
    })
  })
}

function parseRipgrepJsonLine(rawLine: string, cwd: string): Match | null {
  if (!rawLine.trim()) return null
  let record: unknown
  try {
    record = JSON.parse(rawLine)
  } catch {
    return null
  }
  if (
    record === null ||
    typeof record !== 'object' ||
    (record as { type?: unknown }).type !== 'match'
  ) {
    return null
  }
  const data = (record as { data?: unknown }).data
  if (data === null || typeof data !== 'object') return null
  const d = data as {
    path?: { text?: unknown }
    line_number?: unknown
    lines?: { text?: unknown }
  }
  const fileText = typeof d.path?.text === 'string' ? d.path.text : null
  const lineNumber = typeof d.line_number === 'number' ? d.line_number : null
  const text = typeof d.lines?.text === 'string' ? d.lines.text : ''
  if (!fileText || lineNumber === null) return null
  const rel = path.isAbsolute(fileText)
    ? path.relative(cwd, fileText)
    : fileText
  return {
    file: rel.split(path.sep).join('/'),
    line: lineNumber,
    text,
  }
}

async function readFileInRange(
  absolute: string,
  startLine: number,
  maxLines: number,
  signal: AbortSignal,
): Promise<string> {
  const content = await fs.readFile(absolute, { encoding: 'utf8', signal })
  return content
    .split(/\r?\n/u)
    .slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + maxLines)
    .join('\n')
}

function openFileInExternalEditor(absolute: string, line?: number): boolean {
  const editor = process.env.EDITOR || process.env.VISUAL || 'nano'
  const args = line ? [`+${line}`, absolute] : [absolute]
  try {
    spawn(editor, args, { stdio: 'inherit', shell: false }).unref()
    return true
  } catch {
    return false
  }
}

function truncateToWidth(s: string, width: number): string {
  if (s.length <= width) return s
  if (width <= 3) return s.slice(0, Math.max(0, width))
  return s.slice(0, Math.max(0, width - 3)) + '...'
}

function truncatePathMiddle(s: string, width: number): string {
  if (s.length <= width) return s
  if (width <= 6) return truncateToWidth(s, width)
  const keep = width - 3
  const left = Math.ceil(keep / 2)
  const right = Math.floor(keep / 2)
  return `${s.slice(0, left)}...${s.slice(-right)}`
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <Text color="accent">{text.slice(idx, idx + q.length)}</Text>
      {text.slice(idx + q.length)}
    </>
  )
}
