import { listAgentRoles } from '../../agents/role.js'
import type { AgentColorName } from './agentColorManager.js'

export type HooksSettings = unknown

export type SettingSource =
  | 'userSettings'
  | 'projectSettings'
  | 'policySettings'
  | 'flagSettings'

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'

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

function roleToAgentDefinition(role: ReturnType<typeof listAgentRoles>[number]): BuiltInAgentDefinition {
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

async function loadAgentDefinitions(): Promise<AgentDefinitionsResult> {
  const allAgents = listAgentRoles().map(roleToAgentDefinition)
  return {
    activeAgents: getActiveAgentsFromList(allAgents),
    allAgents,
  }
}

export const getAgentDefinitionsWithOverrides = Object.assign(
  async (_cwd: string): Promise<AgentDefinitionsResult> => loadAgentDefinitions(),
  {
    cache: {
      clear(): void {
        // Role definitions are process-local in AgenC; there is no file cache here.
      },
    },
  },
)

export function clearAgentDefinitionsCache(): void {
  getAgentDefinitionsWithOverrides.cache.clear()
}

export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: SettingSource = 'flagSettings',
): CustomAgentDefinition | null {
  if (definition === null || typeof definition !== 'object') return null
  const input = definition as Record<string, unknown>
  const description = input.description
  const prompt = input.prompt
  if (typeof description !== 'string' || typeof prompt !== 'string') {
    return null
  }
  const tools = Array.isArray(input.tools)
    ? input.tools.filter((tool): tool is string => typeof tool === 'string')
    : undefined
  return {
    agentType: name,
    whenToUse: description,
    source,
    getSystemPrompt: () => prompt,
    ...(tools !== undefined ? { tools } : {}),
  }
}

export function parseAgentsFromJson(
  agentsJson: unknown,
  source: SettingSource = 'flagSettings',
): AgentDefinition[] {
  if (agentsJson === null || typeof agentsJson !== 'object') return []
  return Object.entries(agentsJson)
    .map(([name, definition]) => parseAgentFromJson(name, definition, source))
    .filter((agent): agent is CustomAgentDefinition => agent !== null)
}
