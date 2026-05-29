import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import Text from '../ink/components/Text.js'
import { useMainLoopModel } from './useMainLoopModel.js'

const appState = vi.hoisted(() => ({
  mainLoopModel: undefined as string | undefined,
  mainLoopModelForSession: undefined as string | undefined,
}))

const model = vi.hoisted(() => ({
  defaultSetting: 'default-main-model',
  parsedInputs: [] as string[],
}))

vi.mock('../state/AppState.js', () => ({
  useAppState: (
    selector: (state: {
      mainLoopModel?: string
      mainLoopModelForSession?: string
    }) => unknown,
  ) => selector(appState),
}))

vi.mock('../../utils/model/model.js', () => ({
  getDefaultMainLoopModelSetting: () => model.defaultSetting,
  parseUserSpecifiedModel: (value: string) => {
    model.parsedInputs.push(value)
    return `parsed:${value}`
  },
}))

function ModelProbe() {
  const selectedModel = useMainLoopModel()

  return <Text>{selectedModel}</Text>
}

async function renderModelProbe(): Promise<string> {
  return renderToString(<ModelProbe />, 80)
}

describe('useMainLoopModel', () => {
  beforeEach(() => {
    appState.mainLoopModel = undefined
    appState.mainLoopModelForSession = undefined
    model.defaultSetting = 'default-main-model'
    model.parsedInputs = []
  })

  test('prefers the session model override', async () => {
    appState.mainLoopModel = 'stored-model'
    appState.mainLoopModelForSession = 'session-model'

    const output = await renderModelProbe()

    expect(output).toContain('parsed:session-model')
    expect(model.parsedInputs).toContain('session-model')
    expect(model.parsedInputs).not.toContain('stored-model')
  })

  test('falls back to the stored main loop model', async () => {
    appState.mainLoopModel = 'stored-model'

    await expect(renderModelProbe()).resolves.toContain('parsed:stored-model')
    expect(model.parsedInputs).toContain('stored-model')
  })

  test('uses the default model setting when no state model is configured', async () => {
    model.defaultSetting = 'fallback-model'

    await expect(renderModelProbe()).resolves.toContain('parsed:fallback-model')
    expect(model.parsedInputs).toContain('fallback-model')
  })
})
