/**
 * FuzzyPicker — a generic search-and-pick overlay.
 *
 * Caller-driven filtering: pass `items` already filtered for the current
 * `query`, and supply `onQueryChange(q)` so the caller can re-filter on
 * each keystroke. The widget owns the focus index (with a sliding window),
 * the empty-state, the byline hints, and the keyboard contract.
 *
 * Keyboard contract
 * -----------------
 *   ↑ / ctrl+p  — move focus up   (visually; flipped automatically when
 *                                   `direction='up'`)
 *   ↓ / ctrl+n  — move focus down
 *   Enter       — onSelect(focused)
 *   Tab         — onTab.handler ?? onSelect
 *   shift+Tab   — onShiftTab.handler ?? onTab.handler
 *   Esc / ctrl+c — onCancel
 *
 * Cross-batch dependencies
 * ------------------------
 *   - Upstream FuzzyPicker imports a shared `useSearchInput` hook + a
 *     `SearchBox` component. Neither is ported into AgenC yet (they pull
 *     a heavy `Cursor` utility, ~1530 LOC, scheduled for a later
 *     tranche). Until those land we use a local minimal text input
 *     (insert, backspace, delete, left/right cursor, home/end) that
 *     covers every FuzzyPicker call site. When `useSearchInput`/`SearchBox`
 *     arrive, replace the local helpers below and delete this comment.
 *   - Upstream uses `fuzzysort` for filtering. AgenC doesn't ship it yet
 *     (see `runtime/package.json`). Filtering happens in the caller, so
 *     this widget itself is independent of the library; but callers that
 *     used to call `fuzzysort.go(...)` should fall back to a
 *     `string.includes(query.toLowerCase())` pre-filter and add a
 *     `// TODO(tranche-2D): swap simple includes match for fuzzysort once
 *     dep is added` comment at their call sites.
 */
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useTerminalFocus } from '../ink-public.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { clamp } from '../ink/layout/geometry.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Byline } from './Byline.js'
import { KeyboardShortcutHint } from './KeyboardShortcutHint.js'
import { ListItem } from './ListItem.js'
import { Pane } from './Pane.js'

type PickerAction<T> = {
  /** Hint label shown in the byline, e.g. "mention" → "Tab to mention". */
  action: string
  handler: (item: T) => void
}

type Props<T> = {
  title: string
  placeholder?: string
  initialQuery?: string
  items: readonly T[]
  getKey: (item: T) => string
  /** Keep to one line — preview handles overflow. */
  renderItem: (item: T, isFocused: boolean) => React.ReactNode
  renderPreview?: (item: T) => React.ReactNode
  /** 'right' keeps hints stable (no bounce), but needs width. */
  previewPosition?: 'bottom' | 'right'
  visibleCount?: number
  /**
   * 'up' puts items[0] at the bottom next to the input (atuin-style). Arrows
   * always match screen direction — ↑ walks visually up regardless.
   */
  direction?: 'down' | 'up'
  /** Caller owns filtering: re-filter on each call and pass new items. */
  onQueryChange: (query: string) => void
  /** Enter key. Primary action. */
  onSelect: (item: T) => void
  /**
   * Tab key. If provided, Tab no longer aliases Enter — it gets its own
   * handler and hint. Shift+Tab falls through to this if onShiftTab is unset.
   */
  onTab?: PickerAction<T>
  /** Shift+Tab key. Gets its own hint. */
  onShiftTab?: PickerAction<T>
  /**
   * Fires when the focused item changes (via arrows or when items reset).
   * Useful for async preview loading — keeps I/O out of renderPreview.
   */
  onFocus?: (item: T | undefined) => void
  onCancel: () => void
  /** Shown when items is empty. Caller bakes loading/searching state into this. */
  emptyMessage?: string | ((query: string) => string)
  /**
   * Status line below the list, e.g. "500+ matches" or "42 matches…".
   * Caller decides when to show it — pass undefined to hide.
   */
  matchLabel?: string
  selectAction?: string
  extraHints?: React.ReactNode
}

