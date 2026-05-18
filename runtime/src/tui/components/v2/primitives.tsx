import type { ReactNode } from 'react'
import React from 'react'
import type { PermissionMode } from '../../../permissions/types.js'
import type { Theme } from '../../../utils/theme.js'
import Box from '../../ink/components/Box.js'
import ThemedBox from '../design-system/ThemedBox.js'
import ThemedText from '../design-system/ThemedText.js'

type ThemeColor = keyof Theme

const TerminalFrameColumnsContext = React.createContext(120)

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

const toolGlyph: Record<ToolState, string> = {
  queued: '○',
  running: '◐',
  done: '●',
  failed: '✕',
}

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
    <Box flexDirection="row" gap={1} flexShrink={0}>
      <ThemedText color="muted3">[</ThemedText>
      <ThemedText color="agenc">{k}</ThemedText>
      <ThemedText color="muted3">]</ThemedText>
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
}: {
  readonly label: string
  readonly value: string
  readonly color?: ThemeColor
}): React.ReactNode {
  return (
    <Box flexDirection="row">
      <ThemedText color="inactive">{label.toUpperCase()} </ThemedText>
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
  return (
    <ThemedBox
      flexDirection="row"
      backgroundColor={variantWash[variant] ?? 'agencWash'}
      borderTop
      borderTopColor={color}
      paddingX={1}
      gap={2}
      minHeight={1}
      flexShrink={0}
    >
      {left.map((segment, index) => (
        <React.Fragment key={`left-${index}`}>{segment}</React.Fragment>
      ))}
      <Box flexGrow={1} />
      {(right ?? []).map((segment, index) => (
        <React.Fragment key={`right-${index}`}>{segment}</React.Fragment>
      ))}
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
}: {
  readonly text?: string
  readonly placeholder?: string
  readonly hint?: string
  readonly shellMode?: boolean
  readonly paused?: boolean
}): React.ReactNode {
  const color: ThemeColor = shellMode ? 'worker' : paused ? 'planMode' : 'agenc'
  return (
    <ThemedBox
      flexDirection="row"
      borderTop
      borderTopColor="lineSoft"
      backgroundColor={shellMode ? 'workerWash' : 'clawd_background'}
      paddingX={2}
      paddingTop={2}
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
  promptOverlay,
  contextLeft,
  contextRight,
  promptText,
  promptPlaceholder,
  promptHint,
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
  readonly promptOverlay?: ReactNode
  readonly contextLeft?: ReactNode
  readonly contextRight?: ReactNode
  readonly promptText?: string
  readonly promptPlaceholder?: string
  readonly promptHint?: string
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
              left={columns >= 120 ? 8 : 2}
              right={columns >= 120 ? 8 : 2}
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

const wordmarkLines = [
  '  ▄▄▄▄    ▄▄▄▄▄  ▄▄▄▄▄ ▄▄  ▄▄ ▄▄▄▄  ',
  ' ▐█▌▐█▌  ▐█ ▄ █ ▐█ ▄▄  ██▐█▌ ▐█ ▄ █ ',
  ' ▐█▌▐█▌  ▐█▀▀▄█ ▐█▀▀▀  ██▐█▌ ▐█ █▀█ ',
  ' ▐██▄██▌ ▐█▄▄▄█ ▐█▄▄▄  ██▐█▌ ▐█▄▄▄█ ',
] as const

const defaultWelcomeStats = [
  { label: 'IDENTITY', value: 'orchestrator', color: 'agenc' },
  { label: 'WALLET', value: '7nB4…q2Pe', color: 'text2' },
  { label: 'STAKE', value: '18.40 ◎', color: 'text2' },
  { label: 'REP', value: '412', color: 'text2' },
  { label: 'SLASHED', value: '0', color: 'subtle' },
] as const satisfies readonly {
  readonly label: string
  readonly value: string
  readonly color: ThemeColor
}[]

export function WelcomeColdPanel({
  version = '0.4.2',
  build = 'a7c1f4e',
  network = 'mainnet-beta',
  cwd = '~/work/tetsuo/swap-program',
  gitBranch = 'main',
  gitState = 'clean',
  stats = defaultWelcomeStats,
}: {
  readonly version?: string
  readonly build?: string
  readonly network?: string
  readonly cwd?: string
  readonly gitBranch?: string
  readonly gitState?: string
  readonly stats?: readonly {
    readonly label: string
    readonly value: string
    readonly color?: ThemeColor
  }[]
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {wordmarkLines.map(line => (
          <ThemedText key={line} color="agenc">
            {line}
          </ThemedText>
        ))}
      </Box>

      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <ThemedText color="subtle">agenc </ThemedText>
          <ThemedText color="text">{version}</ThemedText>
          <ThemedText color="muted3">· build  </ThemedText>
          <ThemedText color="text">{build}</ThemedText>
          <ThemedText color="muted3">· solana  </ThemedText>
          <ThemedText color="text">{network}</ThemedText>
        </Box>
        <Box minHeight={1} />
        <Box flexDirection="row" flexWrap="wrap">
          <ThemedText color="inactive">cwd </ThemedText>
          <ThemedText color="subtle" wrap="truncate-middle">
            {cwd}
          </ThemedText>
          <ThemedText color="inactive">· git </ThemedText>
          <ThemedText color="subtle">{gitBranch}</ThemedText>
          <ThemedText color="inactive">· {gitState}</ThemedText>
        </Box>
      </Box>

      <ThemedBox
        flexDirection="row"
        borderStyle="single"
        borderColor="lineSoft"
        backgroundColor="surfaceBackground"
        flexWrap="wrap"
      >
        {stats.map(stat => (
          <ThemedBox
            key={stat.label}
            flexDirection="column"
            minWidth={13}
            flexGrow={1}
            paddingX={1}
            paddingY={1}
          >
            <ThemedText color="inactive" wrap="truncate-end">
              {stat.label}
            </ThemedText>
            <ThemedText color={stat.color ?? 'text2'} wrap="truncate-end">
              {stat.value}
            </ThemedText>
          </ThemedBox>
        ))}
      </ThemedBox>

      <Box flexDirection="column">
        <ThemedText color="subtle">ready.</ThemedText>
        <Box flexDirection="row" flexWrap="wrap">
          <ThemedText color="inactive">type </ThemedText>
          <ThemedText color="agenc">/help</ThemedText>
          <ThemedText color="inactive">for commands ·  </ThemedText>
          <ThemedText color="agenc">/claim</ThemedText>
          <ThemedText color="inactive">to pick a task off the marketplace</ThemedText>
        </Box>
      </Box>
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
      borderStyle="single"
      borderColor="worker"
      backgroundColor="workerWash"
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <ThemedText color="worker">▸ TASK IN FLIGHT</ThemedText>
        <ThemedText color="subtle">
          {taskPda} · escrow {escrow}
        </ThemedText>
        <ThemedText color="worker">{deadline}</ThemedText>
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <ThemedText color="text">{taskId}</ThemedText>
        <ThemedText color="text2" wrap="truncate-end">
          {title}
        </ThemedText>
      </Box>
      <PlanList title="checkpointed plan" items={planItems} />
      <Box flexDirection="row" gap={2} flexWrap="wrap">
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
  readonly label: string
  readonly time?: string
  readonly children: ReactNode
}): React.ReactNode {
  const colors: Record<typeof role, ThemeColor> = {
    user: 'briefLabelYou',
    agenc: 'briefLabelAgenC',
    worker: 'briefLabelWorker',
    system: 'subtle',
  }
  return (
    <Box flexDirection="row" gap={2}>
      <ThemedText color={colors[role]}>{role === 'system' ? '∙' : '▮'}</ThemedText>
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" gap={1}>
          <ThemedText color={colors[role]} bold>
            {label.toUpperCase()}
          </ThemedText>
          {time ? <ThemedText color="inactive">{time}</ThemedText> : null}
        </Box>
        <Content color="text2">{children}</Content>
      </Box>
    </Box>
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
  readonly result?: string
  readonly detail?: ReactNode
  readonly expanded?: boolean
  readonly time?: string
}): React.ReactNode {
  const color = state === 'failed' ? 'error' : state === 'queued' ? 'inactive' : toolColor[kind]
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <ThemedText color={color}>{toolGlyph[state]}</ThemedText>
        <ThemedText color={toolColor[kind]} bold>
          {label ?? capitalize(kind)}
        </ThemedText>
        <ThemedText color="inactive">(</ThemedText>
        <ThemedText color="text2" wrap="truncate-middle">
          {args}
        </ThemedText>
        <ThemedText color="inactive">)</ThemedText>
        {time ? <ThemedText color="inactive">{time}</ThemedText> : null}
      </Box>
      {result ? (
        <Box flexDirection="row" paddingLeft={1} gap={1}>
          <ThemedText color="muted3">⎿</ThemedText>
          <ThemedText color={state === 'failed' ? 'error' : 'subtle'} wrap="wrap">
            {result}
          </ThemedText>
        </Box>
      ) : null}
      {expanded && detail ? (
        <ThemedBox
          flexDirection="column"
          marginLeft={2}
          paddingLeft={1}
          borderLeft
          borderLeftColor="lineSoft"
        >
          {detail}
        </ThemedBox>
      ) : null}
    </Box>
  )
}

export function PlanList({
  items,
  title = 'plan',
  dense = false,
}: {
  readonly title?: string
  readonly dense?: boolean
  readonly items: readonly {
    readonly state: 'done' | 'active' | 'pending' | 'failed'
    readonly text: string
  }[]
}): React.ReactNode {
  const done = items.filter(item => item.state === 'done').length
  return (
    <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft">
      <ThemedBox flexDirection="row" paddingX={1} borderBottom borderBottomColor="lineSoft">
        <ThemedText color="subtle">{title.toUpperCase()}</ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="inactive">
          {done} / {items.length}
        </ThemedText>
      </ThemedBox>
      <Box flexDirection="column" paddingX={1} paddingY={dense ? 0 : 1}>
        {items.map((item, index) => {
          const glyph = {
            done: '✓',
            active: '▮',
            pending: '·',
            failed: '✕',
          }[item.state]
          const color: ThemeColor = {
            done: 'success',
            active: 'agenc',
            pending: 'inactive',
            failed: 'error',
          }[item.state] as ThemeColor
          return (
            <Box key={index} flexDirection="row" gap={1}>
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
        })}
      </Box>
    </ThemedBox>
  )
}

export function DiffInline({
  file,
  stats,
  lines,
}: {
  readonly file: string
  readonly stats?: string
  readonly lines: readonly {
    readonly kind: 'add' | 'rem' | 'ctx' | 'hunk'
    readonly oldLine?: string
    readonly newLine?: string
    readonly code: string
  }[]
}): React.ReactNode {
  return (
    <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft">
      <ThemedBox flexDirection="row" paddingX={1} borderBottom borderBottomColor="lineSoft" gap={1}>
        <ThemedText color="subtle">DIFF</ThemedText>
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
            <ThemedBox key={index} flexDirection="row" backgroundColor={bg} paddingX={1}>
              <ThemedText color="muted3">{(line.oldLine ?? '').padStart(4, ' ')}</ThemedText>
              <ThemedText color="muted3">{(line.newLine ?? '').padStart(4, ' ')}</ThemedText>
              <ThemedText color={sigilColor}> {sigil} </ThemedText>
              <ThemedText color={codeColor} wrap="truncate-end">{line.code}</ThemedText>
            </ThemedBox>
          )
        })}
      </Box>
    </ThemedBox>
  )
}

