import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import yaml from 'js-yaml'
import memoize from 'lodash-es/memoize.js'

import { listAgentRoles } from '../../agents/role.js'
import {
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
} from '../../permissions/types.js'
import { FILE_EDIT_TOOL_NAME } from '../system/file-edit.js'
import { FILE_READ_TOOL_NAME } from '../system/file-read.js'
import { FILE_WRITE_TOOL_NAME } from '../system/file-write.js'
import { AGENT_COLORS, setAgentColor, type AgentColorName } from './agentColorManager.js'

export type HooksSettings = Record<string, unknown>

export type SettingSource =
  | 'userSettings'
  | 'projectSettings'
  | 'policySettings'
  | 'flagSettings'

export type EffortValue =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | number

export type AgentMemoryScope = 'user' | 'project' | 'local'

export type AgentMcpServerSpec =
  | string
  | { readonly [name: string]: unknown }

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
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}

type MarkdownAgentFile = {
  filePath: string
  baseDir: string
  frontmatter: Record<string, unknown>
  content: string
  source: SettingSource
}

const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const VALID_MEMORY_SCOPES = ['user', 'project', 'local'] as const
const VALID_ISOLATION_MODES = ['worktree', 'remote'] as const
const MEMORY_TOOLS = [
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
] as const

let pluginAgentsLoaderForTesting:
  | (() => Promise<PluginAgentDefinition[]>)
  | undefined
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  return value === true || value === 'true' ? true : undefined
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const parsed = raw
    .filter((tool): tool is string => typeof tool === 'string')
    .flatMap(tool => tool.split(/[,\s]+/))
    .map(tool => tool.trim())
    .filter(Boolean)
  if (parsed.includes('*')) return undefined
  return parsed
}

function parseSkills(value: unknown): string[] | undefined {
  const parsed = parseTools(value)
  return parsed && parsed.length > 0 ? parsed : undefined
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

function parsePositiveInt(value: unknown): number | undefined {
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
  return typeof value === 'string' &&
    (VALID_ISOLATION_MODES as readonly string[]).includes(value)
    ? (value as 'worktree' | 'remote')
    : undefined
}

function parseHooks(value: unknown): HooksSettings | undefined {
  return isRecord(value) ? value : undefined
}

function parseMcpServers(value: unknown): AgentMcpServerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value.filter((item): item is AgentMcpServerSpec => {
    if (typeof item === 'string') return item.trim().length > 0
    if (!isRecord(item)) return false
    return Object.values(item).every(v => isRecord(v))
  })
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

function isAutoMemoryEnabled(): boolean {
  if (process.env.AGENC_DISABLE_AUTO_MEMORY === '1') return false
  if (process.env.AGENC_SIMPLE === '1' || process.env.AGENC_SIMPLE === 'true') {
    return false
  }
  return true
}

function roleToAgentDefinition(
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

function collectMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(fullPath)
    }
  }
  return out.sort()
}

function projectAgentDirs(cwd: string): Array<{ dir: string; source: SettingSource }> {
  if (markdownDirsForTesting) return markdownDirsForTesting
  const dirs: Array<{ dir: string; source: SettingSource }> = []
  const managed = process.env.AGENC_MANAGED_AGENTS_DIR
  if (managed) {
    dirs.push({ dir: managed, source: 'policySettings' })
  }
  dirs.push({ dir: join(homedir(), '.agenc', 'agents'), source: 'userSettings' })

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

async function loadMarkdownAgentFiles(cwd: string): Promise<MarkdownAgentFile[]> {
  const files: MarkdownAgentFile[] = []
  for (const { dir, source } of projectAgentDirs(cwd)) {
    for (const filePath of collectMarkdownFiles(dir)) {
      const raw = readFileSync(filePath, 'utf8')
      const { frontmatter, content } = parseMarkdown(raw)
      files.push({
        filePath,
        baseDir: dir,
        frontmatter,
        content,
        source,
      })
    }
  }
  return files
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
  const tools = addMemoryTools(parseTools(raw.tools), memory)
  const disallowedTools = parseTools(raw.disallowedTools)
  const skills = parseSkills(raw.skills)
  const color = AGENT_COLORS.includes(raw.color as AgentColorName)
    ? (raw.color as AgentColorName)
    : undefined
  const model = nonEmptyString(raw.model)
  const effort = parseEffortValue(raw.effort)
  const permissionMode = parsePermissionMode(raw.permissionMode)
  const mcpServers = parseMcpServers(raw.mcpServers)
  const hooks = parseHooks(raw.hooks)
  const maxTurns = parsePositiveInt(raw.maxTurns)
  const initialPrompt = nonEmptyString(raw.initialPrompt)
  const background = parseBooleanFlag(raw.background)
  const isolation = parseIsolation(raw.isolation)

  return {
    agentType: name,
    whenToUse: description.replace(/\\n/g, '\n'),
    source,
    getSystemPrompt: () => systemPrompt,
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
    const snapshotModulePath = './agentMemorySnapshot.js'
    const snapshots = await import(snapshotModulePath)
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

async function loadPluginAgentsSafe(): Promise<PluginAgentDefinition[]> {
  if (pluginAgentsLoaderForTesting) {
    return pluginAgentsLoaderForTesting()
  }
  try {
    const pluginModulePath =
      '../../agenc/upstream/utils/plugins/loadPluginAgents.js'
    const pluginModule = (await import(pluginModulePath)) as {
      loadPluginAgents?: () => Promise<unknown>
    }
    const loaded = await pluginModule.loadPluginAgents?.()
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

  const failedFiles: Array<{ path: string; error: string }> = []
  const markdownFiles = await loadMarkdownAgentFiles(cwd)
  const customAgents = markdownFiles
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
    loadPluginAgentsSafe(),
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
}

export function __setPluginAgentsLoaderForTesting(
  loader: (() => Promise<PluginAgentDefinition[]>) | undefined,
): void {
  pluginAgentsLoaderForTesting = loader
  clearAgentDefinitionsCache()
}

export function __setMarkdownAgentDirsForTesting(
  dirs: Array<{ dir: string; source: SettingSource }> | undefined,
): void {
  markdownDirsForTesting = dirs
  clearAgentDefinitionsCache()
}
