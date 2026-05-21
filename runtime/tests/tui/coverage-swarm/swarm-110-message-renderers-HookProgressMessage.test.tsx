import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import {
  getHookProgressRunningLabel,
  getHookProgressTranscriptRunningLabel,
  HookProgressMessage,
} from '../../../src/tui/message-renderers/HookProgressMessage.js'

type HookCounts = ReadonlyArray<readonly [string, Readonly<Record<string, number>>]>
type HookProgressProps = React.ComponentProps<typeof HookProgressMessage>

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  }
})

function createLookups(options: {
  readonly inProgress?: HookCounts
  readonly resolved?: HookCounts
}): HookProgressProps['lookups'] {
  const createCountMap = (counts: HookCounts = []) =>
    new Map(
      counts.map(([toolUseID, byEvent]) => [
        toolUseID,
        new Map(Object.entries(byEvent)),
      ]),
    )

  return {
    inProgressHookCounts: createCountMap(options.inProgress),
    resolvedHookCounts: createCountMap(options.resolved),
  } as HookProgressProps['lookups']
}

function normalize(output: string): string {
  return output.replace(/\s+/g, ' ').trim()
}

async function renderHookProgress(
  props: Omit<HookProgressProps, 'verbose'>,
): Promise<string> {
  return renderToString(
    <HookProgressMessage
      {...props}
      verbose={false}
    />,
    { columns: 100, rows: 8 },
  )
}

describe('HookProgressMessage swarm-110 coverage', () => {
  test('formats running labels for glyph mode and hook count variants', () => {
    expect(
      getHookProgressRunningLabel(1, { AGENC_TUI_GLYPHS: 'unicode' }),
    ).toBe(' hook…')
    expect(
      getHookProgressRunningLabel(3, { AGENC_TUI_GLYPHS: 'ascii' }),
    ).toBe(' hooks...')
    expect(getHookProgressTranscriptRunningLabel(1)).toBe(' hook running')
    expect(getHookProgressTranscriptRunningLabel(3)).toBe(' hooks running')
  })

  test('renders tool hook progress before the non-tool resolved-count gate', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = normalize(
      await renderHookProgress({
        hookEvent: 'PreToolUse',
        toolUseID: 'toolu-resolved-pre-hook',
        lookups: createLookups({
          inProgress: [['toolu-resolved-pre-hook', { PreToolUse: 2 }]],
          resolved: [['toolu-resolved-pre-hook', { PreToolUse: 2 }]],
        }),
      }),
    )

    expect(output).toContain('Running PreToolUse hooks...')
  })

  test('renders singular transcript wording for post-tool hooks', async () => {
    const output = normalize(
      await renderHookProgress({
        hookEvent: 'PostToolUse',
        toolUseID: 'toolu-transcript-post-hook',
        isTranscriptMode: true,
        lookups: createLookups({
          inProgress: [['toolu-transcript-post-hook', { PostToolUse: 1 }]],
        }),
      }),
    )

    expect(output).toContain('1 PostToolUse hook running')
    expect(output).not.toContain('Running PostToolUse')
  })

  test('renders active non-tool hooks and omits missing event entries', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const missingEvent = await renderHookProgress({
      hookEvent: 'Notification',
      toolUseID: 'toolu-other-hook-only',
      lookups: createLookups({
        inProgress: [['toolu-other-hook-only', { Stop: 1 }]],
      }),
    })

    expect(missingEvent).toBe('\n')

    const activeNonToolHook = normalize(
      await renderHookProgress({
        hookEvent: 'Notification',
        toolUseID: 'toolu-active-notification',
        lookups: createLookups({
          inProgress: [['toolu-active-notification', { Notification: 1 }]],
        }),
      }),
    )

    expect(activeNonToolHook).toContain('Running Notification hook...')
  })
})