export function ApprovalCard({
  risk,
  title,
  command,
  facts,
  note,
  confirmLabel,
  requireTypedConfirmation = false,
}: {
  readonly risk: 'low' | 'high'
  readonly title: string
  readonly command: string
  readonly facts: readonly { readonly label: string; readonly value: string; readonly color?: ThemeColor }[]
  readonly note?: string
  readonly confirmLabel: string
  readonly requireTypedConfirmation?: boolean
}): React.ReactNode {
  const variant: BadgeVariant = risk === 'high' ? 'error' : 'worker'
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor={variantColor[variant]}
      backgroundColor={variantWash[variant]}
    >
      <ThemedBox
        flexDirection="row"
        borderBottom
        borderBottomColor={variantColor[variant]}
        paddingX={1}
      >
        <ThemedText color={variantColor[variant]}>▸ tool · bash · {title}</ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="subtle">req {risk === 'high' ? '0x9c14' : '0x47a3'}</ThemedText>
      </ThemedBox>
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        <ThemedBox borderStyle="single" borderColor="lineSoft" paddingX={1}>
          <ThemedText color="text" wrap="wrap">
            $ {command}
          </ThemedText>
        </ThemedBox>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {facts.map(fact => (
            <Box
              key={fact.label}
              flexDirection="column"
              width={fact.label === 'network' || fact.label === 'net' ? 30 : 22}
            >
              <ThemedText color="inactive">{fact.label.toUpperCase()}</ThemedText>
              <ThemedText color={fact.color ?? 'text2'}>{fact.value}</ThemedText>
            </Box>
          ))}
        </Box>
        {note ? (
          <ThemedText color="subtle" wrap="wrap">
            note · {note}
          </ThemedText>
        ) : null}
        <Box flexDirection="row" gap={2}>
          <ThemedBox borderStyle="single" borderColor={variantColor[variant]} paddingX={1}>
            <ThemedText color={risk === 'high' ? 'text' : 'agenc'}>{confirmLabel}</ThemedText>
          </ThemedBox>
          <KeyHint k={requireTypedConfirmation ? 'type' : 'e'} label={requireTypedConfirmation ? 'confirmation required' : 'edit command'} />
          <KeyHint k="esc" label="cancel" />
        </Box>
      </Box>
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

  return (
    <ThemedBox
      flexDirection="column"
      borderStyle={omitTopBorder ? undefined : 'single'}
      borderLeft={omitTopBorder}
      borderRight={omitTopBorder}
      borderBottom={omitTopBorder}
      borderColor="agenc"
      borderLeftColor="agenc"
      borderRightColor="agenc"
      borderBottomColor="agenc"
      backgroundColor="clawd_background"
      overflow="hidden"
      minHeight={modalMinHeight}
    >
      <ThemedBox flexDirection="row" borderBottom borderBottomColor="agenc" paddingX={paddingX} gap={columnGap}>
        <Box flexShrink={0}>
          <ThemedText color="agenc" wrap="truncate-end">{title.toUpperCase()}</ThemedText>
        </Box>
        {count ? (
          <Box flexShrink={0}>
            <ThemedText color="text" wrap="truncate-end">{count}</ThemedText>
          </Box>
        ) : null}
        {summary ? <ThemedText color="subtle" wrap="truncate-end">{summary}</ThemedText> : null}
        <Box flexGrow={1} />
        {headerRight ? <ThemedText color="inactive" wrap="truncate-end">{headerRight}</ThemedText> : null}
      </ThemedBox>
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
          {items.map((item, index) => {
            const active = index === activeIndex
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
          >
            {preview}
          </ThemedBox>
        ) : null}
      </Box>
      <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={paddingX} gap={2}>
        {footer.map(item => (
          <KeyHint key={item.keyName} k={item.keyName} label={item.label} />
        ))}
        <Box flexGrow={1} />
        {hint ? <ThemedText color="inactive" wrap="truncate-end">{hint}</ThemedText> : null}
        <KeyHint k="esc" label="dismiss" />
      </ThemedBox>
    </ThemedBox>
  )
}

export function SlashPalette({
  items,
  activeCommand,
  filter,
  totalCount = items.length,
  maxVisible = 12,
}: {
  readonly items: readonly SlashPaletteItem[]
  readonly activeCommand: string
  readonly filter?: string
  readonly totalCount?: number
  readonly maxVisible?: number
}): React.ReactNode {
  const visible = items.slice(0, maxVisible)
  const hidden = Math.max(0, totalCount - visible.length)
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="lineSoft"
      backgroundColor="clawd_background"
      overflow="hidden"
    >
      <ThemedBox flexDirection="row" borderBottom borderBottomColor="lineSoft" paddingX={2}>
        <ThemedText color="subtle" wrap="truncate-end">
          {filter ? `matches · ${items.length}` : `slash commands · ${totalCount}`}
        </ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-end">
          ↑↓ navigate · ⏎ run · esc dismiss
        </ThemedText>
      </ThemedBox>
      {visible.map((item, index) => {
        const active = item.command === activeCommand
        const isAgenc = item.description.startsWith('agenc · ')
        const description = item.description.replace(/^agenc · /u, '')
        const addSourceCadenceRow = hidden > 0 && (index === 0 || index === 3)
        return (
          <React.Fragment key={item.command}>
            <ThemedBox
              flexDirection="row"
              backgroundColor={active ? 'agencWash' : undefined}
              borderLeft={active}
              borderLeftColor={active ? 'agenc' : undefined}
              paddingX={2}
              gap={2}
            >
              <Box width={2} flexShrink={0}>
                <ThemedText color={isAgenc ? 'worker' : 'muted3'}>
                  {isAgenc ? '◆' : '·'}
                </ThemedText>
              </Box>
              <Box width={18} flexShrink={0}>
                <ThemedText color={active ? 'agenc' : 'text2'} wrap="truncate-end">
                  {item.command}
                </ThemedText>
              </Box>
              <Box width={20} flexShrink={0}>
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
          <ThemedText color="inactive"> agenc · · core</ThemedText>
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
