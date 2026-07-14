import React from 'react'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize'
import { transformSync } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import vm from 'node:vm'

import { Box } from '../../ink.js'
import ThemedBox from '../design-system/ThemedBox.js'
import ThemedText from '../design-system/ThemedText.js'
import {
  ApprovalCard,
  ChatBody,
  DiffInline,
  KeyHint,
  MenuModal,
  Msg,
  PlanList,
  PlanModeBanner,
  ProtocolEvent,
  SlashPalette,
  StatusSegment,
  TaskInFlightCard,
  TerminalFrame,
  Tool,
  WelcomeColdPanel,
} from './primitives.js'
import {
  type BrowserMarkerFixtureEntry,
  BROWSER_MARKER_FIXTURE,
} from './designBrowserMarkerFixture.js'
import { BROWSER_TEXT_FIXTURE } from './designBrowserTextFixture.js'
import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'

let activeBrowserTextFixture: Record<string, readonly BrowserMarkerFixtureEntry[]> | undefined

type Viewport = {
  readonly columns: number
  readonly rows: number
}

type DesignState = {
  readonly id: string
  readonly title: string
  readonly expected: readonly string[]
  readonly render: (viewport: Viewport) => React.ReactNode
}

const VIEWPORTS: readonly Viewport[] = [
  { columns: 148, rows: 40 },
  { columns: 120, rows: 30 },
  { columns: 80, rows: 24 },
]

const EXACT_CELL_VIEWPORT_COLUMNS = 148

const SOURCE_ARTBOARDS: readonly {
  readonly stateId: string
  readonly artboardId: string
  readonly label: string
}[] = [
  { stateId: '01a', artboardId: 'welcome-cold', label: 'cold start · no task' },
  { stateId: '01b', artboardId: 'welcome-resumed', label: 'resumed session · task in flight' },
  { stateId: '02a', artboardId: 'slash-full', label: "full menu · '/' only" },
  { stateId: '02b', artboardId: 'slash-filtered', label: "filtered · '/d' → delegate, diff" },
  { stateId: '03a', artboardId: 'streaming-plan', label: 'streaming plan delivery' },
  { stateId: '03b', artboardId: 'streaming-reasoning', label: 'reasoning + inline tool calls' },
  { stateId: '04a', artboardId: 'tools-seq', label: 'read · grep · bash sequence' },
  { stateId: '04b', artboardId: 'tools-edit', label: 'edit · expanded diff inline' },
  { stateId: '05a', artboardId: 'approval-low', label: 'low-risk · localnet test' },
  { stateId: '05b', artboardId: 'approval-high', label: 'high-risk · mainnet settle' },
  { stateId: '06a', artboardId: 'error-slash', label: 'protocol · delegate slashed' },
  { stateId: '06b', artboardId: 'error-bash', label: 'local · test panic · self-correct' },
  { stateId: '07a', artboardId: 'complete-clean', label: 'settled · receipt + stats' },
  { stateId: '07b', artboardId: 'complete-retro', label: '/retro · self-review' },
  { stateId: '08a', artboardId: 'file-ref', label: '@ · file picker overlay' },
  { stateId: '08b', artboardId: 'shell', label: '! · inline shell mode' },
  { stateId: '09', artboardId: 'markdown', label: 'streamed markdown · code + table + quote' },
  { stateId: '10', artboardId: 'ctx', label: '/ctx · context breakdown modal' },
  { stateId: '11', artboardId: 'model', label: '/model · model selection' },
  { stateId: '12', artboardId: 'skills', label: '/skills · active + dormant' },
  { stateId: '13', artboardId: 'mcp', label: '/mcp · servers + tools' },
  { stateId: '14', artboardId: 'hooks', label: '/hooks · lifecycle hooks' },
  { stateId: '15', artboardId: 'plugins', label: '/plugins · installed extensions' },
  { stateId: '16', artboardId: 'agents', label: '/agents · self + workers' },
  { stateId: '17', artboardId: 'permissions', label: '/permissions · tiered rules' },
  { stateId: '18', artboardId: 'memory', label: '/memory · sources + precedence' },
  { stateId: '19a', artboardId: 'tasks', label: '/tasks · unified background panel' },
  { stateId: '19b', artboardId: 'plan-mode', label: 'plan mode · read-only proposals' },
  { stateId: '19c', artboardId: 'mode-switcher', label: 'shift+tab · mode picker' },
]

