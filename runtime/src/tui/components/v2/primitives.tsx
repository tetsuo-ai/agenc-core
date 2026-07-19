import type { ReactNode } from 'react'
import React from 'react'
import type { PermissionMode } from '../../../permissions/types.js'
import { AURA_LIFECYCLE_GLYPHS, AURA_PLAN_GLYPHS, type Theme } from '../../../utils/theme.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useQueuedMessage } from '../../context/QueuedMessageContext.js'
import { ContentWidthProvider, insetContentWidth, useContentWidth } from '../../context/contentWidthContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import Box from '../../ink/components/Box.js'
import wrapText from '../../ink/wrap-text.js'
import ThemedBox from '../design-system/ThemedBox.js'
import ThemedText from '../design-system/ThemedText.js'
import { stringWidth } from '../../ink/stringWidth.js'

type ThemeColor = keyof Theme

const TerminalFrameColumnsContext = React.createContext(120)

/**
 * Fixed horizontal chrome of the `DiffInline` box, measured against the rendered
 * output (see `diffInlineCodeCellWidth` for the exact decomposition). These are
 * the columns that are NEVER available to the flexing code text:
 *
 *   - the box's `borderStyle="single"` border: 1 col on each side          → 2
 *   - each diff row's `paddingX={1}`: 1 col on each side                    → 2
 *   - the fixed line-number gutter on every row:
 *       old line, `padStart(4, ' ')`                                        → 4
 *       new line, `padStart(4, ' ')`                                        → 4
 *       the ` {sigil} ` marker cell (space + 1-col sigil + space)           → 3
 *
 * Border (2) + paddingX (2) + gutter (4 + 4 + 3 = 11) = 15. The gutter is
 * content-independent — the line numbers are always padded to 4 and the sigil
 * cell is always 3 wide — so the chrome is a constant, which is what lets the
 * code-cell width be deterministic.
 */
const DIFF_INLINE_BORDER_COLS = 2
const DIFF_INLINE_ROW_PADDING_COLS = 2
const DIFF_INLINE_GUTTER_COLS = 4 + 4 + 3
const DIFF_INLINE_CHROME_COLS =
  DIFF_INLINE_BORDER_COLS + DIFF_INLINE_ROW_PADDING_COLS + DIFF_INLINE_GUTTER_COLS

/**
 * The EXACT visible width available to a `DiffInline` code cell, given the box's
 * total outer width. Pure + exported so the width contract is unit-testable in
 * isolation, independent of Yoga: `codeCellWidth = boxOuterWidth − 15`.
 *
 * When the box is so narrow there is no room for code (≤ chrome), this clamps to
 * a minimum of 1 so the truncate helper still emits a single-column marker
 * rather than producing a negative/zero width.
 */
export function diffInlineCodeCellWidth(boxOuterWidth: number): number {
  return Math.max(1, Math.floor(boxOuterWidth) - DIFF_INLINE_CHROME_COLS)
}

/**
 * Carries the EXACT outer width the embedded `DiffInline` box should occupy, set
 * ONLY by render contexts that fill a known content width (the post-approval
 * transcript DIFF card under a tool-use row). When present, `DiffInline` sizes
 * its code cell deterministically (`diffInlineCodeCellWidth`) and pre-truncates
 * each line, so Yoga flex rounding can never shift the truncation point by ±1
 * (which produced both the early-ellipsis and the spill-past-border symptoms).
 *
 * Deliberately separate from the general `ContentWidthContext`: a surface-wide
 * content width (e.g. an auto-sized approval popup that does NOT fill the whole
 * surface) is NOT the DiffInline box width, so reading the general context could
 * feed a too-wide value and overflow. `null` → the legacy flex layout is kept.
 */
const DiffInlineWidthContext = React.createContext<number | null>(null)

/**
 * Horizontal chrome the `Tool` detail box adds around its content before an
 * embedded `DiffInline`: `marginLeft={2}` + the `borderLeft` rule (1) +
 * `paddingLeft={1}` = 4 columns. The diff's outer width is therefore the
 * inherited content width minus this inset.
 */
const DIFF_INLINE_DETAIL_INSET_COLS = 2 + 1 + 1

export type BadgeVariant =
  | 'neutral'
  | 'accent'
  | 'worker'
  | 'success'
  | 'error'
  | 'plan'

export type ToolKind =
  | 'read'
  | 'grep'
  | 'edit'
  | 'bash'
  | 'delegate'
  | 'proof'
  | 'claim'
  | 'settle'
  | 'stake'

export type ToolState = 'queued' | 'running' | 'done' | 'failed'

export type SlashPaletteItem = {
  readonly command: string
  readonly args: string
  readonly description: string
}

const modeChrome: Record<
  PermissionMode,
  { readonly fg: ThemeColor; readonly bg?: ThemeColor; readonly label: string }
> = {
  default: { fg: 'subtle', label: 'default' },
  acceptEdits: { fg: 'agenc', bg: 'agencWash', label: 'accept edits' },
  plan: { fg: 'planMode', bg: 'planModeWash', label: 'plan' },
  auto: { fg: 'success', bg: 'successWash', label: 'auto' },
  bypassPermissions: { fg: 'error', bg: 'errorWash', label: 'bypass perms' },
  dontAsk: { fg: 'inactive', label: 'dont ask' },
  unattended: { fg: 'inactive', label: 'unattended' },
  bubble: { fg: 'inactive', label: 'bubble' },
}

const variantColor: Record<BadgeVariant, ThemeColor> = {
  neutral: 'subtle',
  accent: 'agenc',
  worker: 'worker',
  success: 'success',
  error: 'error',
  plan: 'planMode',
}

const variantWash: Partial<Record<BadgeVariant, ThemeColor>> = {
  accent: 'agencWash',
  worker: 'workerWash',
  success: 'successWash',
  error: 'errorWash',
  plan: 'planModeWash',
}

const toolColor: Record<ToolKind, ThemeColor> = {
  read: 'text2',
  grep: 'text2',
  edit: 'agenc',
  bash: 'worker',
  delegate: 'worker',
  proof: 'agenc',
  claim: 'worker',
  settle: 'success',
  stake: 'worker',
}

const toolGlyph: Readonly<Record<ToolState, string>> = AURA_LIFECYCLE_GLYPHS

function capitalize(value: string): string {
  return value.length > 0 ? value.slice(0, 1).toUpperCase() + value.slice(1) : value
}

function Content({
  children,
  color = 'text2',
  wrap = 'wrap',
}: {
  readonly children: ReactNode
  readonly color?: ThemeColor
  readonly wrap?: 'wrap' | 'truncate-end' | 'truncate-middle'
}): React.ReactNode {
  if (
    typeof children === 'string' ||
    typeof children === 'number' ||
    Array.isArray(children)
  ) {
    return (
      <ThemedText color={color} wrap={wrap}>
        {children}
      </ThemedText>
    )
  }
  return <Box flexDirection="column">{children}</Box>
}

export function KeyHint({
  k,
  label,
}: {
  readonly k: string
  readonly label: string
}): React.ReactNode {
  return (
    <Box flexDirection="row" flexShrink={0}>
      <ThemedText color="muted3">[</ThemedText>
      <ThemedText color="agenc">{k}</ThemedText>
      <ThemedText color="muted3">]</ThemedText>
      <ThemedText color="subtle"> </ThemedText>
      <ThemedText color="subtle" wrap="truncate-end">{label}</ThemedText>
    </Box>
  )
}

