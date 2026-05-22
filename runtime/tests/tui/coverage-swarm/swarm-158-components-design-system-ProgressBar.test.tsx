import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { ProgressBar } from '../../../src/tui/components/design-system/ProgressBar.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import type { TextStyles } from '../../../src/tui/ink/styles.js'
import { getTheme } from '../../../src/utils/theme.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
  rows: number
}

type MountedRoot = {
  root: Awaited<ReturnType<typeof createRoot>>
  stdin: TestStdin
  stdout: TestStdout
}

type StyledSegment = {
  text: string
  styles: TextStyles
}

const mountedRoots: MountedRoot[] = []

function createStreams(): { stdin: TestStdin; stdout: TestStdout } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function collectSegments(
  node: DOMNode,
  inheritedStyles: TextStyles = {},
  segments: StyledSegment[] = [],
): StyledSegment[] {
  if (node.nodeName === '#text') {
    if (node.nodeValue !== '') {
      segments.push({ text: node.nodeValue, styles: inheritedStyles })
    }
    return segments
  }

  const nextStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles

  for (const child of node.childNodes) {
    collectSegments(child, nextStyles, segments)
  }

  return segments
}

async function renderProgressBar(node: React.ReactNode): Promise<{
  rerender: (next: React.ReactNode) => Promise<void>
  segment: () => StyledSegment
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  mountedRoots.push({ root, stdin, stdout })

  const rerender = async (next: React.ReactNode) => {
    root.render(next)
    await sleep()
  }

  await rerender(node)

  return {
    rerender,
    segment: () => {
      const segments = collectSegments(getRootNode(stdout))
      expect(segments).toHaveLength(1)
      return segments[0]!
    },
  }
}

afterEach(() => {
  for (const { root, stdin, stdout } of mountedRoots.splice(0)) {
    root.unmount()
    stdin.end()
    stdout.end()
    instances.delete(stdout as unknown as NodeJS.WriteStream)
  }
})

describe('ProgressBar coverage swarm row 158', () => {
  test('clamps ratios and renders fractional blocks for narrow widths', async () => {
    const empty = await renderProgressBar(<ProgressBar ratio={-0.25} width={4} />)
    expect(empty.segment()).toEqual({ text: '    ', styles: {} })

    const partial = await renderProgressBar(
      <ProgressBar ratio={0.2} width={1} />,
    )
    expect(partial.segment()).toEqual({ text: '▏', styles: {} })

    const full = await renderProgressBar(<ProgressBar ratio={1.5} width={4} />)
    expect(full.segment()).toEqual({ text: '████', styles: {} })
  })

  test('passes fill and empty colors through while preserving rerendered segments', async () => {
    const theme = getTheme('dark')
    const rendered = await renderProgressBar(
      <ProgressBar
        ratio={0.5}
        width={6}
        fillColor="success"
        emptyColor="rate_limit_empty"
      />,
    )

    expect(rendered.segment()).toEqual({
      text: '███   ',
      styles: {
        backgroundColor: theme.rate_limit_empty,
        color: theme.success,
      },
    })

    await rendered.rerender(
      <ProgressBar
        ratio={0.5}
        width={6}
        fillColor="success"
        emptyColor="rate_limit_empty"
      />,
    )
    expect(rendered.segment()).toEqual({
      text: '███   ',
      styles: {
        backgroundColor: theme.rate_limit_empty,
        color: theme.success,
      },
    })

    await rendered.rerender(
      <ProgressBar ratio={0.58} width={6} fillColor="warning" />,
    )
    expect(rendered.segment()).toEqual({
      text: '███▌  ',
      styles: {
        color: theme.warning,
      },
    })
  })
})
