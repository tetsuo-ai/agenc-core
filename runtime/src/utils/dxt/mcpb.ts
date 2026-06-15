import { z } from 'zod/v4'

const MANIFEST_VERSIONS = ['0.1', '0.2', '0.3', '0.4'] as const
const LOCALE_PLACEHOLDER_REGEX = /\$\{locale\}/i
const BCP47_REGEX = /^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{1,8})*$/
const ICON_SIZE_REGEX = /^\d+x\d+$/

const McpServerConfigSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const McpbManifestAuthorSchema = z.strictObject({
  name: z.string(),
  email: z.email().optional(),
  url: z.url().optional(),
})

const McpbManifestRepositorySchema = z.strictObject({
  type: z.string(),
  url: z.url(),
})

const McpbManifestPlatformOverrideSchema = McpServerConfigSchema.partial()

const McpbManifestMcpConfigSchema = McpServerConfigSchema.extend({
  platform_overrides: z
    .record(z.string(), McpbManifestPlatformOverrideSchema)
    .optional(),
})

const McpbManifestCompatibilitySchema = z.strictObject({
  claude_desktop: z.string().optional(),
  platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).optional(),
  runtimes: z
    .strictObject({
      python: z.string().optional(),
      node: z.string().optional(),
    })
    .optional(),
})

const McpbManifestToolSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
})

const McpbManifestPromptSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  text: z.string(),
})

const McpbUserConfigurationOptionSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  default: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

const McpbManifestLocalizationSchema = z.strictObject({
  resources: z.string().regex(
    LOCALE_PLACEHOLDER_REGEX,
    'resources must include a "${locale}" placeholder',
  ),
  default_locale: z
    .string()
    .regex(BCP47_REGEX, 'default_locale must be a valid BCP 47 locale identifier'),
})

const McpbManifestIconSchema = z.strictObject({
  src: z.string(),
  size: z.string().regex(
    ICON_SIZE_REGEX,
    'size must be in the format "WIDTHxHEIGHT" (e.g., "16x16")',
  ),
  theme: z.string().min(1, 'theme cannot be empty when provided').optional(),
})

function mcpbManifestServerSchema(version: (typeof MANIFEST_VERSIONS)[number]) {
  return z.strictObject({
    type: z.enum(
      version === '0.4'
        ? ['python', 'node', 'binary', 'uv']
        : ['python', 'node', 'binary'],
    ),
    entry_point: z.string(),
    mcp_config: McpbManifestMcpConfigSchema,
  })
}

function mcpbManifestSchema(version: (typeof MANIFEST_VERSIONS)[number]) {
  const base = {
    $schema: z.string().optional(),
    dxt_version: z.literal(version).optional(),
    manifest_version: z.literal(version).optional(),
    name: z.string(),
    display_name: z.string().optional(),
    version: z.string(),
    description: z.string(),
    long_description: z.string().optional(),
    author: McpbManifestAuthorSchema,
    repository: McpbManifestRepositorySchema.optional(),
    homepage: z.url().optional(),
    documentation: z.url().optional(),
    support: z.url().optional(),
    icon: z.string().optional(),
    screenshots: z.array(z.string()).optional(),
    server: mcpbManifestServerSchema(version),
    tools: z.array(McpbManifestToolSchema).optional(),
    tools_generated: z.boolean().optional(),
    prompts: z.array(McpbManifestPromptSchema).optional(),
    prompts_generated: z.boolean().optional(),
    keywords: z.array(z.string()).optional(),
    license: z.string().optional(),
    compatibility: McpbManifestCompatibilitySchema.optional(),
    user_config: z
      .record(z.string(), McpbUserConfigurationOptionSchema)
      .optional(),
  }

  const versioned =
    version === '0.1'
      ? base
      : {
          ...base,
          privacy_policies: z.array(z.url()).optional(),
          ...(version === '0.2'
            ? {}
            : {
                icons: z.array(McpbManifestIconSchema).optional(),
                localization: McpbManifestLocalizationSchema.optional(),
                _meta: z.record(z.string(), z.record(z.string(), z.any())).optional(),
              }),
        }

  return z.strictObject(versioned).refine(
    data => Boolean(data.dxt_version || data.manifest_version),
    {
      message:
        "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided",
    },
  )
}

