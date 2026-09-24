import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { vi } from 'vitest'
import type { SecureStorageData } from '../../src/utils/secureStorage/index.js'

const secureStorageRecords = vi.hoisted(
  () => new Map<string, SecureStorageData>(),
)

vi.mock('../utils/secureStorage/native.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/utils/secureStorage/native.js')>()
  return {
    ...actual,
    readNativeSecureStorage: (home: { path: string }) =>
      structuredClone(secureStorageRecords.get(home.path) ?? {}),
    readNativeSecureStorageAsync: async (home: { path: string }) =>
      structuredClone(secureStorageRecords.get(home.path) ?? {}),
    updateNativeSecureStorage: (
      home: { path: string },
      updater: (current: SecureStorageData) => SecureStorageData,
    ) => {
      const previous = structuredClone(secureStorageRecords.get(home.path) ?? {})
      const written = structuredClone(updater(previous))
      if (JSON.stringify(previous) === JSON.stringify(written)) return null
      secureStorageRecords.set(home.path, written)
      return { previous, written }
    },
    rollbackNativeSecureStorage: (
      home: { path: string },
      transaction: { previous: SecureStorageData; written: SecureStorageData } | null,
      updater: (
        current: SecureStorageData,
        transaction: { previous: SecureStorageData; written: SecureStorageData },
      ) => SecureStorageData,
    ) => {
      if (transaction === null) return
      const current = structuredClone(secureStorageRecords.get(home.path) ?? {})
      secureStorageRecords.set(home.path, structuredClone(updater(current, transaction)))
    },
  }
})

import { ConfigStore } from '../../src/config/store.js'
import { runWithCanonicalSettingsAuthority } from '../../src/utils/settings/canonicalAuthority.js'
import {
  loadMcpServerUserConfig,
  saveMcpServerUserConfig,
  type UserConfigSchema,
} from '../../src/utils/plugins/mcpbHandler.js'
import { PlaintextPluginSecretError } from '../../src/utils/plugins/pluginConfigAuthority.js'
import {
  loadPluginOptions,
  savePluginOptions,
  type PluginOptionSchema,
} from '../../src/utils/plugins/pluginOptionsStorage.js'

const temporaryDirectories: string[] = []
const PLUGIN_ID = 'demo@local'

const OPTION_SCHEMA = {
  color: {
    type: 'string',
    title: 'Color',
    description: 'Display color',
  },
  token: {
    type: 'string',
    title: 'Token',
    description: 'API token',
    sensitive: true,
    required: true,
  },
} satisfies PluginOptionSchema

