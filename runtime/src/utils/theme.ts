import chalk, { Chalk } from 'chalk'
import {
  TUI_THEME_SETTINGS,
  type TuiThemeSetting,
} from '../config/schema.js'
import { env } from './env.js'

export type Theme = {
  autoAccept: string
  bashBorder: string
  agenc: string
  agencShimmer: string // Lighter version of agenc color for shimmer effect
  agencBlue_FOR_SYSTEM_SPINNER: string
  agencBlueShimmer_FOR_SYSTEM_SPINNER: string
  permission: string
  permissionShimmer: string // Lighter version of permission color for shimmer effect
  planMode: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string // Lighter version of promptBorder color for shimmer effect
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string // Lighter version of inactive color for shimmer effect
  subtle: string
  suggestion: string
  remember: string
  background: string
  // Semantic colors
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string // Lighter version of warning color for shimmer effect
  // Diff colors
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  // Word-level diff highlighting
  diffAddedWord: string
  diffRemovedWord: string
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  yellow_FOR_SUBAGENTS_ONLY: string
  purple_FOR_SUBAGENTS_ONLY: string
  orange_FOR_SUBAGENTS_ONLY: string
  pink_FOR_SUBAGENTS_ONLY: string
  cyan_FOR_SUBAGENTS_ONLY: string
  // Grove colors
  professionalBlue: string
  // Chrome colors
  chromeYellow: string
  // TUI V2 colors
  clawd_body: string
  clawd_background: string
  surfaceBackground: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  /** Message-actions selection. Cool shift toward `suggestion` blue; distinct from default AND userMessageBackground. */
  messageActionsBackground: string
  /** Text-selection highlight background (alt-screen mouse selection). Solid
   *  bg that REPLACES the cell's bg while preserving its fg — matches native
   *  terminal selection. Previously SGR-7 inverse (swapped fg/bg per cell),
   *  which fragmented badly over syntax highlighting. */
  selectionBg: string
  bashMessageBackgroundColor: string
  agencWash: string
  worker: string
  workerWash: string
  successWash: string
  errorWash: string
  text2: string
  muted3: string
  line: string
  lineSoft: string
  /** Fill behind the prompt input. It replaces the prompt border, so it must
   *  stay visible against the terminal's own background. */
  promptBackground: string
  /** Brand purple: the user's ❯, the reply ●, and the working line. */
  accent: string
  /** Softer brand violet: file names, the model name, the shimmer peak. */
  accentSoft: string
  /** A tool step that finished. */
  stepOk: string
  /** A tool step that failed. */
  stepFail: string
  /** Band behind the user's own messages. */
  userBand: string
  briefLabelWorker: string
  planModeWash: string

  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  // Brief/assistant mode label colors
  briefLabelYou: string
  briefLabelAgenC: string
  // Rainbow colors for ultrathink keyword highlighting
  rainbow_red: string
  rainbow_orange: string
  rainbow_yellow: string
  rainbow_green: string
  rainbow_blue: string
  rainbow_indigo: string
  rainbow_violet: string
  rainbow_red_shimmer: string
  rainbow_orange_shimmer: string
  rainbow_yellow_shimmer: string
  rainbow_green_shimmer: string
  rainbow_blue_shimmer: string
  rainbow_indigo_shimmer: string
  rainbow_violet_shimmer: string
}

export const THEME_NAMES = TUI_THEME_SETTINGS.slice(1) as readonly Exclude<
  (typeof TUI_THEME_SETTINGS)[number],
  'auto'
>[]

/** A renderable theme. Always resolvable to a concrete color palette. */
export type ThemeName = (typeof THEME_NAMES)[number]

export const AURA_LIFECYCLE_GLYPHS = {
  queued: '○',
  running: '◐',
  done: '●',
  failed: '✕',
} as const

export const AURA_PLAN_GLYPHS = {
  done: AURA_LIFECYCLE_GLYPHS.done,
  active: '▮',
  pending: AURA_LIFECYCLE_GLYPHS.queued,
  failed: AURA_LIFECYCLE_GLYPHS.failed,
} as const

/**
 * A theme preference stored by the canonical settings authority. `'auto'`
 * follows the terminal dark/light mode and resolves to a ThemeName at runtime.
 */