export const McpbManifestSchema = z.union([
  mcpbManifestSchema('0.1'),
  mcpbManifestSchema('0.2'),
  mcpbManifestSchema('0.3'),
  mcpbManifestSchema('0.4'),
])

export type McpbManifest = z.infer<typeof McpbManifestSchema>
export type McpbUserConfigurationOption = z.infer<
  typeof McpbUserConfigurationOptionSchema
>
export type McpbUserConfigValues = Record<
  string,
  string | number | boolean | string[]
>
export type McpbMcpConfig = z.infer<typeof McpbManifestMcpConfigSchema>

type Logger = {
  warn: (...args: unknown[]) => void
}

type GetMcpConfigForManifestOptions = {
  manifest: McpbManifest
  extensionPath: string
  systemDirs: Record<string, string>
  userConfig?: McpbUserConfigValues
  pathSeparator: string
  logger?: Logger
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function replaceMcpbVariables(
  value: unknown,
  variables: Record<string, string | string[]>,
): unknown {
  if (typeof value === 'string') {
    let result = value
    for (const [key, replacement] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${escapeRegExp(key)}\\}`, 'g')
      if (!pattern.test(result)) {
        continue
      }
      if (!Array.isArray(replacement)) {
        result = result.replace(pattern, replacement)
      }
    }
    return result
  }

  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) {
      if (typeof item === 'string') {
        const variableName = item.match(/^\$\{([^}]+)\}$/)?.[1]
        const replacement = variableName ? variables[variableName] : undefined
        if (Array.isArray(replacement)) {
          result.push(...replacement)
          continue
        }
        if (replacement !== undefined) {
          result.push(replacement)
          continue
        }
      }
      result.push(replaceMcpbVariables(item, variables))
    }
    return result
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        replaceMcpbVariables(nestedValue, variables),
      ]),
    )
  }

  return value
}

function isInvalidSingleValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function hasRequiredConfigMissing(
  manifest: McpbManifest,
  userConfig?: McpbUserConfigValues,
): boolean {
  if (!manifest.user_config) {
    return false
  }

  const config = userConfig ?? {}
  for (const [key, configOption] of Object.entries(manifest.user_config)) {
    if (!configOption.required) {
      continue
    }
    const value = config[key]
    if (
      isInvalidSingleValue(value) ||
      (Array.isArray(value) &&
        (value.length === 0 || value.some(isInvalidSingleValue)))
    ) {
      return true
    }
  }
  return false
}

export async function getMcpConfigForManifest({
  manifest,
  extensionPath,
  systemDirs,
  userConfig,
  pathSeparator,
  logger,
}: GetMcpConfigForManifestOptions): Promise<McpbMcpConfig | undefined> {
  const baseConfig = manifest.server?.mcp_config
  if (!baseConfig) {
    return undefined
  }

  let result: McpbMcpConfig = { ...baseConfig }
  const platformConfig = baseConfig.platform_overrides?.[process.platform]
  if (platformConfig) {
    result = {
      ...result,
      command: platformConfig.command ?? result.command,
      args: platformConfig.args ?? result.args,
      env: platformConfig.env ?? result.env,
    }
  }

  if (hasRequiredConfigMissing(manifest, userConfig)) {
    logger?.warn(
      `Extension ${manifest.name} has missing required configuration, skipping MCP config`,
    )
    return undefined
  }

  const variables: Record<string, string | string[]> = {
    __dirname: extensionPath,
    pathSeparator,
    '/': pathSeparator,
    ...systemDirs,
  }

  const mergedConfig: McpbUserConfigValues = {}
  if (manifest.user_config) {
    for (const [key, configOption] of Object.entries(manifest.user_config)) {
      if (configOption.default !== undefined) {
        mergedConfig[key] = configOption.default
      }
    }
  }
  if (userConfig) {
    Object.assign(mergedConfig, userConfig)
  }

  for (const [key, value] of Object.entries(mergedConfig)) {
    const userConfigKey = `user_config.${key}`
    if (Array.isArray(value)) {
      variables[userConfigKey] = value.map(String)
    } else if (typeof value === 'boolean') {
      variables[userConfigKey] = value ? 'true' : 'false'
    } else {
      variables[userConfigKey] = String(value)
    }
  }

  return replaceMcpbVariables(result, variables) as McpbMcpConfig
}
