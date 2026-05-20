import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import type { CollapsedReadSearchGroup } from '../../types/message.js'
import { checkHasTeamMemOps, TeamMemCountParts } from './teamMemCollapsed.js'
import { teamMemSavedPart } from './teamMemSaved.js'

async function renderTeamMemParts(
  message: Partial<CollapsedReadSearchGroup>,
  options: {
    isActiveGroup?: boolean
    hasPrecedingParts?: boolean
  } = {},
): Promise<string> {
  return renderToString(
    <TeamMemCountParts
      message={message as CollapsedReadSearchGroup}
      isActiveGroup={options.isActiveGroup ?? false}
      hasPrecedingParts={options.hasPrecedingParts ?? false}
    />,
    100,
  )
}

type TeamMemState = {
  message: Partial<CollapsedReadSearchGroup>
  isActiveGroup?: boolean
  hasPrecedingParts?: boolean
}

function TeamMemSequence({ states }: { states: readonly TeamMemState[] }) {
  const [index, setIndex] = React.useState(0)
  const state = states[index] ?? states[states.length - 1]

  React.useLayoutEffect(() => {
    if (index < states.length - 1) {
      setIndex(index + 1)
    }
  }, [index, states])

  return (
    <TeamMemCountParts
      message={state.message as CollapsedReadSearchGroup}
      isActiveGroup={state.isActiveGroup ?? false}
      hasPrecedingParts={state.hasPrecedingParts ?? false}
    />
  )
}

describe('team memory collapsed renderers', () => {
  test('detects team memory operations from any count', () => {
    expect(checkHasTeamMemOps({} as CollapsedReadSearchGroup)).toBe(false)
    expect(
      checkHasTeamMemOps({
        teamMemoryReadCount: 1,
      } as CollapsedReadSearchGroup),
    ).toBe(true)
    expect(
      checkHasTeamMemOps({
        teamMemorySearchCount: 1,
      } as CollapsedReadSearchGroup),
    ).toBe(true)
    expect(
      checkHasTeamMemOps({
        teamMemoryWriteCount: 1,
      } as CollapsedReadSearchGroup),
    ).toBe(true)
  })

  test('renders no collapsed count parts when every count is absent or zero', async () => {
    await expect(renderTeamMemParts({})).resolves.toBe('\n')
    await expect(
      renderTeamMemParts({
        teamMemoryReadCount: 0,
        teamMemorySearchCount: 0,
        teamMemoryWriteCount: 0,
      }),
    ).resolves.toBe('\n')
  })

  test('renders inactive read, search, and write counts with commas and plurals', async () => {
    const output = await renderTeamMemParts({
      teamMemoryReadCount: 2,
      teamMemorySearchCount: 1,
      teamMemoryWriteCount: 3,
    })

    expect(output).toContain('Recalled 2 team memories')
    expect(output).toContain('searched team memories')
    expect(output).toContain('wrote 3 team memories')
    expect(output).toMatch(/,\s*searched/)
    expect(output).toMatch(/,\s*wrote/)
  })

  test('renders active and preceded variants with lower-case follow-on verbs', async () => {
    const activeOutput = await renderTeamMemParts(
      {
        teamMemoryReadCount: 1,
        teamMemorySearchCount: 1,
        teamMemoryWriteCount: 1,
      },
      {
        isActiveGroup: true,
      },
    )

    expect(activeOutput).toContain('Recalling 1 team memory')
    expect(activeOutput).toContain('searching team memories')
    expect(activeOutput).toContain('writing 1 team memory')

    const precededOutput = await renderTeamMemParts(
      {
        teamMemoryReadCount: 1,
      },
      {
        hasPrecedingParts: true,
      },
    )

    expect(precededOutput).toMatch(/,\s*recalled 1 team memory/)
  })

  test('renders first search and write operations with active and inactive verbs', async () => {
    await expect(
      renderTeamMemParts({
        teamMemorySearchCount: 1,
      }),
    ).resolves.toContain('Searched team memories')
    await expect(
      renderTeamMemParts(
        {
          teamMemorySearchCount: 1,
        },
        {
          isActiveGroup: true,
        },
      ),
    ).resolves.toContain('Searching team memories')

    await expect(
      renderTeamMemParts({
        teamMemoryWriteCount: 1,
      }),
    ).resolves.toContain('Wrote 1 team memory')
    await expect(
      renderTeamMemParts(
        {
          teamMemoryWriteCount: 2,
        },
        {
          isActiveGroup: true,
        },
      ),
    ).resolves.toContain('Writing 2 team memories')
  })

  test('reuses compiled render cache branches across rerenders', async () => {
    await renderToString(
      <TeamMemSequence
        states={[
          {
            message: {
              teamMemoryReadCount: 2,
              teamMemorySearchCount: 1,
              teamMemoryWriteCount: 3,
            },
          },
          {
            message: {
              teamMemoryReadCount: 2,
              teamMemorySearchCount: 1,
              teamMemoryWriteCount: 3,
            },
          },
        ]}
      />,
      100,
    )

    await renderToString(
      <TeamMemSequence
        states={[
          {
            hasPrecedingParts: true,
            message: {
              teamMemoryReadCount: 1,
            },
          },
          {
            hasPrecedingParts: true,
            isActiveGroup: true,
            message: {
              teamMemoryReadCount: 1,
            },
          },
        ]}
      />,
      100,
    )

    await renderToString(
      <TeamMemSequence
        states={[
          {
            message: {
              teamMemoryReadCount: 1,
              teamMemorySearchCount: 1,
            },
          },
          {
            message: {
              teamMemoryReadCount: 1,
              teamMemorySearchCount: 2,
            },
          },
        ]}
      />,
      100,
    )

    await renderToString(
      <TeamMemSequence
        states={[
          {
            message: {
              teamMemoryReadCount: 1,
              teamMemorySearchCount: 1,
              teamMemoryWriteCount: 1,
            },
          },
          {
            message: {
              teamMemoryReadCount: 1,
              teamMemorySearchCount: 1,
              teamMemoryWriteCount: 2,
            },
          },
        ]}
      />,
      100,
    )

    await renderToString(
      <TeamMemSequence
        states={[
          {
            message: {
              teamMemoryReadCount: 1,
              teamMemoryWriteCount: 1,
            },
          },
          {
            message: {
              teamMemoryReadCount: 1,
              teamMemorySearchCount: 1,
              teamMemoryWriteCount: 1,
            },
          },
        ]}
      />,
      100,
    )
  })
})

describe('team memory saved renderer helper', () => {
  test('returns null when no team memories were saved', () => {
    expect(teamMemSavedPart({} as never)).toBeNull()
    expect(teamMemSavedPart({ teamCount: 0 } as never)).toBeNull()
  })

  test('returns singular and plural saved-memory segments', () => {
    expect(teamMemSavedPart({ teamCount: 1 } as never)).toEqual({
      segment: '1 team memory',
      count: 1,
    })
    expect(teamMemSavedPart({ teamCount: 3 } as never)).toEqual({
      segment: '3 team memories',
      count: 3,
    })
  })
})
