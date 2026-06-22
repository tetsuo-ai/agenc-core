import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import yaml from 'js-yaml'
import memoize from 'lodash-es/memoize.js'
import { z } from 'zod/v4'

import { listAgentRoles } from '../../agents/role.js'
import {
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
} from '../../permissions/types.js'
import { FILE_EDIT_TOOL_NAME } from '../system/file-edit.js'
import { FILE_READ_TOOL_NAME } from '../system/file-read.js'
import { FILE_WRITE_TOOL_NAME } from '../system/file-write.js'
import {
  clearPluginAgentCache,
  loadPluginAgents,
} from '../../plugins/registration/load-plugin-agents.js'
import { isRecord } from '../../utils/record.js'
import { AGENT_COLORS, setAgentColor, type AgentColorName } from './agentColorManager.js'
import { loadAgentMemoryPrompt } from './agentMemory.js'

export type HooksSettings = Partial<Record<string, unknown[]>>

export type SettingSource =
  | 'userSettings'
  | 'projectSettings'
  | 'policySettings'
  | 'flagSettings'

export type EffortValue =
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | 'xhigh'
  | 'none'
  | number

export type AgentMemoryScope = 'user' | 'project' | 'local'

export type AgentMcpServerSpec =
  | string
  | { readonly [name: string]: McpServerConfig }

type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

const McpStdioServerConfigSchema = () =>
  z
    .object({
      type: z.literal('stdio').optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()

const McpUrlServerConfigSchema = (type: 'sse' | 'http' | 'ws') =>
  z
    .object({
      type: z.literal(type),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
      headersHelper: z.string().optional(),
    })
    .passthrough()

const McpIdeServerConfigSchema = (type: 'sse-ide' | 'ws-ide') =>
  z
    .object({
      type: z.literal(type),
      url: z.string().min(1),
      ideName: z.string().min(1),
      authToken: z.string().optional(),
      ideRunningInWindows: z.boolean().optional(),
    })
    .passthrough()

const McpSdkServerConfigSchema = () =>
  z
    .object({
      type: z.literal('sdk'),
      name: z.string().min(1),
    })
    .passthrough()

const McpServerConfigSchema = () =>
  z.union([
    McpStdioServerConfigSchema(),
    McpUrlServerConfigSchema('sse'),
    McpUrlServerConfigSchema('http'),
    McpUrlServerConfigSchema('ws'),
    McpIdeServerConfigSchema('sse-ide'),
    McpIdeServerConfigSchema('ws-ide'),
    McpSdkServerConfigSchema(),
  ])

const AgentMcpServerSpecSchema = () =>
  z.union([
    z.string().min(1),
    z.record(z.string(), McpServerConfigSchema()),
  ])

export type BaseAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  mcpServers?: AgentMcpServerSpec[]
  hooks?: HooksSettings
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  permissionMode?: PermissionMode
  maxTurns?: number
  filename?: string
  baseDir?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  requiredMcpServers?: string[]
  background?: boolean
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: 'worktree' | 'remote'
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  omitAgenCMd?: boolean
}

export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void
  getSystemPrompt: (params?: {
    toolUseContext?: { readonly options?: unknown }
  }) => string
}

export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: SettingSource
  filename?: string
  baseDir?: string
}

export type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  filename?: string
  plugin: string
}

export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  failedFiles?: FailedAgentFile[]
  allowedAgentTypes?: string[]
}

type FailedAgentFile = { path: string; error: string }

type MarkdownAgentFile = {
  filePath: string
  baseDir: string
  frontmatter: Record<string, unknown>
  content: string
  source: SettingSource
}

type SettingSourceWithLocal = SettingSource | 'localSettings'
type SettingSourceEnabled = (source: SettingSourceWithLocal) => boolean

const VALID_MEMORY_SCOPES = ['user', 'project', 'local'] as const
const MEMORY_TOOLS = [
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
] as const
const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'max', 'xhigh'] as const
const HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
])

let pluginAgentsLoaderForTesting:
  | (() => Promise<PluginAgentDefinition[]>)
  | undefined