const DEFAULT_VISIBLE = 8
// Pane (paddingTop + Divider) + title + 3 gaps + SearchBox (rounded border = 3
// rows) + hints. matchLabel adds +1 when present, accounted for separately.
const CHROME_ROWS = 10
const MIN_VISIBLE = 2

export function FuzzyPicker<T>({
  title,
  placeholder = 'Type to search…',
  initialQuery,
  items,
  getKey,
  renderItem,
  renderPreview,
  previewPosition = 'bottom',
  visibleCount: requestedVisible = DEFAULT_VISIBLE,
  direction = 'down',
  onQueryChange,
  onSelect,
  onTab,
  onShiftTab,
  onFocus,
  onCancel,
  emptyMessage = 'No results',
  matchLabel,
  selectAction = 'select',
  extraHints,
}: Props<T>): React.ReactElement {
  const isTerminalFocused = useTerminalFocus()
  const { rows, columns } = useTerminalSize()
  const [focusedIndex, setFocusedIndex] = useState(0)

  // Cap visibleCount so the picker never exceeds the terminal height. When it
  // overflows, each re-render (arrow key, ctrl+p) mis-positions the cursor-up
  // by the overflow amount and a previously-drawn line flashes blank.
  const visibleCount = Math.max(
    MIN_VISIBLE,
    Math.min(requestedVisible, rows - CHROME_ROWS - (matchLabel ? 1 : 0)),
  )

  // Full hint row with onTab+onShiftTab is ~100 chars and wraps inconsistently
  // below that. Compact mode drops shift+tab and shortens labels.
  const compact = columns < 120

  const step = (delta: 1 | -1) => {
    setFocusedIndex((i) => clamp(i + delta, 0, items.length - 1))
  }

  // Local text input state. Replaces the upstream `useSearchInput` hook
  // (cross-batch dependency, see header comment). Supported edits:
  //   - insert any printable chord (multi-char accepted for paste)
  //   - backspace/delete
  //   - left/right cursor + home/end
  // Higher-end editing (kill ring, word jump, yank) is intentionally
  // out of scope until the shared hook is ported.
  const [query, setQuery] = useState(initialQuery ?? '')
  const [cursorOffset, setCursorOffset] = useState(initialQuery?.length ?? 0)

  const insertText = useCallback(
    (text: string) => {
      const off = Math.min(cursorOffset, query.length)
      const next = query.slice(0, off) + text + query.slice(off)
      setQuery(next)
      setCursorOffset(off + text.length)
    },
    [cursorOffset, query],
  )

  const backspace = useCallback(() => {
    const off = Math.min(cursorOffset, query.length)
    if (off === 0) return
    setQuery(query.slice(0, off - 1) + query.slice(off))
    setCursorOffset(off - 1)
  }, [cursorOffset, query])

  const deleteForward = useCallback(() => {
    const off = Math.min(cursorOffset, query.length)
    if (off >= query.length) return
    setQuery(query.slice(0, off) + query.slice(off + 1))
  }, [cursorOffset, query])

  const handleKeyDown = (e: KeyboardEvent) => {
    // Cancel chords first so they win over text input.
    if (e.key === 'escape' || (e.ctrl && (e.key === 'c' || e.key === 'd'))) {
      e.preventDefault()
      e.stopImmediatePropagation()
      onCancel()
      return
    }

    if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
      e.preventDefault()
      e.stopImmediatePropagation()
      step(direction === 'up' ? 1 : -1)
      return
    }
    if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
      e.preventDefault()
      e.stopImmediatePropagation()
      step(direction === 'up' ? -1 : 1)
      return
    }
    if (e.key === 'return') {
      e.preventDefault()
      e.stopImmediatePropagation()
      const selected = items[focusedIndex]
      if (selected) onSelect(selected)
      return
    }
    if (e.key === 'tab') {
      e.preventDefault()
      e.stopImmediatePropagation()
      const selected = items[focusedIndex]
      if (!selected) return
      const tabAction = e.shift ? onShiftTab ?? onTab : onTab
      if (tabAction) {
        tabAction.handler(selected)
      } else {
        onSelect(selected)
      }
      return
    }

    // Cursor movement.
    if (e.key === 'left') {
      e.preventDefault()
      setCursorOffset((off) => Math.max(0, off - 1))
      return
    }
    if (e.key === 'right') {
      e.preventDefault()
      setCursorOffset((off) => Math.min(query.length, off + 1))
      return
    }
    if (e.key === 'home' || (e.ctrl && e.key === 'a')) {
      e.preventDefault()
      setCursorOffset(0)
      return
    }
    if (e.key === 'end' || (e.ctrl && e.key === 'e')) {
      e.preventDefault()
      setCursorOffset(query.length)
      return
    }

    // Text editing.
    if (e.key === 'backspace') {
      e.preventDefault()
      backspace()
      return
    }
    if (e.key === 'delete') {
      e.preventDefault()
      deleteForward()
      return
    }

    // Plain printable input. Reject special key names that fall through.
    if (e.ctrl || e.meta) return
    if (e.key.length >= 1 && !UNHANDLED_SPECIAL_KEYS.has(e.key)) {
      e.preventDefault()
      insertText(e.key)
    }
  }

  // Notify the caller whenever the query changes so they can re-filter.
  // We intentionally don't depend on onQueryChange here — see comment in
  // upstream FuzzyPicker; reset focus to top on every query change.
  const onQueryChangeRef = useRef(onQueryChange)
  useEffect(() => {
    onQueryChangeRef.current = onQueryChange
  }, [onQueryChange])
  useEffect(() => {
    onQueryChangeRef.current(query)
    setFocusedIndex(0)
  }, [query])

  useEffect(() => {
    setFocusedIndex((i) => clamp(i, 0, items.length - 1))
  }, [items.length])

  const focused = items[focusedIndex]
  const onFocusRef = useRef(onFocus)
  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])
  useEffect(() => {
    onFocusRef.current?.(focused)
  }, [focused])

  const windowStart = clamp(
    focusedIndex - visibleCount + 1,
    0,
    Math.max(0, items.length - visibleCount),
  )
  const visible = items.slice(windowStart, windowStart + visibleCount)
  const emptyText =
    typeof emptyMessage === 'function' ? emptyMessage(query) : emptyMessage

  const searchBox = (
    <SearchBox
      query={query}
      cursorOffset={cursorOffset}
      placeholder={placeholder}
      isFocused
      isTerminalFocused={isTerminalFocused}
    />
  )

  const listBlock = (
    <List
      visible={visible}
      windowStart={windowStart}
      visibleCount={visibleCount}
      total={items.length}
      focusedIndex={focusedIndex}
      direction={direction}
      getKey={getKey}
      renderItem={renderItem}
      emptyText={emptyText}
    />
  )

  const preview =
    renderPreview && focused ? (
      <Box flexDirection="column" flexGrow={1}>
        {renderPreview(focused)}
      </Box>
    ) : null

  // Structure must not depend on preview truthiness — when focused goes
  // undefined (e.g. delete clears matches), switching row→fragment would
  // change both layout AND gap count, bouncing the searchBox below.
  const listGroup =
    renderPreview && previewPosition === 'right' ? (
      <Box
        flexDirection="row"
        gap={2}
        height={visibleCount + (matchLabel ? 1 : 0)}
      >
        <Box flexDirection="column" flexShrink={0}>
          {listBlock}
          {matchLabel && <Text dimColor>{matchLabel}</Text>}
        </Box>
        {preview ?? <Box flexGrow={1} />}
      </Box>
    ) : (
      // Box (not fragment) so the outer gap={1} doesn't insert a blank line
      // between list/matchLabel/preview — that read as extra space above
      // the prompt in direction='up'.
      <Box flexDirection="column">
        {listBlock}
        {matchLabel && <Text dimColor>{matchLabel}</Text>}
        {preview}
      </Box>
    )

  const inputAbove = direction !== 'up'
  return (
    <Pane color="accent">
      <Box
        flexDirection="column"
        gap={1}
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
      >
        <Text bold color="accent">
          {title}
        </Text>
        {inputAbove && searchBox}
        {listGroup}
        {!inputAbove && searchBox}
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint
              shortcut="↑/↓"
              action={compact ? 'nav' : 'navigate'}
            />
            <KeyboardShortcutHint
              shortcut="Enter"
              action={compact ? firstWord(selectAction) : selectAction}
            />
            {onTab && (
              <KeyboardShortcutHint shortcut="Tab" action={onTab.action} />
            )}
            {onShiftTab && !compact && (
              <KeyboardShortcutHint
                shortcut="shift+tab"
                action={onShiftTab.action}
              />
            )}
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
            {extraHints}
          </Byline>
        </Text>
      </Box>
    </Pane>
  )
}