export type ThemeSetting = TuiThemeSetting

/**
 * Dark theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const chromaticDarkTheme: Theme = {
  autoAccept: 'rgb(206,92,255)', // hot violet
  bashBorder: 'rgb(255,132,66)', // command orange
  agenc: 'rgb(206,92,255)', // neon purple
  agencShimmer: 'rgb(238,196,255)', // pale lavender shimmer
  agencBlue_FOR_SYSTEM_SPINNER: 'rgb(161,92,255)', // violet for system spinner
  agencBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(215,174,255)', // lighter spinner shimmer
  permission: 'rgb(177,91,255)', // panel purple
  permissionShimmer: 'rgb(227,187,255)', // lighter panel shimmer
  planMode: 'rgb(142,99,255)', // muted violet
  ide: 'rgb(82,214,255)', // cool cyan
  promptBorder: 'rgb(129,55,176)', // purple chrome line
  promptBorderShimmer: 'rgb(190,122,255)', // lighter chrome line
  text: 'rgb(255,255,255)', // White
  inverseText: 'rgb(13,10,20)', // near-black
  inactive: 'rgb(139,120,157)', // muted lavender gray
  inactiveShimmer: 'rgb(193,170,216)', // lighter inactive shimmer
  subtle: 'rgb(74,61,92)', // dark lavender gray
  suggestion: 'rgb(178,95,255)', // menu purple
  remember: 'rgb(178,95,255)', // menu purple
  background: 'rgb(39,22,54)', // panel purple background
  success: 'rgb(44,214,139)', // task-settled green
  error: 'rgb(255,79,122)', // slashed red
  warning: 'rgb(255,151,72)', // approval orange
  merged: 'rgb(206,92,255)', // hot violet
  warningShimmer: 'rgb(255,195,124)', // lighter approval orange
  diffAdded: 'rgb(18,94,62)', // dark green
  diffRemoved: 'rgb(107,32,56)', // dark red
  diffAddedDimmed: 'rgb(23,62,48)', // very dark green
  diffRemovedDimmed: 'rgb(72,35,50)', // very dark red
  diffAddedWord: 'rgb(45,226,146)', // bright green
  diffRemovedWord: 'rgb(255,88,128)', // bright red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(255,79,122)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(82,164,255)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(44,214,139)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(255,210,92)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(178,95,255)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,151,72)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,91,190)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(82,214,255)',
  // Grove colors
  professionalBlue: 'rgb(82,164,255)',
  // Chrome colors
  chromeYellow: 'rgb(255,210,92)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(206,92,255)',
  clawd_background: 'rgb(6,5,10)',
  surfaceBackground: 'rgb(6,5,10)',
  userMessageBackground: 'rgb(34, 20, 48)',
  userMessageBackgroundHover: 'rgb(48, 29, 68)',
  messageActionsBackground: 'rgb(44, 27, 61)',
  selectionBg: 'rgb(96, 44, 150)', // violet selection against light text
  bashMessageBackgroundColor: 'rgb(24, 15, 32)',
  agencWash: 'rgb(36,25,49)',
  worker: 'rgb(255,106,47)',
  workerWash: 'rgb(46,26,22)',
  successWash: 'rgb(19,38,31)',
  errorWash: 'rgb(46,22,31)',
  text2: 'rgb(206,205,212)',
  muted3: 'rgb(64,64,70)',
  line: 'rgb(52,53,57)',
  lineSoft: 'rgb(34,35,39)',
  promptBackground: 'rgb(34,35,39)',
  accent: 'rgb(206,92,255)',
  accentSoft: 'rgb(178,140,255)',
  stepOk: 'rgb(44,214,139)',
  stepFail: 'rgb(255,79,122)',
  userBand: 'rgb(36,25,49)',
  briefLabelWorker: 'rgb(255,151,72)',
  planModeWash: 'rgb(46,26,22)',

  memoryBackgroundColor: 'rgb(22, 40, 48)',
  rate_limit_fill: 'rgb(178,95,255)',
  rate_limit_empty: 'rgb(55,39,72)',
  briefLabelYou: 'rgb(82,214,255)',
  briefLabelAgenC: 'rgb(206,92,255)',
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

// Every theme starts monochrome: painted surfaces take one background
// (black or white) and every foreground takes the opposite ink, so hierarchy
// comes from weight and gray steps. A few accents then carry meaning: the
// brand purple marks who speaks, green and red mark how a step ended and
// what an edit changed. Glyphs and copy still carry the same meaning, so
// color is never the only signal. The chromatic palette above supplies the
// token list.
const monochromeBackgroundTokens = new Set<keyof Theme>([
  'background',
  'diffAdded',
  'diffRemoved',
  'diffAddedDimmed',
  'diffRemovedDimmed',
  'clawd_background',
  'surfaceBackground',
  'userMessageBackground',
  'userMessageBackgroundHover',
  'messageActionsBackground',
  'selectionBg',
  'bashMessageBackgroundColor',
  'agencWash',
  'workerWash',
  'successWash',
  'errorWash',
  'planModeWash',
  'memoryBackgroundColor',
  'rate_limit_empty',
])

function monochromeTheme(
  surface: string,
  ink: string,
  tones: Partial<Theme>,
): Theme {
  return Object.fromEntries(
    (Object.keys(chromaticDarkTheme) as Array<keyof Theme>).map((token) => [
      token,
      tones[token] ??
        (monochromeBackgroundTokens.has(token) || token === 'inverseText'
          ? surface
          : ink),
    ]),
  ) as Theme
}

const darkTheme = monochromeTheme('rgb(0,0,0)', 'rgb(255,255,255)', {
  inactive: 'rgb(112,112,112)',
  inactiveShimmer: 'rgb(142,142,142)',
  subtle: 'rgb(82,82,82)',
  muted3: 'rgb(68,68,68)',
  line: 'rgb(48,48,48)',
  lineSoft: 'rgb(34,34,34)',
  promptBackground: 'rgb(34,34,34)',
  // Color only where it carries meaning: the brand purple marks who speaks,
  // green and red mark how a step ended and what an edit changed.
  accent: 'rgb(206,92,255)',
  accentSoft: 'rgb(178,140,255)',
  stepOk: 'rgb(44,214,139)',
  stepFail: 'rgb(255,79,122)',
  userBand: 'rgb(36,25,49)',
  success: 'rgb(44,214,139)',
  error: 'rgb(255,79,122)',
  diffAdded: 'rgb(14,48,34)',
  diffRemoved: 'rgb(56,20,32)',
  diffAddedDimmed: 'rgb(10,30,22)',
  diffRemovedDimmed: 'rgb(36,14,22)',
  diffAddedWord: 'rgb(44,214,139)',
  diffRemovedWord: 'rgb(255,79,122)',
})

// The light grays keep the dark theme's contrast against the surface, so
// muted text reads the same weight on a white terminal.
const lightTheme = monochromeTheme('rgb(255,255,255)', 'rgb(0,0,0)', {
  inactive: 'rgb(118,118,118)',
  inactiveShimmer: 'rgb(96,96,96)',
  subtle: 'rgb(158,158,158)',
  muted3: 'rgb(176,176,176)',
  line: 'rgb(204,204,204)',
  lineSoft: 'rgb(225,225,225)',
  promptBackground: 'rgb(232,232,232)',
  accent: 'rgb(134,46,200)',
  accentSoft: 'rgb(110,70,190)',
  stepOk: 'rgb(16,140,84)',
  stepFail: 'rgb(204,32,72)',
  userBand: 'rgb(244,238,252)',
  success: 'rgb(16,140,84)',
  error: 'rgb(204,32,72)',
  diffAdded: 'rgb(222,246,232)',
  diffRemoved: 'rgb(253,228,234)',
  diffAddedDimmed: 'rgb(236,250,242)',
  diffRemovedDimmed: 'rgb(254,240,243)',
  diffAddedWord: 'rgb(16,140,84)',
  diffRemovedWord: 'rgb(204,32,72)',
})

// Sixteen-color terminals have one gray on each side, so the ANSI themes use
// the terminal's own palette for the muted tones and the prompt fill.
const darkAnsiTheme = monochromeTheme('ansi:black', 'ansi:whiteBright', {
  inactive: 'ansi:white',
  inactiveShimmer: 'ansi:whiteBright',
  subtle: 'ansi:blackBright',
  muted3: 'ansi:blackBright',
  line: 'ansi:blackBright',
  lineSoft: 'ansi:blackBright',
  promptBackground: 'ansi:blackBright',
  accent: 'ansi:magentaBright',
  accentSoft: 'ansi:magenta',
  stepOk: 'ansi:greenBright',
  stepFail: 'ansi:redBright',
  userBand: 'ansi:blackBright',
  success: 'ansi:greenBright',
  error: 'ansi:redBright',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
})

const lightAnsiTheme = monochromeTheme('ansi:whiteBright', 'ansi:black', {
  inactive: 'ansi:blackBright',
  inactiveShimmer: 'ansi:black',
  subtle: 'ansi:white',
  muted3: 'ansi:white',
  line: 'ansi:white',
  lineSoft: 'ansi:white',
  promptBackground: 'ansi:white',
  accent: 'ansi:magenta',
  accentSoft: 'ansi:magenta',
  stepOk: 'ansi:green',
  stepFail: 'ansi:red',
  userBand: 'ansi:white',
  success: 'ansi:green',
  error: 'ansi:red',
  diffAddedWord: 'ansi:green',
  diffRemovedWord: 'ansi:red',
})

/**
 * Without truecolor (Apple Terminal, most 256-color terminals) a dark tint
 * such as the user band's rgb(36,25,49) rounds to a saturated palette entry
 * (#5f005f, a loud magenta), and a light tint rounds to plain white. Tinted
 * backgrounds then fall back to the neutral prompt gray and the surface, so
 * diffs keep only their green and red text. Foreground accents survive the
 * 256-color palette and stay.
 */