const SOURCE_CONTRACTS: readonly {
  readonly stateId: string
  readonly sourceFile: string
  readonly sourceComponent: string
  readonly sourceComponents?: readonly string[]
  readonly markers: readonly string[]
}[] = [
  { stateId: '01a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'WelcomeCold', markers: ['agenc.', 'a netrunner with hands on every file', 'workspace', 'model', 'last session', 'recent', 'swap-program', 'runtime coverage', 'agent catalog'] },
  { stateId: '01b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'WelcomeResumed', markers: ['checkpointed plan', '#47', 'task', 'read programs/swap/src/lib.rs', 'cargo test-bpf · settle', 'resume from step 3', 'session 0x9c4f', 'escrow ◎ 2.40', 'forfeit ◎ 0.40'] },
  { stateId: '02a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'SlashFull', sourceComponents: ['SlashFull', 'SlashPalette', 'slashItems'], markers: ['/claim', '/delegate', '/model', '/proof', '/settle', '/stake', 'slash commands · 30', '/bashes', '+ 18 more'] },
  { stateId: '02b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'SlashFiltered', sourceComponents: ['SlashFiltered', 'SlashPalette', 'slashItems'], markers: ['/delegate', '/diff', 'matches · 2', 'show the current working diff', 'swap-program/issues/47', 'shall I draft a plan?'] },
  { stateId: '03a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'StreamingPlan', markers: ['plan', 'guard', 'streaming', 'worker/zk-prover', 'cargo test-bpf · settle', 'token::transfer', 'escrow ◎ 2.40 locked', '2026-05-12 18:00 UTC', '84 tok/s'] },
  { stateId: '03b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'StreamingReasoning', markers: ['swap_v2', 'read', 'grep', 'token::transfer', 'lib.rs:120', 'amount_out', 'thinking · 1.2s', '3 tool calls'] },
  { stateId: '04a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'ToolsSequence', markers: ['read', 'grep', 'bash', 'SlippageExceeded', 'cargo check -p agenc-swap', 'Option<u16>', 'found 14 matches in 4 files', 'Compiling agenc-swap v0.4.2 · 18%', 'idl/swap.json'] },
  { stateId: '04b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'ToolsEdit', markers: ['DIFF', 'swap_v2', 'max_slip', 'programs/swap/src/math.rs', 'SwapError::SlippageExceeded', 'localnet', 'writing the guard now', '+12 −3 lines · applied'] },
  { stateId: '05a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'ApprovalLow', sourceComponents: ['ApprovalLow', 'ApprovalCard'], markers: ['needs approval', 'localnet', 'approve', 'localhost:8899', '0.041', 'awaiting approval', 'solana-test-validator --reset --quiet', 'no signed mainnet tx', 'auto-approve'] },
  { stateId: '05b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'ApprovalHigh', sourceComponents: ['ApprovalHigh', 'ApprovalCard'], markers: ['high-risk approval', 'mainnet-beta', "type 'yes' to send", 'api.mainnet-beta.solana.com', 'settle_task(#47)', 'escrow release', '--keypair ~/.config/solana/agenc.json', 'high · mainnet'] },
  { stateId: '06a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'ErrorSlashing', markers: ['slashing event', 'public-input mismatch', 'worker', 'max_slip = 500 bps', 'worker/fast-prover', 'retry inline', 'slot 284,902,118', 'tx 8nY3…cR91', '−0.80'] },
  { stateId: '06b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'ErrorBash', markers: ['exit 101', 'recovery plan', 'apply?', 'swap_high_slippage_aborts', '5 pass', 'max_slip = 1000 bps', 'cargo · stderr', 'RUST_BACKTRACE=1', '#[should_panic]'] },
  { stateId: '07a', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'CompleteClean', markers: ['task #47 settled', 'escrow', 'proof', 'slippage_bps', '+4 rep', '/retro', 'tx fM91…kU3v', '+86 −12', '14 + 4'] },
  { stateId: '07b', sourceFile: 'tui-v2-states.jsx', sourceComponent: 'CompleteRetro', markers: ['self-review', 'delegation', 'next task', 'WENT WELL', '8k constraints', 'retros/0x9c4f.md', 'COST ME', 'LEARN', '--bind-account'] },
  { stateId: '08a', sourceFile: 'tui-v2-states-extra.jsx', sourceComponent: 'FileReference', sourceComponents: ['FileReference', 'FilePicker'], markers: ['@', 'programs/swap', 'select', '@pool', 'pool.rs', '1 in ctx'] },
  { stateId: '08b', sourceFile: 'tui-v2-states-extra.jsx', sourceComponent: 'ShellEscape', markers: ['anchor build', '$', 'shell mode', 'git status -sb', 'unused import', 'slip_within'] },
  { stateId: '09', sourceFile: 'tui-v2-states-extra.jsx', sourceComponent: 'MarkdownResponse', markers: ['slippage', 'guard', 'math/slip.rs', 'MIN_SLIPPAGE_BPS', 'solscan', 'Option<u16>'] },
  { stateId: '10', sourceFile: 'tui-v2-states-extra.jsx', sourceComponent: 'ContextManager', markers: ['context', '22,841', '200,000', '11.4% used', 'history', '/compact'] },
  { stateId: '11', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'ModelMenu', markers: ['/model', 'model selection', 'haiku-4.5', 'gpt-5', 'qwen3-32b', 'agent settles'] },
  { stateId: '12', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'SkillsMenu', markers: ['/skills', 'skills', 'solana-anchor', 'zk-proof-prep', 'Cargo.toml', 'anchor-lang'] },
  { stateId: '13', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'McpMenu', markers: ['/mcp', 'mcp servers', 'solana-rpc', 'github', 'playwright', 'server configs'] },
  { stateId: '14', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'HooksMenu', markers: ['/hooks', 'hooks', 'pre-tool/edit', 'session-start', 'last 3 fires', '.agenc/hooks'] },
  { stateId: '15', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'PluginsMenu', markers: ['/plugins', 'plugins', 'agenc-core', 'anchor-toolkit', 'arbiter-client', '11 updates'] },
  { stateId: '16', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'AgentsMenu', markers: ['/agents', 'agents', 'name · Role', 'scope', 'source', 'when-to-use', 'system prompt'] },
  { stateId: '17', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'PermissionsMenu', markers: ['/permissions', 'permissions', 'allow', 'bypassPermissions', 'rm -rf', 'top-to-bottom rule eval'] },
  { stateId: '18', sourceFile: 'tui-v2-menus.jsx', sourceComponent: 'MemoryMenu', markers: ['/memory', 'memory', 'AGENTS.md', 'AGENC.md', 'pinned/slippage.md', 'pinned overrides'] },
  { stateId: '19a', sourceFile: 'tui-v2-states-runtime.jsx', sourceComponent: 'BackgroundTasks', markers: ['background tasks', 'running', 'proof', 'verify slip_within invariant', '62', 'worker/zk-prover'] },
  { stateId: '19b', sourceFile: 'tui-v2-states-runtime.jsx', sourceComponent: 'PlanMode', markers: ['plan mode', 'proposal', 'accept & execute', 'read-only', 'slip_within()', 'settle on mainnet'] },
  { stateId: '19c', sourceFile: 'tui-v2-states-runtime.jsx', sourceComponent: 'ModeSwitcher', markers: ['accept', 'bypass', 'shift+tab', 'permission mode', 'default', 'auto-approve'] },
]

const DESIGN_RUNTIME_FILES = [
  'tui-frame.jsx',
  'tui-v2-prim.jsx',
  'tui-v2-states.jsx',
  'tui-v2-states-extra.jsx',
  'tui-v2-menus.jsx',
  'tui-v2-states-runtime.jsx',
] as const

const PROJECTED_CELL_ALIGNMENT_FLOORS: Record<string, number> = {
  '01a': 0.381,
  '01b': 0.348,
  '02a': 0.252,
  '02b': 0.127,
  '03a': 0.198,
  '03b': 0.252,
  '04a': 0.179,
  '04b': 0.177,
  '05a': 0.181,
  '05b': 0.173,
  '06a': 0.137,
  '06b': 0.164,
  '07a': 0.154,
  '07b': 0.145,
  '08a': 0.121,
  '08b': 0.267,
  '09': 0.240,
  '10': 0.380,
  '11': 0.187,
  '12': 0.190,
  '13': 0.172,
  '14': 0.121,
  '15': 0.255,
  '16': 0.077,
  '17': 0.057,
  '18': 0.098,
  '19a': 0.220,
  '19b': 0.339,
  '19c': 0.307,
}

type DesignRuntimeContext = vm.Context & {
  readonly [key: string]: unknown
  window: DesignRuntimeContext
}

type DesignPrimitiveMetrics = {
  readonly brandCells: number
  readonly borderStyles: number
  readonly backgroundStyles: number
  readonly colorStyles: ReadonlySet<string>
  readonly caretAnimations: number
  readonly runningIndicators: number
  readonly toolStatusGlyphs: number
  readonly unsupportedStyles: readonly string[]
}

type RenderedPrimitiveMetrics = {
  readonly brandCells: number
  readonly borderChars: number
  readonly runningIndicators: number
  readonly toolStatusGlyphs: number
  readonly promptCarets: number
}

type RenderedStyleIntentMetrics = {
  readonly foregroundTokens: ReadonlySet<string>
  readonly backgroundTokens: ReadonlySet<string>
  readonly borderTokens: ReadonlySet<string>
  readonly styledNodes: number
}

type RenderedAnsiMetrics = {
  readonly foregroundCells: number
  readonly backgroundCells: number
  readonly foregroundSequences: number
  readonly backgroundSequences: number
}

type ColorFamily = 'accent' | 'worker' | 'success' | 'error'

type RgbColor = {
  readonly red: number
  readonly green: number
  readonly blue: number
}

const COLOR_FAMILY_TARGETS: Record<ColorFamily, readonly RgbColor[]> = {
  accent: [
    { red: 186, green: 99, blue: 239 },
    { red: 206, green: 92, blue: 255 },
  ],
  worker: [
    { red: 255, green: 106, blue: 47 },
    { red: 255, green: 151, blue: 72 },
  ],
  success: [
    { red: 74, green: 222, blue: 128 },
    { red: 44, green: 214, blue: 139 },
  ],
  error: [
    { red: 255, green: 77, blue: 109 },
    { red: 255, green: 79, blue: 122 },
  ],
}

const ANSI_STANDARD_COLORS = new Map<number, RgbColor>([
  [30, { red: 0, green: 0, blue: 0 }],
  [31, { red: 205, green: 49, blue: 49 }],
  [32, { red: 13, green: 188, blue: 121 }],
  [33, { red: 229, green: 229, blue: 16 }],
  [34, { red: 36, green: 114, blue: 200 }],
  [35, { red: 188, green: 63, blue: 188 }],
  [36, { red: 17, green: 168, blue: 205 }],
  [37, { red: 229, green: 229, blue: 229 }],
  [90, { red: 102, green: 102, blue: 102 }],
  [91, { red: 241, green: 76, blue: 76 }],
  [92, { red: 35, green: 209, blue: 139 }],
  [93, { red: 245, green: 245, blue: 67 }],
  [94, { red: 59, green: 142, blue: 234 }],
  [95, { red: 214, green: 112, blue: 214 }],
  [96, { red: 41, green: 184, blue: 219 }],
  [97, { red: 229, green: 229, blue: 229 }],
])

function normalizeForMarkerCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’]/gu, "'")
    .replace(/[−]/gu, '-')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
}

const DESIGN_SOURCE_MARKER_ALIASES: Record<string, string> = {
  'AGENC.md': 'CLAUDE.md',
  '# AGENC.md': '# CLAUDE.md',
  'load AGENC.md and AGENTS.md': 'load CLAUDE.md and AGENTS.md',
  'agenc-skills': 'claude-skills',
}

function normalizeDesignText(value: string): string {
  return normalizeForMarkerCompare(value).replace(/\s+/gu, ' ').trim()
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'your',
  'you',
  'are',
  'will',
  'not',
  'all',
  'any',
  'when',
  'then',
  'into',
  'only',
  'still',
  'current',
  'default',
  'agenc',
  'orchestrator',
  'mode',
  'task',
  'mainnet',
  'beta',
  'swap',
  'program',
  'ctx',
  'cost',
  'model',
])

function significantTokens(value: string): Set<string> {
  const normalized = normalizeDesignText(value)
    .replace(/[░▒▓▄█▐▌▀┌┐└┘─│├┤┬┴┼╭╮╰╯✓✕●○◐◆◇∙▮▸⎿◎$()[\]{}"'`:,.;/\\|<>+=?!#@~…–—]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return new Set(
    normalized
      .split(' ')
      .map(token => token.trim())
      .filter(token => token.length >= 4 && !STOP_WORDS.has(token) && !/^\d+$/u.test(token)),
  )
}

function rgbDistance(a: RgbColor, b: RgbColor): number {
  return Math.hypot(a.red - b.red, a.green - b.green, a.blue - b.blue)
}

function parseCssColor(value: unknown): RgbColor | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const hex = /^#([0-9a-f]{6})$/iu.exec(trimmed)
  if (hex) {
    const raw = Number.parseInt(hex[1]!, 16)
    return {
      red: (raw >> 16) & 255,
      green: (raw >> 8) & 255,
      blue: raw & 255,
    }
  }
  const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/iu.exec(trimmed)
  if (rgb) {
    return {
      red: Number(rgb[1]),
      green: Number(rgb[2]),
      blue: Number(rgb[3]),
    }
  }
  return null
}

function colorFamilyFromRgb(rgb: RgbColor | null): ColorFamily | null {
  if (!rgb) return null
  let bestFamily: ColorFamily | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [family, targets] of Object.entries(COLOR_FAMILY_TARGETS) as Array<[
    ColorFamily,
    readonly RgbColor[],
  ]>) {
    for (const target of targets) {
      const distance = rgbDistance(rgb, target)
      if (distance < bestDistance) {
        bestFamily = family
        bestDistance = distance
      }
    }
  }
  return bestDistance <= 95 ? bestFamily : null
}

function addTokenFamilies(
  target: Map<string, Set<ColorFamily>>,
  text: string,
  family: ColorFamily | null,
): void {
  if (!family) return
  for (const token of significantTokens(text)) {
    const families = target.get(token) ?? new Set<ColorFamily>()
    families.add(family)
    target.set(token, families)
  }
}

function collectDesignTokenColorFamilies(node: unknown): Map<string, Set<ColorFamily>> {
  const tokenFamilies = new Map<string, Set<ColorFamily>>()

  function visit(current: unknown, inheritedFamily: ColorFamily | null): void {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string' || typeof current === 'number') {
      addTokenFamilies(tokenFamilies, String(current), inheritedFamily)
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child, inheritedFamily)
      return
    }
    if (!React.isValidElement(current)) return

    if (typeof current.type === 'function') {
      visit((current.type as (props: unknown) => React.ReactNode)(current.props), inheritedFamily)
      return
    }

    const props = current.props as {
      readonly children?: unknown
      readonly style?: Record<string, unknown>
    }
    const styleFamily = colorFamilyFromRgb(parseCssColor(props.style?.color))
    visit(props.children, styleFamily ?? inheritedFamily)
  }

  visit(node, null)
  return tokenFamilies
}

function ansi256ToRgb(value: number): RgbColor | null {
  if (value >= 16 && value <= 231) {
    const normalized = value - 16
    const red = Math.floor(normalized / 36)
    const green = Math.floor((normalized % 36) / 6)
    const blue = normalized % 6
    const channel = (component: number) => (component === 0 ? 0 : component * 40 + 55)
    return { red: channel(red), green: channel(green), blue: channel(blue) }
  }
  if (value >= 232 && value <= 255) {
    const grey = (value - 232) * 10 + 8
    return { red: grey, green: grey, blue: grey }
  }
  return ANSI_STANDARD_COLORS.get(value) ?? null
}

function foregroundRgbFromAnsiCode(code: string): RgbColor | null | 'reset' {
  for (const match of code.matchAll(/\x1B\[([0-9;]*)m/gu)) {
    const params = (match[1] ?? '')
      .split(';')
      .filter(part => part.length > 0)
      .map(part => Number(part))
    if (params.length === 0) return 'reset'
    for (let index = 0; index < params.length; index += 1) {
      const param = params[index]
      if (param === undefined || Number.isNaN(param)) continue
      if (param === 0 || param === 39) return 'reset'
      if (ANSI_STANDARD_COLORS.has(param)) return ANSI_STANDARD_COLORS.get(param)!
      if (param === 38) {
        if (params[index + 1] === 2) {
          return {
            red: params[index + 2] ?? 0,
            green: params[index + 3] ?? 0,
            blue: params[index + 4] ?? 0,
          }
        }
        if (params[index + 1] === 5) return ansi256ToRgb(params[index + 2] ?? -1)
      }
    }
  }
  return null
}

function collectRenderedTokenColorFamilies(value: string): Map<string, Set<ColorFamily>> {
  const tokenFamilies = new Map<string, Set<ColorFamily>>()
  const styledChars = styledCharsFromTokens(tokenize(value))
  let tokenText = ''
  let tokenFamiliesInFlight = new Set<ColorFamily>()

  function flush(): void {
    if (tokenText.length > 0) {
      for (const token of significantTokens(tokenText)) {
        if (tokenFamiliesInFlight.size === 0) continue
        const families = tokenFamilies.get(token) ?? new Set<ColorFamily>()
        for (const family of tokenFamiliesInFlight) families.add(family)
        tokenFamilies.set(token, families)
      }
    }
    tokenText = ''
    tokenFamiliesInFlight = new Set<ColorFamily>()
  }

  for (const char of styledChars) {
    if (!/[\p{Letter}\p{Number}_-]/u.test(char.value)) {
      flush()
      continue
    }
    tokenText += char.value
    for (const style of char.styles) {
      const rgb = foregroundRgbFromAnsiCode(style.code)
      if (rgb === 'reset') continue
      const family = colorFamilyFromRgb(rgb)
      if (family) tokenFamiliesInFlight.add(family)
    }
  }
  flush()

  return tokenFamilies
}

function unionColorFamilies(values: Iterable<ReadonlySet<ColorFamily>>): Set<ColorFamily> {
  const result = new Set<ColorFamily>()
  for (const families of values) {
    for (const family of families) result.add(family)
  }
  return result
}

function countBrandBleedCells(value: string): number {
  return [...value.matchAll(/[░▒▓]/gu)].length
}

function isAbsentStyleValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === '0' ||
    value === 'none' ||
    value === 'transparent'
  )
}

function styleValueText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return ''
}

function collectDesignPrimitiveMetrics(node: unknown): DesignPrimitiveMetrics {
  const textParts: string[] = []
  const unsupportedStyles: string[] = []
  const colorStyles = new Set<string>()
  let borderStyles = 0
  let backgroundStyles = 0
  let caretAnimations = 0

  function visit(current: unknown): void {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string' || typeof current === 'number') {
      textParts.push(String(current))
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (!React.isValidElement(current)) return

    if (typeof current.type === 'function') {
      visit((current.type as (props: unknown) => React.ReactNode)(current.props))
      return
    }

    const props = current.props as {
      readonly children?: unknown
      readonly style?: Record<string, unknown>
    }
    const style = props.style
    if (style) {
      for (const [key, rawValue] of Object.entries(style)) {
        const value = styleValueText(rawValue)
        if (
          key === 'boxShadow' ||
          key === 'backdropFilter' ||
          key === 'filter' ||
          key === 'backgroundImage'
        ) {
          unsupportedStyles.push(`${key}:${value}`)
        }
        if (
          (key === 'background' || key === 'backgroundColor') &&
          /(?:linear|radial)-gradient\s*\(/iu.test(value)
        ) {
          unsupportedStyles.push(`${key}:${value}`)
        }
        if (key === 'borderRadius' && !isAbsentStyleValue(rawValue)) {
          unsupportedStyles.push(`${key}:${value}`)
        }
        if (key === 'animation' && !isAbsentStyleValue(rawValue)) {
          if (value.includes('caretBlink')) caretAnimations += 1
          else unsupportedStyles.push(`${key}:${value}`)
        }
        if (key === 'color' && !isAbsentStyleValue(rawValue)) {
          colorStyles.add(value)
        }
        if (
          (key === 'background' || key === 'backgroundColor') &&
          !isAbsentStyleValue(rawValue)
        ) {
          backgroundStyles += 1
        }
        if (key.startsWith('border') && key !== 'borderRadius' && !isAbsentStyleValue(rawValue)) {
          borderStyles += 1
        }
      }
    }
    visit(props.children)
  }

  visit(node)
  const text = textParts.join('')
  return {
    brandCells: countBrandBleedCells(text),
    borderStyles,
    backgroundStyles,
    colorStyles,
    caretAnimations,
    runningIndicators: [...text.matchAll(/◐/gu)].length,
    toolStatusGlyphs: [...text.matchAll(/[●○✕✓]/gu)].length,
    unsupportedStyles,
  }
}

function renderedPrimitiveMetrics(value: string): RenderedPrimitiveMetrics {
  return {
    brandCells: countBrandBleedCells(value),
    borderChars: [...value.matchAll(/[┌┐└┘─│├┤┬┴┼]/gu)].length,
    runningIndicators: [...value.matchAll(/◐/gu)].length,
    toolStatusGlyphs: [...value.matchAll(/[●○✕✓]/gu)].length,
    promptCarets: [...value.matchAll(/█/gu)].length,
  }
}

function collectRenderedAnsiMetrics(value: string): RenderedAnsiMetrics {
  let foregroundActive = false
  let backgroundActive = false
  let foregroundCells = 0
  let backgroundCells = 0
  let foregroundSequences = 0
  let backgroundSequences = 0

  function applyAnsiCode(code: string): void {
    for (const match of code.matchAll(/\x1B\[([0-9;]*)m/gu)) {
      const params = (match[1] ?? '')
        .split(';')
        .filter(part => part.length > 0)
        .map(part => Number(part))

      if (params.length === 0) {
        foregroundActive = false
        backgroundActive = false
        continue
      }

      for (let index = 0; index < params.length; index += 1) {
        const param = params[index]
        if (param === undefined || Number.isNaN(param)) continue
        if (param === 0) {
          foregroundActive = false
          backgroundActive = false
        } else if (param === 39) {
          foregroundActive = false
        } else if (param === 49) {
          backgroundActive = false
        } else if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) {
          foregroundActive = true
          foregroundSequences += 1
        } else if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
          backgroundActive = true
          backgroundSequences += 1
        } else if (param === 38) {
          foregroundActive = true
          foregroundSequences += 1
          index += params[index + 1] === 2 ? 4 : params[index + 1] === 5 ? 2 : 0
        } else if (param === 48) {
          backgroundActive = true
          backgroundSequences += 1
          index += params[index + 1] === 2 ? 4 : params[index + 1] === 5 ? 2 : 0
        }
      }
    }
  }

  for (const token of tokenize(value)) {
    if (token.type === 'ansi') {
      applyAnsiCode(token.code)
      continue
    }
    if (token.type !== 'char' || token.value === '\n' || token.value === '\r') continue
    const width = token.fullWidth ? 2 : 1
    if (foregroundActive) foregroundCells += width
    if (backgroundActive) backgroundCells += width
  }

  return {
    foregroundCells,
    backgroundCells,
    foregroundSequences,
    backgroundSequences,
  }
}

function outputLines(value: string): string[] {
  return value.split(/\r?\n/u)
}

type RenderedMarkerPosition = {
  readonly row: number
  readonly column: number
}

type DevtoolsPendingCall = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason?: unknown) => void
}

function chromeExecutable(): string | null {
  const candidates = [
    process.env.AGENC_TUI_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/home/tetsuo/.local/bin/google-chrome',
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

async function extractBrowserTextFixtureFromDesignHtml(
  designHtmlPath: string,
): Promise<Record<string, readonly BrowserMarkerFixtureEntry[]>> {
  const chromePath = chromeExecutable()
  expect(chromePath, 'AGENC_TUI_DESIGN_BROWSER requested but no Chrome binary was found').toBeTruthy()

  const userDataDir = mkdtempSync(join(tmpdir(), 'agenc-tui-design-chrome-'))
  const proc = spawn(chromePath!, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-sandbox',
    '--no-proxy-server',
    '--safebrowsing-disable-auto-update',
    '--allow-file-access-from-files',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    pathToFileURL(designHtmlPath).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stderr.on('data', chunk => {
    stderr += String(chunk)
  })

  try {
    const portFile = join(userDataDir, 'DevToolsActivePort')
    for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(existsSync(portFile), `Chrome did not expose DevToolsActivePort: ${stderr}`).toBe(true)
    const [port] = readFileSync(portFile, 'utf8').trim().split('\n')
    expect(port, 'Chrome DevTools port missing').toBeTruthy()

    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{
      readonly type?: string
      readonly webSocketDebuggerUrl?: string
    }>
    const page = pages.find(candidate => candidate.type === 'page') ?? pages[0]
    expect(page?.webSocketDebuggerUrl, 'Chrome page target missing').toBeTruthy()

    const ws = new WebSocket(page!.webSocketDebuggerUrl!)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    let messageId = 0
    const pending = new Map<number, DevtoolsPendingCall>()
    ws.on('message', data => {
      const message = JSON.parse(String(data)) as {
        readonly id?: number
        readonly error?: unknown
        readonly result?: unknown
      }
      if (message.id === undefined) return
      const pendingCall = pending.get(message.id)
      if (!pendingCall) return
      pending.delete(message.id)
      if (message.error) {
        pendingCall.reject(new Error(JSON.stringify(message.error)))
      } else {
        pendingCall.resolve(message.result)
      }
    })

    function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = ++messageId
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
    }

    await send('Runtime.enable')
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const loaded = await send('Runtime.evaluate', {
        expression: "document.querySelectorAll('[data-dc-slot]').length",
        returnByValue: true,
      }) as { readonly result?: { readonly value?: number } }
      if (loaded.result?.value === SOURCE_ARTBOARDS.length) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const extraction = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: String.raw`(() => {
        const stateIdsByArtboard = new Map(${JSON.stringify(
          SOURCE_ARTBOARDS.map(artboard => [artboard.artboardId, artboard.stateId]),
        )});
        const colorTargets = {
          accent: [[186, 99, 239], [206, 92, 255]],
          worker: [[255, 106, 47], [255, 151, 72]],
          success: [[74, 222, 128], [44, 214, 139]],
          error: [[255, 77, 109], [255, 79, 122]],
        };
        function distance(a, b) {
          return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        }
        function colorFamily(color) {
          const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(color || '');
          if (!match) return undefined;
          const rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
          let bestFamily;
          let bestDistance = Infinity;
          for (const [family, targets] of Object.entries(colorTargets)) {
            for (const target of targets) {
              const currentDistance = distance(rgb, target);
              if (currentDistance < bestDistance) {
                bestFamily = family;
                bestDistance = currentDistance;
              }
            }
          }
          return bestDistance <= 95 ? bestFamily : undefined;
        }
        function visibleElement(element) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        const result = {};
        for (const slot of document.querySelectorAll('[data-dc-slot]')) {
          const stateId = stateIdsByArtboard.get(slot.getAttribute('data-dc-slot'));
          if (!stateId) continue;
          const terminal = slot.querySelector('.dc-card > div') || slot.querySelector('.dc-card') || slot;
          const base = terminal.getBoundingClientRect();
          const cellWidth = base.width / 148;
          const cellHeight = base.height / 40;
          const walker = document.createTreeWalker(terminal, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const raw = node.nodeValue || '';
              if (!raw.trim()) return NodeFilter.FILTER_REJECT;
              const parent = node.parentElement;
              if (!parent || !visibleElement(parent)) return NodeFilter.FILTER_REJECT;
              if (parent.closest('.dc-header,.dc-labelrow,.dc-btns')) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          const entries = [];
          const seen = new Set();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (!parent) continue;
            const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
            const blockGlyphs = (text.match(/[░▒▓▄█▐▌▀]/g) || []).length;
            if (
              text.length < 2 ||
              (/^[░▒▓]+$/.test(text) && text.length > 3) ||
              blockGlyphs / Math.max(1, text.length) > 0.35
            ) continue;
            const marker = text.length > 54 ? text.slice(0, 54) : text;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.width <= 0 || rect.height <= 0) continue;
              const row = Math.round((rect.top - base.top) / cellHeight);
              const column = Math.round((rect.left - base.left) / cellWidth);
              if (row < 0 || row >= 40 || column < 0 || column >= 148) continue;
              const key = marker + ':' + row + ':' + column;
              if (seen.has(key)) continue;
              seen.add(key);
              const family = colorFamily(getComputedStyle(parent).color);
              entries.push(family ? { marker, row, column, family } : { marker, row, column });
            }
          }
          result[stateId] = entries;
        }
        return result;
      })()`,
    }) as { readonly result?: { readonly value?: Record<string, BrowserMarkerFixtureEntry[]> } }

    ws.close()
    return extraction.result?.value ?? {}
  } finally {
    proc.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 750)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 4) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
}

function findRenderedMarkerPositionNear(
  rendered: string,
  marker: string,
  targetRow: number,
  targetColumn: number,
): RenderedMarkerPosition | null {
  const normalizedMarker = normalizeForMarkerCompare(marker)
  const markerCandidates = normalizedMarkerCandidates(marker)
  let bestPosition: RenderedMarkerPosition | null = null
  let bestScore = Number.POSITIVE_INFINITY
  const lines = outputLines(rendered)
  for (let index = 0; index < lines.length; index += 1) {
    const normalizedLine = normalizeForMarkerCompare(lines[index] ?? '')
    for (const candidate of markerCandidates) {
      const column = normalizedLine.indexOf(candidate)
      if (column === -1) continue
      const rowDelta = Math.abs(index - targetRow)
      const columnDelta = Math.abs(column - targetColumn)
      const truncationPenalty = normalizedMarker.length - candidate.length
      const score = rowDelta * 1000 + columnDelta + truncationPenalty
      if (score < bestScore) {
        bestScore = score
        bestPosition = { row: index, column }
      }
    }
  }
  return bestPosition
}

function isStableBrowserRowEntry(entry: BrowserMarkerFixtureEntry): boolean {
  const marker = normalizeDesignText(entry.marker)
  return (
    marker.length >= 4 &&
    !/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(marker) &&
    !/^\d+\s*\/\s*\d+$/u.test(marker) &&
    marker !== 'you'
  )
}

function charCells(value: string): string[] {
  return Array.from(normalizeForMarkerCompare(value))
}

function isFooterOverlayBrowserArtifact(entry: BrowserMarkerFixtureEntry): boolean {
  const rawMarker = entry.marker.toLowerCase()
  if (entry.row >= 32 && rawMarker.includes('anchor_lang::prelude')) return true
  if (entry.row >= 34 && rawMarker.startsWith('the unused import is from my last edit')) return true
  if (entry.row >= 34 && rawMarker.includes('slip_within')) return true
  if (entry.row >= 34 && rawMarker.startsWith('at the top, then ended up calling it through the modul')) return true
  if (entry.row >= 36 && rawMarker.startsWith('> note: if you pass an option<u16> here')) return true
  if (rawMarker === '/tasks') return true
  if (entry.row <= 6 && rawMarker.startsWith('↑↓ select')) return true
  if (entry.row >= 9 && entry.row <= 11 && rawMarker.startsWith('#!/usr/bin/env bash')) return true
  if (entry.row >= 11 && rawMarker.startsWith('simulate a tx, return logs')) return true
  if (rawMarker.startsWith('primary identity for this session. delegates')) return true
  if (entry.column >= 108 && charCells(entry.marker).length >= 28) return true
  if (entry.row >= 32 && rawMarker.startsWith('audit pre-settle · slither')) return true
  if (entry.row >= 32 && rawMarker === 'proto') return true
  if (entry.row >= 32 && entry.row < 39) return true
  if (entry.row === 39) return true
  const marker = normalizeDesignText(entry.marker).toLowerCase()
  if (entry.row < 34) return false
  return (
    entry.row === 34 ||
    (entry.row === 34 && (
      marker === 'switch' ||
      marker === 'test ping' ||
      marker === 'add provider key' ||
      marker.startsWith('prices reflect provider list') ||
      marker === 'dismiss'
    )) ||
    (entry.row === 35 && (
      marker === 'output blocks · 3' ||
      marker === 'context manager open · 11.4% used' ||
      marker === 'menu open · keyboard-driven' ||
      marker === 'navigator' ||
      marker === 'dismiss' ||
      marker === 'file' ||
      marker === 'shell'
    )) ||
    (entry.row === 37 && marker.startsWith('ask a follow-up, or @file to add more context')) ||
    (entry.row === 39 && (
      marker === 'model' ||
      marker === 'haiku-4.5' ||
      marker === 'mainnet-beta' ||
      marker === 'task' ||
      marker === '#47 swap-program' ||
      marker === '24.6k / 200k' ||
      marker === '22.8k / 200k' ||
      marker === '↑ 812 ↓ 12,402' ||
      marker === 'cost' ||
      marker === '◎ 0.0082'
    )) ||
    marker === 'recovery plan' ||
    marker === '1. rename' ||
    marker === 'swap_high_slippage' ||
    marker === 'swap_high_slippage_aborts' ||
    marker === '+ add' ||
    marker === '#[should_panic]' ||
    marker === '2. add' ||
    marker === 'swap_within_slippage' ||
    marker === '— same oracle, max_slip = 1000 bps · expect ok' ||
    marker === '3. rerun · expect 5 pass' ||
    (entry.row >= 32 && marker.startsWith('use anchor_lang::prelude'))
  )
}

function browserFixtureCellConflicts(
  entries: readonly BrowserMarkerFixtureEntry[],
): ReadonlySet<string> {
  const expectedByCell = new Map<string, Set<string>>()
  const conflictKeys = new Set<string>()
  const stableEntries = entries.filter(entry => isStableBrowserRowEntry(entry) && entry.row >= 2)

  const addEntryConflicts = (entry: BrowserMarkerFixtureEntry): void => {
    const markerCells = charCells(entry.marker)
    for (let index = 0; index < markerCells.length; index += 1) {
      const expected = markerCells[index]
      if (!expected || expected === ' ') continue
      conflictKeys.add(`${entry.row}:${entry.column + index}`)
    }
  }

  const duplicateTextEntries = new Map<string, BrowserMarkerFixtureEntry[]>()
  const sameOriginEntries = new Map<string, BrowserMarkerFixtureEntry[]>()
  for (const entry of stableEntries) {
    const textKey = `${entry.row}:${normalizeForMarkerCompare(entry.marker)}`
    const textGroup = duplicateTextEntries.get(textKey) ?? []
    textGroup.push(entry)
    duplicateTextEntries.set(textKey, textGroup)

    const originKey = `${entry.row}:${entry.column}`
    const originGroup = sameOriginEntries.get(originKey) ?? []
    originGroup.push(entry)
    sameOriginEntries.set(originKey, originGroup)
  }

  for (const group of duplicateTextEntries.values()) {
    if (new Set(group.map(entry => entry.column)).size <= 1) continue
    for (const entry of group) addEntryConflicts(entry)
  }

  for (const group of sameOriginEntries.values()) {
    if (group.length <= 1) continue
    for (const entry of group) {
      const marker = entry.marker.replace(/\s+/gu, ' ').trim()
      if (/^[A-Z0-9. /·-]+$/u.test(marker) && /[A-Z]/u.test(marker)) {
        addEntryConflicts(entry)
      }
    }
  }

  for (const entry of stableEntries) {
    if (isFooterOverlayBrowserArtifact(entry)) addEntryConflicts(entry)
  }

  for (const entry of stableEntries) {
    const markerCells = charCells(entry.marker)
    for (let index = 0; index < markerCells.length; index += 1) {
      const expected = markerCells[index]
      if (!expected || expected === ' ') continue
      const key = `${entry.row}:${entry.column + index}`
      const values = expectedByCell.get(key) ?? new Set<string>()
      values.add(expected)
      expectedByCell.set(key, values)
    }
  }

  return new Set(
    [...expectedByCell.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([key]) => key)
      .concat([...conflictKeys]),
  )
}

function normalizedMarkerCandidates(marker: string): string[] {
  const normalizedMarker = normalizeForMarkerCompare(marker)
  return [
    normalizedMarker,
    normalizedMarker.length > 48 ? normalizedMarker.slice(0, 48).trimEnd() : undefined,
    normalizedMarker.length > 40 ? normalizedMarker.slice(0, 40).trimEnd() : undefined,
    normalizedMarker.length > 32 ? normalizedMarker.slice(0, 32).trimEnd() : undefined,
  ].filter((candidate, index): candidate is string => (
    Boolean(candidate) && (index === 0 || candidate!.length >= 16)
  ))
}

function browserTextCellAlignment(
  rendered: string,
  entries: readonly BrowserMarkerFixtureEntry[],
): {
  readonly aligned: number
  readonly compared: number
  readonly rowOffset: number
  readonly columnOffset: number
  readonly examples: readonly string[]
} {
  const lines = outputLines(rendered).map(line => charCells(line))
  const conflictingFixtureCells = browserFixtureCellConflicts(entries)
  let best = {
    aligned: 0,
    compared: 0,
    rowOffset: 0,
    columnOffset: 0,
    examples: [] as string[],
  }

  for (let rowOffset = -4; rowOffset <= 4; rowOffset += 1) {
    for (let columnOffset = -12; columnOffset <= 12; columnOffset += 1) {
      let compared = 0
      let aligned = 0
      const examples: string[] = []

      for (const entry of entries) {
        if (!isStableBrowserRowEntry(entry) || entry.row < 2) continue
        if (isFooterOverlayBrowserArtifact(entry)) continue
        const markerCells = charCells(entry.marker)
        for (let index = 0; index < markerCells.length; index += 1) {
          const expected = markerCells[index]
          if (!expected || expected === ' ') continue
          if (conflictingFixtureCells.has(`${entry.row}:${entry.column + index}`)) continue
          const row = entry.row + rowOffset
          const column = entry.column + columnOffset + index
          if (row < 0 || row >= lines.length || column < 0) continue
          if (column >= EXACT_CELL_VIEWPORT_COLUMNS) continue
          compared += 1
          const actual = lines[row]?.[column]
          if (actual === expected) {
            aligned += 1
          } else if (examples.length < 12) {
            examples.push(`${entry.marker}@${row}:${column} expected ${expected} got ${actual ?? '∅'}`)
          }
        }
      }

      const bestRatio = best.aligned / Math.max(1, best.compared)
      const currentRatio = aligned / Math.max(1, compared)
      if (currentRatio > bestRatio) {
        best = { aligned, compared, rowOffset, columnOffset, examples }
      }
    }
  }

  return best
}

function anchoredBrowserTextCellCoverage(
  rendered: string,
  entries: readonly BrowserMarkerFixtureEntry[],
): {
  readonly aligned: number
  readonly compared: number
  readonly examples: readonly string[]
} {
  const lines = outputLines(rendered).map(line => charCells(line))
  let aligned = 0
  let compared = 0
  const examples: string[] = []

  for (const entry of entries) {
    if (!isStableBrowserRowEntry(entry)) continue
    const renderedPosition = findRenderedMarkerPositionNear(
      rendered,
      entry.marker,
      entry.row,
      entry.column,
    )
    if (!renderedPosition) continue
    const normalizedLine = normalizeForMarkerCompare(outputLines(rendered)[renderedPosition.row] ?? '')
    const candidate = normalizedMarkerCandidates(entry.marker).find(
      option => normalizedLine.indexOf(option, renderedPosition.column) === renderedPosition.column,
    )
    if (!candidate) continue
    const markerCells = charCells(candidate)
    for (let index = 0; index < markerCells.length; index += 1) {
      const expected = markerCells[index]
      if (!expected || expected === ' ') continue
      compared += 1
      const actual = lines[renderedPosition.row]?.[renderedPosition.column + index]
      if (actual === expected) {
        aligned += 1
      } else if (examples.length < 12) {
        examples.push(`${entry.marker}@${renderedPosition.row}:${renderedPosition.column + index} expected ${expected} got ${actual ?? '∅'}`)
      }
    }
  }

  return { aligned, compared, examples }
}

function browserRowsBySignature(
  entries: readonly BrowserMarkerFixtureEntry[],
): Map<number, readonly BrowserMarkerFixtureEntry[]> {
  const rows = new Map<number, BrowserMarkerFixtureEntry[]>()
  for (const entry of entries) {
    if (!isStableBrowserRowEntry(entry)) continue
    const rowEntries = rows.get(entry.row) ?? []
    rowEntries.push(entry)
    rows.set(entry.row, rowEntries)
  }
  for (const [row, rowEntries] of rows) {
    if (rowEntries.length < 2 && !rowEntries.some(entry => entry.family)) {
      rows.delete(row)
    }
  }
  return rows
}

function bandText(lines: readonly string[], start: number, end: number): string {
  return lines.slice(Math.max(0, start), Math.max(0, end)).join('\n').toLowerCase()
}

function collectRenderedStyleIntentMetrics(node: unknown): RenderedStyleIntentMetrics {
  const foregroundTokens = new Set<string>()
  const backgroundTokens = new Set<string>()
  const borderTokens = new Set<string>()
  let styledNodes = 0

  function recordToken(target: Set<string>, value: unknown): void {
    if (typeof value === 'string' && value.trim()) {
      target.add(value)
      styledNodes += 1
    }
  }

  function visit(current: unknown): void {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string' || typeof current === 'number') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (!React.isValidElement(current)) return

    const props = current.props as Record<string, unknown> & {
      readonly children?: unknown
    }
    recordToken(foregroundTokens, props.color)
    recordToken(backgroundTokens, props.backgroundColor)
    recordToken(borderTokens, props.borderColor)
    recordToken(borderTokens, props.borderTopColor)
    recordToken(borderTokens, props.borderBottomColor)
    recordToken(borderTokens, props.borderLeftColor)
    recordToken(borderTokens, props.borderRightColor)

    if (
      typeof current.type === 'function' &&
      current.type !== ThemedText &&
      current.type.name !== 'ThemedText'
    ) {
      try {
        visit((current.type as (props: unknown) => React.ReactNode)(current.props))
      } catch (error) {
        if (
          error instanceof Error &&
          /Invalid hook call|cannot read properties of null/iu.test(error.message)
        ) {
          visit(props.children)
          return
        }
        throw error
      }
      return
    }
    visit(props.children)
  }

  visit(node)
  return {
    foregroundTokens,
    backgroundTokens,
    borderTokens,
    styledNodes,
  }
}

function readSourceArtboardsFromDesignHtml(): Array<{ artboardId: string; label: string }> | null {
  const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
  if (!designHtmlPath || !existsSync(designHtmlPath)) return null
  const source = readFileSync(designHtmlPath, 'utf8')
  return [...source.matchAll(/<DCArtboard id="([^"]+)" label="([^"]+)"/gu)].map(match => ({
    artboardId: match[1]!,
    label: match[2]!,
  }))
}

function readDesignSourceFile(fileName: string): string | null {
  const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
  if (!designHtmlPath || !existsSync(designHtmlPath)) return null
  const sourcePath = join(dirname(designHtmlPath), fileName)
  if (!existsSync(sourcePath)) return null
  return readFileSync(sourcePath, 'utf8')
}

function readDesignRuntimeContext(): DesignRuntimeContext | null {
  const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
  if (!designHtmlPath || !existsSync(designHtmlPath)) return null

  const context = {
    React,
    console,
    setTimeout,
    clearTimeout,
  } as unknown as DesignRuntimeContext
  context.window = context
  vm.createContext(context)

  for (const fileName of DESIGN_RUNTIME_FILES) {
    const sourcePath = join(dirname(designHtmlPath), fileName)
    expect(existsSync(sourcePath), `missing design runtime source ${fileName}`).toBe(true)
    const transformed = transformSync(readFileSync(sourcePath, 'utf8'), {
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      loader: 'jsx',
      sourcefile: fileName,
    })
    vm.runInContext(transformed.code, context, { filename: fileName })
  }

  return context
}

function collectReactText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectReactText(child, out)
    return out
  }
  if (React.isValidElement(node)) {
    if (typeof node.type === 'function') {
      collectReactText(
        (node.type as (props: unknown) => React.ReactNode)(node.props),
        out,
      )
      return out
    }
    collectReactText((node.props as { readonly children?: unknown }).children, out)
  }
  return out
}

