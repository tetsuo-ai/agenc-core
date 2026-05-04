import type { AgentDefinition } from './loadAgentsDir.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    return effectiveTools.length > 0 ? effectiveTools.join(', ') : 'None'
  }
  if (hasAllowlist) return tools.join(', ')
  if (hasDenylist) return `All tools except ${disallowedTools.join(', ')}`
  return 'All tools'
}

export function formatAgentLine(agent: AgentDefinition): string {
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${getToolsDescription(agent)})`
}

export function shouldInjectAgentListInMessages(): boolean {
  if (process.env.AGENC_AGENT_LIST_IN_MESSAGES === 'false') return false
  return true
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  _isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions
  const agentList = shouldInjectAgentListInMessages()
    ? 'Available agent types are listed in system reminder messages in the conversation.'
    : `Available agent types and the tools they have access to:\n${effectiveAgents
        .map(agent => formatAgentLine(agent))
        .join('\n')}`
  return `Launch a new AgenC agent to handle complex, multi-step tasks autonomously.\n\n${agentList}`
}