export function BrandCells({
  columns = 38,
  rows = 9,
}: {
  readonly columns?: number
  readonly rows?: number
}): React.ReactNode {
  const shades = ['░', '▒', '▓']
  const colors: ThemeColor[] = ['agenc', 'agencShimmer', 'worker', 'briefLabelWorker']

  return (
    <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
      {Array.from({ length: rows }, (_, row) => (
        <Box key={row} flexDirection="row">
          {Array.from({ length: columns }, (_, column) => {
            const dr = (rows - 1 - row) / Math.max(1, rows - 1)
            const dc = column / Math.max(1, columns - 1)
            const intensity = Math.max(0, dr * 0.55 + dc * 0.55 - 0.45)
            if (intensity < 0.06) {
              return <ThemedText key={column}> </ThemedText>
            }
            const shade = shades[intensity > 0.55 ? 2 : intensity > 0.32 ? 1 : 0]!
            const color = colors[Math.min(colors.length - 1, Math.floor(dc * colors.length))]!
            return (
              <ThemedText key={column} color={color}>
                {shade}
              </ThemedText>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

export function ModePill({
  mode,
}: {
  readonly mode: PermissionMode
}): React.ReactNode {
  const chrome = modeChrome[mode] ?? modeChrome.default
  return (
    <Box flexDirection="row" flexShrink={0}>
      <ThemedText color={chrome.fg} backgroundColor={chrome.bg}>
        {' mode'}
      </ThemedText>
      <ThemedText color="muted3" backgroundColor={chrome.bg}>
        {' · '}
      </ThemedText>
      <ThemedText color={chrome.fg} backgroundColor={chrome.bg}>
        {`${chrome.label} `}
      </ThemedText>
    </Box>
  )
}

const userFacingModeOrder: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]

function modeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'standard · ask for ambiguous tools'
    case 'acceptEdits':
      return 'auto-accept file edits in this session'
    case 'plan':
      return 'read-only · propose plans, never execute'
    case 'auto':
      return 'auto-approve everything allowlisted'
    case 'bypassPermissions':
      return 'DANGER · all approvals bypassed'
    case 'dontAsk':
      return 'internal prompt suppression mode'
    case 'unattended':
      return 'background-agent unattended mode'
    case 'bubble':
      return 'nested-agent permission bubbling'
  }
}

export function ModeSwitcher({
  currentMode,
  bypassAvailable = true,
  autoAvailable = true,
  spacious = false,
}: {
  readonly currentMode: PermissionMode
  readonly bypassAvailable?: boolean
  readonly autoAvailable?: boolean
  readonly spacious?: boolean
}): React.ReactNode {
  const modes = userFacingModeOrder.filter(
    mode =>
      (mode !== 'bypassPermissions' || bypassAvailable) &&
      (mode !== 'auto' || autoAvailable),
  )

  return (
    <Box flexDirection="row" justifyContent="center" width="100%">
      <ThemedBox
        flexDirection="column"
        width={80}
        borderStyle="single"
        borderColor="agenc"
        backgroundColor="clawd_background"
      >
      <ThemedBox flexDirection="row" borderBottom borderBottomColor="agenc" paddingX={1} gap={2}>
        <Box width={16} flexShrink={0}>
          <ThemedText color="agenc" wrap="truncate-end">permission mode</ThemedText>
        </Box>
        <Box width={22} flexShrink={0}>
          <ThemedText color="inactive" wrap="truncate-end">{`current · ${currentMode}`}</ThemedText>
        </Box>
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-end">1–5 pick · ⇧⇥ cycle · esc</ThemedText>
      </ThemedBox>
      <Box flexDirection="column">
        {modes.map((mode, index) => {
          const chrome = modeChrome[mode]
          const active = mode === currentMode
          const spacerAfter = spacious ? (active ? 2 : mode === 'plan' ? 1 : 0) : 0
          return (
            <React.Fragment key={mode}>
            <ThemedBox
              flexDirection="row"
              backgroundColor={active ? chrome.bg ?? 'agencWash' : undefined}
              borderLeft={active}
              borderLeftColor={active ? 'agenc' : undefined}
              paddingX={1}
              gap={1}
            >
              <Box width={4} flexShrink={0}>
                <ThemedText color="muted3">{`[${index + 1}]`}</ThemedText>
              </Box>
              <Box width={24} flexShrink={0}>
                <ThemedText color={chrome.fg} bold={active} wrap="truncate-end">
                  {`${mode}${active ? ' · current' : ''}`}
                </ThemedText>
              </Box>
              <ThemedText color={active ? 'text2' : 'subtle'} wrap="truncate-end">
                {modeDescription(mode)}
              </ThemedText>
            </ThemedBox>
            {spacerAfter > 0 ? <Box minHeight={spacerAfter} /> : null}
            </React.Fragment>
          )
        })}
      </Box>
      <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={1}>
        <ThemedText color="inactive">shift+tab cycles forward · /permissions for full rule table</ThemedText>
      </ThemedBox>
      </ThemedBox>
    </Box>
  )
}

export function TuiHeader({
  title,
  tabLabel = 'agenc · orchestrator',
  tabStatus = 'live',
  permissionMode = 'default',
  taskPda,
  columns = 120,
}: {
  readonly title: string
  readonly tabLabel?: string
  readonly tabStatus?: 'live' | 'warn' | 'pending'
  readonly permissionMode?: PermissionMode
  readonly taskPda?: string
  readonly columns?: number
}): React.ReactNode {
  const showTask = columns >= 84
  const showTab = columns >= 56
  const displayTitle = title.replace(/^agenc\s*~?\s*/u, '~/')
  const statusColor: ThemeColor =
    tabStatus === 'warn' ? 'error' : tabStatus === 'pending' ? 'inactive' : 'success'

  return (
    <ThemedBox
      flexDirection="column"
      backgroundColor="surfaceBackground"
      borderBottom
      borderBottomColor="lineSoft"
    >
      <Box flexDirection="row" alignItems="center" paddingX={2} minHeight={1} gap={1}>
        <ThemedText color="agenc">▮</ThemedText>
        <ThemedText color="subtle" wrap="truncate-end">agenc</ThemedText>
        <ThemedText color="muted3">·</ThemedText>
        <ThemedText color="inactive" wrap="truncate-end">
          {displayTitle}
        </ThemedText>
        {showTab ? (
          <>
            <ThemedText color="lineSoft">│</ThemedText>
            <ThemedText color={statusColor}>●</ThemedText>
            <ThemedText color="text2" underline wrap="truncate-end">
              {tabLabel}
            </ThemedText>
          </>
        ) : null}
        <Box flexGrow={1} />
        <ModePill mode={permissionMode} />
        {showTask ? (
          <>
            <ThemedText color="lineSoft">│</ThemedText>
            <ThemedText color="inactive">task </ThemedText>
            <ThemedText color="subtle" wrap="truncate-middle">
              {taskPda ?? '—'}
            </ThemedText>
          </>
        ) : null}
      </Box>
    </ThemedBox>
  )
}

export function StatusSegment({
  label,
  value,
  color = 'text2',
  separator,
}: {
  readonly label: string
  readonly value: string
  readonly color?: ThemeColor
  readonly separator?: boolean
  readonly gapAfter?: number
}): React.ReactNode {
  const columns = React.useContext(TerminalFrameColumnsContext)
  const wideLabelNeedsSeparator = separator ?? (label === 'stake' || label === 'cost')
  const labelText = columns >= 148
    ? `${label.toUpperCase()}${wideLabelNeedsSeparator ? ' ' : ''}`
    : `${label.toUpperCase()} `
  return (
    <Box flexDirection="row">
      <ThemedText color="inactive">{labelText}</ThemedText>
      <ThemedText color={color} wrap="truncate-end">
        {value}
      </ThemedText>
    </Box>
  )
}

export function StatusBar({
  left,
  right,
  variant = 'accent',
}: {
  readonly left: readonly ReactNode[]
  readonly right?: readonly ReactNode[]
  readonly variant?: BadgeVariant
}): React.ReactNode {
  const color = variantColor[variant]
  const columns = React.useContext(TerminalFrameColumnsContext)
  const segmentGapAfter = (segment: ReactNode, fallback: number): number => {
    if (!React.isValidElement(segment)) return fallback
    const props = segment.props as { readonly gapAfter?: unknown }
    return typeof props.gapAfter === 'number' ? props.gapAfter : fallback
  }
  const renderSegments = (segments: readonly ReactNode[], side: 'left' | 'right'): React.ReactNode[] =>
    segments.flatMap((segment, index) => {
      const spacerWidth = columns >= 148
        ? side === 'left' && index === 0
          ? 2
          : 1
        : 2
      const nodes: React.ReactNode[] = [
        <React.Fragment key={`${side}-${index}`}>{segment}</React.Fragment>,
      ]
      if (index < segments.length - 1) {
        nodes.push(<Box key={`${side}-spacer-${index}`} width={segmentGapAfter(segment, spacerWidth)} />)
      }
      return nodes
    })

  return (
    <ThemedBox
      flexDirection="row"
      backgroundColor={variantWash[variant] ?? 'agencWash'}
      borderTop
      borderTopColor={color}
      paddingLeft={columns >= 148 ? 2 : 1}
      paddingRight={1}
      minHeight={1}
      flexShrink={0}
    >
      {renderSegments(left, 'left')}
      <Box flexGrow={1} />
      {renderSegments(right ?? [], 'right')}
    </ThemedBox>
  )
}

export function ContextBar({
  left,
  right,
}: {
  readonly left?: ReactNode
  readonly right?: ReactNode
}): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="row"
      borderTop
      borderTopColor="lineSoft"
      backgroundColor="clawd_background"
      paddingX={2}
      gap={2}
      minHeight={1}
      flexShrink={0}
    >
      <Content color="subtle" wrap="truncate-end">{left}</Content>
      <Box flexGrow={1} />
      <Content color="subtle" wrap="truncate-end">{right}</Content>
    </ThemedBox>
  )
}

export function PromptChrome({
  text,
  placeholder = 'message agenc…',
  hint,
  shellMode = false,
  paused = false,
  paddingTop = 2,
}: {
  readonly text?: string
  readonly placeholder?: string
  readonly hint?: string
  readonly shellMode?: boolean
  readonly paused?: boolean
  readonly paddingTop?: number
}): React.ReactNode {
  const color: ThemeColor = shellMode ? 'worker' : paused ? 'planMode' : 'agenc'
  return (
    <ThemedBox
      flexDirection="row"
      borderTop
      borderTopColor="lineSoft"
      backgroundColor={shellMode ? 'workerWash' : 'clawd_background'}
      paddingLeft={2}
      paddingRight={0}
      paddingTop={paddingTop}
      gap={2}
      flexShrink={0}
    >
      <ThemedText color={color}>{shellMode ? '$' : '▸'}</ThemedText>
      <ThemedText color={text ? 'text' : 'inactive'} wrap="truncate-end">
        {text ?? placeholder}
      </ThemedText>
      <ThemedText color={color}>█</ThemedText>
      <Box flexGrow={1} />
      {hint ? (
        <ThemedText color="inactive" wrap="truncate-end">
          {hint}
        </ThemedText>
      ) : null}
    </ThemedBox>
  )
}

export function PlanModeBanner({
  title = 'plan mode',
  body = 'AgenC will propose changes first. Approve the plan before edits or shell actions run.',
}: {
  readonly title?: string
  readonly body?: string
}): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="row"
      backgroundColor="workerWash"
      borderBottom
      borderBottomColor="worker"
      paddingX={2}
      minHeight={1}
      gap={2}
      flexShrink={0}
    >
      <ThemedText color="worker">{`▸ ${title.toUpperCase()}`}</ThemedText>
      <ThemedText color="text2" wrap="truncate-end">
        {body}
      </ThemedText>
    </ThemedBox>
  )
}

export function TerminalFrame({
  title,
  tabLabel,
  tabStatus,
  permissionMode = 'default',
  taskPda,
  children,
  bodyOverlay,
  bodyOverlayTop = 2,
  bodyOverlayX,
  promptOverlay,
  contextLeft,
  contextRight,
  promptText,
  promptPlaceholder,
  promptHint,
  promptPaddingTop,
  shellMode,
  paused,
  statusLeft,
  statusRight,
  statusVariant,
  columns = 120,
  minHeight,
}: {
  readonly title: string
  readonly tabLabel?: string
  readonly tabStatus?: 'live' | 'warn' | 'pending'
  readonly permissionMode?: PermissionMode
  readonly taskPda?: string
  readonly children: ReactNode
  readonly bodyOverlay?: ReactNode
  readonly bodyOverlayTop?: number
  readonly bodyOverlayX?: number
  readonly promptOverlay?: ReactNode
  readonly contextLeft?: ReactNode
  readonly contextRight?: ReactNode
  readonly promptText?: string
  readonly promptPlaceholder?: string
  readonly promptHint?: string
  readonly promptPaddingTop?: number
  readonly shellMode?: boolean
  readonly paused?: boolean
  readonly statusLeft: readonly ReactNode[]
  readonly statusRight?: readonly ReactNode[]
  readonly statusVariant?: BadgeVariant
  readonly columns?: number
  readonly minHeight?: number
}): React.ReactNode {
  const showBrandBleed = columns >= 72
  const compactBrandBleed = columns < 100

  return (
    <TerminalFrameColumnsContext.Provider value={columns}>
      <ThemedBox
        flexDirection="column"
        minHeight={minHeight}
        backgroundColor="clawd_background"
        overflow="hidden"
      >
        <TuiHeader
          title={title}
          tabLabel={tabLabel}
          tabStatus={tabStatus}
          permissionMode={permissionMode}
          taskPda={taskPda}
          columns={columns}
        />
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {showBrandBleed ? (
            <Box position="absolute" top={0} right={0}>
              <BrandCells
                columns={compactBrandBleed ? 18 : 28}
                rows={compactBrandBleed ? 3 : 5}
              />
            </Box>
          ) : null}
          {children}
          {bodyOverlay ? (
            <Box
              position="absolute"
              top={bodyOverlayTop}
              left={bodyOverlayX ?? (columns >= 120 ? 8 : 2)}
              right={bodyOverlayX ?? (columns >= 120 ? 8 : 2)}
            >
              {bodyOverlay}
            </Box>
          ) : null}
          {promptOverlay ? (
            <Box flexShrink={0} paddingX={3} paddingBottom={1}>
              {promptOverlay}
            </Box>
          ) : null}
        </Box>
        {contextLeft || contextRight ? (
          <ContextBar left={contextLeft} right={contextRight} />
        ) : null}
        <PromptChrome
          text={promptText}
          placeholder={promptPlaceholder}
          hint={promptHint}
          shellMode={shellMode}
          paused={paused}
          paddingTop={promptPaddingTop}
        />
        <StatusBar left={statusLeft} right={statusRight} variant={statusVariant} />
      </ThemedBox>
    </TerminalFrameColumnsContext.Provider>
  )
}

export function ChatBody({
  children,
  centered = false,
  maxWidth,
}: {
  readonly children: ReactNode
  readonly centered?: boolean
  readonly maxWidth?: number
}): React.ReactNode {
  const columns = React.useContext(TerminalFrameColumnsContext)
  const horizontalInset = columns >= 72 ? 3 : 2
  const contentWidth =
    columns >= 120 && (centered || maxWidth !== undefined)
      ? Math.min(maxWidth ?? 108, Math.max(40, columns - (horizontalInset * 2)))
      : undefined

  return (
    <ThemedBox
      flexDirection="column"
      flexGrow={1}
      paddingX={horizontalInset}
      paddingY={1}
      overflow="hidden"
    >
      <Box flexDirection="row" justifyContent="center">
        <Box flexDirection="column" gap={1} width={contentWidth ?? '100%'}>
          {children}
        </Box>
      </Box>
    </ThemedBox>
  )
}

type WelcomeRecentSession = {
  readonly keyName: string
  readonly title: string
  readonly detail: string
}

function defaultWorkspaceLabel(): string {
  const cwd = process.cwd()
  const home = process.env.HOME
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

// Welcome summary/recent cards used to be fixed shrink-to-content boxes, so the
// two cards rendered at mismatched widths and left a jarring empty band on the
// right of a wide transcript pane. They now share one width that grows with the
// available pane up to a tasteful cap. MIN keeps a typical recent row
// (`[1] my-project · 12m ago · main · clean`, plus border + padding) from
// truncating; MAX stops them from stretching absurdly wide on a 200-col
// terminal.
const WELCOME_CARD_MIN_WIDTH = 46
const WELCOME_CARD_MAX_WIDTH = 64
// The transcript surface (ActiveWorkSurface) adds paddingX={1} around the
// welcome panel, so reserve 2 columns from the reported content width to avoid
// overflowing the pane.
const WELCOME_CARD_INSET = 2

function useWelcomeCardWidth(): number {
  const contentWidth = useContentWidth()
  const frameColumns = React.useContext(TerminalFrameColumnsContext)
  const available = contentWidth ?? frameColumns
  const usable = Math.max(1, available - WELCOME_CARD_INSET)
  const capped = Math.min(
    WELCOME_CARD_MAX_WIDTH,
    Math.max(WELCOME_CARD_MIN_WIDTH, usable),
  )
  // Never exceed the usable width — on a very narrow pane the cap floor would
  // otherwise overflow.
  return Math.min(capped, usable)
}

// The welcome hint line drops WHOLE segments when the pane is narrow instead
// of ellipsizing mid-word ("@ to atta…" taught nothing). Segments are ordered
// by teaching value; the first ones survive narrow panes. "? for shortcuts" is
// deliberately absent — the composer footer already shows it, and the welcome
// screen was saying it twice.
const WELCOME_HINT_SEGMENTS = [
  'type a task and press ↵',
  '/ for commands',
  '@ to attach',
] as const
const WELCOME_HINT_SEPARATOR = '  ·  '

export function fitHintSegments(
  segments: readonly string[],
  available: number,
  separator: string = WELCOME_HINT_SEPARATOR,
): string {
  let line = ''
  for (const segment of segments) {
    const candidate = line === '' ? segment : `${line}${separator}${segment}`
    if (stringWidth(candidate) > available) break
    line = candidate
  }
  // Never render an empty row: fall back to the single most valuable segment
  // and let the Text truncate it (only reachable on absurdly narrow panes).
  return line === '' ? (segments[0] ?? '') : line
}

function WelcomeHintLine(): React.ReactNode {
  const contentWidth = useContentWidth()
  const frameColumns = React.useContext(TerminalFrameColumnsContext)
  const available = Math.max(1, (contentWidth ?? frameColumns) - WELCOME_CARD_INSET)
  return (
    <ThemedText color="inactive" wrap="truncate-end">
      {fitHintSegments(WELCOME_HINT_SEGMENTS, available)}
    </ThemedText>
  )
}

function WelcomeMetaRow({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): React.ReactNode {
  return (
    // No `flexWrap="wrap"`: the value is `truncate-middle`, so it must shrink
    // and truncate IN PLACE on the label's row rather than wrap onto a fresh
    // flex line under the label (which breaks the 2-column label/value grid for
    // any long absolute path — the common workspace case). `flexShrink`/
    // `minWidth={0}` on the value cell lets Yoga squeeze it to the truncation
    // width while the fixed 13-col label holds its column.
    <Box flexDirection="row">
      {/* Labels use `inactive` (a readable secondary tone), not `muted3`. In the
          dark themes muted3 (rgb(64,64,70)) sits almost on top of the card's
          lineSoft border (rgb(34,35,39)), so the labels read as chrome rather
          than text. `inactive` is clearly brighter than the border while still
          ranking below the `text2` values. */}
      <Box flexShrink={0}>
        <ThemedText color="inactive">{label.padEnd(13)}</ThemedText>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <ThemedText color="text2" wrap="truncate-middle">
          {value}
        </ThemedText>
      </Box>
    </Box>
  )
}

export function WelcomeColdPanel({
  workspace = defaultWorkspaceLabel(),
  model = 'default model',
  lastSession,
  recentSessions = [],
}: {
  readonly workspace?: string
  readonly model?: string
  readonly lastSession?: string
  readonly recentSessions?: readonly WelcomeRecentSession[]
}): React.ReactNode {
  const visibleSessions = recentSessions.slice(0, 3)
  const cardWidth = useWelcomeCardWidth()
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <ThemedText color="agenc" bold>
          agenc.
        </ThemedText>
        <ThemedText color="text2">
          a netrunner with hands on every file
        </ThemedText>
      </Box>

      <ThemedBox
        flexDirection="column"
        width={cardWidth}
        borderStyle="single"
        borderColor="lineSoft"
        paddingX={1}
        paddingY={1}
      >
        <WelcomeMetaRow label="workspace" value={workspace} />
        <WelcomeMetaRow label="model" value={model} />
        {lastSession !== undefined ? (
          <WelcomeMetaRow label="last session" value={lastSession} />
        ) : null}
      </ThemedBox>

      {/* Real, static keyboard tips — the hint line below teaches the input
          basics (type/↓, /, @); these teach the four bindings a first-time
          user needs next. Unbordered on purpose: the summary/recent cards own
          the bordered rhythm of this panel (and their shared-width contract). */}
      <Box flexDirection="column">
        <ThemedText color="muted3">tips</ThemedText>
        <ThemedText color="inactive">{'  /help lists every command'}</ThemedText>
        <ThemedText color="inactive">{'  shift+tab cycles permission mode'}</ThemedText>
        <ThemedText color="inactive">{'  ctrl+o expands the full transcript'}</ThemedText>
        <ThemedText color="inactive">{'  esc interrupts the agent'}</ThemedText>
      </Box>

      {/* The recent card renders only with real session data — a fabricated
          resume list (or a "press 1-3" affordance over fake sessions) is
          worse than no card at all. */}
      {visibleSessions.length > 0 ? (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <ThemedText color="muted3">recent</ThemedText>
          <ThemedText color="inactive">
            {`  ·  press ${
              visibleSessions.length > 1
                ? `1-${visibleSessions.length}`
                : '1'
            } to resume`}
          </ThemedText>
        </Box>
        <ThemedBox
          flexDirection="column"
          width={cardWidth}
          borderStyle="single"
          // The resume list is the most likely next action on a cold start, so
          // it carries the one accent border on this screen — the info card
          // above stays lineSoft. Two identically-dim boxes gave the eye
          // nowhere to land.
          borderColor="agenc"
          paddingX={1}
          paddingY={1}
        >
          {visibleSessions.map(session => (
            // No `flexWrap="wrap"`: a long title/detail must truncate in place
            // rather than wrap the `· detail` segment onto its own flex line
            // under the `[n]` key (the same grid-breaking pattern as
            // WelcomeMetaRow). The flexing cell holds title + detail and
            // truncate-ends them together; the `[n] ` key prefix stays fixed.
            <Box key={session.keyName} flexDirection="row">
              {/* The `[n] ` key prefix is fixed and must not be squeezed when the
                  flexing title/detail cell shrinks (without flexShrink={0} Yoga
                  eats the `[` bracket under pressure). */}
              <Box flexShrink={0} flexDirection="row">
                <ThemedText color="muted3">[</ThemedText>
                <ThemedText color="agenc">{session.keyName}</ThemedText>
                <ThemedText color="muted3">] </ThemedText>
              </Box>
              <Box flexShrink={1} minWidth={0} flexDirection="row">
                {/* Titles at full text intensity, metadata dim: the previous
                    text2-on-muted3 pairing read as one gray blur, hiding the
                    only word the user actually scans for. */}
                <ThemedText color="text" wrap="truncate-end">{session.title}</ThemedText>
                <ThemedText color="muted3" wrap="truncate-end"> · {session.detail}</ThemedText>
              </Box>
            </Box>
          ))}
        </ThemedBox>
      </Box>
      ) : null}

      <WelcomeHintLine />
    </Box>
  )
}

export function TaskInFlightCard({
  taskId = '#47',
  title = 'swap_v2 fails on high-volatility pairs · add slippage_bps guard before settle',
  taskPda = '5yC9BM8K…uHnP4Q',
  escrow = '◎ 2.40',
  deadline = 'deadline in 3h 41m',
  planItems,
}: {
  readonly taskId?: string
  readonly title?: string
  readonly taskPda?: string
  readonly escrow?: string
  readonly deadline?: string
  readonly planItems: readonly {
    readonly state: 'done' | 'active' | 'pending' | 'failed'
    readonly text: string
  }[]
}): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="column"
      width={108}
      borderStyle="single"
      borderColor="worker"
      backgroundColor="workerWash"
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="row">
        <ThemedText color="worker">▸ TASK IN FLIGHT</ThemedText>
        <Box width={3} />
        <ThemedText color="subtle">
          {taskPda} · escrow {escrow}
        </ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="worker">{deadline}</ThemedText>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" marginLeft={-1}>
        <ThemedText color="text">{taskId}</ThemedText>
        <ThemedText color="text2" wrap="truncate-end">
          {title}
        </ThemedText>
      </Box>
      <PlanList title="checkpointed plan" items={planItems} dense gapAfterActive headerPaddingX={0} />
      <Box flexDirection="row" flexWrap="wrap">
        <KeyHint k="⏎" label="resume from step 3" />
        <KeyHint k="r" label="restart plan" />
        <KeyHint k="esc" label="abandon · forfeit ◎ 0.40" />
      </Box>
    </ThemedBox>
  )
}

export function Msg({
  role,
  label,
  time,
  children,
}: {
  readonly role: 'user' | 'agenc' | 'worker' | 'system'
  // Optional: user prompts pass no label — a "YOU" header over your own
  // messages is noise (the colored marker already identifies the role). When
  // absent, the header row renders only if a time/queued marker needs it.
  readonly label?: string
  readonly time?: string
  readonly children: ReactNode
}): React.ReactNode {
  const colors: Record<typeof role, ThemeColor> = {
    user: 'briefLabelYou',
    agenc: 'briefLabelAgenC',
    worker: 'briefLabelWorker',
    system: 'subtle',
  }
  const inheritedWidth = useContentWidth()
  // Queued previews carry no real per-item enqueue time, so they pass no
  // `time` (see PromptInputQueuedCommands). Show a quiet neutral "queued"
  // marker in the header slot instead of a misleading render-time clock.
  const queued = useQueuedMessage()
  const isQueued = queued?.isQueued ?? false
  // QUEUED items are additionally wrapped by QueuedMessageProvider in a
  // `<Box paddingX={2}>` (4 cols of horizontal padding) that the inherited
  // ContentWidth does NOT account for. Subtract that padding (the context's
  // already-computed `paddingWidth`, 0 for the brief layout) so the wrapped
  // body measures against the real available width and its first wrapped line
  // can't overshoot the highlight box by a column. Non-queued messages are
  // unaffected: `paddingWidth` defaults to 0.
  const queuedPaddingWidth = isQueued ? queued?.paddingWidth ?? 0 : 0
  // The marker glyph (1 cell) + the single-space row gap below = a 2-cell inset
  // for the content column; keep the inset in sync with the gap so wrapped body
  // text measures against the right width.
  const contentWidth = insetContentWidth(inheritedWidth, 2 + queuedPaddingWidth)
  return (
    // Gutter identity: a role-colored left border runs the FULL height of the
    // message (header + body), replacing the old single-row ▮ marker — the
    // colored line now spans the complete message, blockquote-style. The
    // border (1 cell) + paddingLeft (1 cell) preserves the same 2-cell
    // content inset the marker + gap used, so body widths are unchanged.
    <ThemedBox
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft
      borderLeftColor={colors[role]}
      paddingLeft={1}
      flexDirection="column"
      flexGrow={1}
    >
      {label !== undefined || time !== undefined || isQueued ? (
        <Box flexDirection="row" gap={1}>
          {label !== undefined ? (
          <ThemedText color={colors[role]} bold>
            {label.toUpperCase()}
          </ThemedText>
          ) : null}
          {time ? (
            <ThemedText color="inactive">{time}</ThemedText>
          ) : isQueued ? (
            <ThemedText color="inactive">queued</ThemedText>
          ) : null}
        </Box>
      ) : null}
      <ContentWidthProvider width={contentWidth}>
        <Content color="text2">{children}</Content>
      </ContentWidthProvider>
    </ThemedBox>
  )
}

export function Tool({
  kind,
  label,
  state = 'done',
  args,
  result,
  detail,
  expanded = false,
  time,
}: {
  readonly kind: ToolKind
  readonly label?: string
  readonly state?: ToolState
  readonly args: string
  /**
   * Continuation content rendered under the call row behind a `⎿` gutter,
   * matching the industry-standard convention. A string is split on newlines
   * and each line gets its own row (gutter on the first, indented after); a
   * ReactNode is rendered verbatim inside the gutter column (used for compact
   * inline diffs).
   */
  readonly result?: string | ReactNode
  readonly detail?: ReactNode
  readonly expanded?: boolean
  readonly time?: string
}): React.ReactNode {
  const color = state === 'failed' ? 'error' : state === 'queued' ? 'inactive' : toolColor[kind]
  // The detail box below indents its content by `marginLeft={2}` + the
  // `borderLeft` rule (1) + `paddingLeft={1}` = 4 columns. An embedded
  // `DiffInline` therefore has exactly `inheritedContentWidth − 4` columns to
  // fill; surface that exact width so the diff sizes its code cell
  // deterministically instead of relying on Yoga flex rounding.
  const inheritedWidth = useContentWidth()
  const detailContentWidth = insetContentWidth(inheritedWidth, DIFF_INLINE_DETAIL_INSET_COLS)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {/*
          The leading glyph and bold tool label must NEVER shrink: every
          ink-text node defaults to flexShrink:1, so under arg overflow Yoga
          would otherwise squeeze the glyph + label down too, collapsing the
          `gap={1}` space (the glyph touches the label — `●Run`) and doubling
          the trailing space. Pinning each in a flexShrink={0} Box keeps
          `● Run` intact and forces all shrinkage onto the args text below.
        */}
        <Box flexShrink={0}>
          <ThemedText color={color}>{toolGlyph[state]}</ThemedText>
        </Box>
        <Box flexShrink={0}>
          <ThemedText color={toolColor[kind]} bold>
            {label ?? capitalize(kind)}
          </ThemedText>
        </Box>
        {/*
          The parenthesized args render as a single gap={0} unit so the parens
          hug the argument (`Write (index.html)`) instead of the outer gap={1}
          inserting a stray space on the inside of each paren (`Write ( index.html )`).
          The single space between the bold tool label and the opening paren is
          still supplied by the parent row's gap={1}.

          The whole group shrinks (flexShrink={1} minWidth={0}), but only the
          inner args text gives way: both parens are pinned flexShrink={0} so
          the opening `(` is never dropped and the closing `)` always survives,
          while the args text truncates in the middle. Without this, Yoga shrank
          the parens too and dropped the opening `(` while keeping the close `)`.
        */}
        <Box flexDirection="row" gap={0} flexShrink={1} minWidth={0}>
          <Box flexShrink={0}>
            <ThemedText color="inactive">(</ThemedText>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <ThemedText color="text2" wrap="truncate-middle">
              {args}
            </ThemedText>
          </Box>
          <Box flexShrink={0}>
            <ThemedText color="inactive">)</ThemedText>
          </Box>
        </Box>
        {time ? <ThemedText color="inactive">{time}</ThemedText> : null}
      </Box>
      {result != null && result !== '' ? (
        <ToolResultLines state={state}>{result}</ToolResultLines>
      ) : null}
      {expanded && detail ? (
        <ThemedBox
          flexDirection="column"
          marginLeft={2}
          paddingLeft={1}
          borderLeft
          borderLeftColor="lineSoft"
        >
          <DiffInlineWidthContext.Provider value={detailContentWidth}>
            {detail}
          </DiffInlineWidthContext.Provider>
        </ThemedBox>
      ) : null}
    </Box>
  )
}

