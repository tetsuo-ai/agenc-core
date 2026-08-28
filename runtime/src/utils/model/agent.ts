import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import {
  getCanonicalName,
  parseUserSpecifiedModel,
} from './model.js'
import {
  getAPIProvider,
  getSelectedProviderName,
  isFirstPartyAnthropicBaseUrl,
} from './providers.js'
import { resolveAllowedModelProjection } from './modelAllowlist.js'
import { getExecutionAuthoritySettings } from '../settings/settings.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel: ModelAlias | undefined,
): string {
  let projectedModel: string

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      projectedModel = parentModel
    } else {
      projectedModel = parseUserSpecifiedModel(toolSpecifiedModel)
    }
  } else {
    const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

    // Provider-aware model alias fallback for agents.
    // AgenC-native provider API modes have guaranteed haiku/sonnet model
    // availability. Other providers and compatible endpoints may not have
    // equivalent models, causing "model not found" errors when resolving aliases.
    // For haiku/sonnet aliases on non-AgenC-native providers, inherit parent model.
    // Note: 'opus' is NOT included here because it's handled separately by
    // aliasMatchesParentTier() which checks if parent's tier matches the alias.
    if (
      (agentModelWithExp === 'haiku' || agentModelWithExp === 'sonnet') &&
      !checkIsAgenCNativeProvider()
    ) {
      // Non-AgenC-native provider → inherit parent model
      projectedModel = parentModel
    } else if (agentModelWithExp === 'inherit') {
      projectedModel = parentModel
    } else if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
      projectedModel = parentModel
    } else {
      projectedModel = parseUserSpecifiedModel(agentModelWithExp)
    }
  }

  return resolveAllowedModelProjection(
    getSelectedProviderName(),
    projectedModel,
    getExecutionAuthoritySettings(),
  )
}

/**
 * Check if a bare family alias (opus/sonnet/haiku) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a Vertex user on Opus 4.6 (via /model) who
 * spawns a subagent with `model: opus` should get Opus 4.6, not whatever
 * getDefaultOpusModel() returns for 3P.
 * See https://github.com/tetsuo-ai/agenc-core/issues/30815.
 *
 * Only bare family aliases match. `opus[1m]` and `best` fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
    case 'haiku':
      return canonical.includes('haiku')
    default:
      return false
  }
}

/**
 * Check if the current provider is AgenC-native (has guaranteed haiku/sonnet models).
 * AgenC-native providers: official provider API.
 * Non-AgenC-native: openai, Gemini, Mistral, GitHub, NVIDIA NIM, MiniMax,
 * and custom provider-compatible endpoints (proxies, self-hosted).
 */
export function checkIsAgenCNativeProvider(): boolean {
  const provider = getAPIProvider()
  return provider === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient for simple tasks',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
