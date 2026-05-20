import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test, vi } from 'vitest'

type ColorizeModule = typeof import('./colorize.js')

const ORIGINAL_ENV = {
  AGENC_TMUX_TRUECOLOR: process.env.AGENC_TMUX_TRUECOLOR,
  TERM_PROGRAM: process.env.TERM_PROGRAM,
  TMUX: process.env.TMUX,
}
const ORIGINAL_CHALK_LEVEL = chalk.level

function restoreEnv(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name]
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

async function loadColorize(): Promise<ColorizeModule> {
  vi.resetModules()
  return await import('./colorize.js')
}

describe('colorize coverage', () => {
  afterEach(() => {
    restoreEnv('AGENC_TMUX_TRUECOLOR')
    restoreEnv('TERM_PROGRAM')
    restoreEnv('TMUX')
    chalk.level = ORIGINAL_CHALK_LEVEL
    vi.resetModules()
  })

  test('applies every supported raw color format for foreground and background output', async () => {
    delete process.env.AGENC_TMUX_TRUECOLOR
    delete process.env.TERM_PROGRAM
    delete process.env.TMUX
    chalk.level = 3

    const { applyColor, applyTextStyles, colorize } = await loadColorize()

    expect(colorize('sample', undefined, 'foreground')).toBe('sample')
    expect(colorize('sample', 'ansi:not-a-real-color', 'foreground')).toBe(
      'sample',
    )
    expect(colorize('sample', 'ansi256(nope)', 'foreground')).toBe('sample')
    expect(colorize('sample', 'rgb(1,2)', 'background')).toBe('sample')
    expect(colorize('sample', 'named-color', 'foreground')).toBe('sample')

    const ansiColors: Array<{
      readonly name: string
      readonly foreground: number
      readonly background: number
    }> = [
      { name: 'black', foreground: 30, background: 40 },
      { name: 'red', foreground: 31, background: 41 },
      { name: 'green', foreground: 32, background: 42 },
      { name: 'yellow', foreground: 33, background: 43 },
      { name: 'blue', foreground: 34, background: 44 },
      { name: 'magenta', foreground: 35, background: 45 },
      { name: 'cyan', foreground: 36, background: 46 },
      { name: 'white', foreground: 37, background: 47 },
      { name: 'blackBright', foreground: 90, background: 100 },
      { name: 'redBright', foreground: 91, background: 101 },
      { name: 'greenBright', foreground: 92, background: 102 },
      { name: 'yellowBright', foreground: 93, background: 103 },
      { name: 'blueBright', foreground: 94, background: 104 },
      { name: 'magentaBright', foreground: 95, background: 105 },
      { name: 'cyanBright', foreground: 96, background: 106 },
      { name: 'whiteBright', foreground: 97, background: 107 },
    ]

    for (const { name, foreground, background } of ansiColors) {
      expect(colorize('x', `ansi:${name}`, 'foreground')).toBe(
        `\x1B[${foreground}mx\x1B[39m`,
      )
      expect(colorize('x', `ansi:${name}`, 'background')).toBe(
        `\x1B[${background}mx\x1B[49m`,
      )
    }

    expect(colorize('x', '#010203', 'foreground')).toBe(
      '\x1B[38;2;1;2;3mx\x1B[39m',
    )
    expect(colorize('x', '#010203', 'background')).toBe(
      '\x1B[48;2;1;2;3mx\x1B[49m',
    )
    expect(colorize('x', 'ansi256(202)', 'foreground')).toBe(
      '\x1B[38;5;202mx\x1B[39m',
    )
    expect(colorize('x', 'ansi256(202)', 'background')).toBe(
      '\x1B[48;5;202mx\x1B[49m',
    )
    expect(colorize('x', 'rgb(4, 5, 6)', 'foreground')).toBe(
      '\x1B[38;2;4;5;6mx\x1B[39m',
    )
    expect(colorize('x', 'rgb(4, 5, 6)', 'background')).toBe(
      '\x1B[48;2;4;5;6mx\x1B[49m',
    )

    expect(applyColor('plain', undefined)).toBe('plain')

    const styled = applyTextStyles('decorated', {
      backgroundColor: 'ansi256(45)',
      bold: true,
      color: 'rgb(7,8,9)',
      dim: true,
      inverse: true,
      italic: true,
      strikethrough: true,
      underline: true,
    })

    expect(stripAnsi(styled)).toBe('decorated')
    expect(styled).toContain('\x1B[48;5;45m')
    expect(styled).toContain('\x1B[38;2;7;8;9m')
    expect(styled).toContain('\x1B[1m')
    expect(styled).toContain('\x1B[2m')
    expect(styled).toContain('\x1B[3m')
    expect(styled).toContain('\x1B[4m')
    expect(styled).toContain('\x1B[7m')
    expect(styled).toContain('\x1B[9m')
  })

  test('adjusts chalk color level for xterm.js and tmux module-load environments', async () => {
    delete process.env.AGENC_TMUX_TRUECOLOR
    process.env.TERM_PROGRAM = 'vscode'
    delete process.env.TMUX
    chalk.level = 2

    const xtermJs = await loadColorize()

    expect(xtermJs.CHALK_BOOSTED_FOR_XTERMJS).toBe(true)
    expect(xtermJs.CHALK_CLAMPED_FOR_TMUX).toBe(false)
    expect(chalk.level).toBe(3)

    delete process.env.AGENC_TMUX_TRUECOLOR
    process.env.TERM_PROGRAM = 'vscode'
    process.env.TMUX = '/tmp/tmux-1000/default,1,0'
    chalk.level = 2

    const tmuxInsideXtermJs = await loadColorize()

    expect(tmuxInsideXtermJs.CHALK_BOOSTED_FOR_XTERMJS).toBe(true)
    expect(tmuxInsideXtermJs.CHALK_CLAMPED_FOR_TMUX).toBe(true)
    expect(chalk.level).toBe(2)

    process.env.AGENC_TMUX_TRUECOLOR = '1'
    delete process.env.TERM_PROGRAM
    process.env.TMUX = '/tmp/tmux-1000/default,1,0'
    chalk.level = 3

    const truecolorTmux = await loadColorize()

    expect(truecolorTmux.CHALK_BOOSTED_FOR_XTERMJS).toBe(false)
    expect(truecolorTmux.CHALK_CLAMPED_FOR_TMUX).toBe(false)
    expect(chalk.level).toBe(3)
  })
})