let pluginAgentCacheClearer: (() => void) | undefined
let pluginAgentCacheClearerForTesting: (() => void) | undefined
let sharedMarkdownCacheClearer: (() => void) | undefined
let markdownDirsForTesting:
  | Array<{ dir: string; source: SettingSource }>
  | undefined

export function isBuiltInAgent(
  agent: AgentDefinition,
): agent is BuiltInAgentDefinition {
  return agent.source === 'built-in'
}

export function isCustomAgent(
  agent: AgentDefinition,
): agent is CustomAgentDefinition {
  return agent.source !== 'built-in' && agent.source !== 'plugin'
}

export function isPluginAgent(
  agent: AgentDefinition,
): agent is PluginAgentDefinition {
  return agent.source === 'plugin'
}

export function getActiveAgentsFromList(
  allAgents: AgentDefinition[],
): AgentDefinition[] {
  const groups = [
    allAgents.filter(a => a.source === 'built-in'),
    allAgents.filter(a => a.source === 'plugin'),
    allAgents.filter(a => a.source === 'userSettings'),
    allAgents.filter(a => a.source === 'projectSettings'),
    allAgents.filter(a => a.source === 'flagSettings'),
    allAgents.filter(a => a.source === 'policySettings'),
  ]
  const byType = new Map<string, AgentDefinition>()
  for (const group of groups) {
    for (const agent of group) {
      byType.set(agent.agentType, agent)
    }
  }
  return [...byType.values()]
}

export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[],
): boolean {
  if (!agent.requiredMcpServers || agent.requiredMcpServers.length === 0) {
    return true
  }
  return agent.requiredMcpServers.every(pattern =>
    availableServers.some(server =>
      server.toLowerCase().includes(pattern.toLowerCase()),
    ),
  )
}

export function filterAgentsByMcpRequirements(
  agents: AgentDefinition[],
  availableServers: string[],
): AgentDefinition[] {
  return agents.filter(agent => hasRequiredMcpServers(agent, availableServers))
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  return value === true || value === 'true' ? true : undefined
}

function parseToolList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!value) return []
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const parsed = raw
    .filter((tool): tool is string => typeof tool === 'string')
    .flatMap(tool => tool.split(/[,\s]+/))
    .map(tool => tool.trim())
    .filter(Boolean)
  return parsed
}

function parseAgentTools(value: unknown): string[] | undefined {
  const parsed = parseToolList(value)
  if (parsed === null) return value === undefined ? undefined : []
  return parsed.includes('*') ? undefined : parsed
}

function parseSlashTools(value: unknown): string[] {
  return parseToolList(value) ?? []
}

function parseEffortValue(value: unknown): EffortValue | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if ((EFFORT_LEVELS as readonly string[]).includes(trimmed)) {
    return trimmed as EffortValue
  }
  const numeric = Number(trimmed)
  return Number.isInteger(numeric) ? numeric : undefined
}

function parsePositiveIntFromFrontmatter(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

function parsePermissionMode(value: unknown): PermissionMode | undefined {
  return typeof value === 'string' &&
    (USER_ADDRESSABLE_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : undefined
}

function parseMemoryScope(value: unknown): AgentMemoryScope | undefined {
  return typeof value === 'string' &&
    (VALID_MEMORY_SCOPES as readonly string[]).includes(value)
    ? (value as AgentMemoryScope)
    : undefined
}

function parseIsolation(value: unknown): 'worktree' | 'remote' | undefined {
  const valid = process.env.USER_TYPE === 'ant' ? ['worktree', 'remote'] : ['worktree']
  return typeof value === 'string' &&
    valid.includes(value)
    ? (value as 'worktree' | 'remote')
    : undefined
}

function parseHooks(value: unknown): HooksSettings | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return undefined
  const parsed: HooksSettings = {}
  for (const [event, matchers] of Object.entries(value)) {
    if (!HOOK_EVENTS.has(event) || !Array.isArray(matchers)) return undefined
    parsed[event] = matchers
  }
  return parsed
}

function parseMcpServers(value: unknown): AgentMcpServerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value
    .map(item => {
      const result = AgentMcpServerSpecSchema().safeParse(item)
      return result.success ? result.data : null
    })
    .filter((item): item is AgentMcpServerSpec => item !== null)
  return parsed.length > 0 ? parsed : undefined
}

