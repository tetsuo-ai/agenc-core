import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')
}

describe('Gemini credential authority', () => {
  test('has no Gemini-specific persisted access-token channel', () => {
    expect(
      existsSync(new URL('../../src/utils/geminiCredentials.ts', import.meta.url)),
    ).toBe(false)
    expect(source('utils/secureStorage/index.ts')).not.toMatch(/\bgemini\?\s*:/u)
    expect(source('config/migration.ts')).not.toContain('parsed.gemini')
  })

  test('credential resolution and the native provider never read process environment', () => {
    const authSource = source('utils/geminiAuth.ts')
    expect(authSource).not.toContain('process.env')
    expect(authSource).not.toContain('new GoogleAuth')
    expect(authSource).not.toContain('keyFilename')
    expect(authSource).not.toContain('ExternalAccountClient')
    expect(authSource).toContain('new JWT')
    expect(authSource).toContain('new UserRefreshClient')
    expect(source('llm/providers/gemini/index.ts')).not.toContain('process.env')
  })

  test('caches the ADC client but materializes a token for each request', () => {
    const authSource = source('utils/geminiAuth.ts')
    expect(authSource).toContain('resolveDefaultGeminiAdcClient')
    expect(authSource).not.toContain('resolveDefaultGeminiAdcCredential')
    expect(authSource).toContain(
      'normalizeAccessToken(await client.getAccessToken())',
    )
  })

  test('only the documented project identifiers participate in resolution', () => {
    const authSource = source('utils/geminiAuth.ts')
    expect(authSource).toContain('env.GEMINI_PROJECT_ID')
    expect(authSource).toContain('env.GOOGLE_CLOUD_PROJECT')
    expect(authSource).not.toContain('env.GCLOUD_PROJECT')
    expect(authSource).not.toContain('env.GOOGLE_PROJECT_ID')
  })

  test('propagates one typed plan through options, factory state, and native requests', () => {
    const optionsSource = source('llm/provider-options.ts')
    const factorySource = source('llm/provider.ts')
    const nativeSource = source('llm/providers/gemini/index.ts')

    expect(optionsSource).toContain('resolveGeminiCredentialPlan')
    expect(optionsSource).toContain('createGeminiEndpointPlan')
    expect(optionsSource).toContain('forcedExtra.gemini')
    expect(factorySource).toContain('readonly gemini?: GeminiRuntimeOptions')
    expect(factorySource).toContain('credentialPlan: gemini.credentialPlan')
    expect(factorySource).toContain('endpointPlan: gemini.endpointPlan')
    expect(nativeSource).toContain(
      'export interface GeminiProviderConfig extends Omit<LLMProviderConfig, "baseURL">',
    )
    expect(nativeSource).toContain('materializeGeminiCredentialPlan')
    expect(nativeSource).toContain('geminiEndpointFor(this.config.endpointPlan')
    expect(nativeSource).not.toMatch(
      /config\.(?:apiKey|accessToken|authMode|oauth|resolveCredential|project)/u,
    )
  })

  test('keeps Gemini on its native provider and preserves wrapped factory state', () => {
    const authSource = source('utils/geminiAuth.ts')
    const agentSource = source('agents/run-agent.ts')
    const compatSource = source('session/turn-compat.ts')
    const endpointSource = source('llm/providers/gemini/endpoint-plan.ts')
    const menuSource = source('commands/provider-menu.tsx')
    const discoverySource = source('llm/discovery/provider-discovery.ts')
    const verificationSource = source('onboarding/useApiKeyVerification.ts')

    expect(authSource).not.toContain('export function resolveGeminiCredential(')
    expect(agentSource).toContain('preserveProviderFactoryState')
    expect(agentSource).not.toContain('buildAgentProviderOverride')
    expect(agentSource).not.toMatch(
      /process\.env\.(?:GEMINI_API_KEY|GOOGLE_API_KEY|GEMINI_ACCESS_TOKEN)/u,
    )
    expect(compatSource).toContain('createTurnCompatProviderLease')
    expect(compatSource).toContain('readProviderFactoryOptions(source)')
    expect(compatSource).toContain('createProvider(')
    expect(endpointSource).not.toContain('openAiCompatibleBaseURL')
    expect(endpointSource).not.toContain('GEMINI_DEVELOPER_OPENAI')
    expect(menuSource).toContain('createProviderCommandAccessOverlay')
    expect(menuSource).not.toContain('resolveProviderFactoryOptions')
    expect(discoverySource).toContain('resolveProviderCredentialAuthority')
    expect(discoverySource).not.toContain('resolveProviderFactoryOptions')
    expect(verificationSource).toContain('resolveProviderCredentialAuthority')
    expect(verificationSource).not.toContain('resolveProviderFactoryOptions')
  })

  test('has no second provider transport override channel', () => {
    expect(
      existsSync(new URL('../../src/llm/provider-override.ts', import.meta.url)),
    ).toBe(false)

    for (const path of [
      'agents/run-agent.ts',
      'tools/Tool.ts',
    ]) {
      const runtimeSource = source(path)
      expect(runtimeSource, path).not.toContain('ProviderTransportOverride')
      expect(runtimeSource, path).not.toMatch(/\bproviderOverride\s*[?:]/u)
    }
  })

  test('keeps cached-content and saved-BYOK state inside canonical owners', () => {
    for (const path of [
      'budget/admitted-model-call.ts',
      'services/compact/_deps/runtime.ts',
    ]) {
      const runtimeSource = source(path)
      expect(runtimeSource, path).toContain('readGeminiRuntimeOptions')
      expect(runtimeSource, path).not.toMatch(/extra\?*\.cachedContent/u)
    }

    for (const path of [
      'session/session.ts',
      'session/provider-service.ts',
    ]) {
      const sessionSource = source(path)
      expect(sessionSource, path).not.toContain('readByokKey')
      expect(sessionSource, path).not.toContain('LocalAuthBackend')
    }
  })

})
