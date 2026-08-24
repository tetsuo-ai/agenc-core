/**
 * Ollama model discovery for the /model picker.
 * Fetches available models from the Ollama API and caches them
 * so the synchronous getModelOptions() can use them.
 */

import type { ModelOption } from './modelOptions.js'
import { listOllamaModels } from '../providerDiscovery.js'
import { getSelectedProviderEnvironment } from './providers.js'

let cachedOllamaOptions: ModelOption[] | null = null
let fetchPromise: Promise<ModelOption[]> | null = null

/**
 * Returns true when the current OPENAI_BASE_URL points at an Ollama instance.
 * Detects OLLAMA_BASE_URL presence, /v1 suffixed URLs, and the raw base URL.
 */
export function isOllamaProvider(): boolean {
  const environment = getSelectedProviderEnvironment()
  // Explicit OLLAMA_BASE_URL is always sufficient
  if (environment.OLLAMA_BASE_URL) return true
  if (!environment.OPENAI_BASE_URL) return false
  const baseUrl = environment.OPENAI_BASE_URL
  // Match common Ollama port
  try {
    const parsed = new URL(baseUrl)
    if (parsed.port === '11434') return true
  } catch {
    // ignore
  }
  return false
}

/**
 * Fetch models from the Ollama /api/tags endpoint.
 */
export async function fetchOllamaModels(): Promise<ModelOption[]> {
  const environment = getSelectedProviderEnvironment()
  const models = await listOllamaModels(undefined, environment)
  return models.map(model => {
    const paramSize = model.parameterSize ?? ''
    const quant = model.quantizationLevel ?? ''
    const sizeGB = model.sizeBytes ? `${(model.sizeBytes / 1e9).toFixed(1)}GB` : ''
    const parts = [paramSize, quant, sizeGB].filter(Boolean).join(' · ')
    return {
      value: model.name,
      label: model.name,
      description: parts ? `Ollama · ${parts}` : 'Ollama model',
    }
  })
}

/**
 * Prefetch and cache Ollama models. Call during startup.
 */
export function prefetchOllamaModels(): void {
  if (!isOllamaProvider()) return
  if (cachedOllamaOptions && cachedOllamaOptions.length > 0) return
  if (fetchPromise) return
  fetchPromise = fetchOllamaModels()
    .then(options => {
      cachedOllamaOptions = options
      return options
    })
    .finally(() => {
      fetchPromise = null
    })
}

/**
 * Get cached Ollama model options (synchronous).
 * Returns empty array if not yet fetched.
 */
export function getCachedOllamaModelOptions(): ModelOption[] {
  return cachedOllamaOptions ?? []
}
