/**
 * QuickOpenDialog — fuzzy file picker overlay (Ctrl+O).
 *
 * Ported from upstream `QuickOpenDialog.tsx` and adapted to AgenC. The
 * upstream version pulled `generateFileSuggestions` from a workspace
 * scanner; here we drive the file enumeration through AgenC's `Glob`
 * tool (`runtime/src/tools/system/glob.ts`) so the dialog can list any
 * file inside the configured allowed paths without growing a new code
 * path.
 *
 * Caller contract:
 *   - `onInsert(text)` — inserts the selected entry into the composer.
 *     The widget appends a trailing space and prepends `@` for the
 *     mention path (Tab) so submit-time mention resolution works.
 *   - `onDone()` — close the dialog. Always called after `onInsert` and
 *     after Enter (open in editor) / Esc (cancel).
 *   - `allowedPaths` — same allowedPaths the runtime hands `createGlobTool`.
 *     The first entry is also used as the search root for relative
 *     display paths.
 */
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { Text } from '../ink-public.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { FuzzyPicker } from '../design-system/FuzzyPicker.js'
import { LoadingState } from '../design-system/LoadingState.js'
import { createGlobTool } from '../../tools/system/glob.js'

type Props = {
  readonly allowedPaths: readonly string[]
  readonly onDone: () => void
  readonly onInsert: (text: string) => void
}

const VISIBLE_RESULTS = 8
const PREVIEW_LINES = 20
const MAX_FILES = 200