const lowColorThemes = new WeakMap<Theme, Theme>()
/**
 * Whether row tints (a faint green or red behind a diff line) render as
 * tints. Without truecolor they quantize to saturated palette colors, so
 * rows carry their meaning in colored text alone.
 */
export function supportsRowTints(): boolean {
  return chalk.level >= 3
}

function forTerminalColorDepth(theme: Theme): Theme {
  if (chalk.level >= 3) return theme
  let lowColor = lowColorThemes.get(theme)
  if (lowColor === undefined) {
    lowColor = {
      ...theme,
      userBand: theme.promptBackground,
      diffAdded: theme.surfaceBackground,
      diffRemoved: theme.surfaceBackground,
      diffAddedDimmed: theme.surfaceBackground,
      diffRemovedDimmed: theme.surfaceBackground,
    }
    lowColorThemes.set(theme, lowColor)
  }
  return lowColor
}

export function getTheme(themeName: ThemeName): Theme {
  return forTerminalColorDepth(getBaseTheme(themeName))
}

function getBaseTheme(themeName: ThemeName): Theme {
  switch (themeName) {
    case 'light':
    // Monochrome has no red/green pairs, so the color-blind variants share
    // the base themes.
    case 'light-daltonized':
      return lightTheme
    case 'light-ansi':
      return lightAnsiTheme
    case 'dark-ansi':
      return darkAnsiTheme
    default:
      return darkTheme
  }
}

// Create a chalk instance with 256-color level for Apple Terminal
// Apple Terminal doesn't handle 24-bit color escape sequences well
const chalkForChart =
  env.terminal === 'Apple_Terminal'
    ? new Chalk({ level: 2 }) // 256 colors
    : chalk

/**
 * Converts a theme color to an ANSI escape sequence for use with asciichart.
 * Uses chalk to generate the escape codes, with 256-color mode for Apple Terminal.
 */
export function themeColorToAnsi(themeColor: string): string {
  const rgbMatch = themeColor.match(/rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]!, 10)
    const g = parseInt(rgbMatch[2]!, 10)
    const b = parseInt(rgbMatch[3]!, 10)
    // Use chalk.rgb which auto-converts to 256 colors when level is 2
    // Extract just the opening escape sequence by using a marker
    const colored = chalkForChart.rgb(r, g, b)('X')
    return colored.slice(0, colored.indexOf('X'))
  }
  // Fallback to magenta if parsing fails
  return '\x1b[35m'
}