function addMemoryTools(
  tools: string[] | undefined,
  memory: AgentMemoryScope | undefined,
): string[] | undefined {
  if (!memory || tools === undefined || !isAutoMemoryEnabled()) return tools
  const merged = new Set(tools)
  for (const tool of MEMORY_TOOLS) {
    merged.add(tool)
  }
  return [...merged]
}

function systemPromptWithMemory(
  agentType: string,
  systemPrompt: string,
  memory: AgentMemoryScope | undefined,
): string {
  if (!memory || !isAutoMemoryEnabled()) return systemPrompt
  return `${systemPrompt}\n\n${loadAgentMemoryPrompt(agentType, memory)}`
}

function isAutoMemoryEnabled(): boolean {
  if (process.env.AGENC_DISABLE_AUTO_MEMORY === '1') return false
  if (process.env.AGENC_SIMPLE === '1' || process.env.AGENC_SIMPLE === 'true') {
    return false
  }
  return true
}

export function roleToAgentDefinition(
  role: ReturnType<typeof listAgentRoles>[number],
): BuiltInAgentDefinition {
  const description = role.config.description ?? role.name
  const systemPrompt = role.config.systemPrompt ?? ''
  const tools = role.config.allowlist
    ? Array.from(role.config.allowlist)
    : undefined
  return {
    agentType: role.name,
    whenToUse: description,
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => systemPrompt,
    ...(tools !== undefined ? { tools } : {}),
    ...(role.config.disallowlist
      ? { disallowedTools: Array.from(role.config.disallowlist) }
      : {}),
    ...(role.config.background ? { background: true } : {}),
    ...(role.config.reasoningEffort
      ? { effort: role.config.reasoningEffort }
      : {}),
  }
}

function getBuiltInAgents(): BuiltInAgentDefinition[] {
  return listAgentRoles().map(roleToAgentDefinition)
}

function parseMarkdown(raw: string): {
  frontmatter: Record<string, unknown>
  content: string
} {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, content: raw }
  }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) {
    return { frontmatter: {}, content: raw }
  }
  const frontmatterRaw = raw.slice(3, end)
  const contentStart = raw.indexOf('\n', end + 4)
  const content = contentStart === -1 ? '' : raw.slice(contentStart + 1)
  const parsed = yaml.load(frontmatterRaw)
  return {
    frontmatter: isRecord(parsed) ? parsed : {},
    content,
  }
}

function fileIdentity(filePath: string): string | null {
  try {
    const stats = statSync(filePath, { bigint: true })
    if (stats.dev === 0n && stats.ino === 0n) return null
    return `${stats.dev}:${stats.ino}`
  } catch {
    try {
      return realpathSync(filePath)
    } catch {
      return null
    }
  }
}

