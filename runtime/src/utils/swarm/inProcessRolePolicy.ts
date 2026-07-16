import type { TeammateIdentity } from '../../tasks/InProcessTeammateTask/types.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../../tools/TeamDeleteTool/constants.js'

const TEAM_COORDINATION_TOOLS = Object.freeze([
  SEND_MESSAGE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
])

/**
 * Retain the selected role's executable policy while adding only the
 * coordination tools an in-process teammate needs. The normal AgentTool
 * resolver still applies disallowedTools after this allowlist merge, so an
 * explicit deny always wins.
 */
export function resolveInProcessAgentDefinition(opts: {
  readonly identity: TeammateIdentity
  readonly teammateSystemPrompt: string
  readonly agentDefinition?: AgentDefinition
}): AgentDefinition {
  const {
    agentRoleFingerprint: _agentRoleFingerprint,
    ...selected
  } = opts.agentDefinition ?? {
    agentType: opts.identity.agentName,
    whenToUse: `In-process teammate: ${opts.identity.agentName}`,
    source: 'projectSettings' as const,
    getSystemPrompt: () => opts.teammateSystemPrompt,
  }
  const selectedTools = opts.agentDefinition?.tools
  return {
    ...selected,
    ...(opts.agentDefinition === undefined
      ? {
          agentType: opts.identity.agentName,
          whenToUse: `In-process teammate: ${opts.identity.agentName}`,
        }
      : {}),
    getSystemPrompt: () => opts.teammateSystemPrompt,
    ...(selectedTools !== undefined
      ? { tools: [...new Set([...selectedTools, ...TEAM_COORDINATION_TOOLS])] }
      : {}),
    permissionMode: opts.identity.planModeRequired
      ? 'plan'
      : (opts.agentDefinition?.permissionMode ?? 'default'),
  } as AgentDefinition
}
