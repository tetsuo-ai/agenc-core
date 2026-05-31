import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { saveGlobalConfig } from '../../../src/utils/config.ts'
import {
  setActiveConfigModel,
  getActiveConfigModel,
} from '../../../src/bootstrap/state.ts'

// model.ts is env-driven: getAPIProvider() reads env. The real providers.js
// returns 'xai' when XAI_API_KEY is set, 'openai'/'agenc' when AGENC_USE_OPENAI
// is set. We exercise those branches directly so getDefaultMainLoopModel()
// reflects the AgenC config.model published via setActiveConfigModel().
async function importFreshModelModule() {
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`../../../src/utils/model/model.ts?cfg=${nonce}`)
}

const SAVED_ENV = {
  XAI_API_KEY: process.env.XAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
}

function clearEnv(): void {
  delete process.env.XAI_API_KEY
  delete process.env.OPENAI_MODEL
  delete process.env.AGENC_USE_OPENAI
  delete process.env.OPENAI_BASE_URL
}

beforeEach(() => {
  mock.restore()
  clearEnv()
  setActiveConfigModel(undefined)
  saveGlobalConfig(current => ({ ...current, model: undefined }))
})

afterEach(() => {
  mock.restore()
  setActiveConfigModel(undefined)
  for (const key of Object.keys(SAVED_ENV) as Array<keyof typeof SAVED_ENV>) {
    if (SAVED_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_ENV[key] as string
  }
  saveGlobalConfig(current => ({ ...current, model: undefined }))
})

test('getDefaultMainLoopModel reflects config.model for the active xai provider', async () => {
  // Regression: `agenc config set model grok-build-0.1` (no OPENAI_MODEL env).
  // The xai branch hardcoded grok-4.3; it must now read the published config
  // model instead.
  process.env.XAI_API_KEY = 'xai-test'
  setActiveConfigModel({ provider: 'grok', model: 'grok-build-0.1' })
  expect(getActiveConfigModel()).toEqual({
    provider: 'grok',
    model: 'grok-build-0.1',
  })

  const { getDefaultMainLoopModel, getDefaultMainLoopModelSetting } =
    await importFreshModelModule()
  expect(getDefaultMainLoopModelSetting()).toBe('grok-build-0.1')
  expect(getDefaultMainLoopModel()).toBe('grok-build-0.1')
})

test('getDefaultMainLoopModel still defaults to grok-4.3 when config.model is unset', async () => {
  process.env.XAI_API_KEY = 'xai-test'
  setActiveConfigModel(undefined)

  const { getDefaultMainLoopModel } = await importFreshModelModule()
  expect(getDefaultMainLoopModel()).toBe('grok-4.3')
})

test('grok-4.3 keeps working when it is the configured model', async () => {
  process.env.XAI_API_KEY = 'xai-test'
  setActiveConfigModel({ provider: 'grok', model: 'grok-4.3' })

  const { getDefaultMainLoopModel } = await importFreshModelModule()
  expect(getDefaultMainLoopModel()).toBe('grok-4.3')
})

test('OPENAI_MODEL env wins over the published config model (provider profile precedence)', async () => {
  process.env.XAI_API_KEY = 'xai-test'
  process.env.OPENAI_MODEL = 'grok-from-env'
  setActiveConfigModel({ provider: 'grok', model: 'grok-build-0.1' })

  const { getDefaultMainLoopModel } = await importFreshModelModule()
  expect(getDefaultMainLoopModel()).toBe('grok-from-env')
})

test('config model for a different provider does not leak into xai default', async () => {
  process.env.XAI_API_KEY = 'xai-test'
  // Published selection is for openai, but the active provider is xai.
  setActiveConfigModel({ provider: 'openai', model: 'gpt-5' })

  const { getDefaultMainLoopModel } = await importFreshModelModule()
  expect(getDefaultMainLoopModel()).toBe('grok-4.3')
})
