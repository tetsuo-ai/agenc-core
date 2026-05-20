import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import type { PrReviewState } from '../../utils/ghPrStatus.js'
import { getTheme } from '../../utils/theme.js'
import type { DOMElement } from '../ink/dom.js'
import instances from '../ink/instances.js'
import { createRoot } from '../ink/root.js'
import { squashTextNodesToSegments } from '../ink/squash-text-nodes.js'
import { PrBadge } from './PrBadge.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

const previousForceHyperlink = process.env.FORCE_HYPERLINK

function createTestStreams(): {
  stdout: PassThrough
  stdin: TestStdin
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdout, stdin }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
  if (previousForceHyperlink === undefined) {
    delete process.env.FORCE_HYPERLINK
  } else {
    process.env.FORCE_HYPERLINK = previousForceHyperlink
  }
})

describe('PrBadge coverage', () => {
  test('renders review-state colors, hyperlink styling, and unreviewed bold fallback', async () => {
    process.env.FORCE_HYPERLINK = '1'
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    const statusCases: Array<{
      number: number
      state: PrReviewState
      color: 'success' | 'error' | 'warning' | 'merged' | undefined
    }> = [
      { number: 101, state: 'approved', color: 'success' },
      { number: 102, state: 'changes_requested', color: 'error' },
      { number: 103, state: 'pending', color: 'warning' },
      { number: 104, state: 'merged', color: 'merged' },
      { number: 105, state: 'draft', color: undefined },
    ]
    const theme = getTheme('dark')

    try {
      root.render(
        <>
          {statusCases.map(({ number, state }) => (
            <PrBadge
              key={number}
              number={number}
              url={`https://example.test/pull/${number}`}
              reviewState={state}
            />
          ))}
          <PrBadge
            number={106}
            url="https://example.test/pull/106"
            bold={true}
          />
        </>,
      )
      await sleep(25)

      const segments = squashTextNodesToSegments(getRootNode(stdout))

      expect(segments.map(segment => segment.text).join('')).toContain(
        'PR #101PR #102PR #103PR #104PR #105PR #106',
      )

      for (const { number, color } of statusCases) {
        const url = `https://example.test/pull/${number}`
        const numberSegments = segments.filter(
          segment => segment.hyperlink === url,
        )
        expect(numberSegments.map(segment => segment.text).join('')).toBe(
          `#${number}`,
        )

        const [hashSegment, digitsSegment] = numberSegments
        expect(hashSegment).toMatchObject({
          hyperlink: url,
          styles: expect.objectContaining({ underline: true }),
        })
        expect(digitsSegment).toMatchObject({
          hyperlink: url,
          styles: expect.objectContaining({ underline: true }),
        })

        if (color === undefined) {
          expect(hashSegment?.styles).toMatchObject({
            color: theme.inactive,
            underline: true,
          })
          expect(digitsSegment?.styles).toMatchObject(hashSegment!.styles)
        } else {
          expect(hashSegment?.styles).toMatchObject({
            color: theme[color],
            underline: true,
          })
          expect(digitsSegment?.styles).toMatchObject(hashSegment!.styles)
        }
      }

      const prLabels = segments.filter(segment => segment.text === 'PR')
      expect(prLabels.slice(0, 5).map(segment => segment.styles.color)).toEqual(
        Array.from({ length: 5 }, () => theme.inactive),
      )

      const boldFallback = segments.filter(
        segment => segment.hyperlink === 'https://example.test/pull/106',
      )
      expect(boldFallback.map(segment => segment.text).join('')).toBe('#106')
      expect(boldFallback[0]).toMatchObject({
        styles: expect.objectContaining({
          bold: true,
          underline: true,
        }),
      })
      expect(boldFallback[1]).toMatchObject({
        hyperlink: boldFallback[0]?.hyperlink,
        styles: boldFallback[0]?.styles,
      })
      expect(boldFallback[0]?.styles.color).toBeUndefined()
      expect(prLabels.at(-1)?.styles.color).toBeUndefined()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    }
  })
})
