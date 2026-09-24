import { ConfigStore } from '../config/store.js'
import { readCanonicalUserConfigSnapshotSync } from '../config/update-sync.js'
import { stableJson } from '../config/json.js'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as lockfile from '../utils/lockfile.js'
import { runWithCanonicalSettingsAuthority } from '../utils/settings/canonicalAuthority.js'
import { inspectPluginOptions, inspectPluginOptionsSnapshot, resetPluginOptions, savePluginOptions, PluginSettingsConflictError } from '../utils/plugins/pluginOptionsStorage.js'
import { requirePluginConfigAuthority } from '../utils/plugins/pluginConfigAuthority.js'
import { readNativeSecureStorageFresh, NativeSecureStorageError, NativeSecureStorageUnavailableError } from '../utils/secureStorage/native.js'
import { validateUserConfig, type UserConfigValues } from '../utils/plugins/mcpbHandler.js'
import { loadPlugins } from './loader.js'
import type { PluginUserConfigOption } from './manifest-schema.js'

export interface PluginSettingsParams { readonly pluginId: string }
export interface PluginSettingsSetParams extends PluginSettingsParams { readonly values: Readonly<Record<string, string | number | boolean | string[]>> }
export interface PluginSettingsResult {
  readonly pluginId: string
  readonly schema: Readonly<Record<string, PluginUserConfigOption>>
  readonly values: Readonly<Record<string, string | number | boolean | string[]>>
  readonly sensitiveSet: Readonly<Record<string, boolean>>
  readonly needsSetup: readonly string[]
}

export class PluginSettingsService {
  constructor(private readonly options: {
    readonly home: string
    readonly pluginStorageRoot: string
    readonly workspaceRoot: string
    readonly env: NodeJS.ProcessEnv
  }) {}

  private async withMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.options.home, { recursive: true, mode: 0o700 })
    const target = join(this.options.home, `.plugin-settings-${createHash('sha256').update(pluginId).digest('hex')}`)
    const release = await lockfile.lock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
    })
    try { return await operation() } finally { await release() }
  }

  private async withPlugin<T>(pluginId: string, operation: (schema: Record<string, PluginUserConfigOption>) => Promise<T>): Promise<T> {
    if (typeof pluginId !== 'string' || pluginId.trim() !== pluginId || pluginId.length === 0) throw new Error('A plugin ID is required')
    const store = new ConfigStore({ home: this.options.home, cwd: this.options.workspaceRoot, projectRoot: this.options.workspaceRoot, env: this.options.env })
    await store.reload()
    try {
      return await runWithCanonicalSettingsAuthority(store, async () => {
        const loaded = await loadPlugins({ pluginStorageRoot: this.options.pluginStorageRoot, workspaceRoot: this.options.workspaceRoot, config: store.current() })
        const matches = [...loaded.enabled, ...loaded.disabled].filter(plugin => plugin.id === pluginId)
        if (matches.length !== 1) throw new Error(matches.length ? `Plugin ${pluginId} is ambiguous` : `Plugin ${pluginId} is not installed`)
        return operation({ ...matches[0]!.manifest.userConfig })
      })
    } catch (error) {
      if (error instanceof NativeSecureStorageUnavailableError) throw new NativeSecureStorageUnavailableError('Native secure storage is unavailable')
      if (error instanceof NativeSecureStorageError) throw new NativeSecureStorageError('Native secure storage operation failed')
      throw error
    }
  }

  async get({ pluginId }: PluginSettingsParams): Promise<PluginSettingsResult> {
    return this.withPlugin(pluginId, async schema => {
      const { values: saved, plaintextSensitiveKeys } = inspectPluginOptions(pluginId, schema, { fresh: true })
      const values: Record<string, string | number | boolean | string[]> = {}
      const sensitiveSet: Record<string, boolean> = {}
      const needsSetup: string[] = []
      const effective = Object.fromEntries(Object.entries(schema).map(([key, field]) =>
        [key, saved[key] ?? (field.sensitive ? undefined : field.default)],
      )) as UserConfigValues
      const invalid = new Set((await validateUserConfig(effective, schema)).invalidKeys)
      for (const [key, field] of Object.entries(schema)) {
        const value = effective[key]
        if (field.sensitive) {
          sensitiveSet[key] = saved[key] !== undefined && !plaintextSensitiveKeys.includes(key)
        } else if (value !== undefined) {
          values[key] = value as string | number | boolean | string[]
        }
        if (plaintextSensitiveKeys.includes(key) || invalid.has(key)) needsSetup.push(key)
      }
      const publicSchema = Object.fromEntries(Object.entries(schema).map(([key, field]) => [
        key,
        field.sensitive ? { ...field, default: undefined } : field,
      ])) as Record<string, PluginUserConfigOption>
      return { pluginId, schema: publicSchema, values, sensitiveSet, needsSetup }
    })
  }

  async set({ pluginId, values }: PluginSettingsSetParams): Promise<PluginSettingsResult> {
    return this.withMutation(pluginId, async () => {
      await this.withPlugin(pluginId, async schema => {
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Settings values must be an object')
        const unknown = Object.keys(values).filter(key => !Object.hasOwn(schema, key))
        if (unknown.length) throw new Error(`Unknown plugin setting: ${unknown.join(', ')}`)
        for (let attempt = 0; attempt < 5; attempt++) {
          const home = requirePluginConfigAuthority().homeContext
          const configSnapshot = readCanonicalUserConfigSnapshotSync(home.configTomlPath).raw
          const config = stableJson(configSnapshot)
          let secureSnapshot: ReturnType<typeof readNativeSecureStorageFresh>
          try { secureSnapshot = readNativeSecureStorageFresh(home) }
          catch (error) {
            if (!(error instanceof NativeSecureStorageUnavailableError)) throw error
            secureSnapshot = {}
          }
          const secure = stableJson(secureSnapshot)
          const configuredOptions = (configSnapshot.pluginConfigs as Record<string, {
            options?: Record<string, import('../utils/plugins/pluginConfigAuthority.js').PluginConfigStoredValue>
          }> | undefined)?.[pluginId]?.options
          const { values: saved, plaintextSensitiveKeys } = inspectPluginOptionsSnapshot(
            pluginId, schema, configuredOptions, secureSnapshot.pluginSecrets?.[pluginId], secureSnapshot.pluginSecretFormats?.[pluginId],
          )
          const unreplaced = plaintextSensitiveKeys.filter(key => !Object.hasOwn(values, key))
          if (unreplaced.length) throw new Error(`Replace plaintext plugin setting(s): ${unreplaced.join(', ')}`)
          const effective = { ...Object.fromEntries(Object.entries(schema).filter(([, field]) => !field.sensitive && field.default !== undefined).map(([key, field]) => [key, field.default])), ...saved, ...values } as UserConfigValues
          const validation = await validateUserConfig(effective, schema)
          if (!validation.valid) throw new Error(validation.errors.join('; '))
          try {
            await savePluginOptions(pluginId, values as UserConfigValues, schema, { config, secure })
            return
          } catch (error) {
            if (!(error instanceof PluginSettingsConflictError)) throw error
          }
        }
        throw new PluginSettingsConflictError()
      })
      return this.get({ pluginId })
    })
  }

  async reset({ pluginId }: PluginSettingsParams): Promise<PluginSettingsResult> {
    return this.withMutation(pluginId, async () => {
      await this.withPlugin(pluginId, async schema => { await resetPluginOptions(pluginId, Object.keys(schema)) })
      return this.get({ pluginId })
    })
  }
}