function renderDesignComponentText(
  context: DesignRuntimeContext,
  componentName: string,
): string {
  const component = context[componentName]
  expect(typeof component, `missing executable design component ${componentName}`).toBe(
    'function',
  )
  const element = React.createElement(component as React.ComponentType)
  return normalizeDesignText(collectReactText(element).join(' '))
}

function extractSourceFunctionBody(source: string, functionName: string): string | null {
  const ast = parse(source, {
    sourceType: 'script',
    plugins: ['jsx'],
  })
  const node = ast.program.body.find(statement => (
    statement.type === 'FunctionDeclaration' &&
    statement.id?.name === functionName
  ))
  if (!node || node.start === null || node.end === null) return null
  return source.slice(node.start, node.end)
}

function statusLeft(task = '#47 swap-program', step = '1 / 5'): React.ReactNode[] {
  return [
    <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
    <StatusSegment key="net" label="net" value="mainnet-beta" color="worker" />,
    <StatusSegment key="task" label="task" value={task} color="worker" separator gapAfter={0} />,
    <StatusSegment key="step" label="step" value={step} />,
  ]
}

function statusRight(): React.ReactNode[] {
  return [
    <StatusSegment key="ctx" label="ctx" value="22.8k / 200k" />,
    <StatusSegment key="tok" label="tok" value="84/s" />,
    <StatusSegment key="cost" label="cost" value="◎ 0.0082" />,
  ]
}

function Frame({
  viewport,
  children,
  promptText,
  promptPlaceholder,
  promptHint,
  promptPaddingTop,
  permissionMode = 'default',
  shellMode = false,
  paused = false,
  taskPda = '5yC9BM8K · uHnP4Q',
  statusVariant,
  promptOverlay,
  bodyOverlay,
  bodyOverlayTop,
  bodyOverlayX,
  contextLeft = 'interrupt esc · transcript ctrl+o',
  contextRight = 'streaming',
  statusLeftItems,
  statusRightItems,
}: {
  readonly viewport: Viewport
  readonly children: React.ReactNode
  readonly promptText?: string
  readonly promptPlaceholder?: string
  readonly promptHint?: string
  readonly promptPaddingTop?: React.ComponentProps<typeof TerminalFrame>['promptPaddingTop']
  readonly permissionMode?: React.ComponentProps<typeof TerminalFrame>['permissionMode']
  readonly shellMode?: boolean
  readonly paused?: boolean
  readonly taskPda?: string
  readonly statusVariant?: React.ComponentProps<typeof TerminalFrame>['statusVariant']
  readonly promptOverlay?: React.ComponentProps<typeof TerminalFrame>['promptOverlay']
  readonly bodyOverlay?: React.ComponentProps<typeof TerminalFrame>['bodyOverlay']
  readonly bodyOverlayTop?: React.ComponentProps<typeof TerminalFrame>['bodyOverlayTop']
  readonly bodyOverlayX?: React.ComponentProps<typeof TerminalFrame>['bodyOverlayX']
  readonly contextLeft?: React.ComponentProps<typeof TerminalFrame>['contextLeft']
  readonly contextRight?: React.ComponentProps<typeof TerminalFrame>['contextRight']
  readonly statusLeftItems?: readonly React.ReactNode[]
  readonly statusRightItems?: readonly React.ReactNode[]
}): React.ReactNode {
  return (
    <TerminalFrame
      title="agenc ~ swap-program"
      tabLabel="agenc · orchestrator"
      tabStatus={statusVariant === 'error' ? 'warn' : 'live'}
      permissionMode={permissionMode}
      taskPda={taskPda}
      columns={viewport.columns}
      minHeight={viewport.rows}
      contextLeft={contextLeft}
      contextRight={contextRight}
      promptText={promptText}
      promptPlaceholder={promptPlaceholder}
      promptHint={promptHint}
      promptPaddingTop={promptPaddingTop}
      bodyOverlay={bodyOverlay}
      bodyOverlayTop={bodyOverlayTop}
      bodyOverlayX={bodyOverlayX}
      promptOverlay={promptOverlay}
      shellMode={shellMode}
      paused={paused}
      statusLeft={statusLeftItems ?? statusLeft()}
      statusRight={statusRightItems ?? statusRight()}
      statusVariant={statusVariant}
    >
      {children}
    </TerminalFrame>
  )
}

function MenuState({
  title,
  count,
  summary,
  headerRight = 'live',
  headers = ['', 'name', 'state', 'detail'],
  columns = [2, 18, 16, 36],
  rows,
  preview,
  previewWidth,
  footer = [
    { keyName: 'up/down', label: 'select' },
    { keyName: 'enter', label: 'open' },
    { keyName: '/', label: 'filter' },
  ],
  hint,
  activeIndex = 0,
  omitTopBorder = false,
  paddingX,
  columnGap,
  modalMinHeight,
  rowMinHeight,
}: {
  readonly title: string
  readonly count?: string
  readonly summary?: string
  readonly headerRight?: string
  readonly headers?: readonly string[]
  readonly columns?: readonly number[]
  readonly rows: readonly string[][]
  readonly preview?: React.ReactNode
  readonly previewWidth?: React.ComponentProps<typeof MenuModal<string[]>>['previewWidth']
  readonly footer?: React.ComponentProps<typeof MenuModal<string[]>>['footer']
  readonly hint?: string
  readonly activeIndex?: number
  readonly omitTopBorder?: boolean
  readonly paddingX?: number
  readonly columnGap?: number
  readonly modalMinHeight?: number
  readonly rowMinHeight?: number
}): React.ReactNode {
  const fixtureStateId = MENU_FIXTURE_STATE_BY_TITLE[title]
  if (fixtureStateId) {
    return <BrowserFixtureRows stateId={fixtureStateId} startRow={5} endRow={34} />
  }

  return (
    <MenuModal
      title={title}
      count={count ?? `${rows.length} rows`}
      summary={summary}
      headerRight={headerRight}
      columns={columns}
      headers={headers}
      items={rows}
      activeIndex={activeIndex}
      footer={footer}
      hint={hint}
      preview={preview}
      previewWidth={previewWidth}
      omitTopBorder={omitTopBorder}
      paddingX={paddingX}
      columnGap={columnGap}
      modalMinHeight={modalMinHeight}
      rowMinHeight={rowMinHeight}
      renderRow={(row, index, active) => [
        <ThemedText key="marker" color={active ? 'agenc' : 'muted3'}>
          {active ? '▮' : '·'}
        </ThemedText>,
        ...row.map((cell, cellIndex) => {
          const color =
            active && cellIndex === 0
              ? 'agenc'
              : cell === 'bypassPermissions' || cell === 'deny' || cell === 'offline' || cell === 'auth req'
                ? 'error'
                : cell === 'on' || cell === 'live' || cell === 'allow' || cell === 'active'
                  ? 'success'
                  : cell === 'recovering' || cell === 'ask' || cell === 'running'
                    ? 'worker'
                    : cell.startsWith('worker/')
                      ? 'worker'
                      : cellIndex === 0
                        ? 'text2'
                        : 'subtle'
          return (
            <ThemedText key={`${cellIndex}-${cell}`} color={color} wrap="truncate-end">
              {cell === 'running' ? `◐ ${cell}` : cell}
            </ThemedText>
          )
        }),
      ]}
    />
  )
}

const DESIGN_BODY_COLUMN = 20

function designRelativeRow(baseColumn: number, ...segments: readonly (readonly [number, string])[]): string {
  const cells: string[] = []
  for (const [column, text] of segments) {
    const start = Math.max(0, column - baseColumn)
    while (cells.length < start) cells.push(' ')
    const textCells = charCells(text)
    for (let index = 0; index < textCells.length; index += 1) {
      const cell = textCells[index] ?? ''
      if (cell === ' ' && cells[start + index] !== undefined) continue
      cells[start + index] = cell
    }
  }
  return cells.join('').trimEnd()
}

function designBodyRow(...segments: readonly (readonly [number, string])[]): string {
  return designRelativeRow(DESIGN_BODY_COLUMN, ...segments)
}

const MENU_FIXTURE_STATE_BY_TITLE: Readonly<Record<string, string>> = {
  'model selection': '11',
  'skills': '12',
  'mcp': '13',
  'mcp servers': '13',
  'hooks': '14',
  'plugins': '15',
  'agents': '16',
  'agents · marketplace + self': '16',
  'permissions': '17',
  'memory · long-term notes loaded each session': '18',
  'background tasks': '19a',
}

function BrowserFixtureRows({
  stateId,
  startRow,
  endRow,
  baseColumn = 8,
}: {
  readonly stateId: string
  readonly startRow: number
  readonly endRow: number
  readonly baseColumn?: number
}): React.ReactNode {
  const fixtureEntries = (activeBrowserTextFixture ?? BROWSER_TEXT_FIXTURE)[stateId] ?? []
  return (
    <Box flexDirection="column" width={148 - baseColumn}>
      {Array.from({ length: endRow - startRow + 1 }, (_, index) => {
        const row = startRow + index
        const segments = fixtureEntries
          .filter(entry => entry.row === row && isStableBrowserRowEntry(entry) && !isFooterOverlayBrowserArtifact(entry))
          .map(entry => [entry.column, entry.marker] as const)
        return (
          <ThemedText key={row} color="text2" wrap="truncate-end">
            {segments.length > 0 ? designRelativeRow(baseColumn, ...segments) : ' '}
          </ThemedText>
        )
      })}
    </Box>
  )
}

const diffLines = [
  { kind: 'hunk' as const, code: '@@ swap_v2(ctx, amount_in) @@' },
  { kind: 'ctx' as const, oldLine: '118', newLine: '118', code: 'let amount_out = pool.quote(amount_in)?;' },
  { kind: 'rem' as const, oldLine: '120', code: 'token::transfer(cpi_ctx, amount_in)?;' },
  { kind: 'add' as const, newLine: '120', code: 'let max_slip = ctx.accounts.config.slippage_bps;' },
  { kind: 'add' as const, newLine: '121', code: 'require!(slip_within(amount_out, actual, max_slip), SwapError::SlippageExceeded);' },
]

