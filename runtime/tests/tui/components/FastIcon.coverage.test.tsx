import React from 'react'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test } from 'vitest'

import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { renderToAnsiString, renderToString } from '../../utils/staticRender.js'
import { FastIcon } from './FastIcon.js'

const originalChalkLevel = chalk.level

afterEach(() => {
  chalk.level = originalChalkLevel
})

describe('FastIcon coverage', () => {
  test('renders distinct active and cooldown icons', async () => {
    chalk.level = 3

    const activeText = await renderToString(<FastIcon />, 20)
    const cooldownText = await renderToString(<FastIcon cooldown={true} />, 20)

    expect(activeText).toBe(LIGHTNING_BOLT)
    expect(cooldownText).toBe(LIGHTNING_BOLT)
    const activeAnsi = await renderToAnsiString(<FastIcon />, {
      columns: 20,
      color: true,
    })
    const cooldownAnsi = await renderToAnsiString(<FastIcon cooldown={true} />, {
      columns: 20,
      color: true,
    })
    expect(stripAnsi(activeAnsi)).toBe(LIGHTNING_BOLT)
    expect(stripAnsi(cooldownAnsi)).toBe(LIGHTNING_BOLT)
    expect(activeAnsi).toContain('\u001B[')
    expect(cooldownAnsi).toContain('\u001B[')
    expect(cooldownAnsi).not.toBe(activeAnsi)
  })
})