/**
 * Renders the `⎿`-gutter continuation block under a tool call row. A ReactNode
 * child (e.g. a compact diff) is placed verbatim in the gutter column; a string
 * is split on newlines so the gutter glyph sits on the first line and following
 * lines indent to align under it — matching common CLI-agent output.
 */
function ToolResultLines({
  state,
  children,
}: {
  readonly state: ToolState
  readonly children: string | ReactNode
}): React.ReactNode {
  const color: ThemeColor = state === 'failed' ? 'error' : 'subtle'
  if (typeof children !== 'string') {
    return (
      <Box flexDirection="row" paddingLeft={1} gap={1}>
        <ThemedText color="muted3">⎿</ThemedText>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    )
  }
  const lines = children.split('\n')
  return (
    <Box flexDirection="row" paddingLeft={1} gap={1}>
      <ThemedText color="muted3">⎿</ThemedText>
      <Box flexDirection="column" flexGrow={1}>
        {lines.map((line, index) => (
          <ThemedText key={index} color={color} wrap="wrap">
            {line === '' ? ' ' : line}
          </ThemedText>
        ))}
      </Box>
    </Box>
  )
}

export function PlanList({
  items,
  title = 'plan',
  dense = false,
  gapAfterActive = false,
  headerPaddingX = 1,
}: {
  readonly title?: string
  readonly dense?: boolean
  readonly gapAfterActive?: boolean
  readonly headerPaddingX?: number
  readonly items: readonly {
    readonly state: 'done' | 'active' | 'pending' | 'failed'
    readonly text: string
  }[]
}): React.ReactNode {
  const done = items.filter(item => item.state === 'done').length
  return (
    <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft">
      <ThemedBox flexDirection="row" paddingX={headerPaddingX} borderBottom borderBottomColor="lineSoft">
        <ThemedText color="subtle">{title.toUpperCase()}</ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="inactive">
          {done} / {items.length}
        </ThemedText>
      </ThemedBox>
      <Box flexDirection="column" paddingX={1} paddingY={dense ? 0 : 1}>
        {items.map((item, index) => {
          const glyph = AURA_PLAN_GLYPHS[item.state]
          const color: ThemeColor = {
            done: 'success',
            active: 'agenc',
            pending: 'inactive',
            failed: 'error',
          }[item.state] as ThemeColor
          const row = (
            <Box key={`row-${index}`} flexDirection="row" gap={1}>
              <ThemedText color="muted3">{String(index + 1).padStart(2, '0')}</ThemedText>
              <ThemedText color={color}>{glyph}</ThemedText>
              <ThemedText
                color={item.state === 'done' || item.state === 'pending' ? 'subtle' : 'text2'}
                strikethrough={item.state === 'done'}
                wrap="truncate-end"
              >
                {item.text}
              </ThemedText>
            </Box>
          )
          if (gapAfterActive && item.state === 'active' && index < items.length - 1) {
            return (
              <React.Fragment key={index}>
                {row}
                <Box height={1} />
              </React.Fragment>
            )
          }
          return row
        })}
      </Box>
    </ThemedBox>
  )
}

