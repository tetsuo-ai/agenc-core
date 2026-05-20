import { pathToFileURL } from 'node:url'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { renderToAnsiString } from '../../utils/staticRender.js'
import { Box } from '../ink.js'
import { ClickableImageRef } from './ClickableImageRef.js'

const imageStoreMock = vi.hoisted(() => ({
  pathById: new Map<number, string>(),
}))

vi.mock('../../utils/imageStore.js', () => ({
  getStoredImagePath: (imageId: number) =>
    imageStoreMock.pathById.get(imageId) ?? null,
}))

const hyperlinkEnvKeys = [
  'FORCE_HYPERLINK',
  'LC_TERMINAL',
  'NO_COLOR',
  'TERM',
  'TERM_PROGRAM',
] as const
const previousHyperlinkEnv = new Map(
  hyperlinkEnvKeys.map(key => [key, process.env[key]]),
)
const osc8Prefix = '\x1B]8;'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function expectOsc8Link(output: string, url: string, label: string): void {
  const pattern = [
    '\\x1B\\]8;[^;\\x07]*;',
    escapeRegExp(url),
    '\\x07',
    escapeRegExp(label),
    '\\x1B\\]8;;\\x07',
  ].join('')

  expect(output).toMatch(new RegExp(pattern))
}

afterEach(() => {
  imageStoreMock.pathById.clear()

  for (const key of hyperlinkEnvKeys) {
    const value = previousHyperlinkEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

function setHyperlinksSupported(supported: boolean): void {
  process.env.FORCE_HYPERLINK = supported ? '1' : '0'
  delete process.env.LC_TERMINAL
  delete process.env.NO_COLOR
  process.env.TERM = 'xterm-256color'
  delete process.env.TERM_PROGRAM
}

describe('ClickableImageRef wave200-092 coverage', () => {
  test('renders cached images as OSC 8 links and falls back to text when unavailable', async () => {
    const imagePath = '/tmp/agenc image cache/selected.png'
    imageStoreMock.pathById.set(7, imagePath)
    setHyperlinksSupported(true)

    const linkedOutput = await renderToAnsiString(
      <ClickableImageRef imageId={7} />,
      { columns: 80 },
    )

    expectOsc8Link(linkedOutput, pathToFileURL(imagePath).href, '[Image #7]')

    setHyperlinksSupported(false)
    const unsupportedOutput = await renderToAnsiString(
      <ClickableImageRef imageId={7} isSelected backgroundColor="warning" />,
      { columns: 80 },
    )

    expect(stripAnsi(unsupportedOutput)).toContain('[Image #7]')
    expect(unsupportedOutput).not.toContain(osc8Prefix)

    imageStoreMock.pathById.clear()
    setHyperlinksSupported(true)
    const missingOutput = await renderToAnsiString(
      <Box>
        <ClickableImageRef imageId={8} />
      </Box>,
      { columns: 80 },
    )

    expect(stripAnsi(missingOutput)).toContain('[Image #8]')
    expect(missingOutput).not.toContain(osc8Prefix)
  })
})
