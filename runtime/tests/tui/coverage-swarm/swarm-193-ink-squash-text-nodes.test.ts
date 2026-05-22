import { describe, expect, test } from 'vitest'

import {
  createNode,
  createTextNode,
  type DOMElement,
  type DOMNode,
} from '../../../src/tui/ink/dom.js'
import squashTextNodes, {
  squashTextNodesToSegments,
} from '../../../src/tui/ink/squash-text-nodes.js'
import type { TextStyles } from '../../../src/tui/ink/styles.js'

function append(
  parent: DOMElement,
  ...children: Array<DOMNode | undefined>
): DOMElement {
  for (const child of children) {
    if (child !== undefined) {
      child.parentNode = parent
    }
    parent.childNodes.push(child as DOMNode)
  }

  return parent
}

function element(
  nodeName: DOMElement['nodeName'],
  children: Array<DOMNode | undefined> = [],
  textStyles?: TextStyles,
): DOMElement {
  const node = createNode(nodeName)
  node.textStyles = textStyles
  append(node, ...children)

  return node
}

function text(value: string): DOMNode {
  return createTextNode(value)
}

describe('squash-text-nodes coverage swarm row 193', () => {
  test('squashes plain text through supported text containers only', () => {
    const ignoredBox = element('ink-box', [text('hidden')])
    const root = element('ink-root', [
      undefined,
      text('alpha'),
      text(''),
      element('ink-text', [
        text('-'),
        element('ink-virtual-text', [text('beta')]),
      ]),
      element('ink-link', [text('-gamma')]),
      ignoredBox,
    ])

    expect(squashTextNodes(root)).toBe('alpha-beta-gamma')
  })

  test('emits styled segments while preserving caller output array', () => {
    const inheritedStyles = { dim: true, underline: true } satisfies TextStyles
    const root = element(
      'ink-root',
      [
        text('base'),
        text(''),
        element('ink-text', [text('-bold')], { bold: true, dim: false }),
        element('ink-virtual-text', [text('-virtual')], {
          backgroundColor: '#101010',
        }),
      ],
      { color: 'ansi:green' },
    )
    const out = [
      { text: 'seed', styles: { italic: true } satisfies TextStyles },
    ]

    expect(squashTextNodesToSegments(root, inheritedStyles, undefined, out)).toBe(
      out,
    )
    expect(out).toEqual([
      {
        styles: { italic: true },
        text: 'seed',
      },
      {
        hyperlink: undefined,
        styles: { color: 'ansi:green', dim: true, underline: true },
        text: 'base',
      },
      {
        hyperlink: undefined,
        styles: {
          bold: true,
          color: 'ansi:green',
          dim: false,
          underline: true,
        },
        text: '-bold',
      },
      {
        hyperlink: undefined,
        styles: {
          backgroundColor: '#101010',
          color: 'ansi:green',
          dim: true,
          underline: true,
        },
        text: '-virtual',
      },
    ])
  })

  test('uses link hrefs and falls back to inherited hyperlinks for empty hrefs', () => {
    const explicit = element('ink-link', [text('explicit')])
    explicit.attributes.href = 'https://agenc.test/explicit'

    const inherited = element('ink-link', [text('-inherited')])
    inherited.attributes.href = ''

    const nested = element('ink-text', [explicit, inherited])
    const root = element('ink-root', [nested])

    expect(
      squashTextNodesToSegments(root, {}, 'https://agenc.test/fallback'),
    ).toEqual([
      {
        hyperlink: 'https://agenc.test/explicit',
        styles: {},
        text: 'explicit',
      },
      {
        hyperlink: 'https://agenc.test/fallback',
        styles: {},
        text: '-inherited',
      },
    ])
  })
})