export function QuickOpenDialog({
  allowedPaths,
  onDone,
  onInsert,
}: Props): React.ReactElement {
  const { columns, rows } = useTerminalSize()
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14))
  const [allFiles, setAllFiles] = useState<readonly string[]>([])
  const [results, setResults] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<{
    path: string
    content: string
  } | null>(null)
  const queryGenRef = useRef(0)

  const searchRoot = allowedPaths[0] ?? process.cwd()

  // One-shot enumeration via the AgenC Glob tool. Running it on mount
  // gives us a finite list we can fuzzy-match against without spinning
  // up a new ripgrep process per keystroke.
  useEffect(() => {
    let cancelled = false
    const tool = createGlobTool({ allowedPaths })
    void (async () => {
      const result = await tool.execute({
        pattern: '**/*',
        path: searchRoot,
        // Type widening: ToolExecutionInjectedArgs allows __abortSignal.
      } as unknown as Record<string, unknown>)
      if (cancelled) return
      if (result.isError) {
        setAllFiles([])
        return
      }
      const text = typeof result.content === 'string' ? result.content : ''
      const lines = text.split('\n').slice(1) // first row is the count summary
      const rels: string[] = []
      for (const absolute of lines) {
        const trimmed = absolute.trim()
        if (!trimmed || trimmed.startsWith('(')) continue
        if (path.isAbsolute(trimmed)) {
          const rel = path.relative(searchRoot, trimmed)
          if (rel && !rel.startsWith('..')) rels.push(rel.split(path.sep).join('/'))
        } else {
          rels.push(trimmed.split(path.sep).join('/'))
        }
        if (rels.length >= MAX_FILES) break
      }
      setAllFiles(rels)
    })()
    return () => {
      cancelled = true
    }
  }, [allowedPaths, searchRoot])

  useEffect(() => {
    return () => {
      queryGenRef.current += 1
    }
  }, [])

  const previewOnRight = columns >= 120
  const effectivePreviewLines = previewOnRight
    ? VISIBLE_RESULTS - 1
    : PREVIEW_LINES

  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q)
      const gen = ++queryGenRef.current
      if (!q.trim()) {
        setResults([])
        return
      }
      // Simple subsequence match — caller-side filter as the contract
      // requires. Newest-first ordering already comes from Glob.
      const lower = q.toLowerCase()
      const exact: string[] = []
      const fuzzy: string[] = []
      for (const f of allFiles) {
        const fl = f.toLowerCase()
        if (fl.includes(lower)) {
          exact.push(f)
        } else if (isSubsequence(fl, lower)) {
          fuzzy.push(f)
        }
      }
      if (gen !== queryGenRef.current) return
      // TODO(tranche-2D): swap simple includes match for fuzzysort once
      // dep is added.
      setResults(exact.concat(fuzzy).slice(0, MAX_FILES))
    },
    [allFiles],
  )

  // Async preview load for the focused entry.
  useEffect(() => {
    if (!focusedPath) {
      setPreview(null)
      return
    }
    const controller = new AbortController()
    const absolute = path.resolve(searchRoot, focusedPath)
    void readFileHead(absolute, effectivePreviewLines, controller.signal)
      .then((content) => {
        if (controller.signal.aborted) return
        setPreview({ path: focusedPath, content })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setPreview({ path: focusedPath, content: '(preview unavailable)' })
      })
    return () => controller.abort()
  }, [focusedPath, effectivePreviewLines, searchRoot])

  const maxPathWidth = previewOnRight
    ? Math.max(20, Math.floor((columns - 10) * 0.4))
    : Math.max(20, columns - 8)
  const previewWidth = previewOnRight
    ? Math.max(40, columns - maxPathWidth - 14)
    : columns - 6

  const handleOpen = useCallback(
    (p: string) => {
      openFileInExternalEditor(path.resolve(searchRoot, p))
      onDone()
    },
    [onDone, searchRoot],
  )

  const handleInsert = useCallback(
    (p: string, mention: boolean) => {
      onInsert(mention ? `@${p} ` : `${p} `)
      onDone()
    },
    [onDone, onInsert],
  )

  return (
    <FuzzyPicker<string>
      title="Quick Open"
      placeholder="Type to search files…"
      items={results}
      getKey={(p: string) => p}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={setFocusedPath}
      onSelect={handleOpen}
      onTab={{
        action: 'mention',
        handler: (p: string) => handleInsert(p, true),
      }}
      onShiftTab={{
        action: 'insert path',
        handler: (p: string) => handleInsert(p, false),
      }}
      onCancel={onDone}
      emptyMessage={(q: string) =>
        q ? 'No matching files' : 'Start typing to search…'
      }
      selectAction="open in editor"
      renderItem={(p: string, isFocused: boolean) => (
        <Text color={isFocused ? 'accent' : undefined}>
          {truncatePathMiddle(p, maxPathWidth)}
        </Text>
      )}
      renderPreview={(p: string) =>
        preview ? (
          <>
            <Text dimColor>
              {truncatePathMiddle(p, previewWidth)}
              {preview.path !== p ? ' · loading…' : ''}
            </Text>
            {preview.content.split('\n').map((line: string, i: number) => (
              <Text key={i}>
                {highlightMatch(truncateToWidth(line, previewWidth), query)}
              </Text>
            ))}
          </>
        ) : (
          <LoadingState message="Loading preview…" dimColor />
        )
      }
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

async function readFileHead(
  absolute: string,
  maxLines: number,
  signal: AbortSignal,
): Promise<string> {
  const buf = await fs.readFile(absolute, { encoding: 'utf8', signal })
  const newline = buf.indexOf('\n')
  if (newline === -1) return buf
  const lines = buf.split('\n')
  return lines.slice(0, maxLines).join('\n')
}

/**
 * Hand the file to `$EDITOR` / `$VISUAL`, falling back to `nano`. The
 * spawned process inherits stdio so the user briefly takes over the
 * terminal. Returns true when the editor was launched.
 */
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

function truncatePathMiddle(p: string, width: number): string {
  if (p.length <= width) return p
  if (width <= 1) return p.slice(0, width)
  const head = Math.ceil((width - 1) / 2)
  const tail = Math.floor((width - 1) / 2)
  return `${p.slice(0, head)}…${p.slice(p.length - tail)}`
}

function truncateToWidth(s: string, width: number): string {
  if (s.length <= width) return s
  return s.slice(0, Math.max(0, width - 1)) + '…'
}

/**
 * Inline match highlight — returns the input string unchanged when the
 * query is empty or absent. Upstream returns a JSX node with bold spans;
 * the AgenC port keeps it text-only because `Text` accepts strings only.
 * If a richer highlight is needed later, port upstream's
 * `highlightMatch` from `utils/highlightMatch.ts`.
 */
function highlightMatch(text: string, _query: string): string {
  return text
}