export function DiffInline({
  file,
  stats,
  lines,
  op = 'DIFF',
}: {
  readonly file: string
  readonly stats?: string
  readonly lines: readonly {
    readonly kind: 'add' | 'rem' | 'ctx' | 'hunk'
    readonly oldLine?: string
    readonly newLine?: string
    readonly code: string
  }[]
  /**
   * Header verb. Distinguishes a first-write CREATE from an EDIT so the user can
   * tell "made a new file" from "changed an existing one" — the diff body looks
   * identical otherwise. Defaults to the neutral 'DIFF' for the approval-preview
   * and any caller that doesn't know the operation.
   */
  readonly op?: string
}): React.ReactNode {
  // When a render context supplies the box's exact outer width (the transcript
  // DIFF card), size the code cell deterministically instead of leaving it to
  // Yoga flex. Yoga's flex rounding occasionally lands ±1 col off, which made an
  // at-width code line either ellipsize one char too early OR spill its last
  // char past the right border (two identically-sized boxes rendering the same
  // line differently). Pinning `width={codeCellWidth}` on the code cell and
  // pre-truncating the text to that same width removes the rounding entirely.
  const explicitBoxWidth = React.useContext(DiffInlineWidthContext)
  const codeCellWidth =
    explicitBoxWidth !== null ? diffInlineCodeCellWidth(explicitBoxWidth) : null
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="lineSoft"
      {...(explicitBoxWidth !== null ? { width: explicitBoxWidth } : {})}
    >
      <ThemedBox flexDirection="row" paddingX={1} borderBottom borderBottomColor="lineSoft" gap={1}>
        <ThemedText color="subtle">{op}</ThemedText>
        <ThemedText color="text2" wrap="truncate-middle">{file}</ThemedText>
        <Box flexGrow={1} />
        {stats ? <ThemedText color="subtle">{stats}</ThemedText> : null}
      </ThemedBox>
      <Box flexDirection="column">
        {lines.map((line, index) => {
          const bg =
            line.kind === 'add'
              ? 'successWash'
              : line.kind === 'rem'
                ? 'errorWash'
                : line.kind === 'hunk'
                  ? 'agencWash'
                  : undefined
          const sigil = { add: '+', rem: '-', ctx: ' ', hunk: '@' }[line.kind]
          const sigilColor: ThemeColor =
            line.kind === 'add'
              ? 'success'
              : line.kind === 'rem'
                ? 'error'
                : line.kind === 'hunk'
                  ? 'agenc'
                  : 'muted3'
          const codeColor: ThemeColor =
            line.kind === 'add'
              ? 'success'
              : line.kind === 'rem'
                ? 'error'
                : line.kind === 'hunk'
                  ? 'agenc'
                  : 'text2'
          return (
            // The gutter cells (old/new line nums + sigil) are fixed-width and
            // must never shrink; only the code cell flexes and truncates. Without
            // flexShrink={0} on the gutter and minWidth={0} on the code cell, a
            // wide code line lets Yoga squeeze the gutter (eating a pad space)
            // and wrap the row, which silently drops the truncation marker.
            <ThemedBox key={index} flexDirection="row" backgroundColor={bg} paddingX={1}>
              <Box flexShrink={0}>
                <ThemedText color="muted3">{(line.oldLine ?? '').padStart(4, ' ')}</ThemedText>
              </Box>
              <Box flexShrink={0}>
                <ThemedText color="muted3">{(line.newLine ?? '').padStart(4, ' ')}</ThemedText>
              </Box>
              <Box flexShrink={0}>
                <ThemedText color={sigilColor}> {sigil} </ThemedText>
              </Box>
              {codeCellWidth !== null ? (
                // Deterministic path: the cell is a fixed `codeCellWidth` wide and
                // never flexes, and the code is PRE-TRUNCATED to that exact width
                // with the same `truncate-end` helper the text node would use — so
                // the visible result cannot depend on Yoga rounding. A line at or
                // under the width passes through unchanged (truncate is a no-op),
                // so short lines still render in full.
                <Box flexShrink={0} width={codeCellWidth}>
                  <ThemedText color={codeColor} wrap="truncate-end">
                    {wrapText(line.code, codeCellWidth, 'truncate-end')}
                  </ThemedText>
                </Box>
              ) : (
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <ThemedText color={codeColor} wrap="truncate-end">{line.code}</ThemedText>
                </Box>
              )}
            </ThemedBox>
          )
        })}
      </Box>
    </ThemedBox>
  )
}

