import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import type { DOMElement, DOMNode } from '../ink/dom.ts'
import instances from '../ink/instances.js'
import { createRoot } from '../ink/root.js'
import { Text } from '../ink.js'
import {
  TeamMemCountParts,
  checkHasTeamMemOps,
} from './teamMemCollapsed.js'

type TeamMemRenderOptions = {
  readonly hasPrecedingParts?: boolean
  readonly isActiveGroup?: boolean
  readonly teamMemoryReadCount?: number
  readonly teamMemorySearchCount?: number
  readonly teamMemoryWriteCount?: number
}

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function createTestStreams(): {
  stdin: TestStdin
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdin, stdout }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) {
    throw new Error('Ink instance root node not found')
  }
  return instance.rootNode
}

function renderTeamMemParts(options: {
  readonly hasPrecedingParts?: boolean
  readonly isActiveGroup?: boolean
  readonly teamMemoryReadCount?: number
  readonly teamMemorySearchCount?: number
  readonly teamMemoryWriteCount?: number
}): Promise<string> {
  return renderToString(
    <Text>
      <TeamMemCountParts
        hasPrecedingParts={options.hasPrecedingParts ?? false}
        isActiveGroup={options.isActiveGroup ?? false}
        message={{
          teamMemoryReadCount: options.teamMemoryReadCount,
          teamMemorySearchCount: options.teamMemorySearchCount,
          teamMemoryWriteCount: options.teamMemoryWriteCount,
        }}
      />
    </Text>,
    120,
  )
}

function teamMemNode(options: TeamMemRenderOptions): React.ReactNode {
  return (
    <Text>
      <TeamMemCountParts
        hasPrecedingParts={options.hasPrecedingParts ?? false}
        isActiveGroup={options.isActiveGroup ?? false}
        message={{
          teamMemoryReadCount: options.teamMemoryReadCount,
          teamMemorySearchCount: options.teamMemorySearchCount,
          teamMemoryWriteCount: options.teamMemoryWriteCount,
        }}
      />
    </Text>
  )
}

function collectInkText(node: DOMNode): string {
  if (node.nodeName === '#text') {
    return node.nodeValue
  }
  return node.childNodes.map(collectInkText).join('')
}

async function renderTeamMemSequence(
  states: readonly TeamMemRenderOptions[],
): Promise<readonly string[]> {
  const snapshots: string[] = []
  const { stdin, stdout } = createTestStreams()

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    for (const state of states) {
      root.render(teamMemNode(state))
      await sleep(20)
      snapshots.push(collectInkText(getRootNode(stdout)).replace(/\s+/g, ' '))
    }
    return snapshots
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep(25)
  }
}

describe('checkHasTeamMemOps', () => {
  test('detects read, search, and write team memory operations', () => {
    expect(checkHasTeamMemOps({})).toBe(false)
    expect(checkHasTeamMemOps({ teamMemoryReadCount: 1 })).toBe(true)
    expect(checkHasTeamMemOps({ teamMemorySearchCount: 1 })).toBe(true)
    expect(checkHasTeamMemOps({ teamMemoryWriteCount: 1 })).toBe(true)
  })
})

describe('TeamMemCountParts', () => {
  test('renders nothing when there are no team memory operations', async () => {
    await expect(renderTeamMemParts({})).resolves.toBe('\n')
  })

  test('renders active team-memory operations without preceding parts', async () => {
    const output = await renderTeamMemParts({
      isActiveGroup: true,
      teamMemoryReadCount: 1,
      teamMemorySearchCount: 1,
      teamMemoryWriteCount: 2,
    })
    const flatOutput = output.replace(/\s+/g, ' ')

    expect(flatOutput).toContain(
      'Recalling 1 team memory, searching team memories, writing 2 team memories',
    )
  })

  test('renders finalized team-memory operations after preceding parts', async () => {
    const output = await renderTeamMemParts({
      hasPrecedingParts: true,
      teamMemoryReadCount: 2,
      teamMemorySearchCount: 1,
      teamMemoryWriteCount: 1,
    })
    const flatOutput = output.replace(/\s+/g, ' ')

    expect(flatOutput).toContain(
      ', recalled 2 team memories, searched team memories, wrote 1 team memory',
    )
  })

  test('renders standalone finalized verbs for each operation type', async () => {
    await expect(renderTeamMemParts({ teamMemoryReadCount: 1 })).resolves.toContain(
      'Recalled 1 team memory',
    )
    await expect(
      renderTeamMemParts({ teamMemorySearchCount: 1 }),
    ).resolves.toContain('Searched team memories')
    await expect(
      renderTeamMemParts({ teamMemoryWriteCount: 1 }),
    ).resolves.toContain('Wrote 1 team memory')
  })

  test('renders standalone active verbs for search and write operations', async () => {
    await expect(
      renderTeamMemParts({
        isActiveGroup: true,
        teamMemorySearchCount: 1,
      }),
    ).resolves.toContain('Searching team memories')
    await expect(
      renderTeamMemParts({
        isActiveGroup: true,
        teamMemoryWriteCount: 1,
      }),
    ).resolves.toContain('Writing 1 team memory')
  })

  test('renders active read operations after preceding parts', async () => {
    await expect(
      renderTeamMemParts({
        hasPrecedingParts: true,
        isActiveGroup: true,
        teamMemoryReadCount: 1,
      }),
    ).resolves.toContain(', recalling 1 team memory')
  })

  test('reuses memoized nodes while rerendering changed counts', async () => {
    const snapshots = await renderTeamMemSequence([
      {
        hasPrecedingParts: true,
        teamMemoryReadCount: 1,
        teamMemorySearchCount: 1,
        teamMemoryWriteCount: 1,
      },
      {
        hasPrecedingParts: true,
        teamMemoryReadCount: 1,
        teamMemorySearchCount: 1,
        teamMemoryWriteCount: 2,
      },
      {
        hasPrecedingParts: true,
        teamMemoryReadCount: 2,
        teamMemorySearchCount: 1,
        teamMemoryWriteCount: 2,
      },
      {
        hasPrecedingParts: true,
        teamMemoryReadCount: 2,
        teamMemorySearchCount: 1,
        teamMemoryWriteCount: 2,
      },
    ])

    expect(snapshots.at(-1)).toContain(
      ', recalled 2 team memories, searched team memories, wrote 2 team memories',
    )
  })
})
