import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { KNOWN_CONFIG_KEYS } from '../../src/config/schema.js'
import { retiredFieldManifestFor } from '../../src/config/retired-field-manifest.js'
import { PROJECT_RUNTIME_STATE_FIELDS } from '../../src/config/state.js'

const sourceRoot = resolve(import.meta.dirname, '../../src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = resolve(directory, entry)
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : []
  })
}

describe('home and runtime-state authority boundary', () => {
  test('has no field retained by both runtime state and canonical config', () => {
    const configFields = new Set(KNOWN_CONFIG_KEYS)
    const duplicated = retiredFieldManifestFor('global-state')
      .filter(entry => entry.authority === 'state' && entry.action === 'retain')
      .map(entry => entry.field)
      .filter(field => configFields.has(field))
      .sort()

    expect(duplicated).toEqual([])
  })

  test('has no retired global-state or profile-file runtime path', () => {
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const content = readFileSync(path, 'utf8')
      const reasons = [
        content.includes('getGlobalAgenCFile')
          ? 'getGlobalAgenCFile'
          : undefined,
        content.includes('.agenc-profile.json')
          ? '.agenc-profile.json'
          : undefined,
        content.includes('providerProfile.js')
          ? 'providerProfile.js'
          : undefined,
        content.includes('providerProfiles.js')
          ? 'providerProfiles.js'
          : undefined,
        content.includes('keychainPrefetch.js')
          ? 'keychainPrefetch.js'
          : undefined,
        content.includes('runtime-tools/state.json')
          ? 'runtime-tools/state.json'
          : undefined,
      ].filter((reason): reason is string => reason !== undefined)
      return reasons.map(reason => `${relative(sourceRoot, path)}: ${reason}`)
    })

    expect(violations).toEqual([])
    expect(
      [
        'utils/providerProfile.ts',
        'utils/providerProfiles.ts',
        'utils/secureStorage/keychainPrefetch.ts',
      ].filter(name => existsSync(resolve(sourceRoot, name))),
    ).toEqual([])
  })

  test('has no retired GlobalConfig API or schema aliases', () => {
    const retired = [
      'getGlobalConfig',
      'saveGlobalConfig',
      'LegacyGlobalConfig',
      'DEFAULT_GLOBAL_CONFIG',
      'GLOBAL_CONFIG_KEYS',
      '_setGlobalConfigCacheForTesting',
    ]
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const content = readFileSync(path, 'utf8')
      return retired
        .filter(name => new RegExp(`\\b${name}\\b`, 'u').test(content))
        .map(name => `${relative(sourceRoot, path)}: ${name}`)
    })

    expect(violations).toEqual([])
  })

  test('does not retain retired compatibility markers in runtime state', () => {
    const configSource = readFileSync(
      resolve(sourceRoot, 'config/runtime-state-repository.ts'),
      'utf8',
    )
    const retired = [
      'cachedChangelog',
      'agencAiMcpEverConnected',
      'customNotifyCommand',
      'iterm2KeyBindingInstalled',
      'subscriptionUpsellShownCount',
      'recommendedSubscription',
      'legacyOpusMigrationTimestamp',
      'providerProfiles',
      'activeProviderProfileId',
      'openaiAdditionalModelOptionsCacheByProfile',
      'fastModePerSessionOptIn',
      'bypassPermissionsModeAcceptedIn',
    ].filter(field => new RegExp(`\\b${field}\\b`, 'u').test(configSource))

    expect(retired).toEqual([])
  })

  test('keeps the structural state parser inside the explicit migration boundary', () => {
    const consumers = sourceFiles(sourceRoot)
      .map(path => ({
        name: relative(sourceRoot, path),
        content: readFileSync(path, 'utf8'),
      }))
      .filter(({ name }) => name !== 'config/state.ts')
      .filter(({ content }) =>
        /\bparseCanonicalStateJsonStructure\b/u.test(content)
      )
      .map(({ name }) => name)

    expect(consumers).toEqual(['config/migration.ts'])
  })

  test('keeps project state free of trust and executable policy authority', () => {
    const configSource = readFileSync(
      resolve(sourceRoot, 'config/runtime-state-repository.ts'),
      'utf8',
    )
    const projectType = configSource.match(
      /export type ProjectRuntimeState = \{([\s\S]*?)\n\}/u,
    )?.[1] ?? ''
    const retiredProjectFields = [
      'allowedTools',
      'mcpContextUris',
      'mcpServers',
      'hasTrustDialogAccepted',
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
      'enableAllProjectMcpServers',
      'approvedMcpjsonServerDigests',
      'disabledMcpServers',
      'enabledMcpServers',
      'hasCompletedProjectOnboarding',
      'projectOnboardingSeenCount',
      'hasAgenCMdExternalIncludesWarningShown',
      'remoteControlSpawnMode',
    ].filter(field => new RegExp(`\\b${field}\\b`, 'u').test(projectType))

    expect(retiredProjectFields).toEqual([])
    const declaredProjectRuntimeFields = Array.from(
      projectType.matchAll(/^  ([A-Za-z][A-Za-z0-9]*)\??:/gmu),
      match => match[1],
    ).sort()
    expect(declaredProjectRuntimeFields).toEqual(
      [...PROJECT_RUNTIME_STATE_FIELDS].sort(),
    )
    expect(configSource).not.toMatch(
      /\b(?:getCurrentProjectConfig|saveCurrentProjectConfig|PROJECT_CONFIG_KEYS)\b/u,
    )

    const authorityConsumers = [
      'cli/handlers/mcp.tsx',
      'services/mcp/config.ts',
      'services/mcp/utils.ts',
      'utils/messages.ts',
    ]
    const violations = authorityConsumers.flatMap(name => {
      const content = readFileSync(resolve(sourceRoot, name), 'utf8')
      return /\b(?:getCurrentProjectRuntimeState|saveCurrentProjectRuntimeState)\b/u.test(
        content,
      )
        ? [name]
        : []
    })
    expect(violations).toEqual([])
  })

  test('binds mutable state caches, watchers, fixtures, and locks to one HomeContext', () => {
    const bridge = readFileSync(resolve(sourceRoot, 'utils/config.ts'), 'utf8')
    const env = readFileSync(resolve(sourceRoot, 'utils/env.ts'), 'utf8')
    const authority = readFileSync(
      resolve(sourceRoot, 'utils/settings/canonicalAuthority.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'config/runtime-state-repository.ts'),
      'utf8',
    )

    expect(env).not.toMatch(/getGlobalStateFile|state\.json/u)
    expect(bridge).not.toMatch(
      /runtimeStateCache|freshnessWatcherStarted|TEST_GLOBAL_CONFIG_FOR_TESTING|TEST_PROJECT_RUNTIME_STATE_FOR_TESTING|getGlobalStateFile/u,
    )
    expect(authority).toMatch(
      /readonly stateRepository: RuntimeStateRepository/u,
    )
    expect(repository).toMatch(/readonly homeContext: HomeContext/u)
    expect(repository).toMatch(/#cache: StateCache/u)
    expect(repository).toMatch(/#memoryState: GlobalRuntimeState/u)
    expect(repository).toMatch(/#watcherStarted = false/u)
    expect(repository).toMatch(/const file = this\.statePath/u)
  })

  test('keeps obsolete home inspection inside the rejection/migration boundary', () => {
    const allowed = new Set([
      'config/env.ts',
      'config/home.ts',
      'config/migration.ts',
      'utils/secureStorage/migrationIdentity.ts',
    ])
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path)
      if (allowed.has(name)) return []
      return /\bAGENC_CONFIG_DIR\b/u.test(readFileSync(path, 'utf8'))
        ? [name]
        : []
    })

    expect(violations).toEqual([])
  })

  test('does not rediscover simple mode from ambient env outside ingress', () => {
    const allowed = new Set([
      'session/runtime-options.ts',
      'utils/envUtils.ts',
    ])
    const directRead = /(?:process\.env|env|source)\s*(?:\.|\[)["']?AGENC_SIMPLE/u
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path)
      if (allowed.has(name)) return []
      return directRead.test(readFileSync(path, 'utf8')) ? [name] : []
    })

    expect(violations).toEqual([])
  })

  test('keeps direct AGENC_HOME reads at explicit ingress and isolation boundaries', () => {
    const allowed = new Set([
      'app-server/daemon-instance-identity.ts', // Inspecting a foreign process.
      'bin/agenc-main.ts', // Initial writable-home ingress validation.
      'config/home.ts', // The canonical authority implementation.
      'eval-executor/trust-run.ts', // Scoped in-process conformance isolation.
      'utils/secureStorage/migrationIdentity.ts', // Explicit retired-namespace migration reconstruction.
    ])
    const directRead =
      /process\.env\.AGENC_HOME|\benv\??\.AGENC_HOME|\benvironment\.AGENC_HOME/u
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path)
      if (allowed.has(name)) return []
      return directRead.test(readFileSync(path, 'utf8')) ? [name] : []
    })

    expect(violations).toEqual([])
  })

  test('does not invoke the canonical home resolver from ambient process env outside ingress', () => {
    const allowed = new Set([
      'bin/agenc-main.ts', // Process ingress before HomeContext/ConfigStore exists.
    ])
    const directAmbientResolution =
      /\bresolveAgencHome\(\s*process\.env\s*\)/u
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path)
      if (allowed.has(name)) return []
      return directAmbientResolution.test(readFileSync(path, 'utf8'))
        ? [name]
        : []
    })

    expect(violations).toEqual([])
  })

  test('has no hand-rolled HOME/.agenc resolution or alternate home helper', () => {
    const handRolledDefault =
      /\b(?:join|resolve)\s*\(\s*[^,\n]*(?:homedir\(\)|\b(?:env|environment|process\.env)\.HOME)[^,\n]*,\s*["']\.agenc["']/u
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path)
      const content = readFileSync(path, 'utf8')
      if (/\bgetAgenCConfigHomeDir\b/u.test(content)) {
        return [`${name}: retired config-only home helper name`]
      }
      if (name !== 'config/home.ts' && handRolledDefault.test(content)) {
        return [`${name}: hand-rolled default`]
      }
      if (
        /(?:export\s+)?function\s+resolveAgencHome\s*\(/u.test(content) &&
        !content.includes('resolveHomeContext')
      ) {
        return [`${name}: alternate resolver`]
      }
      return []
    })

    expect(violations).toEqual([])
  })

  test('has one Windows credential backend with no opt-in plaintext-compatible path', () => {
    const migrationOnly = new Set([
      'config/migration.ts',
      'config/retired-auth-migration.ts',
    ])
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path)
      if (migrationOnly.has(name)) return []
      const content = readFileSync(path, 'utf8')
      return /AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT|PasswordVault/u.test(
        content,
      )
        ? [name]
        : []
    })

    expect(violations).toEqual([])
  })
})
