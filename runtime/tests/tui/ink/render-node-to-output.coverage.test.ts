import { describe, expect, test } from 'vitest'

import {
  applyStylesToWrappedText,
  buildCharToSegmentMap,
} from './render-node-to-output.ts'
import type { StyledSegment } from './squash-text-nodes.ts'

const OSC = '\u001B]'
const BEL = '\u0007'

function link(text: string, url: string): string {
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`
}

function mapFor(segments: StyledSegment[]): number[] {
  return buildCharToSegmentMap(segments)
}

describe('render-node-to-output coverage', () => {
  test('maps trim-wrapped text back to linked segments after skipped whitespace', () => {
    const softWrappedSegments: StyledSegment[] = [
      {
        hyperlink: 'https://example.test/first',
        styles: {},
        text: 'AB   ',
      },
      {
        hyperlink: 'https://example.test/second',
        styles: {},
        text: '\tD\n ',
      },
      {
        hyperlink: 'https://example.test/third',
        styles: {},
        text: 'EF',
      },
    ]

    expect(
      applyStylesToWrappedText(
        'AB\n\tD\nEF',
        softWrappedSegments,
        mapFor(softWrappedSegments),
        softWrappedSegments.map(segment => segment.text).join(''),
        true,
      ),
    ).toBe(
      [
        link('AB', 'https://example.test/first'),
        link('\tD', 'https://example.test/second'),
        link('EF', 'https://example.test/third'),
      ].join('\n'),
    )

    const leadingTrimSegments: StyledSegment[] = [
      { styles: {}, text: '  ' },
      {
        hyperlink: 'https://example.test/leading',
        styles: {},
        text: 'AB',
      },
    ]

    expect(
      applyStylesToWrappedText(
        'AB',
        leadingTrimSegments,
        mapFor(leadingTrimSegments),
        leadingTrimSegments.map(segment => segment.text).join(''),
        true,
      ),
    ).toBe(link('AB', 'https://example.test/leading'))
  })
})