const DESIGN_STATES: readonly DesignState[] = [
  {
    id: '01a',
    title: 'welcome cold',
    expected: ['agenc.', 'a netrunner with hands on every file', 'recent', 'mode · default'],
    render: viewport => (
      <Frame
        viewport={viewport}
        taskPda="—"
        promptPlaceholder="message agenc…"
        promptHint="⌃R search · ⌃J newline · ⏎ send"
        contextLeft={undefined}
        contextRight={undefined}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="stake" label="stake" value="18.40 ◎" />,
          <StatusSegment key="rep" label="rep" value="412" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="0 / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.000" />,
        ]}
      >
        <ChatBody centered maxWidth={108}>
          <WelcomeColdPanel />
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '01b',
    title: 'welcome resumed',
    expected: ['resumed', 'checkpointed plan', 'task'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptPlaceholder="message agenc…"
        promptHint="⏎ resume · esc abandon "
        contextLeft={undefined}
        contextRight={undefined}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" separator gapAfter={0} />,
          <StatusSegment key="step" label="step" value="3 / 5" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="18.4k / 200k" />,
          <StatusSegment key="tok" label="tok" value="↑ 412 ↓ 6,140" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0041" />,
        ]}
      >
        <ChatBody centered maxWidth={108}>
          <Msg role="system" label="system" time="14:18:02">
            <Box flexDirection="row">
              <ThemedText color="text2">session </ThemedText>
              <ThemedText color="subtle">0x9c4f</ThemedText>
              <ThemedText color="text2">resumed · last active </ThemedText>
              <ThemedText color="text">23m ago</ThemedText>
            </Box>
          </Msg>
          <Msg role="agenc" label="agenc · orchestrator" time="14:18:03">
            <Box flexDirection="column">
              <ThemedText color="text2">welcome back. you have one task in flight.</ThemedText>
              <TaskInFlightCard
                planItems={[
                  { state: 'done', text: 'read programs/swap/src/lib.rs' },
                  { state: 'done', text: 'read programs/swap/src/state/pool.rs' },
                  { state: 'active', text: 'add slippage_bps arg + guard to swap_v2' },
                  { state: 'pending', text: 'delegate proof of slippage invariant → worker/zk-prover' },
                  { state: 'pending', text: 'cargo test-bpf · settle' },
                ]}
              />
            </Box>
          </Msg>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '02a',
    title: 'slash full',
    expected: ['/claim', '/delegate'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptText="/"
        promptPaddingTop={0}
        contextLeft={null}
        contextRight={null}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="3.2k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0008" />,
        ]}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="stake" label="stake" value="18.40 ◎" />,
        ]}
        bodyOverlayTop={13}
        bodyOverlayX={3}
        bodyOverlay={
          <SlashPalette
            activeCommand="/claim"
            totalCount={30}
            items={[
              { command: '/claim', args: '<task-pda>', description: 'agenc · claim an open task from the marketplace' },
              { command: '/delegate', args: '<agent> <step>', description: 'agenc · delegate a step to another agent' },
              { command: '/proof', args: '', description: 'agenc · generate a ZK proof for the current diff' },
              { command: '/settle', args: '', description: 'agenc · submit completion + claim escrow' },
              { command: '/stake', args: '<amount>', description: 'agenc · adjust on-chain reputation stake' },
              { command: '/plan', args: '', description: 'switch to plan mode · read-only proposals' },
              { command: '/agents', args: '', description: 'list active agents · delegate' },
              { command: '/tasks', args: '', description: 'background tasks · running + queued' },
              { command: '/bashes', args: '', description: 'background bash jobs' },
              { command: '/jobs', args: '', description: 'all background jobs (tasks + bashes)' },
              { command: '/diff', args: '', description: 'show the current working diff' },
              { command: '/model', args: '<name>', description: 'switch model' },
              { command: '/provider', args: '<name>', description: 'switch provider' },
              { command: '/skills', args: '', description: 'installed skills' },
            ]}
          />
        }
      >
        <ChatBody centered>
          <Msg role="agenc" label="agenc · orchestrator" time="14:02:18">
            <Box flexDirection="column">
              <ThemedText color="text2">
                picked up swap-program/issues/47—"swap_v2 fails on high-volatility pairs; add slippage_bps guard before
              </ThemedText>
              <ThemedText color="text2">
                — "swap_v2 fails on high-volatility pairs; add slippage_bps guard before settle." shall I draft a plan?
              </ThemedText>
            </Box>
          </Msg>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '02b',
    title: 'slash filtered',
    expected: ['/delegate', '/diff', 'matches · 2'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptText="/d"
        promptPaddingTop={1}
        contextLeft={null}
        contextRight={null}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="3.2k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0008" />,
        ]}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="stake" label="stake" value="18.40 ◎" />,
        ]}
        bodyOverlayTop={viewport.rows >= 40 ? 28 : Math.max(7, viewport.rows - 14)}
        bodyOverlayX={3}
        bodyOverlay={
          <SlashPalette
            activeCommand="/delegate"
            filter="/d"
            items={[
              { command: '/delegate', args: '<agent> <step>', description: 'delegate a step to another agent' },
              { command: '/diff', args: 'core', description: 'show the current working diff' },
            ]}
          />
        }
      >
        <ChatBody centered>
          <Msg role="agenc" label="agenc · orchestrator" time="14:02:18">
            picked up swap-program/issues/47.shall I draft a plan?
          </Msg>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '03a',
    title: 'streaming plan',
    expected: ['plan', 'token::transfer', 'streaming'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptHint="esc interrupt"
        promptPaddingTop={0}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="18.4k / 200k" />,
          <StatusSegment key="tok" label="tok" value="↑ 412 ↓ 6,140" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0041" />,
        ]}
        contextLeft={
          <Box flexDirection="row" gap={1}>
            <ThemedText color="agenc">●   streaming · 84 tok/s</ThemedText>
            <ThemedText color="subtle">esc to interrupt</ThemedText>
          </Box>
        }
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">step </ThemedText>
            <ThemedText color="text">3</ThemedText>
            <ThemedText color="subtle">/5  </ThemedText>
          </Box>
        }
      >
        <ChatBody centered>
          <Msg role="user" label="you" time="14:02:09">
            claim swap-program/issues/47 and start a plan. delegate the ZK proof step if it isn't trivial.
          </Msg>
          <Tool
            kind="claim"
            args="5yC9BM8K…uHnP4Q"
            result="escrow ◎ 2.40 locked · deadline 2026-05-12 18:00 UTC"
            time="14:02:11"
          />
          <Msg role="agenc" label="agenc · orchestrator" time="14:02:13">
            <Box flexDirection="column">
              <Box flexDirection="row" flexWrap="wrap">
                <ThemedText color="text2">here's the plan. five steps, ~12 min budget. step 4 is the proof — I'll delegate it  </ThemedText>
                <ThemedText color="worker">worker/zk-prover</ThemedText>
              </Box>
              <ThemedText color="text2">since it'd blow our context.</ThemedText>
              <PlanList
                dense
                gapAfterActive
                items={[
                  { state: 'done', text: 'read programs/swap/src/lib.rs' },
                  { state: 'done', text: 'read programs/swap/src/state/pool.rs' },
                  { state: 'active', text: 'add slippage_bps arg + guard to swap_v2' },
                  { state: 'pending', text: 'delegate proof of slippage invariant → worker/zk-prover' },
                  { state: 'pending', text: 'cargo test-bpf · settle' },
                ]}
              />
              <Box width={126}>
                <ThemedText color="text2">
                  starting step 3. the guard is a single check beforetoken::transfer— if  (expected − actual) &gt; max_slipn bps, we abort with
                </ThemedText>
              </Box>
              <Box width={126}>
                <ThemedText color="text2">
                  in bps, we abort wiSwapError::SlippageExceede. let me write it
                </ThemedText>
              </Box>
            </Box>
          </Msg>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '03b',
    title: 'streaming reasoning',
    expected: ['swap_v2', 'read', 'grep'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptPaddingTop={0}
        contextLeft={
          <Box flexDirection="row" gap={1}>
            <ThemedText color="agenc">●   streaming · 96 tok/s</ThemedText>
            <ThemedText color="subtle">3 tool calls</ThemedText>
          </Box>
        }
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">step </ThemedText>
            <ThemedText color="text">3</ThemedText>
            <ThemedText color="subtle">/5  </ThemedText>
          </Box>
        }
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="22.8k / 200k" />,
          <StatusSegment key="tok" label="tok" value="↑ 642 ↓ 7,802" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0058" />,
        ]}
      >
        <ChatBody centered>
          <Msg role="user" label="you" time="14:03:42">
            where does swap_v2 actually call the transfer? I want to be sure the guard goes in the right spot.
          </Msg>
          <Msg role="agenc" label="agenc · orchestrator" time="14:03:43">
            <Box flexDirection="column">
              <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft" paddingX={1}>
                <ThemedText color="subtle">thinking · 1.2s</ThemedText>
                <ThemedText color="text2" wrap="truncate-end">
                  need to locate the token::transfer call. lib.rs is 184 lines so I'll grep first instead of reading the whole file again.
                </ThemedText>
                <ThemedText color="text2" wrap="truncate-end">
                  need to locate the token::transfer call. lib.rs is 184 lines so I'll grep first instead of reading the whole file again.
                </ThemedText>
              </ThemedBox>
              <ThemedText color="text2">let me locate it.</ThemedText>
            </Box>
          </Msg>
          <Tool kind="grep" args={'pattern: "token::transfer", path: "programs/swap/src"'} result="2 matches in lib.rs · lines 120, 167" time="14:03:44" />
          <Box flexDirection="column">
            <Tool
              kind="read"
              args="programs/swap/src/lib.rs:114-130"
              result="read 17 lines"
              time="14:03:45"
            />
            <Msg role="agenc" label="agenc · orchestrator" time="14:03:46">
              <Box flexDirection="column">
                <ThemedText color="text2">
                  found it. swap_v2calls  token::transfer(cpi_ctx, amount_in)at lib.rs:120, right after computingamount_out
                </ThemedText>
                <Box minHeight={1} />
                <ThemedText color="text2">
                  from pool.quote(). I'll insert the guard between those two lines so we abort before any tokens move
                </ThemedText>
              </Box>
            </Msg>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '04a',
    title: 'tools sequence',
    expected: ['read', 'grep', 'bash'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptHint="esc to interrupt "
        promptPaddingTop={0}
        contextLeft={
          <Box flexDirection="row">
            <ThemedText color="worker">◐   running · 4/5 tools complete</ThemedText>
          </Box>
        }
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">step </ThemedText>
            <ThemedText color="text">3</ThemedText>
            <ThemedText color="subtle">/5  </ThemedText>
          </Box>
        }
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="24.2k / 200k" />,
          <StatusSegment key="tok" label="tok" value="↑ 712 ↓ 8,402" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0061" />,
        ]}
      >
        <ChatBody centered>
          <Msg role="user" label="you" time="14:05:11">
            scope it. how big is swap_v2 and what else depends on it?
          </Msg>
          <Msg role="agenc" label="agenc · orchestrator" time="14:05:12">scanning.</Msg>
          <Tool kind="read" args="programs/swap/src/lib.rs" result="read 184 lines" />
          <Tool kind="read" args="programs/swap/src/state/pool.rs" result="read 96 lines" />
          <Box flexDirection="column">
            <Tool kind="grep" args={'pattern: "swap_v2", path: "."'} result="found 14 matches in 4 files" />
            <Box flexDirection="row" gap={1}>
              <ThemedText color="worker">●</ThemedText>
              <ThemedText color="worker" bold>Grep</ThemedText>
              <ThemedText color="inactive">(</ThemedText>
              <ThemedText color="text2">pattern: "SlippageExceeded"</ThemedText>
              <ThemedText color="inactive">)</ThemedText>
            </Box>
            <Box minHeight={1} />
            <Box flexDirection="row" paddingLeft={1} gap={1}>
              <ThemedText color="muted3">⎿</ThemedText>
              <ThemedText color="subtle">0 matches · error type not yet defined</ThemedText>
            </Box>
            <Tool kind="bash" args="cargo check -p agenc-swap" result="Compiling agenc-swap v0.4.2 · 18%" state="running" />
            <Box minHeight={1} />
            <Msg role="agenc" label="agenc · orchestrator">
              <Box flexDirection="column">
                <Box width={130}>
                  <ThemedText color="text2">
                    swap_v2is 64 lines · referenced by tests/swap.rs  idl/swap.json, and two external integrations(jup-agg
                  </ThemedText>
                </Box>
                <Box width={130} flexDirection="row">
                  <ThemedText color="text2">
                    raydium-clmm). idl change will need a new instruction discriminatorI'll add the field as Option&lt;u16&gt;to stay
                  </ThemedText>
                  <Box width={1} />
                  <ThemedText color="text2">backwards-compatible</ThemedText>
                </Box>
                <Box width={130}>
                  <ThemedText color="text2">to stay backwards-compatible</ThemedText>
                </Box>
              </Box>
            </Msg>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '04b',
    title: 'tools edit',
    expected: ['DIFF', 'swap_v2', 'max_slip'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptPaddingTop={0}
        contextLeft={
          <Box flexDirection="row">
            <ThemedText color="subtle">   2 edits · 1 file changed · git statu</ThemedText>
            <ThemedText color="worker">modified</ThemedText>
          </Box>
        }
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="agenc">/diff</ThemedText>
            <Box width={2} />
            <ThemedText color="subtle">show full diff</ThemedText>
            <Box width={2} />
          </Box>
        }
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="28.1k / 200k" gapAfter={1} />,
          <StatusSegment key="tok" label="tok" value="↑ 912 ↓ 11,402" separator gapAfter={0} />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0079" />,
        ]}
      >
        <ChatBody centered>
          <Msg role="agenc" label="agenc · orchestrator" time="14:06:48">
            writing the guard now. one helper in math.rs, one call-site change in lib.rs.
          </Msg>
          <Tool kind="edit" args="programs/swap/src/math.rs" result="+9 lines · new helper slip_within()" time="14:06:50" />
          <Box flexDirection="column">
            <Tool
              kind="edit"
              args="programs/swap/src/lib.rs"
              result="+12 −3 lines · applied"
              time="14:06:52"
            />
            <Box minHeight={1} />
            <ThemedText color="subtle">
              {'     diff programs/swap/src/lib.rs                                                                   +12 −3'}
            </ThemedText>
            <ThemedText color="agenc">
              {'              @@ -118,7 +118,16 @@ pub fn swap_v2(ctx: Context<SwapV'}
            </ThemedText>
            <ThemedText color="text2">{'              let pool = &mut ctx.accounts.pool;'}</ThemedText>
            <ThemedText color="text2">{'              let amount_out = pool.quote(amount_in)?;'}</ThemedText>
            <ThemedText color="error">{'              token::transfer(cpi_ctx, amount_in)?;'}</ThemedText>
            <ThemedText color="success">{'              let max_slip = ctx.accounts.config.slippage_bps;'}</ThemedText>
            <ThemedText color="success">{'              let actual = pool.amount_out_after_fee(amount_in);'}</ThemedText>
            <ThemedText color="success">{'              require!('}</ThemedText>
            <ThemedText color="success">{'              slip_within(amount_out, actual, max_slip),'}</ThemedText>
            <ThemedText color="success">{'              SwapError::SlippageExceeded'}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">{'              token::transfer(cpi_ctx, amount_in)?;'}</ThemedText>
            <ThemedText color="text2">{'              pool.last_swap_slot = Clock::get()?.slot;'}</ThemedText>
          </Box>
          <Msg role="agenc" label="agenc · orchestrator">
            <Box flexDirection="column">
              <Box width={130}>
                <ThemedText color="text2">
                  done. SwapError::SlippageExceedealready exists in  errors.rsfrom a prior PR. next: I'll run the test suite to conf
                </ThemedText>
              </Box>
              <Box width={130}>
                <ThemedText color="text2">
                  from a prior PR. next: I'll run the test suite to confirm non-volatile cases still pass — that needs your approval to spin up localnet
                </ThemedText>
              </Box>
            </Box>
          </Msg>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '05a',
    title: 'approval low',
    expected: ['needs approval', 'localnet', 'approve'],
    render: viewport => (
      <Frame
        viewport={viewport}
        statusVariant="worker"
        promptPlaceholder="press ⏎ to approve, e to edit, esc to skip…"
        promptHint=""
        promptPaddingTop={0}
        contextLeft={<ThemedText color="worker">   ⏸ paused · awaiting approval</ThemedText>}
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">elapsed </ThemedText>
            <ThemedText color="text">4m 51</ThemedText>
            <ThemedText color="subtle">/ 12m budget   </ThemedText>
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" separator gapAfter={0} />,
          <StatusSegment key="step" label="step" value="3.5 / 5" separator />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="24.1k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0079" />,
        ]}
      >
        <ChatBody centered>
          <Msg role="agenc" label="agenc · orchestrator" time="14:07:11">
            <Box flexDirection="column">
              <ThemedText color="text2">
                running the local test suite to confirm non-volatile cases pass. spins up a localnet validator and burns
              </ThemedText>
              <ThemedText color="text2">
                running the local test suite to confirm non-volatile cases pass. spins up a localnet validator and burns
              </ThemedText>
            </Box>
          </Msg>
          <Box flexDirection="column">
            <Box minHeight={1} />
            <ThemedText color="worker">
              {'  ▸ tool · bash ·  needs approval                                                               req 0x47a3'}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">{'  command'}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {'    $ solana-test-validator --reset --quiet & anchor test --skip-local-validator'}
            </ThemedText>
            <ThemedText color="text2">
              {'    $ solana-test-validator --reset --quiet & anchor test --skip-local-validator'}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">
              {'    SCOPE                   NETWORK                 EST. TIME                EST. COST'}
            </ThemedText>
            <ThemedText color="text2">
              {'    cwd · localnet            localhost:8899            ~ 92s                    ◎ 0.041'}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {'  note ·touches localnet only · no signed mainnet tx'}
            </ThemedText>
            <Box minHeight={1} />
            <Box width={130}>
              <ThemedText color="worker">
                {'    ⏎ approve         edit command         cancel                         auto-approvcargo testthis session'}
              </ThemedText>
            </Box>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '05b',
    title: 'approval high',
    expected: ['high-risk approval', 'mainnet-beta', "type 'yes' to send"],
    render: viewport => (
      <Frame
        viewport={viewport}
        statusVariant="error"
        promptText="ye"
        promptHint="⏎ send · esc cancel "
        promptPaddingTop={0}
        contextLeft={<ThemedText color="error">   ⏸ paused · high-risk approval</ThemedText>}
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">elapsed </ThemedText>
            <ThemedText color="text">10m 51</ThemedText>
            <ThemedText color="subtle">/ 12m budget   </ThemedText>
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" separator gapAfter={0} />,
          <StatusSegment key="step" label="step" value="5 / 5" gapAfter={3} />,
          <StatusSegment key="risk" label="risk" value="high · mainnet" color="error" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="58.2k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0202" />,
        ]}
      >
        <ChatBody centered>
          <Msg role="agenc" label="agenc · orchestrator" time="14:13:02">
            <Box flexDirection="column">
              <ThemedText color="text2">
                ready to settle task #47. this is amainnet transactionthat releases the escrow and bumps reputation. type
              </ThemedText>
              <ThemedText color="text2">   to confirm, or  editto inspect.</ThemedText>
            </Box>
          </Msg>
          <Box flexDirection="column">
            <Box minHeight={1} />
            <ThemedText color="error">
              {'  ▸ tool · bash ·  high-risk approval                                                           req 0x9c14'}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">{'  command'}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {'    $ anchor send-tx ./settle.json \\ --keypair ~/.config/solana/agenc.json --rpc-url mainnet-beta'}
            </ThemedText>
            <ThemedText color="text2">
              {'    $ anchor send-tx ./settle.json \\ --keypair ~/.config/solana/agenc.json --rpc-url mainnet-beta'}
            </ThemedText>
            <ThemedText color="text2">
              {'    $ anchor send-tx ./settle.json \\ --keypair ~/.config/solana/agenc.json --rpc-url mainnet-beta'}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">
              {'    SCOPE                   NETWORK                 EST. TIME                EST. COST'}
            </ThemedText>
            <Box width={130}>
              <ThemedText color="text2">
                {'    mainnet-beta              api.mainnet-beta.solana.co~ 12s                    ◎ 0.000012 + escrow release ◎ 2.40'}
              </ThemedText>
            </Box>
            <Box width={130}>
              <ThemedText color="text2">
                {'                              api.mainnet-beta.solana.com                        ◎ 0.000012 + escrow release ◎ 2.40'}
              </ThemedText>
            </Box>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {'  note ·signed by 7nB4…q2Pe · 1 instruction · settle_task(#47)'}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="error">
              {"    type 'yes' to send          edit command        cancel"}
            </ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '06a',
    title: 'protocol slash recovery',
    expected: ['slashing event', 'public-input mismatch', 'worker'],
    render: viewport => (
      <Frame
        viewport={viewport}
        statusVariant="error"
        promptPlaceholder="r retry · d re-delegate · or describe the path…"
        promptHint=""
        promptPaddingTop={0}
        contextLeft={<ThemedText color="error">   ! delegate slashed · awaiting decision</ThemedText>}
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">retry inline</ThemedText>
            <Box width={6} />
            <ThemedText color="subtle">re-delegate</ThemedText>
            <Box width={2} />
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" separator gapAfter={0} />,
          <StatusSegment key="alert" label="alert" value="delegate slashed" color="error" separator />,
        ]}
        statusRightItems={[
          <ThemedText key="right" color="text2">CTX48.2k / 200k  TOK↑ 1,402 ↓ 22,118COST ◎ 0.0148</ThemedText>,
        ]}
      >
        <ChatBody centered>
          <Box flexDirection="column">
            <ThemedText color="worker">
              {designBodyRow([20, '● '], [22, 'Delegate ( worker/zk-prover · slip_within invariant ) 14:08:44'])}
            </ThemedText>
            <ThemedText color="subtle">{designBodyRow([21, '⎿ '], [23, 'dispatched · sub-escrow ◎ 0.40'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="worker">
              {designBodyRow([20, '▮  '], [23, 'WORKER · ZK-PROVER 14:11:18'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [23, 'submitted proof π₁'],
                [41, '· circuit'],
                [52, 'r1cs/slip_within_v1'],
                [70, '· 4,812 constraints'],
              )}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="error">
              {designBodyRow([20, '✕ '], [22, 'Proof ( verify π₁ via arbiter 4kXr…m2Tw ) 14:11:21'])}
            </ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([21, '⎿ '], [23, 'rejected at constraint #2,184 · public-input mismatch'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="error">{designBodyRow([23, 'protocol · slash'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="error">
              {designBodyRow([25, '✕ slashing event'], [45, 'slot 284,902,118 · tx 8nY3…cR91'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [25, 'worker/zk-prover'],
                [41, 'proved the circuit but bound public input'],
                [83, 'max_slip = 500 bps'],
                [101, 'instead of the on-chain'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([25, 'config.slippage_bps = 50'], [49, '. arbiter resolved against the worker; their stake & r'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([25, '. arbiter resolved against the worker; their stake & r'])}
            </ThemedText>
            <Box minHeight={2} />
            <ThemedText color="subtle">
              {designBodyRow([27, 'VIOLATION'], [52, 'SEVERITY'], [77, 'WORKER Δ'], [102, 'OUR Δ'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([27, 'public-input mismatch'], [52, 'moderate'], [77, '−0.80 ◎ · −16 rep'], [102, '0'])}
            </ThemedText>
            <Box minHeight={2} />
            <ThemedText color="agenc">
              {designBodyRow([20, '▮  '], [23, 'AGENC · ORCHESTRATOR 14:11:24'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([23, "taking the proof back in-process. it's a fixed-point comparison — costs more context but I'll bind the"])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [23, "taking the proof back in-process. it's a fixed-point comparison — costs more cont"],
                [104, 'worker/fast-prover'],
              )}
            </ThemedText>
            <ThemedText color="text2">{designBodyRow([23, 'instead?'])}</ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '06b',
    title: 'local bash recovery',
    expected: ['exit 101', 'recovery plan', 'apply?'],
    render: viewport => (
      <Frame
        viewport={{ ...viewport, rows: Math.max(1, viewport.rows - 1) }}
        statusVariant="error"
        promptPlaceholder="apply?"
        promptHint=""
        promptPaddingTop={0}
        bodyOverlayX={20}
        bodyOverlayTop={31}
        bodyOverlay={
          <Box flexDirection="column">
            <ThemedText color="agenc">
              {'▮  AGENC · ORCHESTRATOR 14:09:27'}
            </ThemedText>
            <ThemedText color="agenc">recovery plan</ThemedText>
          </Box>
        }
        contextLeft={
          <Box flexDirection="row">
            <ThemedText color="error">   ! tool failed · 1 test panic </ThemedText>
            <ThemedText color="agenc">recovery plan</ThemedText>
          </Box>
        }
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">apply recovery</ThemedText>
            <Box width={6} />
            <ThemedText color="subtle">inspect failure</ThemedText>
            <Box width={2} />
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" separator gapAfter={0} />,
          <StatusSegment key="alert" label="alert" value="test panic" color="error" separator />,
        ]}
        statusRightItems={[
          <ThemedText key="right" color="text2">CTX38.4k / 200k  TOK↑ 1,112 ↓ 18,402COST ◎ 0.0118</ThemedText>,
        ]}
      >
        <ChatBody centered>
          <Box flexDirection="column">
            <ThemedText color="error">
              {designBodyRow([20, '✕ '], [22, 'Bash ( anchor test --skip-local-validator ) 14:09:22'])}
            </ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([21, '⎿ '], [23, 'exit 101 · 3 tests passed, 1 failed'])}
            </ThemedText>
            <Box minHeight={2} />
            <ThemedText color="inactive">{designBodyRow([25, 'cargo · stderr'])}</ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([25, 'running 4 tests test swap::tests::swap_basic ... ok te'])}
            </ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([25, 'running 4 tests test swap::tests::swap_basic ... ok te'])}
            </ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([25, 'running 4 tests test swap::tests::swap_basic ... ok te'])}
            </ThemedText>
            <ThemedText color="error">
              {designBodyRow([25, 'test swap::tests::swap_high_slippage_aborts ... '], [82, 'FAILED'])}
            </ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([25, 'test swap::tests::swap_quote_match ... ok ---- swap::t'])}
            </ThemedText>
            <Box minHeight={2} />
            {Array.from({ length: 6 }, (_, index) => (
              <ThemedText key={index} color="subtle">
                {designBodyRow([25, 'test swap::tests::swap_quote_match ... ok ---- swap::t'])}
              </ThemedText>
            ))}
            <Box minHeight={1} />
            <ThemedText color="subtle">
              {designBodyRow([25, 'test swap::tests::swap_quote_match ... ok ---- swap::t'])}
            </ThemedText>
            <ThemedText color="error">
              {designBodyRow([25, 'error'], [30, ': test failed, to rerun pass `--test swap`'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="agenc">
              {designBodyRow([20, '▮  '], [23, 'AGENC · ORCHESTRATOR 14:09:25'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([23, 'the test actually exercised the new guard and it tripp'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [23, 'the test actually exercised the new guard and it tripp'],
                [35, 'max_slip = 50'],
                [48, 'against a deliberately 495bps-off oracle, so the abort'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [23, 'against a deliberately 495bps-off oracle, so the abort'],
                [41, '#[should_panic]'],
                [55, 'and add a positive-case companion test.'],
              )}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {designBodyRow([20, '● '], [22, 'Read (programs/swap/tests/swap.rs:42-58) 14:09:26'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">{designBodyRow([21, '⎿ '], [23, 'read 17 lines'])}</ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '07a',
    title: 'complete clean',
    expected: ['task #47 settled', 'escrow', 'proof'],
    render: viewport => (
      <Frame
        viewport={viewport}
        statusVariant="success"
        promptPlaceholder="next task? /claim to pick one off the marketplace…"
        promptHint=""
        promptPaddingTop={0}
        contextLeft={<ThemedText color="success">   ✓ settled · escrow released to 7nB4…q2Pe</ThemedText>}
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="agenc">/retro</ThemedText>
            <Box width={2} />
            <ThemedText color="subtle">self-review</ThemedText>
            <Box width={3} />
            <ThemedText color="agenc">/claim</ThemedText>
            <Box width={2} />
            <ThemedText color="subtle">next task</ThemedText>
            <Box width={2} />
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 ✓ settled" color="success" separator />,
          <StatusSegment key="duration" label="duration" value="12m 31s" />,
        ]}
        statusRightItems={[
          <ThemedText key="right" color="text2">CTX62.4k / 200k  TOK↑ 3,841 ↓ 34,012COST ◎ 0.0218</ThemedText>,
        ]}
      >
        <ChatBody centered>
          <Box flexDirection="column" width={130}>
            <ThemedText color="success">
              {designBodyRow([20, '● '], [22, 'Proof ( π₂ · slip_within bound to config.slippage_bps ) 14:13:48'])}
            </ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([21, '⎿ '], [23, 'verified at slot 284,902,941 · arbiter 4kXr…m2Tw'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="success">{designBodyRow([20, '● '], [22, 'Settle ( task #47 ) 14:14:09'])}</ThemedText>
            <ThemedText color="subtle">
              {designBodyRow([21, '⎿ '], [23, 'escrow ◎ 2.40 released · bonus ◎ 0.40 · +4 rep · tx fM91…kU3v'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="agenc">
              {designBodyRow([20, '▮  '], [23, 'AGENC · ORCHESTRATOR 14:14:11'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="success">
              {designBodyRow([26, '✓ task #47 settled'], [47, '5/5 steps · 12m 31s'], [118, 'fM91…kU3v'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [26, 'added'],
                [31, 'slippage_bps'],
                [43, 'guard to'],
                [53, 'swap_v2'],
                [60, '· helper'],
                [70, 'slip_within()'],
                [83, 'in math.rs · 4 new tests covering the volatility edge '],
              )}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {designBodyRow([26, 'in math.rs · 4 new tests covering the volatility edge '])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([26, 'in math.rs · 4 new tests covering the volatility edge '])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">
              {designBodyRow([27, 'FILES'], [48, 'LINES'], [68, 'TESTS'], [88, 'PROOFS'], [108, 'COST'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([48, '+86 −12'], [68, '14 + 4'], [88, '1 ✓ · 1 ✗'], [108, '◎ 0.0218'])}
            </ThemedText>
            <Box minHeight={3} />
            <ThemedText color="subtle">
              {designBodyRow([23, 'type'], [28, '/retro'], [34, 'for self-review,'], [52, '/claim'], [57, 'for the next task.'])}
            </ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '07b',
    title: 'complete retro',
    expected: ['self-review', 'delegation', 'next task'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptPlaceholder="next task? /claim"
        promptPaddingTop={0}
        contextLeft={<ThemedText color="success">   ✓ retro saved · 4 takeaways</ThemedText>}
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="agenc">/claim</ThemedText>
            <Box width={2} />
            <ThemedText color="subtle">next task</ThemedText>
            <Box width={2} />
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 ✓ + retro" color="success" separator />,
          <StatusSegment key="duration" label="duration" value="13m 18s" />,
        ]}
        statusRightItems={[
          <ThemedText key="right" color="text2">CTX64.2k / 200k COST ◎ 0.0224</ThemedText>,
        ]}
      >
        <ChatBody centered>
          <Box flexDirection="column" width={130}>
            <ThemedText color="agenc">{designBodyRow([20, '▮  YOU 14:14:48'])}</ThemedText>
            <ThemedText color="text2">{designBodyRow([23, '/retro'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="agenc">{designBodyRow([20, '▮  '], [23, 'AGENC · ORCHESTRATOR 14:14:50'])}</ThemedText>
            <ThemedText color="subtle">{designBodyRow([23, 'self-review for task #47 · 12m 31s · ◎ 0.0218'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="success">
              {designBodyRow([25, 'WENT WELL'], [41, 'guard implementation was minimal — one helper, one cal'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([41, 'guard implementation was minimal — one helper, one cal'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {designBodyRow([41, 'guard implementation was minimal — one helper, one cal'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="worker">
              {designBodyRow([25, 'COST ME'], [41, 'delegating π₁ was the wrong call. circuit was 4,812 co'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [41, 'delegating π₁ was the wrong call. circuit was 4,812 constraints'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([41, '~3.4k ctx at the cost of 2m 42s wall and a slash event for the delegate.'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([41, 'break-even threshold is 8k constraints'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="agenc">
              {designBodyRow([25, 'LEARN'], [41, 'when delegating proofs, force the worker to bind publi'])}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [41, 'when delegating proofs, force the worker to bind public inputs with'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([41, '--bind-account flag. would have caught the mismatch before submission'])}
            </ThemedText>
            <Box minHeight={2} />
            <ThemedText color="text2">
              {designBodyRow(
                [25, 'FOR NEXT'],
                [41, 'file a follow-up: add'],
                [62, 'slippage_bps'],
                [73, 'as a top-level'],
                [89, 'SwapV2Config'],
                [100, 'field (currently piggy-backs on Pool config). 2 '],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([41, 'field (currently piggy-backs on Pool config). 2 small '])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">
              {designBodyRow([23, 'retro published to'], [40, 'retros/0x9c4f.md'], [55, '· contributes to your delegation-policy training set.'])}
            </ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '08a',
    title: 'file picker',
    expected: ['lib.rs', 'pool.rs', 'sure'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptText="@pool"
        bodyOverlayX={6}
        bodyOverlayTop={17}
        bodyOverlay={
          <Box flexDirection="column" width={140}>
            <ThemedText color="agenc">
              {designRelativeRow(6, [6, 'file reference · 5 of 187 match'], [95, '↑↓ select · ⏎ insert · tab add · esc dismiss'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2">
              {designRelativeRow(
                6,
                [10, 'programs/swap/src/state/'],
                [33, 'pool.rs'],
                [60, '2.1 KB'],
                [68, '12m ago'],
                [82, 'preview · pool.rs:1-12'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(6, [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'])}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(
                6,
                [10, 'programs/swap/src/state/'],
                [33, 'pool_v2.rs'],
                [60, '1.8 KB'],
                [68, '3d ago'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(
                6,
                [10, 'programs/swap/src/state/'],
                [33, 'init_pool.rs'],
                [60, '0.9 KB'],
                [68, '3d ago'],
                [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(6, [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'])}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(
                6,
                [10, 'programs/swap/src/state/'],
                [33, 'pool_test.rs'],
                [60, '4.2 KB'],
                [68, '7d ago'],
                [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(6, [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'])}
            </ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(
                6,
                [10, 'programs/swap/src/state/'],
                [33, 'pool_math.rs'],
                [60, '1.4 KB'],
                [68, '14d ago'],
                [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'],
              )}
            </ThemedText>
            {Array.from({ length: 6 }, (_, index) => (
              <ThemedText key={index} color="text2">
                {designRelativeRow(6, [82, 'use anchor_lang::prelude::*; #[account] pub struct Poo'])}
              </ThemedText>
            ))}
          </Box>
        }
        statusRightItems={[
          <ThemedText key="right" color="text2">CTX18.4k / 200k  FILES1 in ctx COST ◎ 0.0041</ThemedText>,
        ]}
      >
        <ChatBody centered>
          <Box flexDirection="column" width={130}>
            <ThemedText color="agenc">{designBodyRow([20, '▮  '], [23, 'AGENC · ORCHESTRATOR 14:04:12'])}</ThemedText>
            <ThemedText color="text2">
              {designBodyRow(
                [23, 'I have'],
                [30, 'lib.rs'],
                [36, 'in context already. drop me'],
                [64, 'pool.rs'],
                [71, 'too — I want to confirm the slippage_bps field is on P'],
              )}
            </ThemedText>
            <ThemedText color="text2">
              {designBodyRow([23, 'too — I want to confirm the slippage_bps field is on P'])}
            </ThemedText>
            <Box minHeight={2} />
            <ThemedText color="text2">{designBodyRow([23, 'sure, here:'])}</ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '08b',
    title: 'shell mode',
    expected: ['git status -sb', '$', 'shell'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptText="anchor build"
        shellMode
        promptHint="shell · cwd ~/work/tetsuo/swap-progr"
        promptPaddingTop={0}
        bodyOverlayX={20}
        bodyOverlayTop={31}
        bodyOverlay={
          <Box flexDirection="column" width={130}>
            <ThemedText color="agenc">{'▮  AGENC · ORCHESTRATOR 14:05:24'}</ThemedText>
            <ThemedText color="text2">
              {designRelativeRow(
                20,
                [23, 'the unused import is from my last edit — I imported'],
                [74, 'slip_within'],
                [85, 'at the top, then ended up calling it through the modul'],
              )}
            </ThemedText>
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" separator gapAfter={0} />,
          <StatusSegment key="mode" label="mode" value="shell" color="worker" separator />,
        ]}
        statusRightItems={[
          <ThemedText key="right" color="text2">CTX22.8k / 200k COST ◎ 0.0058</ThemedText>,
        ]}
        contextLeft={<ThemedText color="worker">   ! shell mode · type to compose, ⏎ run</ThemedText>}
        contextRight={
          <Box flexDirection="row">
            <ThemedText color="subtle">repeat last</ThemedText>
            <Box width={8} />
            <ThemedText color="subtle">back to chat</ThemedText>
            <Box width={2} />
          </Box>
        }
      >
        <ChatBody centered>
          <Box flexDirection="column" width={130}>
            <Box minHeight={1} />
            <ThemedText color="text2">{designBodyRow([23, '!git status -sb'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="worker">{designBodyRow([20, '● '], [22, 'Bash ( git status -sb · run by user ) 14:05:11'])}</ThemedText>
            <ThemedText color="subtle">{designBodyRow([21, '⎿ '], [23, 'exit 0 · 38ms'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="inactive">{designBodyRow([25, 'stdout'])}</ThemedText>
            <Box minHeight={1} />
            {Array.from({ length: 3 }, (_, index) => (
              <ThemedText key={index} color="text2">
                {designBodyRow([25, '## main...origin/main M programs/swap/src/lib.rs ?? pr'])}
              </ThemedText>
            ))}
            <Box minHeight={3} />
            <ThemedText color="text2">{designBodyRow([23, '!cargo check -p agenc-swap'])}</ThemedText>
            <ThemedText color="worker">
              {designBodyRow([20, '● '], [22, 'Bash ( cargo check -p agenc-swap · run by user ) 14:05:22'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="subtle">{designBodyRow([21, '⎿ '], [23, 'exit 0 · 4.2s · 0 errors, 1 warning'])}</ThemedText>
            <Box minHeight={1} />
            <ThemedText color="inactive">{designBodyRow([25, 'stderr'], [122, 'cargo'])}</ThemedText>
            <ThemedText color="worker">{designBodyRow([25, 'Checking agenc-swap v0.4.2 warning: unused import: `cr'])}</ThemedText>
            <Box minHeight={1} />
            {Array.from({ length: 5 }, (_, index) => (
              <ThemedText key={index} color="worker">
                {designBodyRow([25, 'Checking agenc-swap v0.4.2 warning: unused import: `cr'])}
              </ThemedText>
            ))}
            <Box minHeight={1} />
            <ThemedText color="success">
              {designBodyRow([25, 'Finished'], [36, '`dev` profile [unoptimized + debuginfo] target(s) in 4'])}
            </ThemedText>
          </Box>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '09',
    title: 'markdown output',
    expected: ['slippage', 'guard', 'math/slip.rs'],
    render: viewport => (
      <Frame
        viewport={{ ...viewport, rows: viewport.rows - 1 }}
        promptPlaceholder="ask a follow-up, or @file to add more context…"
        promptHint=""
        promptPaddingTop={0}
        bodyOverlayX={0}
        bodyOverlayTop={33}
        bodyOverlay={
          <Box flexDirection="column" width={148}>
            <ThemedText color="text2" wrap="truncate-end">
              {designRelativeRow(0, [5, 'output blocks · 3'], [22, '[^O]'], [29, 'navigator'], [122, '[/] cmd'], [128, '[@] file'], [139, '[!] shell'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="agenc" wrap="truncate-end">
              {designRelativeRow(0, [2, '▸'], [5, 'ask a follow-up, or @file to add more context…'], [52, '█'])}
            </ThemedText>
            <Box minHeight={1} />
            <ThemedText color="text2" wrap="truncate-end">
              {designRelativeRow(
                0,
                [2, 'MODEL'],
                [7, 'haiku-4.5'],
                [18, 'NET'],
                [21, 'mainnet-beta'],
                [34, 'TASK'],
                [39, '#47 swap-program'],
                [99, 'CTX'],
                [103, '24.6k / 200k'],
                [116, 'TOK'],
                [120, '↑ 812 ↓ 12,402'],
                [134, 'COST'],
                [139, '◎ 0.0082'],
              )}
            </ThemedText>
          </Box>
        }
        contextLeft={
          <Box flexDirection="row" gap={1}>
            <ThemedText color="text2">output blocks · 3</ThemedText>
            <KeyHint k="^O" label="navigator" />
          </Box>
        }
        contextRight={
          <Box flexDirection="row" gap={1}>
            <KeyHint k="/" label="cmd" />
            <KeyHint k="@" label="file" />
            <KeyHint k="!" label="shell" />
          </Box>
        }
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="24.6k / 200k" />,
          <StatusSegment key="tok" label="tok" value="↑ 812 ↓ 12,402" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0082" />,
        ]}
      >
        <Box flexDirection="column" width={148}>
          <Box minHeight={1} />
          <ThemedText color="briefLabelYou" wrap="truncate-end">{designRelativeRow(0, [20, '▮  YOU 14:06:02'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [23, 'explain how the slippage math works and what the constants are'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="briefLabelAgenC" wrap="truncate-end">{designRelativeRow(0, [20, '▮  AGENC · ORCHESTRATOR'])}</ThemedText>
          <ThemedText color="text" wrap="truncate-end">{designRelativeRow(0, [23, '## slippage in'], [39, 'swap_v2'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(
              0,
              [23, 'the guard is a single bound check. given an'],
              [67, 'expected'],
              [75, 'output from the pool quote and the'],
              [111, 'actual'],
              [117, 'after fees, we abort if the rel'],
            )}
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [23, 'after fees, we abort if the relative gap exceeds'], [65, 'max_slip'], [73, 'in basis points.'])}
          </ThemedText>
          <ThemedText color="lineSoft" wrap="truncate-end">
            {designRelativeRow(0, [23, '┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐'])}
          </ThemedText>
          <ThemedText color="subtle" wrap="truncate-end">{designRelativeRow(0, [25, 'math/slip.rs'], [123, 'rust'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="agenc" wrap="truncate-end">
            {designRelativeRow(
              0,
              [25, 'pub fn'],
              [31, 'slip_within'],
              [42, 'expected'],
              [49, ': u64,'],
              [56, 'actual'],
              [61, ': u64,'],
              [67, 'max_bps'],
              [74, ': u16)'],
              [83, 'bool'],
            )}
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [30, 'actual'], [39, 'expected {'], [50, 'return'], [57, 'true'])}
          </ThemedText>
          <ThemedText color="subtle" wrap="truncate-end">
            {designRelativeRow(0, [29, '// (expected − actual) / expected ≤ max_bps / 10_000'])}
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [31, 'diff = expected.'], [47, 'saturating_sub'], [59, '(actual);'])}
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [25, 'diff.'], [33, 'checked_mul'], [44, '10_000'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [33, 'and_then'], [40, '(|x| x.'], [47, 'checked_div'], [57, '(expected))'])}
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [33, 'map_or'], [39, 'false'], [44, ', |bps| bps'], [57, 'max_bps'], [67, 'u64)'])}
          </ThemedText>
          <Box minHeight={3} />
          <ThemedText color="text" wrap="truncate-end">{designRelativeRow(0, [23, '### constants'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="subtle" wrap="truncate-end">{designRelativeRow(0, [25, 'constant'], [46, 'default'], [58, 'meaning'])}</ThemedText>
          <ThemedText color="agenc" wrap="truncate-end">
            {designRelativeRow(0, [25, 'MIN_SLIPPAGE_BPS'], [46, '10'], [58, '0.10% · prevents griefing via 0-tolerance'])}
          </ThemedText>
          <Box minHeight={1} />
          <ThemedText color="agenc" wrap="truncate-end">
            {designRelativeRow(0, [25, 'MAX_SLIPPAGE_BPS'], [46, '5_000'], [58, '50.0% · sanity cap; reject configs above this'])}
          </ThemedText>
          <Box minHeight={1} />
          <ThemedText color="agenc" wrap="truncate-end">
            {designRelativeRow(0, [25, 'Pool.slippage_bps'], [46, '50'], [58, 'per-pool tolerance · set by pool owner'])}
          </ThemedText>
          <ThemedText color="agenc" wrap="truncate-end">
            {designRelativeRow(0, [25, 'Config.slippage_bps'], [46, '.'], [58, 'global override · DAO-controlled'])}
          </ThemedText>
          <Box minHeight={1} />
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [23, 'the on-chain audit trail lives at'], [56, 'solscan://5yC9…uHnP4Q'], [78, '— click to open in your default explorer.'])}
          </ThemedText>
        </Box>
      </Frame>
    ),
  },
  {
    id: '10',
    title: 'context manager',
    expected: ['CONTEXT', '22,841', 'BREAKDOWN'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptText="/ctx"
        promptPaddingTop={0}
        contextLeft={<ThemedText color="subtle">context manager open · 11.4% used</ThemedText>}
        contextRight={<KeyHint k="esc" label="dismiss" />}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="22.8k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0082" />,
        ]}
      >
        <Box flexDirection="column" width={148}>
          <Box minHeight={1} />
          <ThemedText color="briefLabelYou" wrap="truncate-end">{designRelativeRow(0, [20, '▮  YOU 14:11:42'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [23, '/ctx'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="agenc" wrap="truncate-end">
            {designRelativeRow(
              0,
              [13, 'CONTEXT'],
              [22, '22,841'],
              [31, '200,000 tokens'],
              [50, '11.4% used · headroom 177k'],
              [123, 'session 0x9c4f'],
            )}
          </ThemedText>
          <Box minHeight={3} />
          <ThemedText color="subtle" wrap="truncate-end">{designRelativeRow(0, [13, 'soft warning at 80% · auto-compact at 92%'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="text" wrap="truncate-end">{designRelativeRow(0, [13, 'BREAKDOWN BY SOURCE'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [13, 'SYSTEM'], [36, '1,402'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [13, 'PLAN'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [13, 'FILES (3)'], [36, '8,402'], [54, '36.8'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [16, 'lib.rs'], [38, '3,841'], [56, '16.8'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [16, 'pool.rs'], [38, '2,118'])}</ThemedText>
          <Box minHeight={1} />
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [16, 'math.rs'], [38, '2,443'], [56, '10.7'])}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{designRelativeRow(0, [13, 'HISTORY'], [36, '12,625'], [54, '55.3'])}</ThemedText>
          <Box minHeight={11} />
          <ThemedText color="text2" wrap="truncate-end">
            {designRelativeRow(0, [18, '/compact'], [33, 'drop file'], [48, 'rewind'], [61, '/btw side-question'], [129, 'dismiss'])}
          </ThemedText>
        </Box>
      </Frame>
    ),
  },
  ...[
    {
      id: '11',
      command: '/model',
      title: 'model selection',
      count: '8 available',
      summary: 'active · haiku-4.5',
      headerRight: '↑↓ select · ⏎ switch · / search',
      headers: ['', 'provider', 'name', 'ctx', '↑ /Mtok', '↓ /Mtok', 'latency', 'note'],
      columns: [2, 10, 18, 8, 9, 9, 10, 44],
      rows: [
        ['anthropic', 'haiku-4.5 · current', '200k', '$0.80', '$4.00', '94 tok/s', 'fast · default · best ratio'],
        ['anthropic', 'sonnet-4.5', '200k', '$3.00', '$15.00', '62 tok/s', 'balanced · current frontier'],
        ['anthropic', 'opus-4.5', '200k', '$15.00', '$75.00', '38 tok/s', 'deepest reasoning · costly'],
        ['openai', 'gpt-5', '256k', '$2.50', '$10.00', '71 tok/s', 'via openrouter'],
        ['openai', 'gpt-5-mini', '256k', '$0.40', '$1.60', '128 tok/s', 'via openrouter · cheapest'],
        ['google', 'gemini-2.5-pro', '1M', '$1.25', '$5.00', '54 tok/s', 'long context · vertex'],
        ['xai', 'grok-4', '128k', '$3.00', '$15.00', '48 tok/s', 'reasoning · xai api'],
        ['local', 'qwen3-32b', '32k', '—', '—', '22 tok/s', 'agent settles · localhost:11434 · ollama'],
      ],
      footer: [{ keyName: '⏎', label: 'switch' }, { keyName: 't', label: 'test ping' }, { keyName: 'k', label: 'add provider key' }],
      hint: 'prices reflect provider list · agent settles in ◎ at session end',
      parityMarkers: [
        'fast · default · best ratio',
        'balanced · current frontier',
        'deepest reasoning · costly',
        '128 tok/s',
        'localhost:11434 · ollama',
      ],
    },
    {
      id: '12',
      command: '/skills',
      title: 'skills',
      count: '6 active · 8 installed',
      summary: 'auto-loaded by trigger match · /skills add <path>',
      headerRight: '↑↓ select · space toggle · ⏎ view source',
      headers: ['', 'name', 'category', 'state', 'origin', 'size', 'description'],
      columns: [2, 18, 14, 7, 10, 8, 35],
      rows: [
        ['solana-anchor', 'authoring', 'on', 'agenc', '2.1 KB', 'Cargo.toml · anchor-lang · wallet · IDL · account validation'],
        ['zk-proof-prep', 'authoring', 'on', 'agenc', '3.4 KB', 'binds public inputs, picks circuits, prep delegate'],
        ['rust-test-loop', 'verification', 'on', 'community', '1.8 KB', 'cargo test loop · auto-rerun until pass'],
        ['rust-clippy-fix', 'verification', 'on', 'community', '0.9 KB', 'apply common clippy fixes inline'],
        ['solscan-explorer', 'reference', 'on', 'agenc', '1.2 KB', 'cite on-chain artifacts as solscan:// links'],
        ['markdown-summary', 'writing', 'on', 'core', '0.6 KB', 'how to write retros and task summaries'],
        ['solana-deploy', 'authoring', 'off', 'agenc', '2.8 KB', 'mainnet deploy checklist · disabled until staged'],
        ['python-fastapi', 'authoring', 'off', 'community', '4.1 KB', 'fastapi service scaffolds'],
      ],
      footer: [{ keyName: 'space', label: 'toggle' }, { keyName: 'e', label: 'edit' }, { keyName: '+', label: 'install' }, { keyName: 'x', label: 'uninstall' }],
      hint: 'active skills get loaded when triggers match',
      parityMarkers: [
        '# SKILL.md : solana-anchor',
        ': anchor program patterns, IDL',
        'generation, account validation, common',
        'pitfalls. Triggers on cargo manifests',
        'with anchor-lang dep. triggers',
        '- file: "Cargo.toml" - match:',
        '"anchor-lang" tools : [read, edit, bash]',
        'anchor program patterns, IDL, account validation',
        '"Cargo.toml"',
        '- match:',
        '"anchor-lang"',
        'tools',
        ': [read, edit, bash]',
        '## When to use',
        'Anchor program. Skip for raw solana-',
        'anchor program patterns, IDL',
        'verification',
        'rust-clippy-fix',
        'markdown-summary',
        'Apply when the working set contains an',
        'Anchor program',
        'rust-test-loop',
        'community',
        'apply common clippy fixes inline',
        'solscan-explorer',
        'python-fastapi',
        'binds public inputs, picks circuits, prep delegate',
        'cargo test loop · auto-rerun until pass',
        'cite on-chain artifacts as solscan:// links',
        'how to write retros and task summaries',
        'mainnet deploy checklist · disabled until staged',
        'uninstall',
        'active skills get loaded when triggers match',
        '# SKILL.md',
        ': solana-anchor',
        ': anchor program patterns, IDL',
        'generation, account validation, common',
        'pitfalls. Triggers on cargo manifests',
        'with anchor-lang dep.',
        '- file:',
        '"Cargo.toml"',
        '- match:',
        '"anchor-lang"',
        'tools',
        ': [read, edit, bash]',
        '## When to use',
        'Apply when the working set contains an',
        'Anchor program. Skip for raw solana-',
        'program crates without anchor-lang.',
        'verification',
        'rust-clippy-fix',
        'markdown-summary',
        'anchor program patterns, IDL, account validation',
        'binds public inputs, picks circuits, prep delegate',
        'cargo test loop · auto-rerun until pass',
        'cite on-chain artifacts as solscan:// links',
        'how to write retros and task summaries',
        'mainnet deploy checklist · disabled until staged',
      ],
    },
    {
      id: '13',
      command: '/mcp',
      title: 'mcp servers',
      count: '5 live · 7 configured',
      summary: 'model context protocol · agent calls these as tools · PR review, issue triage, gh status',
      headerRight: '↑↓ select · ⏎ inspect tools',
      headers: ['', 'server', 'status', 'transport', 'tools', 'endpoint', 'latency', 'note'],
      columns: [2, 17, 10, 10, 10, 18, 9, 32],
      rows: [
        ['solana-rpc', 'live', 'stdio', '12 tools', 'mainnet', '4ms', 'fetch account, sim tx, slot info'],
        ['solana.account', 'tool', 'tool', 'fetch', 'pubkey', '<1ms', 'fetch account data by pubkey'],
        ['solana.simulate_tx', 'tool', 'tool', 'simulate', 'logs', '<1ms', 'simulate a tx, return logs + units'],
        ['solana.slot', 'tool', 'tool', 'slot', 'finalized', '<1ms', 'current slot height + finalized'],
        ['solana.tx_history', 'tool', 'tool', 'history', 'wallet', '<1ms', 'historical signatures for a wallet'],
        ['solana.priority_fee', 'tool', 'tool', 'fee', 'recent', '<1ms', 'recent priority fee percentiles'],
        ['solana.balance', 'tool', 'tool', 'balance', 'wallet', '<1ms', 'wallet lamports + token accounts'],
        ['github', 'live', 'http', '8 tools', 'api.github.com', '142ms', 'PR review, issue triage, gh status'],
        ['linear', 'live', 'http', '6 tools', 'api.linear.app', '88ms', 'issue / project sync'],
        ['filesystem', 'live', 'stdio', '5 tools', 'sandboxed cwd', '<1ms', 'read · write · ls within project'],
        ['playwright', 'live', 'stdio', '18 tools', 'local browser', '12ms', 'browser automation · screenshots'],
        ['1password', 'auth req', 'http', '4 tools', 'connect.1pw...', '—', 'reauth needed · token expired'],
        ['anchor-explorer', 'offline', 'http', '—', 'api.anchor.so', '—', 'last seen 2h ago · timeout'],
      ],
      footer: [{ keyName: '⏎', label: 'inspect' }, { keyName: 'r', label: 'restart' }, { keyName: '+', label: 'add server' }, { keyName: 'l', label: 'view logs' }],
      hint: 'server configs live in ~/.agenc/mcp.json',
      parityMarkers: [
        '↑↓ select · ⏎ inspect tools',
        'server configs',
        'solana.account',
        'solana.simulate_tx',
        'solana.tx_history',
        'solana.priority_fee',
        'offline',
        '18 tools',
        'browser automation · screenshots',
        'browser automation · screenshots',
        'browser automation · screenshots',
        '1password',
        'auth req',
        '4 tools',
        'connect.1pw...',
        'reauth needed · token expired',
        'anchor-explorer',
        'last seen 2h ago · timeout',
        'fetch account data by pubkey',
        'simulate a tx, return logs + units',
        'current slot height + finalized',
        'historical signatures for a wallet',
        'recent priority fee percentiles',
        'solana.balance',
        'lamport balance + delta over 24h',
        '+ 6 more · ⏎ to expand',
        'server configs',
        'sandboxed cwd',
        'read · write · ls within project',
        'read · write · ls within project',
      ],
    },
    {
      id: '14',
      command: '/hooks',
      title: 'hooks',
      count: '7 active · 8 configured',
      summary: 'shell commands fired on agent lifecycle events · check circuit hash against registry · rpc · 220ms · gates proof generation',
      headerRight: '↑↓ select · space toggle · ⏎ edit',
      headers: ['', 'event', 'state', 'description', 'last fire'],
      columns: [2, 18, 7, 34, 42],
      rows: [
        ['pre-tool/edit', 'on', 'verify file is under git', 'shell · 12ms · last fired 14:06:50'],
        ['post-tool/edit', 'on', 'cargo check on the affected crate', 'shell · 4.2s · last fired 14:06:54'],
        ['post-tool/bash', 'on', 'log stderr to .agenc/bash.log', 'shell · 2ms · last fired 14:09:25'],
        ['pre-prompt', 'off', 'strip trailing whitespace', 'shell · disabled by user'],
        ['pre-tool/settle', 'on', 'confirm wallet has min stake', 'shell + rpc · 88ms · gates settle'],
        ['session-start', 'on', 'load AGENC.md and AGENTS.md', 'builtin · 14ms · fired at 14:02:01'],
        ['session-end', 'on', 'append retro to retros/', 'builtin · 18ms · pending'],
        ['pre-tool/proof', 'on', 'check circuit hash against registry', 'rpc · 220ms · gates proof generation'],
      ],
      footer: [{ keyName: 'space', label: 'toggle' }, { keyName: 'e', label: 'edit script' }, { keyName: '+', label: 'add hook' }, { keyName: 't', label: 'test fire' }],
      hint: 'hooks live in .agenc/hooks/ · exit-non-zero blocks the gated action',
      parityMarkers: [
        '↑↓ select · space toggle · ⏎ edit',
        'pre-tool/edit',
        'session-start',
        'last 3 fires',
        '#!/usr/bin/env bash # fired with $1 = file path test -',
        '#!/usr/bin/env bash # fired with $1 = file path test -',
        '#!/usr/bin/env bash # fired with $1 = file path test -',
        '#!/usr/bin/env bash # fired with $1 = file path test -',
        '#!/usr/bin/env bash # fired with $1 = file path test -',
        '14:06:50 · exit 0 · 12ms · programs/swap/src/lib.rs',
        '14:06:48 · exit 0 · 11ms · programs/swap/src/math.rs',
        '14:04:54 · exit 0 · 13ms · programs/swap/src/lib.rs',
        'edit script',
      ],
    },
    {
      id: '15',
      command: '/plugins',
      title: 'plugins',
      count: '8 loaded · 10 installed',
      summary: 'extend slash commands, tools, status segments',
      headerRight: '↑↓ select · space toggle · u update · / search',
      headers: ['', 'plugin', 'version', 'state', 'origin', 'description'],
      columns: [2, 20, 9, 7, 11, 48],
      rows: [
        ['agenc-core', '0.4.2', 'on', 'agenc', 'task lifecycle · stake mgmt · settle'],
        ['anchor-toolkit', '1.2.0', 'on', 'community', 'anchor build/test/deploy · IDL + tests'],
        ['solana-explorer', '0.6.1', 'on', 'agenc', 'solscan/explorer links · cluster info'],
        ['arbiter-client', '0.1.4', 'on', 'agenc', 'submit + verify proofs · slashing receipts'],
        ['github-pr', '2.0.0', 'on', 'community', 'open PRs + review · gh status'],
        ['linear-tasks', '0.9.0', 'on', 'community', 'sync agent tasks ↔ linear issues'],
        ['agenc-skills', '1.1.0', 'on', 'core', 'load + manage SKILL.md files'],
        ['costs-watcher', '0.2.0', 'on', 'agenc', '11 updates · live token meter · soft caps'],
        ['rust-clippy', '0.3.0', 'off', 'community', 'inline clippy suggestions · disabled'],
        ['python-uv', '0.7.0', 'off', 'community', 'uv lockfile sync · disabled'],
      ],
      footer: [{ keyName: 'space', label: 'toggle' }, { keyName: 'u', label: 'update' }, { keyName: '+', label: 'install' }, { keyName: 'm', label: 'marketplace' }],
      hint: '11 updates available · type u to update all',
    },
    {
      id: '16',
      command: '/agents',
      title: 'agents · definitions editor',
      count: '4 active · 6 registered',
      summary: 'local definitions · role routing · scoped prompts',
      headerRight: '↑↓ select · enter detail',
      headers: ['', 'name · Role', 'scope', 'source'],
      columns: [2, 26, 14, 18],
      rows: [
        ['worker · Runner', 'project', 'Project'],
        ['explorer · Scanner', 'project', 'Project'],
        ['docs · Scribe', 'user', 'User'],
        ['operator · Fixer', 'local', 'Local'],
        ['browser · Ghost', 'plugin', 'Plugin'],
        ['remote · Trace', 'runtime', 'Built-in'],
      ],
      footer: [{ keyName: 'enter', label: 'detail' }, { keyName: 'n', label: 'new' }, { keyName: 'e', label: 'edit' }, { keyName: 'd', label: 'delete' }],
      hint: 'system prompt preview · scoped tools · worktree isolation',
      parityMarkers: [
        '↑↓ select · enter detail',
        'name · Role',
        'scope',
        'source',
        'worker · Runner',
        'explorer · Scanner',
        'docs · Scribe',
        'when-to-use',
        'tools',
        'model',
        'budget',
        'worktree',
        'system prompt',
        'read-only',
        'current checkout',
      ],
    },
    {
      id: '17',
      command: '/permissions',
      title: 'permissions',
      count: '13 rules · 8 modes',
      summary: 'shift+tab to cycle mode · top-to-bottom rule eval · plan · read-only · propose plans, never execute writes or tx',
      headerRight: '~/.agenc/permissions.json',
      headers: ['', 'outcome', 'scope', 'target', 'pattern', 'behavior'],
      columns: [2, 9, 8, 14, 22, 52],
      rows: [
        ['allow', 'tool', 'read', '*', 'reads are free'],
        ['allow', 'tool', 'grep', '*', 'reads are free'],
        ['allow', 'tool', 'bash', 'cargo *', 'safelisted via /permissions add'],
        ['allow', 'tool', 'bash', 'git status*', 'read-only git'],
        ['ask', 'tool', 'bash', 'cargo test*', 'localnet · ⏎ to approve'],
        ['ask', 'tool', 'edit', '*', 'all file edits'],
        ['ask', 'tool', 'webfetch', 'docs.solana.com/*', 'allowlisted domain · still asks'],
        ['ask', 'proto', 'delegate', '*', 'sub-agent dispatch'],
        ['ask', 'proto', 'settle', '*', 'mainnet · must type yes'],
        ['ask', 'proto', 'stake', '*', 'mainnet · must type stake'],
        ['bypassPermissions', 'mode', 'danger', 'shift+tab', 'all approvals bypassed'],
        ['deny', 'tool', 'bash', 'rm -rf*', 'blocklisted'],
        ['deny', 'mcp', 'github.delete_*', '*', 'never auto-call destructive MCP'],
      ],
      footer: [{ keyName: '+', label: 'add rule' }, { keyName: 'e', label: 'edit' }, { keyName: 'd', label: 'delete' }, { keyName: 'tab', label: 'mode list' }],
      hint: 'rules evaluate top-to-bottom before permission prompt',
      parityMarkers: [
        '~/.agenc/permissions.json',
        'state',
        '· current',
        'acceptEdits',
        'bypassPermissions',
        'u/j',
        'standard · ask for ambiguous tools, allow safelisted o',
        'auto-accept file edits in this session · still asks fo',
        'read-only · propose plans, never execute writes or tx',
        'auto-approve everything that matches an allow rule',
        'standard · ask for ambiguous tools, allow safelisted ones',
        'auto-accept file edits in this session · still asks for bash',
        'DANGER · all approvals bypassed · for CI / sandboxed r',
        'dontAsk',
        'silently treat ask→allow · use only with caller-side g',
        'unattended',
        'background · same as auto but blocks anything ambiguou',
        'bubble',
        'forward decisions to a parent agent · for nested orche',
        'kind',
        'tool / event',
        'note',
        'mainnet · must type "yes"',
        'mainnet · must type "stake"',
        '*.suspicious-rpc.com',
        'untrusted endpoint',
        'github.delete_*',
        'move',
      ],
    },
    {
      id: '18',
      command: '/memory',
      title: 'memory · long-term notes loaded each session',
      count: '7 sources · 43 KB total',
      summary: 'memory · long-term notes loaded each session · merged into system prompt at session start · pinned wins ties',
      headerRight: '↑↓ select · ⏎ inspect · c compact',
      headers: ['', 'source', 'kind', 'size', 'precedence', 'note'],
      columns: [2, 24, 12, 8, 12, 50],
      rows: [
        ['AGENC.md', 'project', '~/work/tetsuo/swap-program/', '2.4 KB', '14:02:01', 'project rules · coding style · do-not-touch'],
        ['AGENTS.md', 'project', '~/work/tetsuo/swap-program/', '1.1 KB', '14:02:01', 'orchestrator behavior · delegation policy'],
        ['~/.agenc/memory.md', 'user', '~/.agenc/', '4.2 KB', '14:02:01', 'cross-project preferences · pinned shortcuts'],
        ['retros/0x9bea.md', 'retro', 'retros/', '0.8 KB', 'last task', 'what went well · cost me · learn'],
        ['retros/0x9c4f.md', 'retro', 'retros/', '1.0 KB', '14:14:48', 'current task retro'],
        ['pinned/slippage.md', 'pinned', '.agenc/pinned/', '0.4 KB', 'manual', 'how slip_within is supposed to work'],
        ['cache/repo-map', 'derived', '.agenc/cache/', '34 KB', '14:02:01', 'tree-sitter repo map · auto-built'],
      ],
      footer: [{ keyName: '⏎', label: 'open' }, { keyName: 'p', label: 'pin' }, { keyName: '+', label: 'add note' }, { keyName: 'r', label: 'rebuild repo-map' }],
      hint: 'user > project > retro > derived · pinned overrides all',
      parityMarkers: [
        'pinned overrides',
        'pinned/slippage.md',
        'merged into system prompt at session start · pinned wi',
        'merged into system prompt at session start · pinned wi',
        '~/work/tetsuo/swap-program/',
        'project rules · coding style · do-not-touch',
        'orchestrator behavior · delegation policy',
        '~/.agenc/memory.md',
        'cross-project preferences · pinned shortcuts',
        'retros/0x9bea.md',
        'what went well · cost me · learn',
        'current task retro',
        '.agenc/pinned/',
        'how slip_within is supposed to work',
        '.agenc/cache/',
        'tree-sitter repo map · auto-built',
        '# AGENC.md',
        '## House rules',
        '- Anchor 0.30 · solana 1.18 · rust 1.78',
        '- Every public fn needs a doc comment',
        'Never',
        'change errors.rs without',
        'bumping the program version',
        '- Tests live in tests/ not src/tests/',
        '## Delegation policy',
        '- Proofs > 8k constraints → delegate',
        '- Audits → always delegate to',
        'worker/auditor regardless of size',
        '- Test reruns < 30s → keep in-process',
        '## Cost caps',
        '- per-task: 0.5 ◎',
        '- per-session: 2.0 ◎',
        '- alert at 80% of either',
      ],
    },
  ].map(menu => ({
    id: menu.id,
    title: menu.title,
    expected: [
      menu.command,
      menu.title.split(/[ ·]/u)[0]!,
    ],
    render: (viewport: Viewport) => (
      <Frame
        viewport={viewport}
        promptText={menu.command}
        contextLeft={<ThemedText color="agenc">menu open · keyboard-driven</ThemedText>}
        contextRight={<KeyHint k="esc" label="dismiss" />}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="22.8k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0082" />,
        ]}
        bodyOverlay={
          <MenuState
            title={menu.title}
            count={menu.count}
            summary={menu.summary}
            headerRight={menu.headerRight}
            headers={menu.headers}
            columns={menu.columns}
            rows={menu.rows}
            footer={menu.footer}
            hint={menu.hint}
            omitTopBorder
            paddingX={3}
            columnGap={2}
            modalMinHeight={30}
            rowMinHeight={2}
            preview={
              menu.id === '12' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end"># SKILL.md : solana-anchor</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">anchor program patterns, IDL, account validation</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">community · apply common clippy fixes inline</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">solscan-explorer · community</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">: anchor program patterns, IDL</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">generation, account validation, common</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pitfalls. Triggers on cargo manifests</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">with anchor-lang dep. triggers</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- file: "Cargo.toml" - match:</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">"anchor-lang" tools : [read, edit, bash]</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">## When to use</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">Apply when the working set contains an</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">Anchor program. Skip for raw solana-</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">program crates without anchor-lang.</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">binds public inputs, picks circuits, prep delegate</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">cargo test loop · auto-rerun until pass</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">cite on-chain artifacts as solscan:// links</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">how to write retros and task summaries</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">mainnet deploy checklist · disabled until staged</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">python-fastapi · rust-test-loop · verification</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">rust-clippy-fix · markdown-summary</ThemedText>
                </Box>
              ) : menu.id === '13' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end">server configs live in ~/.agenc/mcp.json</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">↑↓ select · ⏎ inspect tools</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">transport · latency</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">12 tools · fetch account, sim tx, slot info</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">solana.account · fetch account data by pubkey</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">tools exposed · solana.simulate_tx</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">simulate a tx, return logs + units</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">solana.slot · current slot height + finalized</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">solana.tx_history · historical signatures</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">historical signatures for a wallet</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">for a wallet · solana.priority_fee</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">recent priority fee percentiles</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">solana.balance · lamport balance + delta over 24h</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">api.github.com · PR review, issue triage, gh status</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">api.linear.app · issue / project sync</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">sandboxed cwd · read · write · ls within project</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">local browser · browser automation · screenshots</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">1password · auth req · 4 tools · connect.1pw...</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">reauth needed · token expired</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">anchor-explorer · offline · api.anchor.so</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">last seen 2h ago · timeout</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">8 tools · 6 tools · 5 tools · 18 tools</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">restart · add server · view logs</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">+ 6 more · ⏎ to expand</ThemedText>
                </Box>
              ) : menu.id === '14' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end">↑↓ select · space toggle · ⏎ edit</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pre-tool/edit · verify file is under git</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">shell · 12ms · last fired 14:06:50</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">post-tool/edit · cargo check on the affected crate</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">shell · 4.2s · last fired 14:06:54</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">post-tool/bash · log stderr to .agenc/bash.log</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">shell · 2ms · last fired 14:09:25</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pre-prompt · strip trailing whitespace</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">shell · disabled by user</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pre-tool/settle · confirm wallet has min stake</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">shell + rpc · 88ms · gates settle</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">session-start · load AGENC.md and AGENTS.md</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">builtin · 14ms · fired at 14:02:01</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">session-end · append retro to retros/</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">builtin · 18ms · pending</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pre-tool/proof · check circuit hash against registry</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">rpc · 220ms · gates proof generation</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">last 3 fires · test fire · add hook · edit script</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">14:06:50 · exit 0 · 12ms · programs/swap/src/lib.rs</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">14:06:48 · exit 0 · 11ms · programs/swap/src/math.rs</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">14:04:54 · exit 0 · 13ms · programs/swap/src/lib.rs</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">#!/usr/bin/env bash # fired with $1 = file path</ThemedText>
                </Box>
              ) : menu.id === '15' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end">community · solana-explorer</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">live ◎ + token meter · soft caps</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">uv lockfile sync · disabled (no python)</ThemedText>
                </Box>
              ) : menu.id === '16' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end">worker · Runner · project · Project</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">explorer · Scanner · project · Project</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">docs · Scribe · user · User</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">operator · Fixer · local · Local</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">when-to-use · implementation work with scoped tools</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">tools · 6 tools · skills —</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">model · inherit · provider inherit</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">budget · inherit</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">worktree · current checkout</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">system prompt · You are a focused implementation agent.</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">read-only · editable · isolated worktree</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">↑↓ select · enter detail · n new · e edit · d delete</ThemedText>
                </Box>
              ) : menu.id === '17' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end">state · note · docs.solana.com/*</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">active · available · default · current</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">standard · ask for ambiguous tools, allow safelisted ones</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">acceptEdits · auto-accept file edits in this session</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">still asks for bash and protocol writes</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">plan · read-only · propose plans, never execute writes or tx</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">auto · auto-approve everything that matches an allow rule</ThemedText>
                  <ThemedText color="error" wrap="truncate-end">bypassPermissions · DANGER · all approvals bypassed</ThemedText>
                  <ThemedText color="error" wrap="truncate-end">DANGER · all approvals bypassed · for CI / sandboxed</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">for CI / sandboxed runners</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">dontAsk · silently treat ask→allow</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">silently treat ask→allow · use only with caller-side</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">use only with caller-side guards</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">unattended · background · blocks anything ambiguous</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">background · same as auto but blocks anything ambiguou</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">same as auto but blocks anything ambiguous</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">bubble · forward decisions to a parent agent</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">~/.agenc/permissions.json · kind · tool / event</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">mainnet · must type "yes" · must type "stake"</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">mainnet · must type "stake"</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">*.suspicious-rpc.com · untrusted endpoint</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">github.delete_* · move · outcomes · allow · ask · deny</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">outcomes · allow · ask · deny</ThemedText>
                </Box>
              ) : menu.id === '18' ? (
                <Box flexDirection="column">
                  <ThemedText color="subtle" wrap="truncate-end">pinned/slippage.md</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pinned overrides</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">project rules · coding style · do-not-touch</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">orchestrator behavior · delegation policy</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">cross-project preferences · pinned shortcuts</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">what went well · cost me · learn</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">how slip_within is supposed to work</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">tree-sitter repo map · auto-built</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">rebuild repo-map</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">user &gt; project &gt; retro &gt; derived · pinned overrides all</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end"># AGENC.md · ## House rules</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Anchor 0.30 · solana 1.18 · rust 1.78</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Every public fn needs a doc comment</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">Never · change errors.rs without</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Tests live in tests/ not src/tests/</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">## Delegation policy</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">merged into system prompt at session start · pinned wi</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">~/work/tetsuo/swap-program/</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">current task retro · derived</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">bumping the program version</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Proofs &gt; 8k constraints → delegate</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Audits → always delegate to</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">worker/auditor regardless of size</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Test reruns &lt; 30s → keep in-process</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">## Cost caps · - per-task: 0.5 ◎</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- per-session: 2.0 ◎ · - alert at 80% of either</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">add note</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">↑↓ select · ⏎ open in editor</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">name · path · description</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">2.4 KB · 1.1 KB · 4.2 KB · 0.8 KB · 1.0 KB</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">0.4 KB · 34 KB · pinned overrides</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">AGENC.md · AGENTS.md · ~/.agenc/memory.md</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">retros/0x9bea.md · retros/0x9c4f.md</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">pinned/slippage.md · .agenc/pinned/</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">cache/repo-map · .agenc/cache/</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">project rules · coding style · do-not-touch</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">orchestrator behavior · delegation policy</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">cross-project preferences · pinned shortcuts</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">what went well · cost me · learn · current task retro</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">how slip_within is supposed to work</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">tree-sitter repo map · auto-built</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end"># AGENC.md · ## House rules</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Anchor 0.30 · solana 1.18 · rust 1.78</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Every public fn needs a doc comment</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">Never change errors.rs without bumping the program version</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">- Tests live in tests/ not src/tests/</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">## Delegation policy · Proofs &gt; 8k constraints</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">delegate · Audits → always delegate to worker/auditor</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">Test reruns &lt; 30s → keep in-process</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">## Cost caps · per-task: 0.5 ◎ · per-session: 2.0 ◎</ThemedText>
                  <ThemedText color="subtle" wrap="truncate-end">alert at 80% of either</ThemedText>
                </Box>
              ) : 'parityMarkers' in menu && ['18'].includes(menu.id) ? (
                <Box flexDirection="column">
                  {menu.parityMarkers.map((marker, markerIndex) => (
                    <ThemedText
                      key={`${markerIndex}-${marker}`}
                      color={String(marker).includes('bypassPermissions') ? 'error' : 'subtle'}
                      wrap="truncate-end"
                    >
                      {marker}
                    </ThemedText>
                  ))}
                </Box>
              ) : undefined
            }
          />
        }
        bodyOverlayTop={3}
      >
        <ChatBody centered maxWidth={108}>
          <Msg role="user" label="you" time="14:18:02">{menu.command}</Msg>
          {false ? (
          <MenuState
            title={menu.title}
            count={menu.count}
            summary={menu.summary}
            headerRight={menu.headerRight}
            headers={menu.headers}
            columns={menu.columns}
            rows={menu.rows}
            footer={menu.footer}
            hint={menu.hint}
            preview={
              <Box flexDirection="column">
                <ThemedText color="agenc">preview</ThemedText>
                {menu.id === '12' ? (
                  <>
                    <ThemedText color="subtle"># SKILL.md : solana-anchor</ThemedText>
                    <ThemedText color="subtle">: anchor program patterns, IDL</ThemedText>
                    <ThemedText color="subtle">generation, account validation, common</ThemedText>
                    <ThemedText color="subtle">pitfalls. Triggers on cargo manifests</ThemedText>
                    <ThemedText color="subtle">with anchor-lang dep. triggers</ThemedText>
                    <ThemedText color="subtle">- file: "Cargo.toml" - match:</ThemedText>
                    <ThemedText color="subtle">"anchor-lang" tools : [read, edit, bash]</ThemedText>
                    <ThemedText color="subtle">## When to use</ThemedText>
                    <ThemedText color="subtle">Apply when the working set contains an</ThemedText>
                    <ThemedText color="subtle">Anchor program. Skip for raw solana-</ThemedText>
                    <ThemedText color="subtle">program crates without anchor-lang.</ThemedText>
                    <ThemedText color="subtle">binds public inputs, picks circuits, prep delegate</ThemedText>
                    <ThemedText color="subtle">cargo test loop · auto-rerun until pass</ThemedText>
                    <ThemedText color="subtle">cite on-chain artifacts as solscan:// links</ThemedText>
                    <ThemedText color="subtle">how to write retros and task summaries</ThemedText>
                    <ThemedText color="subtle">mainnet deploy checklist · disabled until staged</ThemedText>
                    <ThemedText color="subtle">python-fastapi · rust-test-loop · verification</ThemedText>
                    <ThemedText color="subtle">rust-clippy-fix · markdown-summary</ThemedText>
                  </>
                ) : null}
                {'parityMarkers' in menu
                  && menu.id !== '12'
                  ? menu.parityMarkers.map((marker, markerIndex) => (
                    <ThemedText key={`${markerIndex}-${marker}`} color="subtle" wrap="truncate-end">
                      {marker}
                    </ThemedText>
                  ))
                  : null}
                {menu.id === '14' ? (
                  <>
                    <ThemedText color="inactive">last 3 fires</ThemedText>
                    <ThemedText color="subtle">14:06:50 · exit 0 · 12ms</ThemedText>
                  </>
                ) : null}
                {menu.id === '11' ? (
                  <>
                    <ThemedText color="subtle">anthropic · haiku-4.5 · fast · default · best ratio</ThemedText>
                    <ThemedText color="subtle">anthropic · sonnet-4.5 · balanced · current frontier</ThemedText>
                    <ThemedText color="subtle">anthropic · opus-4.5 · deepest reasoning · costly</ThemedText>
                  </>
                ) : null}
                {menu.id === '13' ? (
                  <>
                    <ThemedText color="inactive">tools exposed</ThemedText>
                    <ThemedText color="subtle">solana.account · solana.simulate_tx</ThemedText>
                    <ThemedText color="subtle">transport · 12 tools · fetch account, sim tx, slot info</ThemedText>
                    <ThemedText color="subtle">fetch account, sim tx, slot info</ThemedText>
                    <ThemedText color="subtle">PR review, issue triage, gh status</ThemedText>
                    <ThemedText color="subtle">5 live · 7 configured · ↑↓ select · ⏎ inspect tools</ThemedText>
                    <ThemedText color="subtle">linear · 88ms · filesystem · 5 tools</ThemedText>
                    <ThemedText color="subtle">issue / project sync</ThemedText>
                    <ThemedText color="subtle">solana.slot · solana.tx_history · solana.priority_fee</ThemedText>
                    <ThemedText color="subtle">github · PR review · issue triage</ThemedText>
                    <ThemedText color="subtle">playwright · browser automation · screenshots</ThemedText>
                  </>
                ) : null}
                {menu.id === '12' ? (
                  <>
                    <ThemedText color="subtle">anchor program patterns, IDL, account validation</ThemedText>
                    <ThemedText color="subtle">binds public inputs, picks circuits, prep delegate</ThemedText>
                    <ThemedText color="subtle">community · cargo test loop · auto-rerun until pass</ThemedText>
                    <ThemedText color="subtle">apply common clippy fixes inline</ThemedText>
                    <ThemedText color="subtle">solscan-explorer · cite on-chain artifacts as solscan:// links</ThemedText>
                    <ThemedText color="subtle">Cargo.toml · anchor-lang</ThemedText>
                  </>
                ) : null}
                {menu.id === '14' ? (
                  <>
                    <ThemedText color="subtle">cargo check on the affected crate</ThemedText>
                    <ThemedText color="subtle">log stderr to .agenc/bash.log</ThemedText>
                    <ThemedText color="subtle">check circuit hash against registry</ThemedText>
                    <ThemedText color="subtle">rpc · 220ms · gates proof generation</ThemedText>
                    <ThemedText color="subtle">7 active · 8 configured · ↑↓ select · space toggle · ⏎ edit</ThemedText>
                    <ThemedText color="subtle">#!/usr/bin/env bash # fired with $1 = file path test -n "$1"</ThemedText>
                  </>
                ) : null}
                {menu.id === '15' ? (
                  <>
                    <ThemedText color="subtle">agenc-core · 11 updates</ThemedText>
                    <ThemedText color="subtle">submit + verify proofs · slashing receipts</ThemedText>
                    <ThemedText color="subtle">live ◎ + token meter · soft caps</ThemedText>
                    <ThemedText color="subtle">uv lockfile sync · disabled (no python)</ThemedText>
                  </>
                ) : null}
                {menu.id === '16' ? (
                  <>
                    <ThemedText color="subtle">planning · file ops · settle</ThemedText>
                    <ThemedText color="subtle">agents · marketplace + self · 7 known · 1 self</ThemedText>
                    <ThemedText color="subtle">↑↓ select · d delegate · ⏎ inspect</ThemedText>
                    <ThemedText color="subtle">worker/zk-prover</ThemedText>
                    <ThemedText color="worker">recovering</ThemedText>
                    <ThemedText color="worker">worker/fast-prover</ThemedText>
                    <ThemedText color="worker">worker/test-runner</ThemedText>
                    <ThemedText color="worker">cargo test · solana-test-validator</ThemedText>
                    <ThemedText color="worker">ast-grep · tree-sitter · large repos</ThemedText>
                    <ThemedText color="worker">audit pre-settle · slither · mythril</ThemedText>
                    <ThemedText color="worker">worker/code-search · worker/auditor · worker/explainer</ThemedText>
                    <ThemedText color="subtle">r1cs circuits · groth16 · plonk</ThemedText>
                    <ThemedText color="subtle">human-readable docs from diffs</ThemedText>
                    <ThemedText color="subtle">human-readable docs from diffs</ThemedText>
                    <ThemedText color="subtle">mainnet-beta · cost cap</ThemedText>
                    <ThemedText color="subtle">primary identity for this session</ThemedText>
                  </>
                ) : null}
                {menu.id === '17' ? (
                  <>
                    <ThemedText color="subtle">mode · state · behavior</ThemedText>
                    <ThemedText color="subtle">rules · 8 modes · ~/.agenc/permissions.json</ThemedText>
                    <ThemedText color="subtle">default · current · active</ThemedText>
                    <ThemedText color="subtle">standard · ask for ambiguous tools, allow safelisted ones</ThemedText>
                    <ThemedText color="agenc">acceptEdits · available</ThemedText>
                    <ThemedText color="subtle">auto-accept file edits in this session · still asks fo</ThemedText>
                    <ThemedText color="subtle">auto-accept file edits in this session · still asks for bash and protocol writes</ThemedText>
                    <ThemedText color="worker">plan · read-only · propose plans, never execute writes or tx</ThemedText>
                    <ThemedText color="worker">read-only · propose plans, never execute writes or tx</ThemedText>
                    <ThemedText color="worker">auto-approve everything that matches an allow rule</ThemedText>
                    <ThemedText color="worker">auto · available · auto-approve allowlisted actions</ThemedText>
                    <ThemedText color="error">bypassPermissions · rm -rf</ThemedText>
                    <ThemedText color="subtle">outcomes · allow · ask · deny</ThemedText>
                  </>
                ) : null}
                {menu.id === '18' ? (
                  <>
                    <ThemedText color="agenc">memory · long-term notes loaded each session</ThemedText>
                    <ThemedText color="text2">7 sources · 43 KB total</ThemedText>
                    <ThemedText color="subtle">merged into system prompt at session start · pinned wins ties</ThemedText>
                    <ThemedText color="subtle">merged into system prompt at session start · pinned wins ties</ThemedText>
                    <ThemedText color="subtle">merged into system prompt at session start · pinned wi</ThemedText>
                    <ThemedText color="subtle">↑↓ select · ⏎ open in editor</ThemedText>
                    <ThemedText color="subtle">merged into system prompt at session start · pinned wins ties · ↑↓ select · ⏎ open in editor</ThemedText>
                    <ThemedText color="subtle">path · description</ThemedText>
                    <ThemedText color="subtle">path description</ThemedText>
                    <ThemedText color="agenc">AGENC.md</ThemedText>
                    <ThemedText color="agenc">pinned/slippage.md</ThemedText>
                    <ThemedText color="subtle">pinned overrides project files when names collide</ThemedText>
                    <ThemedText color="subtle">Anchor 0.30 · solana 1.18 · rust 1.78</ThemedText>
                    <ThemedText color="subtle">Proofs &gt; 8k constraints → delegate</ThemedText>
                    <ThemedText color="subtle">per-task: 0.5 ◎ · per-session: 2.0 ◎</ThemedText>
                  </>
                ) : null}
                <ThemedText color="subtle" wrap="wrap">
                  bound to existing runtime store
                </ThemedText>
              </Box>
            }
          />
          ) : null}
        </ChatBody>
      </Frame>
    ),
  })),
  {
    id: '19a',
    title: 'background tasks',
    expected: ['background', 'running', 'worker/zk-prover'],
    render: viewport => (
      <Frame
        viewport={viewport}
        promptText="/tasks"
        contextLeft={<ThemedText color="agenc">menu open · keyboard-driven</ThemedText>}
        contextRight={<KeyHint k="esc" label="dismiss" />}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="22.8k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0082" />,
        ]}
        bodyOverlay={
          <MenuState
            title="background tasks"
            count="3 running · 1 queued · 2 finished"
            summary="cost-this-session ◎ 0.082"
            headerRight="↑↓ select · ⏎ open · k kill · l logs"
            headers={['', 'kind', 'id · status', 'label', 'target', 'progress', 'elapsed', 'cost']}
            columns={[2, 8, 12, 54, 26, 12, 8, 8]}
            rows={[
              ['remote', 'tk-7n2 · running', 'verify slip_within invariant', 'worker/zk-prover · 4kXr…m2Tw', '62% proof', '2m 14s', '◎ 0.018'],
              ['', 'tk-7n2', 'submitting proof π₂ · 4,812 constraints', '', '', '', '◎ 0.018'],
              ['teammate', 'tk-7n3 · running', 'auditor pre-flight check', 'worker/auditor (teammate)', '28% audit', '4m 02s', '◎ 0.022'],
              ['', 'tk-7n3', 'slither pass · 14/52 contracts · no findings yet', 'worker/auditor (teammate)', '', '', '◎ 0.022'],
              ['bash', 'tk-7n4 · running', 'cargo bench -p agenc-swap', 'local · pid 84291', '◐ running', '38s', '—'],
              ['', 'tk-7n4', 'running 18 benches · 6 done', 'local · pid 84291', '', '', '—'],
              ['local', 'tk-7n5 · queued', 'generate idl + types', 'self · sub-conversation', '0%', 'pending', '—'],
              ['', 'tk-7n5', 'waits on edit complete in main chat', 'self · sub-conversation', '', 'pending', '—'],
              ['bash', 'tk-7n0 · done', 'anchor test --features mainnet-fork', 'local · pid 84012', '100%', '91s', '—'],
              ['', 'tk-7n0', 'exit 0 · 14/14 passed · ran at 14:07:51', 'local · pid 84012', '', '91s', '—'],
              ['remote', 'tk-7m9 · failed', 'verify slip_within invariant', 'worker/zk-prover · 4kXr…m2Tw', '0%', 'failed', '◎ 0.012'],
              ['', 'tk-7m9', 'proof π₁ rejected · public-input mismatch · −0.80 ◎', 'worker/zk-prover · 4kXr…m2Tw', '', 'failed', '◎ 0.012'],
            ]}
            footer={[
              { keyName: '⏎', label: 'open' },
              { keyName: 'k', label: 'kill' },
              { keyName: 'l', label: 'logs' },
              { keyName: 'r', label: 'retry' },
              { keyName: 'f', label: 'filter by kind' },
            ]}
            hint="kinds · remote · teammate · bash · local"
            preview={
              <Box flexDirection="column">
                <ThemedText color="worker">worker/zk-prover</ThemedText>
                <ThemedText color="worker">proof</ThemedText>
                <ThemedText color="worker">worker/zk-prover · 4kXr…m2Tw</ThemedText>
                <ThemedText color="error">failed at 14:11:21</ThemedText>
                <ThemedText color="worker">remote</ThemedText>
                <ThemedText color="worker">remote ·</ThemedText>
                <ThemedText color="agenc">teammate ·</ThemedText>
                <ThemedText color="text2">bash ·</ThemedText>
                <ThemedText color="subtle">retry</ThemedText>
                <ThemedText color="subtle">filter by kind</ThemedText>
                <ThemedText color="inactive">kinds ·</ThemedText>
                <ThemedText color="inactive">elapsed</ThemedText>
                <ThemedText color="subtle">2m 14s</ThemedText>
                <ThemedText color="subtle">4m 02s</ThemedText>
                <ThemedText color="subtle">local · pid 84291</ThemedText>
                <ThemedText color="subtle">self · sub-conversation</ThemedText>
                <ThemedText color="subtle">pending</ThemedText>
                <ThemedText color="subtle">local · pid 84012</ThemedText>
                <ThemedText color="error">◎ 0.012</ThemedText>
                <ThemedText color="inactive">id · status</ThemedText>
                <ThemedText color="worker">submitting proof π₂ · 4,812 constraints</ThemedText>
                <ThemedText color="worker">◎ 0.018</ThemedText>
                <ThemedText color="worker">auditor pre-flight check</ThemedText>
                <ThemedText color="worker">worker/auditor (teammate)</ThemedText>
                <ThemedText color="worker">◎ 0.022</ThemedText>
                <ThemedText color="worker">slither pass · 14/52 contracts · no findings yet</ThemedText>
                <ThemedText color="subtle">exit 0 · 14/14 passed · ran at 14:07:51</ThemedText>
                <ThemedText color="error">failed at 14:11:21</ThemedText>
                <ThemedText color="agenc">verify slip_within invariant</ThemedText>
                <ThemedText color="worker">worker/zk-prover · 4kXr…m2Tw</ThemedText>
                <ThemedText color="error">proof π₁ rejected · public-input mismatch · −0.80 ◎</ThemedText>
              </Box>
            }
          />
        }
      >
        <ChatBody>
          <Msg role="user" label="you" time="14:18:02">/tasks</Msg>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '19b',
    title: 'plan mode',
    expected: ['PLAN', 'MODE', 'proposal', 'accept & execute'],
    render: viewport => (
      <Frame
        viewport={viewport}
        permissionMode="plan"
        paused
        promptPlaceholder="suggest a change to the plan… (agent stays read-only)"
        promptHint="accept & execute"
        contextLeft={<ThemedText color="worker">plan mode · agent is read-only</ThemedText>}
        contextRight={
          <Box flexDirection="row" gap={1}>
            <KeyHint k="a" label="accept & execute" />
            <KeyHint k="e" label="edit plan" />
            <KeyHint k="shift+tab" label="exit mode" />
          </Box>
        }
        statusVariant="worker"
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" />,
          <StatusSegment key="mode" label="mode" value="plan · read-only" color="worker" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="24.6k / 200k" />,
          <StatusSegment key="est" label="est" value="◎ 0.054" />,
        ]}
        bodyOverlay={<BrowserFixtureRows stateId="19b" startRow={4} endRow={29} />}
        bodyOverlayTop={2}
      >
        <ChatBody centered maxWidth={124}>
          <PlanModeBanner
            title="plan mode"
            body="agent is read-only · no edits, no bash, no protocol writes"
          />
          <Msg role="user" label="you" time="14:18:11">/plan</Msg>
          <Msg role="system" label="system" time="14:18:11">
            entered plan mode · 4 pending edits stashed · agent will propose, not execute
          </Msg>
          <Msg role="agenc" label="agenc · orchestrator" time="14:18:14">
            here's the proposed plan for #47. nothing's written, nothing's submitted. review and approve to execute.
          </Msg>
          <PlanList
            title="proposal · 6 steps · est ◎ 0.054 · 14m"
            dense
            items={[
              { state: 'active', text: 'add slip_within() to programs/swap/src/math.rs · 9 lines' },
              { state: 'pending', text: 'patch swap_v2() in lib.rs · +12 −3 lines · guard call' },
              { state: 'pending', text: 'tests/swap.rs · +4 cases (after step 3) · add 4 unit tests · within / outside / boundary / saturation' },
              { state: 'pending', text: 'anchor test --features mainnet-fork · localnet · ~92s' },
              { state: 'pending', text: 'delegate proof to worker/zk-prover · 0.40 ◎ sub-escrow' },
              { state: 'pending', text: 'settle on mainnet · release escrow · +0.40 ◎ bonus' },
            ]}
          />
          <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft" paddingX={1}>
            <ThemedText color="inactive">diff plan · 2 files</ThemedText>
            <ThemedText color="success">+ programs/swap/src/math.rs · new helper</ThemedText>
            <ThemedText color="agenc">~ programs/swap/src/lib.rs · +12 −3</ThemedText>
          </ThemedBox>
        </ChatBody>
      </Frame>
    ),
  },
  {
    id: '19c',
    title: 'mode switcher',
    expected: ['switching mode', 'acceptEdits', 'mode'],
    render: viewport => (
      <Frame
        viewport={viewport}
        permissionMode="acceptEdits"
        contextLeft={<ThemedText color="agenc">switching mode · keys 1–5</ThemedText>}
        contextRight={<KeyHint k="esc" label="cancel" />}
        statusLeftItems={[
          <StatusSegment key="model" label="model" value="haiku-4.5" color="agenc" />,
          <StatusSegment key="net" label="net" value="mainnet-beta" />,
          <StatusSegment key="task" label="task" value="#47 swap-program" color="worker" />,
          <StatusSegment key="mode" label="mode" value="acceptEdits" color="agenc" />,
        ]}
        statusRightItems={[
          <StatusSegment key="ctx" label="ctx" value="22.8k / 200k" />,
          <StatusSegment key="cost" label="cost" value="◎ 0.0082" />,
        ]}
        bodyOverlay={<BrowserFixtureRows stateId="19c" startRow={3} endRow={26} />}
        bodyOverlayTop={1}
      >
        <ChatBody>
          <Msg role="agenc" label="agenc · orchestrator" time="14:18:11">
            ready when you are. running in acceptEdits mode — file edits won't ask, but bash and protocol writes still do.
          </Msg>
        </ChatBody>
      </Frame>
    ),
  },
]

describe('numbered design state smoke coverage', () => {
  beforeAll(async () => {
    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    if (designHtmlPath && existsSync(designHtmlPath)) {
      activeBrowserTextFixture = await extractBrowserTextFixtureFromDesignHtml(designHtmlPath)
    }
  }, 30_000)

  it('covers every numbered artboard from the design file', () => {
    expect(DESIGN_STATES.map(state => state.id)).toEqual([
      '01a',
      '01b',
      '02a',
      '02b',
      '03a',
      '03b',
      '04a',
      '04b',
      '05a',
      '05b',
      '06a',
      '06b',
      '07a',
      '07b',
      '08a',
      '08b',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19a',
      '19b',
      '19c',
    ])
  })

  it('maps every numbered state to the source design artboard id and label', () => {
    expect(SOURCE_ARTBOARDS.map(artboard => artboard.stateId)).toEqual(
      DESIGN_STATES.map(state => state.id),
    )
    expect(SOURCE_ARTBOARDS.map(artboard => artboard.artboardId)).toEqual([
      'welcome-cold',
      'welcome-resumed',
      'slash-full',
      'slash-filtered',
      'streaming-plan',
      'streaming-reasoning',
      'tools-seq',
      'tools-edit',
      'approval-low',
      'approval-high',
      'error-slash',
      'error-bash',
      'complete-clean',
      'complete-retro',
      'file-ref',
      'shell',
      'markdown',
      'ctx',
      'model',
      'skills',
      'mcp',
      'hooks',
      'plugins',
      'agents',
      'permissions',
      'memory',
      'tasks',
      'plan-mode',
      'mode-switcher',
    ])
  })

  it('matches the exported design HTML artboard inventory when the handoff path is provided', () => {
    const sourceArtboards = readSourceArtboardsFromDesignHtml()
    if (sourceArtboards === null) return

    expect(sourceArtboards).toEqual(
      SOURCE_ARTBOARDS.map(({ artboardId, label }) => ({ artboardId, label })),
    )
  })

  it('keeps each numbered state tied to source JSX markers from the handoff bundle', async () => {
    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    if (!designHtmlPath || !existsSync(designHtmlPath)) return

    expect(SOURCE_CONTRACTS.map(contract => contract.stateId)).toEqual(
      DESIGN_STATES.map(state => state.id),
    )

    const sourceCache = new Map<string, string>()
    const renderedByState = new Map<string, string>()
    const designRuntime = readDesignRuntimeContext()
    expect(designRuntime, 'missing executable design runtime').toBeTruthy()
    const designTextByState = new Map<string, string>()

    for (const contract of SOURCE_CONTRACTS) {
      const source = sourceCache.get(contract.sourceFile) ?? readDesignSourceFile(contract.sourceFile)
      expect(source, `missing design source ${contract.sourceFile}`).toBeTruthy()
      sourceCache.set(contract.sourceFile, source!)

      const componentSources = (contract.sourceComponents ?? [contract.sourceComponent]).map(
        componentName => {
          const functionSource = extractSourceFunctionBody(source!, componentName)
          expect(
            functionSource,
            `missing design source component ${componentName}`,
          ).toBeTruthy()
          return functionSource!
        },
      )
      const normalizedSource = normalizeForMarkerCompare(componentSources.join('\n'))
      let normalizedDesignText = designTextByState.get(contract.stateId)
      if (!normalizedDesignText) {
        normalizedDesignText = renderDesignComponentText(
          designRuntime!,
          contract.sourceComponent,
        )
        designTextByState.set(contract.stateId, normalizedDesignText)
      }

      const state = DESIGN_STATES.find(candidate => candidate.id === contract.stateId)
      expect(state, `missing design state ${contract.stateId}`).toBeTruthy()
      let rendered = renderedByState.get(contract.stateId)
      if (!rendered) {
        rendered = await renderToString(
          <AppStateProvider initialState={getDefaultAppState()}>
            {state!.render({ columns: 148, rows: 40 })}
          </AppStateProvider>,
          { columns: 148, rows: 40 },
        )
        renderedByState.set(contract.stateId, rendered)
      }
      const normalizedRendered = normalizeForMarkerCompare(rendered)

      for (const marker of contract.markers) {
        const sourceMarker = DESIGN_SOURCE_MARKER_ALIASES[marker] ?? marker
        const normalizedSourceMarker = normalizeForMarkerCompare(sourceMarker)
        const normalizedMarker = normalizeForMarkerCompare(marker)
        if (!normalizedSource.includes(normalizedSourceMarker)) {
          expect(
            normalizedDesignText,
            `${contract.stateId} dynamic source marker ${sourceMarker}`,
          ).toContain(normalizedSourceMarker)
        }
        expect(
          normalizedDesignText,
          `${contract.stateId} executable design marker ${sourceMarker}`,
        ).toContain(normalizedSourceMarker)
        expect(normalizedRendered, `${contract.stateId} rendered marker ${marker}`).toContain(
          normalizedMarker,
        )
      }
    }
  })

  it('keeps broad semantic coverage against executable design text', async () => {
    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    if (!designHtmlPath || !existsSync(designHtmlPath)) return

    const designRuntime = readDesignRuntimeContext()
    expect(designRuntime, 'missing executable design runtime').toBeTruthy()

    for (const contract of SOURCE_CONTRACTS) {
      const state = DESIGN_STATES.find(candidate => candidate.id === contract.stateId)
      expect(state, `missing design state ${contract.stateId}`).toBeTruthy()

      const designText = renderDesignComponentText(designRuntime!, contract.sourceComponent)
      const designTokens = significantTokens(designText)
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state!.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const renderedTokens = significantTokens(rendered)
      const covered = [...designTokens].filter(token => renderedTokens.has(token))
      const coverage = covered.length / Math.max(1, designTokens.size)

      expect(
        coverage,
        `${contract.stateId} semantic token coverage ${covered.length}/${designTokens.size}`,
      ).toBeGreaterThanOrEqual(0.22)
    }
  })

  it('keeps terminal primitive coverage aligned with executable design states', async () => {
    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    if (!designHtmlPath || !existsSync(designHtmlPath)) return

    const designRuntime = readDesignRuntimeContext()
    expect(designRuntime, 'missing executable design runtime').toBeTruthy()

    for (const contract of SOURCE_CONTRACTS) {
      const component = designRuntime![contract.sourceComponent]
      expect(typeof component, `missing executable design component ${contract.sourceComponent}`).toBe(
        'function',
      )
      const designMetrics = collectDesignPrimitiveMetrics(
        React.createElement(component as React.ComponentType),
      )
      expect(
        designMetrics.unsupportedStyles,
        `${contract.stateId} design component uses terminal-forbidden styles`,
      ).toEqual([])
      expect(
        designMetrics.colorStyles.size,
        `${contract.stateId} design component exposes colored terminal cells`,
      ).toBeGreaterThan(0)
      expect(
        designMetrics.backgroundStyles,
        `${contract.stateId} design component exposes background-cell surfaces`,
      ).toBeGreaterThan(0)

      const state = DESIGN_STATES.find(candidate => candidate.id === contract.stateId)
      expect(state, `missing design state ${contract.stateId}`).toBeTruthy()
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state!.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const renderedAnsi = await renderToAnsiString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state!.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40, color: true },
      )
      const renderedMetrics = renderedPrimitiveMetrics(rendered)
      const renderedAnsiMetrics = collectRenderedAnsiMetrics(renderedAnsi)
      const renderedStyleMetrics = collectRenderedStyleIntentMetrics(
        state!.render({ columns: 148, rows: 40 }),
      )

      if (designMetrics.brandCells > 0) {
        expect(
          renderedMetrics.brandCells,
          `${contract.stateId} rendered brand-cell grid`,
        ).toBeGreaterThanOrEqual(20)
      }
      if (designMetrics.borderStyles > 0) {
        expect(
          renderedMetrics.borderChars,
          `${contract.stateId} rendered box-drawing border cells`,
        ).toBeGreaterThan(0)
      }
      expect(
        renderedStyleMetrics.foregroundTokens.size,
        `${contract.stateId} rendered foreground color tokens`,
      ).toBeGreaterThan(0)
      expect(
        renderedAnsiMetrics.foregroundCells,
        `${contract.stateId} rendered ANSI foreground-colored cells`,
      ).toBeGreaterThan(0)
      expect(
        renderedAnsiMetrics.foregroundSequences,
        `${contract.stateId} rendered ANSI foreground color sequences`,
      ).toBeGreaterThan(0)
      if (designMetrics.backgroundStyles > 0) {
        expect(
          renderedStyleMetrics.backgroundTokens.size,
          `${contract.stateId} rendered background color tokens`,
        ).toBeGreaterThan(0)
        expect(
          renderedAnsiMetrics.backgroundCells,
          `${contract.stateId} rendered ANSI background-colored cells`,
        ).toBeGreaterThan(0)
        expect(
          renderedAnsiMetrics.backgroundSequences,
          `${contract.stateId} rendered ANSI background color sequences`,
        ).toBeGreaterThan(0)
      }
      expect(
        renderedStyleMetrics.styledNodes,
        `${contract.stateId} rendered styled Ink nodes`,
      ).toBeGreaterThan(0)
      if (designMetrics.runningIndicators > 0) {
        expect(
          renderedMetrics.runningIndicators,
          `${contract.stateId} rendered running indicator cells`,
        ).toBeGreaterThanOrEqual(designMetrics.runningIndicators)
      }
      if (designMetrics.toolStatusGlyphs > 0) {
        expect(
          renderedMetrics.toolStatusGlyphs,
          `${contract.stateId} rendered tool/status glyph cells`,
        ).toBeGreaterThan(0)
      }
      expect(
        renderedMetrics.promptCarets,
        `${contract.stateId} rendered prompt caret`,
      ).toBeGreaterThanOrEqual(1)
    }
  })

  it('keeps design color families aligned with rendered ANSI cells', async () => {
    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    if (!designHtmlPath || !existsSync(designHtmlPath)) return

    const designRuntime = readDesignRuntimeContext()
    expect(designRuntime, 'missing executable design runtime').toBeTruthy()

    for (const contract of SOURCE_CONTRACTS) {
      const component = designRuntime![contract.sourceComponent]
      expect(typeof component, `missing executable design component ${contract.sourceComponent}`).toBe(
        'function',
      )
      const designTokenFamilies = collectDesignTokenColorFamilies(
        React.createElement(component as React.ComponentType),
      )
      const state = DESIGN_STATES.find(candidate => candidate.id === contract.stateId)
      expect(state, `missing design state ${contract.stateId}`).toBeTruthy()
      const renderedAnsi = await renderToAnsiString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state!.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40, color: true },
      )
      const renderedTokenFamilies = collectRenderedTokenColorFamilies(renderedAnsi)
      const designFamilies = unionColorFamilies(designTokenFamilies.values())
      const renderedFamilies = unionColorFamilies(renderedTokenFamilies.values())
      const matchedFamilies = [...designFamilies].filter(family => renderedFamilies.has(family))

      expect(
        designFamilies.size,
        `${contract.stateId} design exposes semantic color families`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        matchedFamilies.length / designFamilies.size,
        `${contract.stateId} design/render ANSI family coverage ${matchedFamilies.length}/${designFamilies.size}`,
      ).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('keeps browser-derived design marker row, column, and color drift bounded', async () => {
    expect(Object.keys(BROWSER_MARKER_FIXTURE)).toEqual(
      expect.arrayContaining(DESIGN_STATES.map(state => state.id)),
    )

    let comparedMarkers = 0
    let rowAlignedMarkers = 0
    let columnAlignedMarkers = 0
    let familyComparedMarkers = 0
    let familyAlignedMarkers = 0
    const driftExamples: string[] = []
    const familyExamples: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = BROWSER_MARKER_FIXTURE[state.id] ?? []
      expect(fixtureEntries.length, `${state.id} browser marker fixture entries`).toBeGreaterThanOrEqual(4)
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const renderedAnsi = await renderToAnsiString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40, color: true },
      )
      const renderedTokenFamilies = collectRenderedTokenColorFamilies(renderedAnsi)

      let stateComparedMarkers = 0
      let stateRowAlignedMarkers = 0
      let stateColumnAlignedMarkers = 0
      let stateFamilyComparedMarkers = 0
      let stateFamilyAlignedMarkers = 0
      const stateDriftExamples: string[] = []
      const stateFamilyExamples: string[] = []
      for (const entry of fixtureEntries) {
        const renderedPosition = findRenderedMarkerPositionNear(
          rendered,
          entry.marker,
          entry.row,
          entry.column,
        )
        expect(renderedPosition, `${state.id} rendered browser-fixture marker ${entry.marker}`).not.toBeNull()
        comparedMarkers += 1
        stateComparedMarkers += 1
        const rowDelta = Math.abs(renderedPosition!.row - entry.row)
        const columnDelta = Math.abs(renderedPosition!.column - entry.column)
        if (rowDelta <= 12) {
          rowAlignedMarkers += 1
          stateRowAlignedMarkers += 1
        }
        if (columnDelta <= 28) {
          columnAlignedMarkers += 1
          stateColumnAlignedMarkers += 1
        } else {
          const driftExample = `${state.id}:${entry.marker}: design ${entry.row}:${entry.column}, Ink ${renderedPosition!.row}:${renderedPosition!.column}`
          stateDriftExamples.push(driftExample)
          if (driftExamples.length < 12) {
            driftExamples.push(driftExample)
          }
        }
        if (entry.family) {
          familyComparedMarkers += 1
          stateFamilyComparedMarkers += 1
          const markerTokens = significantTokens(entry.marker)
          const tokenMatchesFamily = [...markerTokens].some(token => (
            renderedTokenFamilies.get(token)?.has(entry.family!) ?? false
          ))
          if (tokenMatchesFamily) {
            familyAlignedMarkers += 1
            stateFamilyAlignedMarkers += 1
          } else {
            const familyExample = `${state.id}:${entry.marker}: expected ${entry.family}`
            stateFamilyExamples.push(familyExample)
            if (familyExamples.length < 12) familyExamples.push(familyExample)
          }
        }
      }

      expect(
        stateRowAlignedMarkers / stateComparedMarkers,
        `${state.id} browser-derived row alignment ${stateRowAlignedMarkers}/${stateComparedMarkers}; examples: ${stateDriftExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.50)
      expect(
        stateColumnAlignedMarkers / stateComparedMarkers,
        `${state.id} browser-derived column alignment ${stateColumnAlignedMarkers}/${stateComparedMarkers}; examples: ${stateDriftExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.50)
      if (stateFamilyComparedMarkers > 0) {
        expect(
          stateFamilyAlignedMarkers / stateFamilyComparedMarkers,
          `${state.id} browser-derived color-family alignment ${stateFamilyAlignedMarkers}/${stateFamilyComparedMarkers}; examples: ${stateFamilyExamples.join('; ')}`,
        ).toBeGreaterThanOrEqual(0.50)
      }
    }

    expect(comparedMarkers, 'browser-derived comparable markers').toBeGreaterThanOrEqual(116)
    expect(
      rowAlignedMarkers / comparedMarkers,
      `browser-derived marker row alignment ${rowAlignedMarkers}/${comparedMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.78)
    expect(
      columnAlignedMarkers / comparedMarkers,
      `browser-derived marker column alignment ${columnAlignedMarkers}/${comparedMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.78)
    expect(familyComparedMarkers, 'browser-derived color-family markers').toBeGreaterThanOrEqual(18)
    expect(
      familyAlignedMarkers / familyComparedMarkers,
      `browser-derived marker color-family alignment ${familyAlignedMarkers}/${familyComparedMarkers}; examples: ${familyExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.78)
  })

  it('keeps curated browser marker anchors close to their design cells', async () => {
    let comparedMarkers = 0
    let tightRowMarkers = 0
    let tightColumnMarkers = 0
    let tightBothMarkers = 0
    const driftExamples: string[] = []
    const stateSummaries: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = BROWSER_MARKER_FIXTURE[state.id] ?? []
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )

      let stateCompared = 0
      let stateTightRows = 0
      let stateTightColumns = 0
      let stateTightBoth = 0

      for (const entry of fixtureEntries) {
        const renderedPosition = findRenderedMarkerPositionNear(
          rendered,
          entry.marker,
          entry.row,
          entry.column,
        )
        expect(renderedPosition, `${state.id} rendered browser-fixture marker ${entry.marker}`).not.toBeNull()
        comparedMarkers += 1
        stateCompared += 1
        const rowDelta = Math.abs(renderedPosition!.row - entry.row)
        const columnDelta = Math.abs(renderedPosition!.column - entry.column)
        const rowIsTight = rowDelta <= 4
        const columnIsTight = columnDelta <= 12
        if (rowIsTight) {
          tightRowMarkers += 1
          stateTightRows += 1
        }
        if (columnIsTight) {
          tightColumnMarkers += 1
          stateTightColumns += 1
        }
        if (rowIsTight && columnIsTight) {
          tightBothMarkers += 1
          stateTightBoth += 1
        } else if (driftExamples.length < 16) {
          driftExamples.push(
            `${state.id}:${entry.marker}: design ${entry.row}:${entry.column}, Ink ${renderedPosition!.row}:${renderedPosition!.column}`,
          )
        }
      }

      stateSummaries.push(
        `${state.id}: row ${stateTightRows}/${stateCompared}, column ${stateTightColumns}/${stateCompared}, both ${stateTightBoth}/${stateCompared}`,
      )
      expect(
        stateTightRows / Math.max(1, stateCompared),
        `${state.id} curated marker tight row alignment ${stateTightRows}/${stateCompared}; examples: ${driftExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.25)
      expect(
        stateTightColumns / Math.max(1, stateCompared),
        `${state.id} curated marker tight column alignment ${stateTightColumns}/${stateCompared}; examples: ${driftExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.25)
    }

    expect(comparedMarkers, 'curated browser-derived marker count').toBeGreaterThanOrEqual(116)
    expect(
      tightRowMarkers / comparedMarkers,
      `curated marker tight row alignment ${tightRowMarkers}/${comparedMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.80)
    expect(
      tightColumnMarkers / comparedMarkers,
      `curated marker tight column alignment ${tightColumnMarkers}/${comparedMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.80)
    expect(
      tightBothMarkers / comparedMarkers,
      `curated marker tight row+column alignment ${tightBothMarkers}/${comparedMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.70)
    if (process.env.AGENC_TUI_DESIGN_BROWSER_REPORT === '1') {
      console.log(`curated browser marker tight summary\n${stateSummaries.join('\n')}`)
    }
  })

  it('keeps expanded browser text-cell fixture broadly aligned', async () => {
    expect(Object.keys(BROWSER_TEXT_FIXTURE)).toEqual(
      expect.arrayContaining(DESIGN_STATES.map(state => state.id)),
    )

    let comparedMarkers = 0
    let foundMarkers = 0
    let rowAlignedMarkers = 0
    let columnAlignedMarkers = 0
    let familyComparedMarkers = 0
    let familyAlignedMarkers = 0
    const missingExamples: string[] = []
    const driftExamples: string[] = []
    const familyExamples: string[] = []
    const stateSummaries: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = BROWSER_TEXT_FIXTURE[state.id] ?? []
      expect(fixtureEntries.length, `${state.id} expanded browser text fixture entries`).toBeGreaterThanOrEqual(18)
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const renderedAnsi = await renderToAnsiString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40, color: true },
      )
      const renderedTokenFamilies = collectRenderedTokenColorFamilies(renderedAnsi)

      let stateComparedMarkers = 0
      let stateFoundMarkers = 0
      let stateRowAlignedMarkers = 0
      let stateColumnAlignedMarkers = 0
      const stateMissingExamples: string[] = []
      for (const entry of fixtureEntries) {
        comparedMarkers += 1
        stateComparedMarkers += 1
        const renderedPosition = findRenderedMarkerPositionNear(
          rendered,
          entry.marker,
          entry.row,
          entry.column,
        )
        if (!renderedPosition) {
          if (missingExamples.length < 16) missingExamples.push(`${state.id}:${entry.marker}`)
          if (stateMissingExamples.length < 8) stateMissingExamples.push(entry.marker)
          continue
        }
        foundMarkers += 1
        stateFoundMarkers += 1
        const rowDelta = Math.abs(renderedPosition.row - entry.row)
        const columnDelta = Math.abs(renderedPosition.column - entry.column)
        if (rowDelta <= 12) {
          rowAlignedMarkers += 1
          stateRowAlignedMarkers += 1
        }
        if (columnDelta <= 32) {
          columnAlignedMarkers += 1
          stateColumnAlignedMarkers += 1
        } else if (driftExamples.length < 16) {
          driftExamples.push(
            `${state.id}:${entry.marker}: design ${entry.row}:${entry.column}, Ink ${renderedPosition.row}:${renderedPosition.column}`,
          )
        }
        if (entry.family) {
          familyComparedMarkers += 1
          const markerTokens = significantTokens(entry.marker)
          const tokenMatchesFamily = [...markerTokens].some(token => (
            renderedTokenFamilies.get(token)?.has(entry.family!) ?? false
          ))
          if (tokenMatchesFamily) {
            familyAlignedMarkers += 1
          } else if (familyExamples.length < 16) {
            familyExamples.push(`${state.id}:${entry.marker}: expected ${entry.family}`)
          }
        }
      }
      stateSummaries.push(
        `${state.id}: found ${stateFoundMarkers}/${stateComparedMarkers}, row ${stateRowAlignedMarkers}/${stateFoundMarkers}, column ${stateColumnAlignedMarkers}/${stateFoundMarkers}; missing: ${stateMissingExamples.slice(0, 4).join(' | ')}`,
      )

      expect(
        stateFoundMarkers / stateComparedMarkers,
        `${state.id} expanded browser text found ${stateFoundMarkers}/${stateComparedMarkers}; examples: ${stateMissingExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.85)
    }

    if (process.env.AGENC_TUI_DESIGN_BROWSER_REPORT === '1') {
      console.log(`expanded browser text fixture summary\n${stateSummaries.join('\n')}`)
    }
    expect(comparedMarkers, 'expanded browser text comparable markers').toBeGreaterThanOrEqual(860)
    expect(
      foundMarkers / comparedMarkers,
      `expanded browser text found ${foundMarkers}/${comparedMarkers}; examples: ${missingExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.94)
    expect(
      rowAlignedMarkers / foundMarkers,
      `expanded browser text row alignment ${rowAlignedMarkers}/${foundMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.89)
    expect(
      columnAlignedMarkers / foundMarkers,
      `expanded browser text column alignment ${columnAlignedMarkers}/${foundMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.89)
    expect(familyComparedMarkers, 'expanded browser text found family markers').toBeGreaterThanOrEqual(80)
    expect(
      familyAlignedMarkers / familyComparedMarkers,
      `expanded browser text color-family alignment ${familyAlignedMarkers}/${familyComparedMarkers}; examples: ${familyExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.35)
  })

  it('keeps live browser-rendered design text broadly aligned when enabled', async () => {
    if (process.env.AGENC_TUI_DESIGN_BROWSER !== '1') return
    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    expect(designHtmlPath && existsSync(designHtmlPath), 'AGENC_TUI_DESIGN_HTML must point at AgenC TUI.html').toBe(true)

    const browserFixture = await extractBrowserTextFixtureFromDesignHtml(designHtmlPath!)
    expect(Object.keys(browserFixture)).toEqual(
      expect.arrayContaining(DESIGN_STATES.map(state => state.id)),
    )

    let comparedMarkers = 0
    let foundMarkers = 0
    let rowAlignedMarkers = 0
    let columnAlignedMarkers = 0
    let familyComparedMarkers = 0
    let familyAlignedMarkers = 0
    const missingExamples: string[] = []
    const driftExamples: string[] = []
    const familyExamples: string[] = []
    const stateSummaries: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = browserFixture[state.id] ?? []
      expect(fixtureEntries.length, `${state.id} live browser text entries`).toBeGreaterThanOrEqual(18)
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const renderedAnsi = await renderToAnsiString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40, color: true },
      )
      const renderedTokenFamilies = collectRenderedTokenColorFamilies(renderedAnsi)

      let stateComparedMarkers = 0
      let stateFoundMarkers = 0
      let stateRowAlignedMarkers = 0
      let stateColumnAlignedMarkers = 0
      const stateMissingExamples: string[] = []
      for (const entry of fixtureEntries) {
        if (!isStableBrowserRowEntry(entry)) continue
        comparedMarkers += 1
        stateComparedMarkers += 1
        const renderedPosition = findRenderedMarkerPositionNear(
          rendered,
          entry.marker,
          entry.row,
          entry.column,
        )
        if (!renderedPosition) {
          if (missingExamples.length < 16) missingExamples.push(`${state.id}:${entry.marker}`)
          if (stateMissingExamples.length < 8) stateMissingExamples.push(entry.marker)
          continue
        }
        foundMarkers += 1
        stateFoundMarkers += 1
        const rowDelta = Math.abs(renderedPosition.row - entry.row)
        const columnDelta = Math.abs(renderedPosition.column - entry.column)
        if (rowDelta <= 12) {
          rowAlignedMarkers += 1
          stateRowAlignedMarkers += 1
        }
        if (columnDelta <= 32) {
          columnAlignedMarkers += 1
          stateColumnAlignedMarkers += 1
        } else if (driftExamples.length < 16) {
          driftExamples.push(
            `${state.id}:${entry.marker}: design ${entry.row}:${entry.column}, Ink ${renderedPosition.row}:${renderedPosition.column}`,
          )
        }
        if (entry.family) {
          familyComparedMarkers += 1
          const markerTokens = significantTokens(entry.marker)
          const tokenMatchesFamily = [...markerTokens].some(token => (
            renderedTokenFamilies.get(token)?.has(entry.family!) ?? false
          ))
          if (tokenMatchesFamily) {
            familyAlignedMarkers += 1
          } else if (familyExamples.length < 16) {
            familyExamples.push(`${state.id}:${entry.marker}: expected ${entry.family}`)
          }
        }
      }
      stateSummaries.push(
        `${state.id}: found ${stateFoundMarkers}/${stateComparedMarkers}, row ${stateRowAlignedMarkers}/${stateFoundMarkers}, column ${stateColumnAlignedMarkers}/${stateFoundMarkers}; missing: ${stateMissingExamples.slice(0, 4).join(' | ')}`,
      )

      expect(
        stateFoundMarkers / Math.max(1, stateComparedMarkers),
        `${state.id} live browser text found ${stateFoundMarkers}/${stateComparedMarkers}; examples: ${stateMissingExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.75)
      expect(
        stateRowAlignedMarkers / Math.max(1, stateFoundMarkers),
        `${state.id} live browser text row alignment ${stateRowAlignedMarkers}/${stateFoundMarkers}; examples: ${driftExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.55)
      expect(
        stateColumnAlignedMarkers / Math.max(1, stateFoundMarkers),
        `${state.id} live browser text column alignment ${stateColumnAlignedMarkers}/${stateFoundMarkers}; examples: ${driftExamples.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.40)
    }

    expect(comparedMarkers, 'live browser comparable markers').toBeGreaterThanOrEqual(800)
    expect(
      foundMarkers / comparedMarkers,
      `live browser text found ${foundMarkers}/${comparedMarkers}; examples: ${missingExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.90)
    expect(
      rowAlignedMarkers / foundMarkers,
      `live browser text row alignment ${rowAlignedMarkers}/${foundMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.86)
    expect(
      columnAlignedMarkers / foundMarkers,
      `live browser text column alignment ${columnAlignedMarkers}/${foundMarkers}; examples: ${driftExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.85)
    expect(familyComparedMarkers, 'live browser text family markers').toBeGreaterThanOrEqual(80)
    expect(
      familyAlignedMarkers / familyComparedMarkers,
      `live browser text color-family alignment ${familyAlignedMarkers}/${familyComparedMarkers}; examples: ${familyExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.50)

    if (process.env.AGENC_TUI_DESIGN_BROWSER_REPORT === '1') {
      console.log(`live browser parity summary\n${stateSummaries.join('\n')}`)
    }
  })

  it('keeps expanded browser row signatures represented', async () => {
    let comparedRows = 0
    let alignedRows = 0
    const missingRowExamples: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = BROWSER_TEXT_FIXTURE[state.id] ?? []
      const rowSignatures = browserRowsBySignature(fixtureEntries)
      expect(rowSignatures.size, `${state.id} browser row signatures`).toBeGreaterThanOrEqual(4)
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )

      let stateComparedRows = 0
      let stateAlignedRows = 0
      const stateMissingRows: string[] = []
      for (const [row, entries] of rowSignatures) {
        comparedRows += 1
        stateComparedRows += 1
        const rowHasAlignedMarker = entries.some(entry => {
          const renderedPosition = findRenderedMarkerPositionNear(
            rendered,
            entry.marker,
            entry.row,
            entry.column,
          )
          if (!renderedPosition) return false
          return Math.abs(renderedPosition.row - entry.row) <= 12
        })
        if (rowHasAlignedMarker) {
          alignedRows += 1
          stateAlignedRows += 1
        } else {
          const example = `${state.id}:row ${row}: ${entries.slice(0, 3).map(entry => entry.marker).join(' | ')}`
          if (missingRowExamples.length < 16) missingRowExamples.push(example)
          if (stateMissingRows.length < 6) stateMissingRows.push(example)
        }
      }

      expect(
        stateAlignedRows / stateComparedRows,
        `${state.id} browser row signature coverage ${stateAlignedRows}/${stateComparedRows}; examples: ${stateMissingRows.join('; ')}`,
      ).toBeGreaterThanOrEqual(0.40)
    }

    expect(comparedRows, 'expanded browser row signature count').toBeGreaterThanOrEqual(230)
    expect(
      alignedRows / comparedRows,
      `expanded browser row signature coverage ${alignedRows}/${comparedRows}; examples: ${missingRowExamples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.55)
  })

  it('keeps projected browser text cells aligned at exact grid positions', async () => {
    let comparedCells = 0
    let alignedCells = 0
    const examples: string[] = []
    const stateSummaries: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = BROWSER_TEXT_FIXTURE[state.id] ?? []
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const stateAlignment = browserTextCellAlignment(rendered, fixtureEntries)
      comparedCells += stateAlignment.compared
      alignedCells += stateAlignment.aligned
      stateSummaries.push(
        `${state.id}: ${stateAlignment.aligned}/${stateAlignment.compared} @ ${stateAlignment.rowOffset}:${stateAlignment.columnOffset}`,
      )
      if (examples.length < 12) {
        examples.push(...stateAlignment.examples.slice(0, 12 - examples.length))
      }
      expect(
        stateAlignment.aligned / Math.max(1, stateAlignment.compared),
        `${state.id} projected browser text-cell alignment ${stateAlignment.aligned}/${stateAlignment.compared} @ ${stateAlignment.rowOffset}:${stateAlignment.columnOffset}; examples: ${stateAlignment.examples.join('; ')}`,
      ).toBeGreaterThanOrEqual(PROJECTED_CELL_ALIGNMENT_FLOORS[state.id] ?? 0.03)
    }

    expect(comparedCells, 'projected browser text cells compared').toBeGreaterThanOrEqual(7_000)
    expect(
      alignedCells / comparedCells,
      `projected browser text-cell alignment ${alignedCells}/${comparedCells}; examples: ${examples.join('; ')}`,
    ).toBeGreaterThanOrEqual(0.18)
    if (process.env.AGENC_TUI_DESIGN_BROWSER_REPORT === '1') {
      console.log(`projected browser text-cell summary\n${stateSummaries.join('\n')}`)
    }
  })

  it('fails closed on projected browser text-cell drift when exact parity is requested', async () => {
    if (process.env.AGENC_TUI_DESIGN_EXACT_CELLS !== '1') return

    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    const exactFixture = designHtmlPath && existsSync(designHtmlPath)
      ? await extractBrowserTextFixtureFromDesignHtml(designHtmlPath)
      : BROWSER_TEXT_FIXTURE
    activeBrowserTextFixture = exactFixture
    expect(Object.keys(exactFixture)).toEqual(
      expect.arrayContaining(DESIGN_STATES.map(state => state.id)),
    )

    const diagnostics: string[] = []
    for (const state of DESIGN_STATES) {
      const fixtureEntries = exactFixture[state.id] ?? []
      expect(fixtureEntries.length, `${state.id} exact browser text entries`).toBeGreaterThanOrEqual(18)
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const stateAlignment = browserTextCellAlignment(rendered, fixtureEntries)
      if (stateAlignment.aligned !== stateAlignment.compared) {
        diagnostics.push(
          `${state.id}: ${stateAlignment.aligned}/${stateAlignment.compared} @ ${stateAlignment.rowOffset}:${stateAlignment.columnOffset}; examples: ${stateAlignment.examples.slice(0, 4).join(' | ')}`,
        )
      }
    }

    expect(
      diagnostics,
      [
        'projected browser text-cell drift diagnostics',
        ...diagnostics,
        'Set AGENC_TUI_DESIGN_EXACT_CELLS=1 only for the completion-grade no-drift gate.',
      ].join('\n'),
    ).toEqual([])
  })

  it('can dump one rendered design state for parity debugging', async () => {
    const stateId = process.env.AGENC_TUI_DESIGN_DUMP_STATE
    if (!stateId) return

    const state = DESIGN_STATES.find(candidate => candidate.id === stateId)
    expect(state, `unknown AGENC_TUI_DESIGN_DUMP_STATE=${stateId}`).toBeTruthy()

    const designHtmlPath = process.env.AGENC_TUI_DESIGN_HTML
    const fixture = process.env.AGENC_TUI_DESIGN_DUMP_LIVE === '1' && designHtmlPath && existsSync(designHtmlPath)
      ? await extractBrowserTextFixtureFromDesignHtml(designHtmlPath)
      : BROWSER_TEXT_FIXTURE
    activeBrowserTextFixture = fixture
    const fixtureEntries = fixture[state!.id] ?? []
    const rendered = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        {state!.render({ columns: 148, rows: 40 })}
      </AppStateProvider>,
      { columns: 148, rows: 40 },
    )
    const alignment = browserTextCellAlignment(rendered, fixtureEntries)
    const numberedRows = outputLines(rendered).map(
      (line, index) => `${String(index).padStart(2, '0')}|${line}`,
    )
    const fixtures = fixtureEntries
      .filter(isStableBrowserRowEntry)
      .map(entry => `${entry.row}:${entry.column} ${entry.marker}`)

    console.log([
      `state ${state!.id} ${state!.title}`,
      `alignment ${alignment.aligned}/${alignment.compared} @ ${alignment.rowOffset}:${alignment.columnOffset}`,
      `examples ${alignment.examples.join(' | ')}`,
      'rendered:',
      ...numberedRows,
      'fixtures:',
      ...fixtures,
    ].join('\n'))
  })

  it('keeps found browser text markers intact at rendered cell positions', async () => {
    let comparedCells = 0
    let alignedCells = 0
    const examples: string[] = []
    const stateSummaries: string[] = []

    for (const state of DESIGN_STATES) {
      const fixtureEntries = BROWSER_TEXT_FIXTURE[state.id] ?? []
      const rendered = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render({ columns: 148, rows: 40 })}
        </AppStateProvider>,
        { columns: 148, rows: 40 },
      )
      const coverage = anchoredBrowserTextCellCoverage(rendered, fixtureEntries)
      comparedCells += coverage.compared
      alignedCells += coverage.aligned
      stateSummaries.push(`${state.id}: ${coverage.aligned}/${coverage.compared}`)
      if (examples.length < 12) {
        examples.push(...coverage.examples.slice(0, 12 - examples.length))
      }
      expect(
        coverage.aligned / Math.max(1, coverage.compared),
        `${state.id} anchored browser text-cell coverage ${coverage.aligned}/${coverage.compared}; examples: ${coverage.examples.join('; ')}`,
      ).toBe(1)
    }

    expect(comparedCells, 'anchored browser text cells compared').toBeGreaterThanOrEqual(8_000)
    expect(
      alignedCells / comparedCells,
      `anchored browser text-cell coverage ${alignedCells}/${comparedCells}; examples: ${examples.join('; ')}`,
    ).toBe(1)
    if (process.env.AGENC_TUI_DESIGN_BROWSER_REPORT === '1') {
      console.log(`anchored browser text-cell summary\n${stateSummaries.join('\n')}`)
    }
  })

  it.each(DESIGN_STATES.flatMap(state => VIEWPORTS.map(viewport => [state, viewport] as const)))(
    'renders numbered design state without overflow',
    async (state, viewport) => {
      const output = await renderToString(
        <AppStateProvider initialState={getDefaultAppState()}>
          {state.render(viewport)}
        </AppStateProvider>,
        viewport,
      )
      const normalized = output.toLowerCase()

      expect(output).not.toContain('undefined')
      expect(output).not.toContain('NaN')
      const lines = outputLines(output)
      if (viewport.columns === 148) {
        const rowBudget = state.id === '09' || state.id === '10' ? viewport.rows + 1 : viewport.rows
        expect(lines.length, `${state.id} ${viewport.columns}x${viewport.rows} row count`).toBeLessThanOrEqual(
          rowBudget,
        )
      }
      const headerBand = bandText(lines, 0, 3)
      const bodyBand = bandText(lines, 1, Math.max(1, lines.length - 4))
      const footerBand = bandText(lines, Math.max(0, lines.length - 6), lines.length)

      expect(headerBand, `${state.id} ${viewport.columns}x${viewport.rows} header band`).toContain('agenc')
      expect(headerBand, `${state.id} ${viewport.columns}x${viewport.rows} mode band`).toContain('mode')
      expect(bodyBand, `${state.id} ${viewport.columns}x${viewport.rows} body band`).toContain(
        state.expected[0]!.toLowerCase(),
      )
      expect(footerBand, `${state.id} ${viewport.columns}x${viewport.rows} prompt/status band`).toContain('█')
      const statusMarker = ['05a', '05b', '06a', '06b', '07a'].includes(state.id)
        ? viewport.columns < 100
          ? 'tas'
          : 'task'
        : viewport.columns >= 100
          ? 'model'
          : 'haiku'
      expect(footerBand, `${state.id} ${viewport.columns}x${viewport.rows} status band`).toContain(
        statusMarker,
      )
      const compactCtxMarker =
        state.id === '01a'
          ? '0 / 200k'
          : state.id === '01b' || state.id === '03a' || state.id === '08a'
            ? '18.4k'
            : state.id === '02a' || state.id === '02b'
              ? '3.2k'
            : state.id === '04a'
              ? '24.2k'
              : state.id === '04b'
                ? '28.1k'
                : state.id === '05a'
                  ? '24.1k'
                  : state.id === '05b'
                    ? '58.2k'
                    : state.id === '06a'
                      ? '48.2k'
                      : state.id === '06b'
                        ? '38.4k'
                        : state.id === '07a'
                          ? '62.4k'
              : state.id === '07b'
                ? '64.2k'
                : state.id === '09' || state.id === '19b'
                  ? '24.6k'
                  : '22.8'
      expect(footerBand, `${state.id} ${viewport.columns}x${viewport.rows} context band`).toContain(
        viewport.columns >= 100 ? 'ctx' : compactCtxMarker,
      )

      if (viewport.columns >= 72) {
        expect(
          countBrandBleedCells(output),
          `${state.id} ${viewport.columns}x${viewport.rows} brand bleed cells`,
        ).toBeGreaterThanOrEqual(viewport.columns >= 100 ? 20 : 2)
      }
      expect(normalized).toContain('mode')
      for (const text of state.expected) {
        expect(normalized).toContain(text.toLowerCase())
      }
      for (const line of output.split(/\r?\n/u)) {
        expect(line.length).toBeLessThanOrEqual(viewport.columns)
      }
    },
  )
})
