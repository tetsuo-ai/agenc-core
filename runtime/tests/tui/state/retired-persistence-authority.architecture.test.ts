import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

const sourceRoot = resolve(import.meta.dirname, '../../../src')

function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
}

describe('TUI persistence authority', () => {
  test('does not persist session-local presentation state', () => {
    const appStateObserver = source('tui/state/onChangeAppState.ts')

    expect(appStateObserver).not.toMatch(/\b(?:get|update)RuntimeState\b/u)
    expect(appStateObserver).not.toMatch(
      /\b(?:setMainLoopModelOverride|updateSettingsForSource)\b/u,
    )
    expect(appStateObserver).not.toMatch(
      /\b(?:showExpandedTodos|showSpinnerTree|tungstenPanelVisible|verbose)\b/u,
    )
  })

  test('does not read or write retired hint and plan timestamps', () => {
    expect(source('tui/components/PromptInput/PromptInput.tsx')).not.toContain(
      'lastPlanModeUse',
    )
    expect(
      source('tui/components/PromptInput/usePromptInputPlaceholder.ts'),
    ).not.toContain('queuedCommandUpHintCount')
  })

  test('does not retain the retired Fast Mode TUI state', () => {
    expect(source('tui/state/AppStateStore.ts')).not.toMatch(
      /\bfastMode\??\s*:/u,
    )
  })

  test('does not retain the retired Fast Mode organization cache', () => {
    expect(source('config/runtime-state-repository.ts')).not.toContain(
      'penguinModeOrgEnabled',
    )
    expect(source('config/state.ts')).not.toContain(
      'penguinModeOrgEnabled',
    )
    expect(source('utils/fastMode.ts')).not.toContain(
      'penguinModeOrgEnabled',
    )
  })

  test('does not retain the producerless main-loop model override', () => {
    expect(source('bootstrap/state.ts')).not.toContain('mainLoopModelOverride')
    expect(source('utils/model/model.ts')).not.toContain(
      'getMainLoopModelOverride',
    )
    expect(source('utils/swarm/spawnUtils.ts')).not.toContain(
      'getMainLoopModelOverride',
    )
  })
})
