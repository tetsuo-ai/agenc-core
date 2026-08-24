/**
 * MiniMax model list for the /model picker.
 * Full model catalog from MiniMax API.
 */

import type { ModelOption } from './modelOptions.js'
import { getAPIProvider, getSelectedProviderEnvironment } from './providers.js'
import { isEnvTruthy } from '../envUtils.js'

export function isMiniMaxProvider(): boolean {
  const environment = getSelectedProviderEnvironment()
  if (isEnvTruthy(environment.MINIMAX_API_KEY)) {
    return true
  }
  const baseUrl = environment.OPENAI_BASE_URL ?? ''
  if (baseUrl.includes('minimax')) {
    return true
  }
  return getAPIProvider() === 'minimax'
}

function getMiniMaxModels(): ModelOption[] {
  return [
    // Latest Generation Models - use correct MiniMax naming with M prefix
    { value: 'MiniMax-M3', label: 'MiniMax M3', description: 'Current flagship chat/code/reasoning model' },
    { value: 'MiniMax-M2', label: 'MiniMax M2', description: 'MoE model - 131K context - Chat/Code/Reasoning' },
    { value: 'MiniMax-M2.1', label: 'MiniMax M2.1', description: 'Enhanced - 200K context - Vision' },
    { value: 'MiniMax-M2.5', label: 'MiniMax M2.5', description: 'Flagship - 256K context - Vision/Function-calling' },
    { value: 'MiniMax-Text-01', label: 'MiniMax Text 01', description: 'Text-focused - 512K context - FREE' },
    { value: 'MiniMax-Text-01-Preview', label: 'MiniMax Text 01 Preview', description: 'Preview - 256K context - FREE' },
    { value: 'MiniMax-Vision-01', label: 'MiniMax Vision 01', description: 'Vision model - 32K context' },
    { value: 'MiniMax-Vision-01-Fast', label: 'MiniMax Vision 01 Fast', description: 'Fast vision - 16K context - FREE' },
  ]
}

let cachedMiniMaxOptions: ModelOption[] | null = null

export function getCachedMiniMaxModelOptions(): ModelOption[] {
  if (!cachedMiniMaxOptions) {
    cachedMiniMaxOptions = getMiniMaxModels()
  }
  return cachedMiniMaxOptions
}