const SERVER_SCHEMA = {
  owner: {
    type: 'string',
    title: 'Owner',
    description: 'Channel owner',
  },
  bot_token: {
    type: 'string',
    title: 'Bot token',
    description: 'Channel bot token',
    sensitive: true,
    required: true,
  },
} satisfies UserConfigSchema

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`))
  temporaryDirectories.push(path)
  return path
}

async function activateConfig(configToml: string): Promise<ConfigStore> {
  const root = temp('agenc-plugin-secret-authority')
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(home, 'config.toml'), configToml, { mode: 0o600 })
  const store = new ConfigStore({
    home,
    cwd: project,
    projectRoot: project,
    projectTrusted: false,
    env: { AGENC_HOME: home, HOME: root },
    managedConfigPath: join(root, 'missing-managed.toml'),
    managedDropInDir: join(root, 'missing-managed.d'),
  })
  await store.reload()
  return store
}

function filesBelow(root: string): string[] {
  if (!statSync(root).isDirectory()) return [root]
  return readdirSync(root).flatMap(name => filesBelow(join(root, name)))
}

afterEach(() => {
  secureStorageRecords.clear()
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('plugin secret authority', () => {
  test('rejects a top-level plaintext sensitive value instead of using it as fallback', async () => {
    const store = await activateConfig([
      'config_version = 2',
      `[pluginConfigs."${PLUGIN_ID}".options]`,
      'color = "blue"',
      'token = "plaintext-secret"',
      '',
    ].join('\n'))
    secureStorageRecords.set(store.homeContext.path, {
      pluginSecrets: {
        [PLUGIN_ID]: { token: 'stored-secret' },
      },
    })

    expect(() => loadPluginOptions(PLUGIN_ID, OPTION_SCHEMA)).toThrowError(
      PlaintextPluginSecretError,
    )
    expect(() => loadPluginOptions(PLUGIN_ID, OPTION_SCHEMA)).toThrow(
      /contains sensitive field\(s\) in config\.toml: token/u,
    )
  })

  test('loads each declared field only from its schema-selected owner', async () => {
    const store = await activateConfig([
      'config_version = 2',
      `[pluginConfigs."${PLUGIN_ID}".options]`,
      'color = "blue"',
      'stale = "not-live"',
      '',
    ].join('\n'))
    secureStorageRecords.set(store.homeContext.path, {
      pluginSecrets: {
        [PLUGIN_ID]: {
          color: 'stale-storage-color',
          token: 'stored-secret',
          stale_secret: 'not-live',
        },
      },
    })

    expect(loadPluginOptions(PLUGIN_ID, OPTION_SCHEMA)).toEqual({
      color: 'blue',
      token: 'stored-secret',
    })
  })

  test('binds secure-storage reads and cache entries to the owning HomeContext', async () => {
    const config = [
      'config_version = 2',
      `[pluginConfigs."${PLUGIN_ID}".options]`,
      'color = "blue"',
      '',
    ].join('\n')
    const first = await activateConfig(config)
    const second = await activateConfig(config)
    secureStorageRecords.set(first.homeContext.path, {
      pluginSecrets: { [PLUGIN_ID]: { token: 'first-home-secret' } },
    })
    secureStorageRecords.set(second.homeContext.path, {
      pluginSecrets: { [PLUGIN_ID]: { token: 'second-home-secret' } },
    })

    expect(
      runWithCanonicalSettingsAuthority(first, () =>
        loadPluginOptions(PLUGIN_ID, OPTION_SCHEMA),
      ),
    ).toEqual({ color: 'blue', token: 'first-home-secret' })
    expect(
      runWithCanonicalSettingsAuthority(second, () =>
        loadPluginOptions(PLUGIN_ID, OPTION_SCHEMA),
      ),
    ).toEqual({ color: 'blue', token: 'second-home-secret' })
  })

  test('moves a top-level secret into native secure storage and scrubs plaintext without an archive', async () => {
    const store = await activateConfig([
      'config_version = 2',
      `[pluginConfigs."${PLUGIN_ID}".options]`,
      'color = "blue"',
      'token = "old-plaintext-secret"',
      '',
    ].join('\n'))

    await savePluginOptions(
      PLUGIN_ID,
      { color: 'green', token: 'new-stored-secret' },
      OPTION_SCHEMA,
    )

    expect(
      secureStorageRecords.get(store.homeContext.path)?.pluginSecrets?.[PLUGIN_ID],
    ).toEqual({ token: 'new-stored-secret' })
    expect(loadPluginOptions(PLUGIN_ID, OPTION_SCHEMA)).toEqual({
      color: 'green',
      token: 'new-stored-secret',
    })
    const diskText = filesBelow(store.homeContext.path)
      .filter(path => statSync(path).isFile())
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')
    expect(diskText).not.toContain('old-plaintext-secret')
    expect(diskText).not.toContain('new-stored-secret')
  })

  test('rolls back its secure-storage namespace when the following TOML scrub cannot commit', async () => {
    const store = await activateConfig([
      'config_version = 2',
      `[pluginConfigs."${PLUGIN_ID}".options]`,
      'color = "blue"',
      '',
    ].join('\n'))
    secureStorageRecords.set(store.homeContext.path, {
      primaryApiKey: 'unrelated-native-secret',
      pluginSecrets: {
        [PLUGIN_ID]: { token: 'previous-stored-secret' },
        'other@local': { token: 'other-plugin-secret' },
      },
    })
    const configPath = join(store.homeContext.path, 'config.toml')
    rmSync(configPath)
    mkdirSync(configPath)

    await expect(
      savePluginOptions(
        PLUGIN_ID,
        { color: 'green', token: 'replacement-stored-secret' },
        OPTION_SCHEMA,
      ),
    ).rejects.toThrow()

    expect(secureStorageRecords.get(store.homeContext.path)).toEqual({
      primaryApiKey: 'unrelated-native-secret',
      pluginSecrets: {
        [PLUGIN_ID]: { token: 'previous-stored-secret' },
        'other@local': { token: 'other-plugin-secret' },
      },
    })
  })

  test('applies the same rejection and scrub boundary to per-server MCP config', async () => {
    const store = await activateConfig([
      'config_version = 2',
      `[pluginConfigs."${PLUGIN_ID}".mcpServers.telegram]`,
      'owner = "alice"',
      'bot_token = "old-bot-secret"',
      '',
    ].join('\n'))

    expect(() =>
      loadMcpServerUserConfig(PLUGIN_ID, 'telegram', SERVER_SCHEMA),
    ).toThrowError(PlaintextPluginSecretError)

    await saveMcpServerUserConfig(
      PLUGIN_ID,
      'telegram',
      { owner: 'bob', bot_token: 'new-bot-secret' },
      SERVER_SCHEMA,
    )

    expect(
      secureStorageRecords.get(store.homeContext.path)?.pluginSecrets?.[
        `${PLUGIN_ID}/telegram`
      ],
    ).toEqual({ bot_token: 'new-bot-secret' })
    expect(
      loadMcpServerUserConfig(PLUGIN_ID, 'telegram', SERVER_SCHEMA),
    ).toEqual({ owner: 'bob', bot_token: 'new-bot-secret' })
    const diskText = filesBelow(store.homeContext.path)
      .filter(path => statSync(path).isFile())
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')
    expect(diskText).not.toContain('old-bot-secret')
    expect(diskText).not.toContain('new-bot-secret')
  })

  test('refuses values absent from the supplied schema instead of guessing storage', async () => {
    await activateConfig('config_version = 2\n')

    await expect(
      savePluginOptions(
        PLUGIN_ID,
        { undeclared: 'could-be-a-secret' },
        OPTION_SCHEMA,
      ),
    ).rejects.toThrow(/absent from the plugin userConfig schema: undeclared/u)
    await expect(
      saveMcpServerUserConfig(
        PLUGIN_ID,
        'telegram',
        { undeclared: 'could-be-a-secret' },
        SERVER_SCHEMA,
      ),
    ).rejects.toThrow(/absent from the plugin userConfig schema: undeclared/u)
  })
})