/**
 * A bounded diff/content preview shown INSIDE the approval popup so a Write/Edit
 * is never approved blind. Shaped like the `buildEditDiffPreview` output (which
 * the post-approval DIFF card also consumes) so the same `DiffInline` primitive
 * and diff engine are reused — no new diff logic lives here.
 */
export interface ApprovalDiffPreview {
  readonly file: string
  readonly stats: string
  readonly lines: readonly {
    readonly kind: 'add' | 'rem' | 'ctx' | 'hunk'
    readonly oldLine?: string
    readonly newLine?: string
    readonly code: string
  }[]
  /** Rows dropped past the input cap, surfaced as a "… +N more" row. */
  readonly remaining: number
  /**
   * Header verb for the inline diff, matching the post-approval TRANSCRIPT card:
   * a first-write Write → 'CREATE', an Edit/MultiEdit → 'EDIT'. Optional so any
   * caller that doesn't know the operation falls back to the neutral 'DIFF'.
   */
  readonly op?: string
}

/**
 * Fixed (line-independent) rows the embedded `DiffInline` box ALWAYS draws,
 * regardless of how many diff lines it shows:
 *   - top border + bottom border (2)
 *   - the `CREATE/EDIT path +N -M` header (1)
 *   - the header's bottom separator border row (1)
 *   - the `… +N more · ctrl+w d` continuation row that a capped (always-capped
 *     for a real Write/Edit) diff appends (1)
 * The box can never render in fewer than these 5 rows PLUS at least one diff
 * body line.
 */
