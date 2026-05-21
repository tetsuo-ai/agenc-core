import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

import type { DOMNode } from '../../../src/tui/ink/dom.ts'
import type Output from '../../../src/tui/ink/output.ts'
import renderBorder, {
  type BorderStyle,
} from '../../../src/tui/ink/render-border.ts'
import type { Styles } from '../../../src/tui/ink/styles.ts'

function createNode(
  style: Styles,
  width: number,
  height: number,
): DOMNode {
  return {
    attributes: {},
    childNodes: [],
    dirty: false,
    nodeName: 'ink-box',
    parentNode: undefined,
    style,
    yogaNode: {
      getComputedHeight: () => height,
      getComputedWidth: () => width,
    },
  } as unknown as DOMNode
}

function createOutput(): {
  output: Output
  write: ReturnType<typeof vi.fn>
} {
  const write = vi.fn()
  return {
    output: { write } as unknown as Output,
    write,
  }
}

function plainWriteCalls(
  write: ReturnType<typeof vi.fn>,
): Array<[number, number, string]> {
  return write.mock.calls.map(([x, y, text]) => [
    x as number,
    y as number,
    stripAnsi(text as string),
  ])
}

describe('renderBorder coverage swarm row 070', () => {
  test('does not write when the node has no border style', () => {
    const { output, write } = createOutput()

    renderBorder(2, 3, createNode({}, 8, 4), output)

    expect(write).not.toHaveBeenCalled()
  })

  test('renders custom object borders with centered top text and vertical sides', () => {
    const { output, write } = createOutput()
    const borderStyle: BorderStyle = {
      bottom: '_',
      bottomLeft: '{',
      bottomRight: '}',
      left: '|',
      right: '!',
      top: '=',
      topLeft: '[',
      topRight: ']',
    }

    renderBorder(
      1,
      2,
      createNode(
        {
          borderBottomDimColor: true,
          borderColor: 'ansi:white',
          borderLeftColor: 'ansi:yellow',
          borderLeftDimColor: true,
          borderRightColor: 'ansi:green',
          borderRightDimColor: true,
          borderStyle,
          borderText: {
            align: 'center',
            content: 'Hi',
            position: 'top',
          },
          borderTopColor: 'ansi:red',
          borderTopDimColor: true,
        },
        8,
        4,
      ),
      output,
    )

    expect(plainWriteCalls(write)).toEqual([
      [1, 2, '[==Hi==]'],
      [1, 3, '|\n|\n'],
      [8, 3, '!\n!\n'],
      [1, 5, '{______}'],
    ])
  })

  test('renders dashed bottom text with hidden top and left borders', () => {
    const { output, write } = createOutput()

    renderBorder(
      0,
      0,
      createNode(
        {
          borderLeft: false,
          borderStyle: 'dashed',
          borderText: {
            align: 'end',
            content: 'Z',
            offset: 2,
            position: 'bottom',
          },
          borderTop: false,
        },
        7,
        3,
      ),
      output,
    )

    expect(plainWriteCalls(write)).toEqual([
      [6, 0, '╎\n╎\n'],
      [0, 2, '╌╌╌Z╌╌ '],
    ])
  })

  test('clamps start-aligned text and truncates overlong border text', () => {
    const startAligned = createOutput()

    renderBorder(
      0,
      0,
      createNode(
        {
          borderBottom: false,
          borderLeft: false,
          borderRight: false,
          borderStyle: 'single',
          borderText: {
            align: 'start',
            content: 'A',
            offset: 50,
            position: 'top',
          },
        },
        6,
        1,
      ),
      startAligned.output,
    )

    expect(plainWriteCalls(startAligned.write)).toEqual([[0, 0, '────A─']])

    const truncated = createOutput()

    renderBorder(
      4,
      5,
      createNode(
        {
          borderLeft: false,
          borderRight: false,
          borderStyle: 'single',
          borderText: {
            align: 'center',
            content: 'LONGTEXT',
            position: 'bottom',
          },
          borderTop: false,
        },
        5,
        1,
      ),
      truncated.output,
    )

    expect(plainWriteCalls(truncated.write)).toEqual([[4, 5, 'LONGT']])
  })
})
