import type { HomeContext } from '../../../src/config/home.js'
import {
  createProvider,
  type ProviderFactoryOptions,
} from '../../../src/llm/provider.js'
import { resolveProviderCredentialAuthority } from '../../../src/llm/provider-options.js'
import { resolveProviderRuntimeRequest } from '../../../src/llm/provider-request.js'
import {
  projectBoundProviderConnection,
  type BoundProviderConnection,
} from '../../../src/llm/registry/provider-connection.js'
import {
  bindingFromProvider,
  type ProviderBinding,
} from '../../../src/session/provider-service.js'
import {
  resolveBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from '../../../src/llm/registry/provider-info.js'

type FixtureProvider = BuiltInProviderSlug | 'firstParty' | 'xai'

export interface ProviderConnectionFixtureOptions {
  readonly provider: FixtureProvider | string
  readonly model: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly home?: HomeContext
  readonly factoryOptions?: ProviderFactoryOptions
}

function fixtureProvider(provider: string): BuiltInProviderSlug {
  const normalized =
    provider === 'firstParty'
      ? 'anthropic'
      : provider === 'xai'
        ? 'grok'
        : provider
  const resolved = resolveBuiltInProviderSlug(normalized)
  if (resolved === undefined) {
    throw new Error(`unknown provider fixture "${provider}"`)
  }
  return resolved
}

export function providerBindingFixture(
  options: ProviderConnectionFixtureOptions,
): ProviderBinding {
  const provider = fixtureProvider(options.provider)
  const environment = Object.freeze({ ...(options.environment ?? {}) })
  const runtimeRequest = resolveProviderRuntimeRequest({
    provider,
    model: options.model,
    config: {},
    environment,
    ...(options.home !== undefined ? { credentialHome: options.home } : {}),
    ...(options.factoryOptions?.extra !== undefined
      ? { baseExtra: options.factoryOptions.extra }
      : {}),
  })
  const requested: ProviderFactoryOptions = {
    ...runtimeRequest.requested,
    ...(options.factoryOptions ?? {}),
    ...(options.home !== undefined ? { credentialHome: options.home } : {}),
    model: options.model,
    ...(runtimeRequest.requested.extra !== undefined
      ? { extra: runtimeRequest.requested.extra }
      : {}),
  }
  const authority = resolveProviderCredentialAuthority(
    provider,
    requested,
    environment,
  )
  const instance = createProvider(provider, authority.factoryOptions)
  return bindingFromProvider({
    provider: instance,
    providerName: provider,
    model: authority.factoryOptions.model ?? options.model,
  })
}

export function providerConnectionFixture(
  options: ProviderConnectionFixtureOptions,
): BoundProviderConnection {
  const environment = Object.freeze({ ...(options.environment ?? {}) })
  return projectBoundProviderConnection({
    binding: providerBindingFixture({ ...options, environment }),
    environment,
  })
}
