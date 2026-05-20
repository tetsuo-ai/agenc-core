import React from 'react'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { renderToAnsiString, renderToString } from '../../utils/staticRender.js'
import { FastIcon, getFastIconString } from './FastIcon.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ theme: 'dark' }),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('../../utils/systemTheme.js', () => ({
  getSystemThemeName: () => 'dark',
  resolveThemeSetting: () => 'dark',
}))

const originalChalkLevel = chalk.level

afterEach(() => {
  chalk.level = originalChalkLevel
})

describe('FastIcon coverage', () => {
  test('renders active and cooldown icons with matching plain string fallback', async () => {
    chalk.level = 3

    const activeText = await renderToString(<FastIcon />, 20)
    const cooldownText = await renderToString(<FastIcon cooldown={true} />, 20)

    expect(activeText).toBe(LIGHTNING_BOLT)
    expect(cooldownText).toBe(LIGHTNING_BOLT)
    expect(getFastIconString(false)).toBe(LIGHTNING_BOLT)

    const activeAnsi = await renderToAnsiString(<FastIcon />, {
      columns: 20,
      color: true,
    })
    const cooldownAnsi = await renderToAnsiString(<FastIcon cooldown={true} />, {
      columns: 20,
      color: true,
    })
    const activeString = getFastIconString(true, false)
    const cooldownString = getFastIconString(true, true)

    expect(stripAnsi(activeAnsi)).toBe(LIGHTNING_BOLT)
    expect(stripAnsi(cooldownAnsi)).toBe(LIGHTNING_BOLT)
    expect(stripAnsi(activeString)).toBe(LIGHTNING_BOLT)
    expect(stripAnsi(cooldownString)).toBe(LIGHTNING_BOLT)
    expect(activeAnsi).toContain('\u001B[')
    expect(cooldownAnsi).toContain('\u001B[')
    expect(activeString).toContain('\u001B[')
    expect(cooldownString).toContain('\u001B[')
    expect(cooldownAnsi).not.toBe(activeAnsi)
    expect(cooldownString).not.toBe(activeString)
  })
})