type ListProps<T> = Pick<Props<T>, 'direction' | 'getKey' | 'renderItem'> & {
  visible: readonly T[]
  windowStart: number
  visibleCount: number
  total: number
  focusedIndex: number
  emptyText: string
}

function List<T>({
  visible,
  windowStart,
  visibleCount,
  total,
  focusedIndex,
  direction,
  getKey,
  renderItem,
  emptyText,
}: ListProps<T>): React.ReactElement {
  if (visible.length === 0) {
    return (
      <Box height={visibleCount} flexShrink={0}>
        <Text dimColor>{emptyText}</Text>
      </Box>
    )
  }
  const rows = visible.map((item, i) => {
    const actualIndex = windowStart + i
    const isFocused = actualIndex === focusedIndex
    const atLowEdge = i === 0 && windowStart > 0
    const atHighEdge =
      i === visible.length - 1 && windowStart + visibleCount < total
    return (
      <ListItem
        key={getKey(item)}
        isFocused={isFocused}
        showScrollUp={direction === 'up' ? atHighEdge : atLowEdge}
        showScrollDown={direction === 'up' ? atLowEdge : atHighEdge}
        styled={false}
      >
        {renderItem(item, isFocused)}
      </ListItem>
    )
  })
  return (
    <Box
      height={visibleCount}
      flexShrink={0}
      flexDirection={direction === 'up' ? 'column-reverse' : 'column'}
    >
      {rows}
    </Box>
  )
}

