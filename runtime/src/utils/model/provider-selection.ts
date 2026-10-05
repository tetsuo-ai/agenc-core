/** Read the already-bound provider authority without loading the model catalog. */
import type { ProviderEnvironment } from '../../llm/provider-environment.js'
import { getCurrentRuntimeSession } from '../../session/current-session.js'
import { normalizeProviderIdentity } from '../../provider-identity.js'
import { readStartupProviderSelectionSnapshot } from './provider-selection-context.js'

export interface ProviderRuntimeSelection {
  readonly provider: string
  readonly model: string
  readonly environment: ProviderEnvironment
}

export function selectedProviderIdentity(provider: string): string {
  const selected = normalizeProviderIdentity(provider, 'provider API projection')
  if (selected === undefined) {
    throw new Error('provider authority requires a non-empty provider name')
  }
  return selected
}

function sessionSelection(): ProviderRuntimeSelection | undefined {
  const session = getCurrentRuntimeSession()
  if (session === null) return undefined
  const providerService = session.services.providerService
  const binding = providerService?.current()
  if (binding === undefined || providerService === undefined) {
    throw new Error(
      'Ambient runtime session has no session-owned provider binding',
    )
  }
  return Object.freeze({
    provider: binding.provider,
    model: binding.model,
    environment: providerService.environment(),
  })
}

export function getSelectedProviderSelection(): ProviderRuntimeSelection {
  const session = sessionSelection()
  if (session !== undefined) return session
  const startupSelection = readStartupProviderSelectionSnapshot()
  if (startupSelection !== undefined) return startupSelection
  throw new Error(
    'No provider authority is bound; run inside canonical startup/session scope',
  )
}

/**
 * Project the provider selected by an explicit argument, the current session,
 * or the canonical startup scope. Provider environment is captured at ingress;
 * this compatibility projection must never read mutable process-global state.
 */
export function getSelectedProviderName(explicitProvider?: string): string {
  if (explicitProvider !== undefined) {
    return selectedProviderIdentity(explicitProvider)
  }
  return getSelectedProviderSelection().provider
}

export function getSelectedProviderModel(): string {
  return getSelectedProviderSelection().model
}

export function getSelectedProviderEnvironment(): ProviderEnvironment {
  return getSelectedProviderSelection().environment
}
