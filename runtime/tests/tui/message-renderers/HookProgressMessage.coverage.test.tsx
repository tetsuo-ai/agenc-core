import React from 'react'
import { describe, expect, test } from 'vitest'

import type { MessageLookups } from '../../utils/messages.js'
import { renderToString } from '../../utils/staticRender.js'
import { HookProgressMessage } from './HookProgressMessage.js'

type HookCounts = ReadonlyArray<readonly [string, Readonly<Record<string, number>>]>

function createLookups(options: {
  readonly inProgress?: HookCounts
  readonly resolved?: HookCounts
}): MessageLookups {
  const createCountMap = (counts: HookCounts = []) =>
    new Map(
      counts.map(([toolUseID, byEvent]) => [
        toolUseID,
        new Map(Object.entries(byEvent)),
      ]),
    )

  return {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: createCountMap(options.inProgress),
    resolvedHookCounts: createCountMap(options.resolved),
    toolResultByToolUseID: new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 0,
    resolvedToolUseIDs: new Set(),
    erroredToolUseIDs: new Set(),
  } as MessageLookups
}

function renderHookProgress(
  props: Omit<React.ComponentProps<typeof HookProgressMessage>, 'verbose'>,
): Promise<string> {
  return renderToString(
    <HookProgressMessage
      {...props}
      verbose={false}
    />,
    { columns: 100, rows: 10 },
  )
}

describe('HookProgressMessage coverage', () => {
  test('renders active hook progress and omits absent or fully resolved hook events', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    try {
      const preToolUse = await renderHookProgress({
        hookEvent: 'PreToolUse',
        toolUseID: 'toolu-active',
        lookups: createLookups({
          inProgress: [['toolu-active', { PreToolUse: 1 }]],
        }),
      })

      expect(preToolUse).toContain('Running PreToolUse hook...')

      const transcriptPostToolUse = await renderHookProgress({
        hookEvent: 'PostToolUse',
        toolUseID: 'toolu-active',
        isTranscriptMode: true,
        lookups: createLookups({
          inProgress: [['toolu-active', { PostToolUse: 2 }]],
        }),
      })

      expect(transcriptPostToolUse).toContain('2 PostToolUse hooks running')
      expect(transcriptPostToolUse).not.toContain('Running PostToolUse')

      const notification = await renderHookProgress({
        hookEvent: 'Notification',
        toolUseID: 'toolu-active',
        lookups: createLookups({
          inProgress: [['toolu-active', { Notification: 2 }]],
          resolved: [['toolu-active', { Notification: 1 }]],
        }),
      })

      expect(notification).toContain('Running Notification hooks...')

      const missing = await renderHookProgress({
        hookEvent: 'PreToolUse',
        toolUseID: 'toolu-missing',
        lookups: createLookups({}),
      })

      expect(missing).toBe('\n')

      const fullyResolved = await renderHookProgress({
        hookEvent: 'Notification',
        toolUseID: 'toolu-done',
        lookups: createLookups({
          inProgress: [['toolu-done', { Notification: 2 }]],
          resolved: [['toolu-done', { Notification: 2 }]],
        }),
      })

      expect(fullyResolved).toBe('\n')
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })
})