const DIFF_INLINE_FIXED_CHROME_ROWS = 5
/** Hard cap on inline diff lines so even a huge diff stays a compact preview. */
const APPROVAL_PREVIEW_LINE_CAP = 7
/**
 * Essential popup body rows that must ALWAYS survive at the bottom of the body:
 * the summary line, the optional facts grid, the optional note, the
 * `[1]/[2]/[3]` action legend, and the confirm row. The popup clips its body
 * from the BOTTOM and the diff box renders ABOVE these rows, so the diff must be
 * shed BEFORE it can push the legend/confirm off the bottom edge — reserve all
 * of them up front.
 */
const APPROVAL_ESSENTIAL_BODY_ROWS = 5

/**
 * Decide whether the approval popup can show its embedded `DiffInline` preview
 * at a given body height, and if so how many diff lines fit.
 *
 * Two bugs this guards (BUG 1):
 *   1. Gating the preview on too small a budget let the popup body's
 *      `overflow:'hidden'` clip the box right after its header, leaving an
 *      UNTERMINATED box (top border + header, no body, no closing border).
 *   2. Even when the box closed, an under-reserved budget let the box push the
 *      `[1]/[2]/[3]` action legend + confirm row off the BOTTOM of the clipped
 *      body — shedding the PRIMARY action instead of the optional diff.
 * So the box's FULL fixed chrome (5 rows) + at least one diff line must fit
 * AFTER the essential body is reserved, or the preview is omitted entirely — the
 * `$ command`/path summary, `+N -M` stats, and `ctrl+w d for full diff`
 * affordance already cover the constrained case.
 *
 * Pure (no React) so the height/overflow decision is unit-testable in isolation.
 */
export function approvalDiffPreviewBudget(
  popupBodyRows: number,
  availableDiffLines: number,
): { readonly showPreview: boolean; readonly previewLineCap: number } {
  // Rows left for actual diff LINES after reserving the essential body and the
  // box's fixed chrome (borders + header + header separator + continuation row).
  const lineBudget =
    popupBodyRows - APPROVAL_ESSENTIAL_BODY_ROWS - DIFF_INLINE_FIXED_CHROME_ROWS
  if (availableDiffLines <= 0 || lineBudget < 1) {
    return { showPreview: false, previewLineCap: 0 }
  }
  const previewLineCap = Math.max(
    1,
    Math.min(APPROVAL_PREVIEW_LINE_CAP, lineBudget),
  )
  return { showPreview: true, previewLineCap }
}