function firstWord(s: string): string {
  const i = s.indexOf(' ')
  return i === -1 ? s : s.slice(0, i)
}

// Special key names that fall through the explicit handlers above the
// text-input branch. Reject these so e.g. PageUp doesn't leak 'pageup'
// as literal text.
const UNHANDLED_SPECIAL_KEYS = new Set([
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
  'mouse',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

// ---------------------------------------------------------------------------
// Local SearchBox (minimal port of the upstream SearchBox widget).
//
// Renders a rounded-border search prompt with an inverted-cell cursor at
// `cursorOffset`. The full SearchBox component (with prefix/borderless/width
// knobs) is scheduled for a later tranche; this local copy carries only what
// FuzzyPicker uses today.
// ---------------------------------------------------------------------------

type SearchBoxProps = {
  query: string
  cursorOffset: number
  placeholder: string
  isFocused: boolean
  isTerminalFocused: boolean
}

function SearchBox({
  query,
  cursorOffset,
  placeholder,
  isFocused,
  isTerminalFocused,
}: SearchBoxProps): React.ReactElement {
  const offset = cursorOffset ?? query.length
  const inner = isFocused ? (
    query ? (
      isTerminalFocused ? (
        <>
          <Text>{query.slice(0, offset)}</Text>
          <Text inverse>
            {offset < query.length ? query[offset] : ' '}
          </Text>
          {offset < query.length && <Text>{query.slice(offset + 1)}</Text>}
        </>
      ) : (
        <Text>{query}</Text>
      )
    ) : isTerminalFocused ? (
      <>
        <Text inverse>{placeholder.charAt(0)}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </>
    ) : (
      <Text dimColor>{placeholder}</Text>
    )
  ) : query ? (
    <Text>{query}</Text>
  ) : (
    <Text>{placeholder}</Text>
  )

  return (
    <Box
      flexShrink={0}
      borderStyle="round"
      borderColor={isFocused ? 'accent' : undefined}
      borderDimColor={!isFocused}
      paddingX={1}
    >
      <Text dimColor={!isFocused}>
        {'⌕'} {inner}
      </Text>
    </Box>
  )
}