function collectMarkdownFiles(dir: string, visitedDirs = new Set<string>()): string[] {
  let dirStats: ReturnType<typeof statSync>
  try {
    dirStats = statSync(dir, { bigint: true })
  } catch {
    return []
  }
  if (!dirStats.isDirectory()) return []
  const dirKey =
    dirStats.dev === 0n && dirStats.ino === 0n
      ? realpathSync(dir)
      : `${dirStats.dev}:${dirStats.ino}`
  if (visitedDirs.has(dirKey)) return []
  visitedDirs.add(dirKey)

  const out: string[] = []
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(dir, { encoding: 'utf8', withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    try {
      const entryStats = entry.isSymbolicLink()
        ? statSync(fullPath)
        : lstatSync(fullPath)
      if (entryStats.isDirectory()) {
        out.push(...collectMarkdownFiles(fullPath, visitedDirs))
      } else if (entryStats.isFile() && entry.name.endsWith('.md')) {
        out.push(fullPath)
      }
    } catch {
      continue
    }
  }
  return out.sort()
}

async function getSettingSourceEnabled(): Promise<SettingSourceEnabled> {
  try {
    // Literal specifier so esbuild discovers the module at bundle time.
    const module = (await import('../../utils/settings/constants.js')) as {
      isSettingSourceEnabled?: SettingSourceEnabled
    }
    if (typeof module.isSettingSourceEnabled === 'function') {
      return source => module.isSettingSourceEnabled?.(source) ?? true
    }
  } catch {
    // Fall back to allowing sources when the shared settings module is absent.
  }
  return () => true
}

function projectAgentDirs(
  cwd: string,
  isSettingSourceEnabled: SettingSourceEnabled,
): Array<{ dir: string; source: SettingSource }> {
  if (markdownDirsForTesting) return markdownDirsForTesting
  const dirs: Array<{ dir: string; source: SettingSource }> = []
  const managed = process.env.AGENC_MANAGED_AGENTS_DIR
  if (managed) {
    dirs.push({ dir: managed, source: 'policySettings' })
  }
  if (isSettingSourceEnabled('userSettings')) {
    const userRoot = process.env.AGENC_CONFIG_DIR ?? join(homedir(), '.agenc')
    dirs.push({ dir: join(userRoot, 'agents'), source: 'userSettings' })
  }

  if (!isSettingSourceEnabled('projectSettings')) return dirs

  let current = resolve(cwd)
  const home = resolve(homedir())
  while (true) {
    dirs.push({ dir: join(current, '.agenc', 'agents'), source: 'projectSettings' })
    if (current === home || current === dirname(current)) break
    if (existsSync(join(current, '.git'))) break
    current = dirname(current)
  }
  return dirs
}

async function loadSharedMarkdownAgentFiles(
  cwd: string,
): Promise<MarkdownAgentFile[] | null> {
  try {
    // Literal specifier so esbuild discovers the module at bundle time.
    const module = (await import('../../utils/markdownConfigLoader.js')) as {
      loadMarkdownFilesForSubdir: {
        (subdir: string, cwd: string): Promise<MarkdownAgentFile[]>
        cache: { clear?: () => void }
      }
    }
    sharedMarkdownCacheClearer = module.loadMarkdownFilesForSubdir.cache.clear?.bind(
      module.loadMarkdownFilesForSubdir.cache,
    )
    const files = await module.loadMarkdownFilesForSubdir('agents', cwd)
    return files.map(file => ({
      filePath: file.filePath,
      baseDir: file.baseDir,
      frontmatter: file.frontmatter,
      content: file.content,
      source: file.source as SettingSource,
    }))
  } catch {
    return null
  }
}

async function loadMarkdownAgentFiles(
  cwd: string,
): Promise<{ files: MarkdownAgentFile[]; failedFiles: FailedAgentFile[] }> {
  if (!markdownDirsForTesting) {
    const sharedFiles = await loadSharedMarkdownAgentFiles(cwd)
    if (sharedFiles) return { files: sharedFiles, failedFiles: [] }
  }

  const files: MarkdownAgentFile[] = []
  const failedFiles: FailedAgentFile[] = []
  const seenFileIds = new Set<string>()
  const isSettingSourceEnabled = await getSettingSourceEnabled()
  for (const { dir, source } of projectAgentDirs(cwd, isSettingSourceEnabled)) {
    let filePaths: string[]
    try {
      filePaths = collectMarkdownFiles(dir)
    } catch (error) {
      failedFiles.push({ path: dir, error: errorToMessage(error) })
      continue
    }
    for (const filePath of filePaths) {
      try {
        const identity = fileIdentity(filePath)
        if (identity && seenFileIds.has(identity)) continue
        if (identity) seenFileIds.add(identity)
        const raw = readFileSync(filePath, 'utf8')
        const { frontmatter, content } = parseMarkdown(raw)
        files.push({
          filePath,
          baseDir: dir,
          frontmatter,
          content,
          source,
        })
      } catch (error) {
        failedFiles.push({ path: filePath, error: errorToMessage(error) })
      }
    }
  }
  return { files, failedFiles }
}

function parseAgentFields(
  name: string,
  description: string,
  source: SettingSource,
  systemPrompt: string,
  raw: Record<string, unknown>,
  filePath?: string,
  baseDir?: string,
): CustomAgentDefinition {
  const memory = parseMemoryScope(raw.memory)
  const tools = addMemoryTools(parseAgentTools(raw.tools), memory)
  const disallowedTools =
    raw.disallowedTools !== undefined
      ? parseAgentTools(raw.disallowedTools)
      : undefined
  const skills = parseSlashTools(raw.skills)
  const color = AGENT_COLORS.includes(raw.color as AgentColorName)
    ? (raw.color as AgentColorName)
    : undefined
  const model = nonEmptyString(raw.model)
  const effort = parseEffortValue(raw.effort)
  const permissionMode = parsePermissionMode(raw.permissionMode)
  const mcpServers = parseMcpServers(raw.mcpServers)
  const hooks = parseHooks(raw.hooks)
  const maxTurns = parsePositiveIntFromFrontmatter(raw.maxTurns)
  const initialPrompt = nonEmptyString(raw.initialPrompt)
  const background = parseBooleanFlag(raw.background)
  const isolation = parseIsolation(raw.isolation)

  return {
    agentType: name,
    whenToUse: description.replace(/\\n/g, '\n'),
    source,
    getSystemPrompt: () => systemPromptWithMemory(name, systemPrompt, memory),
    ...(filePath ? { filename: basename(filePath, '.md') } : {}),
    ...(baseDir ? { baseDir } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(model !== undefined ? { model: model.toLowerCase() === 'inherit' ? 'inherit' : model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
  }
}

export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: SettingSource = 'flagSettings',
): CustomAgentDefinition | null {
  if (!isRecord(definition)) return null
  const description = nonEmptyString(definition.description)
  const prompt = nonEmptyString(definition.prompt)
  if (!description || !prompt) return null
  return parseAgentFields(name, description, source, prompt, definition)
}

export function parseAgentsFromJson(
  agentsJson: unknown,
  source: SettingSource = 'flagSettings',
): AgentDefinition[] {
  if (!isRecord(agentsJson)) return []
  return Object.entries(agentsJson)
    .map(([name, definition]) => parseAgentFromJson(name, definition, source))
    .filter((agent): agent is CustomAgentDefinition => agent !== null)
}

export function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: SettingSource,
): CustomAgentDefinition | null {
  const name = nonEmptyString(frontmatter.name)
  const description = nonEmptyString(frontmatter.description)
  if (!name || !description) return null
  return parseAgentFields(
    name,
    description,
    source,
    content.trim(),
    frontmatter,
    filePath,
    baseDir,
  )
}

async function initializeAgentMemorySnapshots(
  agents: CustomAgentDefinition[],
): Promise<void> {
  if (!isAutoMemoryEnabled()) return
  const memoryAgents = agents.filter(agent => agent.memory === 'user')
  if (memoryAgents.length === 0) return
  try {
    // Literal specifier so esbuild discovers the module at bundle time.
    const snapshots = await import('./agentMemorySnapshot.js')
    await Promise.all(
      memoryAgents.map(async agent => {
        const result = await snapshots.checkAgentMemorySnapshot(
          agent.agentType,
          agent.memory ?? 'user',
        )
        if (result.action === 'initialize') {
          await snapshots.initializeFromSnapshot(
            agent.agentType,
            agent.memory ?? 'user',
            result.snapshotTimestamp ?? '',
          )
        } else if (result.action === 'prompt-update') {
          agent.pendingSnapshotUpdate = {
            snapshotTimestamp: result.snapshotTimestamp ?? '',
          }
        }
      }),
    )
  } catch {
    // Snapshot initialization is opportunistic; agent discovery still succeeds.
  }
}

async function loadPluginAgentsSafe(cwd: string): Promise<PluginAgentDefinition[]> {
  try {
    if (pluginAgentsLoaderForTesting) {
      return await pluginAgentsLoaderForTesting()
    }
    pluginAgentCacheClearer = clearPluginAgentCache
    const loaded = await loadPluginAgents({ cwd })
    return Array.isArray(loaded)
      ? loaded.filter((agent): agent is PluginAgentDefinition =>
          isRecord(agent) &&
          agent.source === 'plugin' &&
          typeof agent.agentType === 'string' &&
          typeof agent.whenToUse === 'string' &&
          typeof agent.getSystemPrompt === 'function',
        )
      : []
  } catch {
    return []
  }
}

async function loadAgentDefinitions(cwd: string): Promise<AgentDefinitionsResult> {
  const builtInAgents = getBuiltInAgents()
  if (process.env.AGENC_SIMPLE === '1' || process.env.AGENC_SIMPLE === 'true') {
    return {
      activeAgents: builtInAgents,
      allAgents: builtInAgents,
    }
  }

  try {
    const failedFiles: FailedAgentFile[] = []
    const markdownResult = await loadMarkdownAgentFiles(cwd)
    failedFiles.push(...markdownResult.failedFiles)
    const customAgents = markdownResult.files
      .map(file => {
        const agent = parseAgentFromMarkdown(
          file.filePath,
          file.baseDir,
          file.frontmatter,
          file.content,
          file.source,
        )
        if (!agent && file.frontmatter.name) {
          failedFiles.push({
            path: file.filePath,
            error: getParseError(file.frontmatter),
          })
        }
        return agent
      })
      .filter((agent): agent is CustomAgentDefinition => agent !== null)

    const [pluginAgents] = await Promise.all([
      loadPluginAgentsSafe(cwd),
      initializeAgentMemorySnapshots(customAgents),
    ])

    const allAgents = [...builtInAgents, ...pluginAgents, ...customAgents]
    const activeAgents = getActiveAgentsFromList(allAgents)
    for (const agent of activeAgents) {
      if (agent.color) {
        setAgentColor(agent.agentType, agent.color)
      }
    }

    return {
      activeAgents,
      allAgents,
      ...(failedFiles.length > 0 ? { failedFiles } : {}),
    }
  } catch (error) {
    return {
      activeAgents: builtInAgents,
      allAgents: builtInAgents,
      failedFiles: [{ path: 'unknown', error: errorToMessage(error) }],
    }
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getParseError(frontmatter: Record<string, unknown>): string {
  if (!nonEmptyString(frontmatter.name)) {
    return 'Missing required "name" field in frontmatter'
  }
  if (!nonEmptyString(frontmatter.description)) {
    return 'Missing required "description" field in frontmatter'
  }
  return 'Unknown parsing error'
}

export const getAgentDefinitionsWithOverrides = memoize(
  async (cwd: string): Promise<AgentDefinitionsResult> => loadAgentDefinitions(cwd),
  cwd => cwd,
)

export function clearAgentDefinitionsCache(): void {
  getAgentDefinitionsWithOverrides.cache.clear?.()
  sharedMarkdownCacheClearer?.()
  if (pluginAgentCacheClearerForTesting) {
    pluginAgentCacheClearerForTesting()
    return
  }
  if (pluginAgentCacheClearer) {
    pluginAgentCacheClearer()
    return
  }
  clearPluginAgentCache()
}

export function __setPluginAgentsLoaderForTesting(
  loader: (() => Promise<PluginAgentDefinition[]>) | undefined,
): void {
  pluginAgentsLoaderForTesting = loader
  clearAgentDefinitionsCache()
}

export function __setPluginAgentCacheClearerForTesting(
  clearer: (() => void) | undefined,
): void {
  pluginAgentCacheClearerForTesting = clearer
}

export function __setMarkdownAgentDirsForTesting(
  dirs: Array<{ dir: string; source: SettingSource }> | undefined,
): void {
  markdownDirsForTesting = dirs
  clearAgentDefinitionsCache()
}