export function ApprovalCard({
  risk,
  title,
  command,
  commandIsShell = true,
  facts,
  note,
  confirmLabel,
  diffPreview,
  requestId,
  requireTypedConfirmation = false,
  typedConfirmationValue = '',
  typedConfirmationTarget = 'yes',
}: {
  readonly risk: 'low' | 'high'
  readonly title: string
  readonly command: string
  /**
   * Whether `command` is an actual SHELL command (Run/Bash) that should carry
   * the `$ ` shell-prompt glyph, or a non-shell input — e.g. a Write/Edit
   * `file_path` — where a `$ ` would misread as a runnable command AND duplicate
   * the path already shown in the CREATE/EDIT diff header below. File tools pass
   * `false` to drop the prompt glyph (and the redundant path line entirely when a
   * diff header already names the file). Defaults to `true` so existing
   * command-card callers are unchanged.
   */
  readonly commandIsShell?: boolean
  readonly facts: readonly { readonly label: string; readonly value: string; readonly color?: ThemeColor }[]
  readonly note?: string
  readonly confirmLabel: string
  readonly diffPreview?: ApprovalDiffPreview
  /** Real permission-request id for the footer status slot. Optional: without
   *  one the slot stays empty rather than showing a decorative fake hex. */
  readonly requestId?: string
  readonly requireTypedConfirmation?: boolean
  readonly typedConfirmationValue?: string
  readonly typedConfirmationTarget?: string
}): React.ReactNode {
  const variant: BadgeVariant = risk === 'high' ? 'error' : 'accent'
  const primaryFact = facts[0]?.value ?? title
  const approvalSummary = `${risk === 'high' ? 'high-risk approval' : 'needs approval'} · ${primaryFact} · ${command} · ${confirmLabel}`
  // The approval popup is rendered into a fixed-height slot (the workbench
  // overlay row, or the modal context). Without a height cap the body grows
  // past the popup's own bottom border and bleeds onto the footer below it.
  // Cap the popup to the rows actually available and let Popup clip the body
  // with overflow:'hidden', so the popup can never paint past its border.
  const viewport = useModalOrTerminalSize(useTerminalSize())
  const viewportRows = Number.isFinite(viewport.rows)
    ? Math.max(1, Math.trunc(viewport.rows))
    : 24
  // Reserve rows for the status bar, the composer/footer beneath the overlay,
  // and the overlay's own top border; never let the popup own the whole screen.
  const reservedRows = 6
  const popupMaxHeight = Math.max(9, viewportRows - reservedRows)
  // The popup clips its body from the bottom, so the primary action line
  // ([1]/[2]/[3] + confirm) is the first thing lost when the slot is tight.
  // Popup chrome (border/header/footer) costs ~6 rows; the essential body rows
  // are summary, command, facts, the action legend and the confirm row (5). The
  // note is the one optional row — drop it before it can push the action out.
  const popupBodyRows = popupMaxHeight - 6
  const showNote = note !== undefined && note.length > 0 && popupBodyRows >= 6
  // When the slot is extremely tight, drop the secondary facts grid so the
  // primary action legend + confirm row are never the ones clipped away.
  const showFacts = popupBodyRows >= 5
  // The diff/content preview is the LARGEST optional block (a bordered DiffInline
  // box). The pure budget helper decides whether it fits (and how many diff
  // lines it may show) so the same decision is unit-testable without the
  // renderer; see `approvalDiffPreviewBudget`.
  const budget = approvalDiffPreviewBudget(
    popupBodyRows,
    diffPreview?.lines.length ?? 0,
  )
  const showPreview = diffPreview !== undefined && budget.showPreview
  const previewLineCap = showPreview ? budget.previewLineCap : 0
  let previewLines: ApprovalDiffPreview['lines'] = []
  if (showPreview && diffPreview !== undefined) {
    const shown = diffPreview.lines.slice(0, previewLineCap)
    // Total rows hidden = rows dropped by THIS cap + rows the upstream builder
    // already collapsed. Keep one continuation row to state the affordance.
    const droppedHere = diffPreview.lines.length - shown.length
    const hidden = droppedHere + diffPreview.remaining
    previewLines =
      hidden > 0
        ? [
            ...shown,
            {
              kind: 'ctx' as const,
              code: `… +${hidden} more ${hidden === 1 ? 'line' : 'lines'} · ctrl+w d for full diff`,
            },
          ]
        : shown
  }
  return (
    <Popup
      title={title}
      headerRight={
        requireTypedConfirmation
          ? `${typedConfirmationValue.length > 0 ? typedConfirmationValue : ' '} / ${typedConfirmationTarget}`
          : 'esc to close'
      }
      status={requestId === undefined ? undefined : `req ${requestId}`}
      accentColor={variantColor[variant]}
      bodyBackgroundColor={risk === 'high' ? 'errorWash' : 'successWash'}
      bodyPaddingY={0}
      maxHeight={popupMaxHeight}
      minHeight={Math.min(9, popupMaxHeight)}
      footer={
        // Only real affordances go here — there is no `e` handler, so the old
        // `e edit command` hint sent users to a dead key.
        requireTypedConfirmation
          ? [{ keyName: 'type', label: 'confirmation required' }]
          : []
      }
    >
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        <ThemedText color="text2" wrap="truncate-end">
          {approvalSummary}
        </ThemedText>
        {commandIsShell ? (
          // A real shell command (Run/Bash): show it behind the `$ ` prompt glyph.
          <ThemedText color="text2" wrap="truncate-end">
            $ {command}
          </ThemedText>
        ) : showPreview ? null : (
          // A non-shell input (a Write/Edit file_path). Never prefix it with the
          // `$ ` shell-prompt marker — it would misread as a runnable command.
          // When the embedded diff is shown its CREATE/EDIT header already names
          // the file, so this line is redundant and omitted (the `showPreview`
          // branch above); only surface the bare path when no diff is rendered.
          <ThemedText color="text2" wrap="truncate-end">
            {command}
          </ThemedText>
        )}
        {showPreview && diffPreview !== undefined ? (
          <Box flexShrink={1} overflow="hidden">
            <DiffInline
              file={diffPreview.file.length > 0 ? diffPreview.file : 'file'}
              stats={diffPreview.stats}
              lines={previewLines}
              {...(diffPreview.op !== undefined ? { op: diffPreview.op } : {})}
            />
          </Box>
        ) : null}
        {showFacts ? (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {facts.map(fact => (
              // Mirror the DiffInline gutter/code-cell split: the LABEL is a
              // fixed cell (flexShrink={0}) so its text + the inter-cell gap are
              // never squeezed, and ONLY the VALUE flexes/truncates. Without the
              // pinned label, a long value (e.g. a `call_…` request id) made Yoga
              // eat the gap and drop the label's last char to a stray wrap row
              // (`REQUEScall_…` + a lone `T`). truncate-middle keeps a long call
              // id's `call_` prefix + trailing chars instead of just the head.
              <Box
                key={fact.label}
                flexDirection="row"
                gap={1}
                width={fact.label === 'network' || fact.label === 'net' ? 30 : 22}
              >
                <Box flexShrink={0}>
                  <ThemedText color="muted3">{fact.label.toUpperCase()}</ThemedText>
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  <ThemedText color={fact.color ?? 'text2'} wrap="truncate-middle">
                    {fact.value}
                  </ThemedText>
                </Box>
              </Box>
            ))}
          </Box>
        ) : null}
        {showNote ? (
          <ThemedText color="muted3" wrap="truncate-end">
            note · {note}
          </ThemedText>
        ) : null}
        {requireTypedConfirmation ? (
          <Box flexDirection="row" gap={1}>
            <ThemedText color={typedConfirmationValue === typedConfirmationTarget ? 'agenc' : 'text2'}>
              {typedConfirmationValue.length > 0 ? typedConfirmationValue : ' '}
            </ThemedText>
            <ThemedText color="muted3">/ {typedConfirmationTarget}</ThemedText>
          </Box>
        ) : (
          <ThemedText color="muted3" wrap="truncate-end">[1] approve once · [2] approve for session · [3] deny</ThemedText>
        )}
        <Box flexDirection="row" gap={2}>
          <ThemedText color="agenc" wrap="truncate-end">▸ {confirmLabel}</ThemedText>
          <KeyHint k="esc" label="cancel" />
        </Box>
      </Box>
    </Popup>
  )
}

export type PopupFooterItem = {
  readonly keyName: string
  readonly label: string
}

export function Popup({
  title,
  headerRight = 'esc to close',
  status,
  footer = [],
  children,
  accentColor = 'agenc',
  bodyBackgroundColor,
  bodyPaddingX = 2,
  bodyPaddingY = 1,
  maxHeight,
  minHeight,
}: {
  readonly title: string
  readonly headerRight?: string
  readonly status?: string
  readonly footer?: readonly PopupFooterItem[]
  readonly children: ReactNode
  readonly accentColor?: ThemeColor
  readonly bodyBackgroundColor?: ThemeColor
  readonly bodyPaddingX?: number
  readonly bodyPaddingY?: number
  readonly maxHeight?: number
  readonly minHeight?: number
}): React.ReactNode {
  const resolvedMinHeight = minHeight ?? 18
  const shouldConstrainHeight = maxHeight !== undefined
  return (
    <ThemedBox
      flexDirection="column"
      backgroundColor="lineSoft"
      overflow={shouldConstrainHeight ? 'hidden' : undefined}
    >
      <ThemedBox
        flexDirection="column"
        borderStyle="single"
        borderColor="line"
        backgroundColor="clawd_background"
        overflow={shouldConstrainHeight ? 'hidden' : undefined}
        maxHeight={maxHeight}
        minHeight={resolvedMinHeight}
      >
        <ThemedBox flexDirection="row" borderBottom borderBottomColor="lineSoft" paddingX={1} gap={1} flexShrink={0}>
          <ThemedText color={accentColor}>✳</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{title.toUpperCase()}</ThemedText>
          <Box flexGrow={1} />
          <ThemedText color="muted3" wrap="truncate-end">{headerRight}</ThemedText>
        </ThemedBox>
        <ThemedBox
          flexDirection="column"
          backgroundColor={bodyBackgroundColor}
          paddingX={bodyPaddingX}
          paddingY={bodyPaddingY}
          flexShrink={shouldConstrainHeight ? 1 : undefined}
          overflow={shouldConstrainHeight ? 'hidden' : undefined}
        >
          {children}
        </ThemedBox>
        <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={1} gap={2} flexShrink={0}>
          {footer.map(item => (
            <KeyHint key={item.keyName} k={item.keyName} label={item.label} />
          ))}
          <Box flexGrow={1} />
          {status ? <ThemedText color="muted3" wrap="truncate-end">{status}</ThemedText> : null}
        </ThemedBox>
      </ThemedBox>
    </ThemedBox>
  )
}

export function MenuModal<T>({
  title,
  count,
  summary,
  headerRight,
  columns,
  headers,
  items,
  activeIndex = 0,
  renderRow,
  preview,
  previewWidth,
  footer,
  hint,
  omitTopBorder = false,
  paddingX = 1,
  columnGap = 1,
  modalMinHeight,
  rowMinHeight = 1,
}: {
  readonly title: string
  readonly count?: string
  readonly summary?: string
  readonly headerRight?: string
  readonly columns: readonly number[]
  readonly headers: readonly string[]
  readonly items: readonly T[]
  readonly activeIndex?: number
  readonly renderRow: (item: T, index: number, active: boolean) => readonly ReactNode[]
  readonly preview?: ReactNode
  readonly previewWidth?: `${number}%`
  readonly footer: readonly { readonly keyName: string; readonly label: string }[]
  readonly hint?: string
  readonly omitTopBorder?: boolean
  readonly paddingX?: number
  readonly columnGap?: number
  readonly modalMinHeight?: number
  readonly rowMinHeight?: number
}): React.ReactNode {
  const resolvedPreviewWidth = previewWidth ?? '40%'
  const resolvedListWidth = preview
    ? `${100 - Number.parseInt(resolvedPreviewWidth, 10)}%` as `${number}%`
    : undefined
  const viewport = useModalOrTerminalSize(useTerminalSize())
  const viewportRows = Number.isFinite(viewport.rows)
    ? Math.max(1, Math.trunc(viewport.rows))
    : 24
  const rowHeight = Math.max(1, rowMinHeight)
  const chromeRows = (omitTopBorder ? 1 : 2) + 3
  const maxVisibleItems = Math.max(
    1,
    Math.floor(Math.max(1, viewportRows - chromeRows) / rowHeight),
  )
  const visibleCount = Math.min(items.length, maxVisibleItems)
  const clampedActiveIndex = Math.max(0, Math.min(activeIndex, Math.max(0, items.length - 1)))
  const windowStart = Math.min(
    Math.max(0, clampedActiveIndex - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount),
  )
  const visibleItems = items.slice(windowStart, windowStart + visibleCount)
  const windowEnd = windowStart + visibleItems.length
  const scrollStatus =
    items.length > visibleItems.length
      ? `scroll ${windowStart + 1}-${windowEnd}/${items.length}`
      : undefined
  const constrainedMinHeight =
    modalMinHeight === undefined ? undefined : Math.min(modalMinHeight, viewportRows)
  const popupStatus = [headerRight, scrollStatus, hint].filter(Boolean).join(' · ')
  const popupTitle = [title, count, summary].filter(Boolean).join(' · ')

  return (
    <Popup
      title={popupTitle}
      status={popupStatus || undefined}
      footer={footer}
      bodyPaddingX={paddingX}
      bodyPaddingY={0}
      maxHeight={viewportRows}
      minHeight={constrainedMinHeight}
    >
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box
          flexDirection="column"
          flexGrow={preview ? 0 : 1}
          width={resolvedListWidth}
          overflow="hidden"
        >
          <Box flexDirection="row" paddingX={paddingX} gap={columnGap}>
            {headers.map((header, index) => (
              <ThemedText key={`${index}-${header}`} color="inactive" wrap="truncate-end">
                {header.padEnd(columns[index] ?? header.length, ' ')}
              </ThemedText>
            ))}
          </Box>
          {visibleItems.map((item, visibleIndex) => {
            const index = windowStart + visibleIndex
            const active = index === clampedActiveIndex
            const cells = renderRow(item, index, active)
            return (
              <ThemedBox
                key={index}
                flexDirection="row"
                backgroundColor={active ? 'agencWash' : undefined}
                paddingX={paddingX}
                gap={columnGap}
                minHeight={rowMinHeight}
              >
                {cells.map((cell, cellIndex) => (
                  <Box key={cellIndex} width={columns[cellIndex]} overflow="hidden">
                    {cell}
                  </Box>
                ))}
              </ThemedBox>
            )
          })}
        </Box>
        {preview ? (
          <ThemedBox
            flexDirection="column"
            borderLeft
            borderLeftColor="lineSoft"
            width={resolvedPreviewWidth}
            paddingX={paddingX}
            overflow="hidden"
          >
            {preview}
          </ThemedBox>
        ) : null}
      </Box>
    </Popup>
  )
}

export function SlashPalette({
  items,
  activeCommand,
  filter,
  totalCount = items.length,
  maxVisible = 12,
  offsetTop = 0,
  headerRightInset = 2,
}: {
  readonly items: readonly SlashPaletteItem[]
  readonly activeCommand: string
  readonly filter?: string
  readonly totalCount?: number
  readonly maxVisible?: number
  readonly offsetTop?: number
  readonly headerRightInset?: number
}): React.ReactNode {
  const visible = items.slice(0, maxVisible)
  const hidden = Math.max(0, totalCount - visible.length)
  const cadenceAfterIndexes = new Set(hidden > 0 ? [0, 3, 5, 7, 9] : [])
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="lineSoft"
      backgroundColor="clawd_background"
      overflow="hidden"
      position={offsetTop === 0 ? undefined : 'relative'}
      top={offsetTop === 0 ? undefined : offsetTop}
    >
      <ThemedBox
        flexDirection="row"
        paddingX={2}
        borderBottom={hidden === 0}
        borderBottomColor="lineSoft"
      >
        <ThemedText color="subtle" wrap="truncate-end">
          {filter ? `matches · ${items.length}` : `slash commands · ${totalCount}`}
        </ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-end">
          ↑↓ navigate · ⏎ run · esc dismiss
        </ThemedText>
        {headerRightInset > 0 ? <Box width={headerRightInset} /> : null}
      </ThemedBox>
      {visible.map((item, index) => {
        const active = item.command === activeCommand
        const isAgenc = item.description.startsWith('agenc · ')
        const description = item.description.replace(/^agenc · /u, '')
        const addSourceCadenceRow = cadenceAfterIndexes.has(index)
        return (
          <React.Fragment key={item.command}>
            <ThemedBox
              flexDirection="row"
              backgroundColor={active ? 'agencWash' : undefined}
              paddingX={2}
              gap={2}
            >
              <Box width={2} flexShrink={0}>
                <ThemedText color={isAgenc ? 'worker' : 'muted3'}>
                  {isAgenc ? '◆' : '·'}
                </ThemedText>
              </Box>
              <Box width={17} flexShrink={0}>
                <ThemedText color={active ? 'agenc' : 'text2'} wrap="truncate-end">
                  {item.command}
                </ThemedText>
              </Box>
              <Box width={19} flexShrink={0}>
                <ThemedText color="inactive" wrap="truncate-end">
                  {item.args}
                </ThemedText>
              </Box>
              <ThemedText color={active ? 'text2' : 'subtle'} wrap="truncate-end">
                {description}
              </ThemedText>
            </ThemedBox>
            {addSourceCadenceRow ? <Box minHeight={1} /> : null}
          </React.Fragment>
        )
      })}
      {hidden > 0 ? (
        <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={2}>
          <ThemedText color="inactive">{`+ ${hidden} more · ↓ to scroll`}</ThemedText>
          <Box flexGrow={1} />
          <ThemedText color="worker">◆</ThemedText>
          <ThemedText color="inactive"> agenc ·  core</ThemedText>
          <Box width={1} />
        </ThemedBox>
      ) : null}
    </ThemedBox>
  )
}

export function ProtocolEvent({
  kind,
  title,
  body,
  facts = [],
}: {
  readonly kind: 'claim' | 'settle' | 'slash' | 'stake'
  readonly title: string
  readonly body: ReactNode
  readonly facts?: readonly { readonly label: string; readonly value: string; readonly color?: ThemeColor }[]
}): React.ReactNode {
  const variant: BadgeVariant =
    kind === 'settle' ? 'success' : kind === 'slash' ? 'error' : 'worker'
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor={variantColor[variant]}
      backgroundColor={variantWash[variant]}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <ThemedText color={variantColor[variant]} bold>
        {kind === 'settle' ? '✓' : kind === 'slash' ? '✕' : '◆'} {title}
      </ThemedText>
      <Content color="text2">{body}</Content>
      {facts.length > 0 ? (
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {facts.map(fact => (
            <Box key={fact.label} flexDirection="column">
              <ThemedText color="inactive">{fact.label.toUpperCase()}</ThemedText>
              <ThemedText color={fact.color ?? 'text2'}>{fact.value}</ThemedText>
            </Box>
          ))}
        </Box>
      ) : null}
    </ThemedBox>
  )
}
